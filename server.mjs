import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobManager } from "./job-manager.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveBin(env, envVal, name, extraCandidates = [], preferExtra = false) {
  if (envVal && fs.existsSync(envVal)) return envVal;
  const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const dirs = preferExtra ? [...extraCandidates, ...pathDirs] : [...pathDirs, ...extraCandidates];
  for (const dir of dirs) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return envVal || name;
}

function buildWorkerEnv(baseEnv, pythonBin) {
  const env = { ...baseEnv, PYTHONUNBUFFERED: "1" };
  try {
    const venvRoot = path.dirname(path.dirname(pythonBin));
    const libRoot = path.join(venvRoot, "lib");
    if (!fs.existsSync(libRoot)) return env;
    const nvidiaDirs = [];
    for (const pyDir of fs.readdirSync(libRoot)) {
      if (!pyDir.startsWith("python")) continue;
      const nvidiaRoot = path.join(libRoot, pyDir, "site-packages", "nvidia");
      if (!fs.existsSync(nvidiaRoot)) continue;
      for (const pkg of fs.readdirSync(nvidiaRoot)) {
        const libDir = path.join(nvidiaRoot, pkg, "lib");
        if (fs.existsSync(libDir)) nvidiaDirs.push(libDir);
      }
    }
    if (nvidiaDirs.length > 0) {
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        ? `${nvidiaDirs.join(path.delimiter)}${path.delimiter}${env.LD_LIBRARY_PATH}`
        : nvidiaDirs.join(path.delimiter);
    }
  } catch {
    // ignore
  }
  return env;
}

export function createServer(opts = {}) {
  // `env` is the environment the bridge reads its config from AND hands to agent
  // children (so tests can put fake CLIs first on PATH). `homeDir` replaces
  // os.homedir() so tests never touch the real ~/.claude or ~/.config.
  const env = { ...process.env, ...(opts.env || {}) };
  const homeDir = opts.homeDir || os.homedir();
  let PORT = Number(opts.port ?? (env.CLAUDIAN_BRIDGE_PORT || 8790));
  const HOST = opts.host || env.CLAUDIAN_BIND || env.CLAUDIAN_BRIDGE_HOST || "0.0.0.0";
  const BRIDGE_VERSION = "0.1.0";
  const MAX_CONCURRENT_JOBS = Math.max(1, Number(env.CLAUDIAN_MAX_CONCURRENT_JOBS || 3));
  const AUTH_BACKOFF_THRESHOLD = Math.max(1, Number(opts.authBackoffThreshold ?? (env.CLAUDIAN_AUTH_BACKOFF_THRESHOLD || 5)));
  let activeAgentCount = 0;
  const DEFAULT_WORKSPACE =
    opts.workspaceDir ||
    env.CLAUDIAN_WORKSPACE_DIR ||
    env.CLAUDIAN_VAULT_DIR ||
    (fs.existsSync(path.join(homeDir, "dev")) ? path.join(homeDir, "dev") : homeDir);
  const WORKSPACES_ROOT = opts.workspacesRoot || env.CLAUDIAN_WORKSPACES_ROOT || DEFAULT_WORKSPACE;
  const VAULT_DIR = DEFAULT_WORKSPACE;
  // Antigravity (agy) is off unless the owner opts in on this computer.
  const ENABLE_AGY = opts.enableAgy ?? env.CLAUDIAN_ENABLE_AGY === "1";
  const AGY_DISABLED_MESSAGE = "Antigravity is disabled on this computer (set CLAUDIAN_ENABLE_AGY=1)";
  const isAgyProvider = (p) => p === "agy" || p === "antigravity";
  const OBSIDIAN_VAULT_DIR = env.CLAUDIAN_OBSIDIAN_VAULT || DEFAULT_WORKSPACE;

  const CLAUDE_BIN = resolveBin(env, env.CLAUDIAN_CLAUDE_BIN, "claude", [
    path.join(homeDir, ".local", "bin"),
    "/usr/local/bin",
  ]);
  const AGY_BIN = resolveBin(env, env.CLAUDIAN_AGY_BIN, "agy", [
    path.join(homeDir, ".local", "bin"),
    "/usr/local/bin",
  ]);
  const OPENCODE_BIN = resolveBin(env, env.CLAUDIAN_OPENCODE_BIN, "opencode", [
    path.join(homeDir, ".local", "bin"),
    "/usr/local/bin",
  ]);
  const STT_PYTHON = resolveBin(
    env,
    env.CLAUDIAN_STT_PYTHON,
    "python3",
    [path.join(homeDir, ".venvs", "audio", "bin")],
    true
  );
  const STT_WORKER =
    env.CLAUDIAN_STT_WORKER ||
    (fs.existsSync(path.join(__dirname, "stt_worker.py"))
      ? path.join(__dirname, "stt_worker.py")
      : path.resolve(__dirname, "../claudian-voice/stt_worker.py"));
  function firstExisting(candidates) {
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return candidates[0];
  }

  const KOKORO_CACHE_BRIDGE = path.join(homeDir, ".cache", "claudian-bridge");
  const KOKORO_CACHE_READ_ALOUD = path.join(homeDir, ".cache", "obsidian-read-aloud");
  const KOKORO_ROOT =
    env.CLAUDIAN_KOKORO_ROOT ||
    (fs.existsSync(path.join(KOKORO_CACHE_BRIDGE, "models", "kokoro"))
      ? KOKORO_CACHE_BRIDGE
      : KOKORO_CACHE_READ_ALOUD);
  const KOKORO_PYTHON = firstExisting([
    env.CLAUDIAN_KOKORO_PYTHON,
    path.join(KOKORO_ROOT, "venv", "bin", "python"),
    path.join(KOKORO_CACHE_READ_ALOUD, "venv", "bin", "python"),
    STT_PYTHON,
  ]);
  const KOKORO_WORKER = firstExisting([
    env.CLAUDIAN_KOKORO_WORKER,
    path.join(__dirname, "kokoro_worker.py"),
    path.join(KOKORO_ROOT, "kokoro_worker.py"),
  ]);
  const KOKORO_MODEL = firstExisting([
    path.join(KOKORO_ROOT, "models", "kokoro", "kokoro-v1.0.int8.onnx"),
    path.join(KOKORO_CACHE_BRIDGE, "models", "kokoro", "kokoro-v1.0.int8.onnx"),
    path.join(KOKORO_CACHE_READ_ALOUD, "models", "kokoro", "kokoro-v1.0.int8.onnx"),
  ]);
  const KOKORO_VOICES = firstExisting([
    path.join(KOKORO_ROOT, "models", "kokoro", "voices-v1.0.bin"),
    path.join(KOKORO_CACHE_BRIDGE, "models", "kokoro", "voices-v1.0.bin"),
    path.join(KOKORO_CACHE_READ_ALOUD, "models", "kokoro", "voices-v1.0.bin"),
  ]);

  function resolveApkPaths() {
    if (env.CLAUDIAN_CALL_APK) {
      return {
        apkPath: env.CLAUDIAN_CALL_APK,
        metaPath: path.join(path.dirname(env.CLAUDIAN_CALL_APK), "output-metadata.json"),
      };
    }
    const candidates = [
      path.join(__dirname, "claudian-call.apk"),
      path.resolve(__dirname, "../claudian-call/app/build/outputs/apk/direct/debug/app-direct-debug.apk"),
      path.resolve(__dirname, "../claudian-call/dist/claudian-call.apk"),
    ].filter((p) => fs.existsSync(p));

    if (candidates.length > 0) {
      candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      const newest = candidates[0];
      return {
        apkPath: newest,
        metaPath: path.join(path.dirname(newest), "output-metadata.json"),
      };
    }
    const fallback = path.resolve(__dirname, "../claudian-call/dist/claudian-call.apk");
    return {
      apkPath: fallback,
      metaPath: path.join(path.dirname(fallback), "output-metadata.json"),
    };
  }

  const CONFIG_DIR = opts.configDir || path.join(homeDir, ".config", "claudian-bridge");
  const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

  function loadOrCreateToken() {
    if (opts.token) return opts.token;
    if (env.CLAUDIAN_BRIDGE_TOKEN) {
      return env.CLAUDIAN_BRIDGE_TOKEN;
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        if (cfg.token) return cfg.token;
      } catch {
        // regenerate
      }
    }
    const token = crypto.randomBytes(24).toString("hex");
    const tmpPath = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ token }, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, CONFIG_PATH);
    return token;
  }

  const AUTH_TOKEN = loadOrCreateToken();

  function cleanupStaleTempFiles(maxAgeMs = 5 * 60 * 1000) {
    try {
      const tmpDir = os.tmpdir();
      const now = Date.now();
      for (const name of fs.readdirSync(tmpDir)) {
        if (!name.startsWith("bridge-stt-") && !name.startsWith("bridge-tts-")) continue;
        if (!name.endsWith(".wav")) continue;
        const full = path.join(tmpDir, name);
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs > maxAgeMs) fs.unlinkSync(full);
        } catch {
          // ignore race
        }
      }
    } catch {
      // ignore
    }
  }

  class PersistentJsonWorker {
    constructor(name, cmd, args) {
      this.name = name;
      this.cmd = cmd;
      this.args = args;
      this.proc = null;
      this.readyPromise = null;
      this.buf = "";
      this.pendingResolve = null;
      this.pendingReject = null;
      this.queue = Promise.resolve();
    }

    dispose() {
      const proc = this.proc;
      this.proc = null;
      this.readyPromise = null;
      if (proc && !proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }

    ensure() {
      if (this.proc && this.readyPromise) return this.readyPromise;
      this.readyPromise = new Promise((resolve, reject) => {
        let settled = false;
        let stderrTail = "";
        const child = spawn(this.cmd, this.args, {
          env: buildWorkerEnv(env, this.cmd),
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc = child;
        this.buf = "";

        const startTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.dispose();
            reject(new Error(`${this.name} startup timed out`));
          }
        }, 60_000);

        child.stderr.on("data", (c) => {
          stderrTail = (stderrTail + c.toString("utf8")).slice(-1000);
        });

        child.stdout.on("data", (chunk) => {
          this.buf += chunk.toString("utf8");
          let idx;
          while ((idx = this.buf.indexOf("\n")) !== -1) {
            const line = this.buf.slice(0, idx).trim();
            this.buf = this.buf.slice(idx + 1);
            if (!line) continue;
            if (!settled) {
              if (!line.startsWith("{")) continue;
              try {
                const msg = JSON.parse(line);
                clearTimeout(startTimer);
                if (msg.ready) {
                  settled = true;
                  resolve();
                } else {
                  settled = true;
                  this.dispose();
                  reject(new Error(msg.error || `${this.name} init failed`));
                }
              } catch {
                // ignore non-json startup line
              }
              continue;
            }
            if (this.pendingResolve) {
              if (!line.startsWith("{")) continue;
              try {
                const parsed = JSON.parse(line);
                const fn = this.pendingResolve;
                this.pendingResolve = null;
                this.pendingReject = null;
                fn(parsed);
              } catch {
                // ignore malformed stdout line
              }
            }
          }
        });

        child.on("error", (spawnErr) => {
          clearTimeout(startTimer);
          const err = new Error(`${this.name} spawn error: ${spawnErr.message}`);
          if (!settled) {
            settled = true;
            reject(err);
          } else if (this.pendingReject) {
            const fn = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            fn(err);
          }
          this.proc = null;
          this.readyPromise = null;
        });

        child.on("close", (code) => {
          clearTimeout(startTimer);
          const detail = stderrTail.trim() ? `: ${stderrTail.trim().slice(-200)}` : "";
          const err = new Error(`${this.name} exited (${code})${detail}`);
          if (!settled) {
            settled = true;
            reject(err);
          } else if (this.pendingReject) {
            const fn = this.pendingReject;
            this.pendingResolve = null;
            this.pendingReject = null;
            fn(err);
          }
          this.proc = null;
          this.readyPromise = null;
        });
      });
      return this.readyPromise;
    }

    request(payload, timeoutMs = 45_000) {
      const run = async () => {
        await this.ensure();
        return await new Promise((resolve, reject) => {
          if (!this.proc) return reject(new Error(`${this.name} not running`));
          const timer = setTimeout(() => {
            if (this.pendingReject) {
              const fn = this.pendingReject;
              this.pendingResolve = null;
              this.pendingReject = null;
              this.dispose();
              fn(new Error(`${this.name} request timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs);

          this.pendingResolve = (val) => {
            clearTimeout(timer);
            resolve(val);
          };
          this.pendingReject = (err) => {
            clearTimeout(timer);
            reject(err);
          };
          try {
            this.proc.stdin.write(JSON.stringify(payload) + "\n");
          } catch (err) {
            clearTimeout(timer);
            this.pendingResolve = null;
            this.pendingReject = null;
            this.dispose();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      };
      const next = this.queue.then(run, run);
      this.queue = next.then(() => undefined, () => undefined);
      return next;
    }
  }

  const sttWorker = opts.sttWorker || new PersistentJsonWorker("stt", STT_PYTHON, [
    STT_WORKER,
    env.CLAUDIAN_STT_MODEL || "small",
    "auto",
  ]);
  const ttsWorker = opts.ttsWorker || new PersistentJsonWorker("kokoro", KOKORO_PYTHON, [
    KOKORO_WORKER,
    KOKORO_MODEL,
    KOKORO_VOICES,
  ]);

  const activeChildren = new Set();

  function buildProviderSpawn(job, systemPrompt) {
    const provider = String(job.provider || "claude").toLowerCase();
    const finalSystemPrompt = buildVoiceSystemPrompt(systemPrompt, job.cwd);
    const effectivePrompt =
      provider !== "claude" && finalSystemPrompt
        ? `[Instructions: ${finalSystemPrompt}]\n\n${job.prompt}`
        : job.prompt;

    let bin = CLAUDE_BIN;
    let args;
    if (provider === "agy" || provider === "antigravity") {
      bin = AGY_BIN;
      args = ["-p", effectivePrompt, "--output-format", "stream-json", "--mode", "auto"];
      if (job.sessionId) args.push("--conversation", String(job.sessionId));
      if (job.model) args.push("--model", String(job.model));
    } else if (provider === "opencode") {
      bin = OPENCODE_BIN;
      args = ["run", effectivePrompt, "--format", "json", "--auto"];
      if (job.sessionId) args.push("-s", String(job.sessionId));
      if (job.model) args.push("-m", String(job.model));
    } else {
      bin = CLAUDE_BIN;
      args = [
        "-p",
        job.prompt,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-mode",
        "auto",
      ];
      if (job.sessionId) args.push("--resume", String(job.sessionId));
      if (job.model) args.push("--model", String(job.model));
      if (finalSystemPrompt) args.push("--append-system-prompt", finalSystemPrompt);
    }
    return spawn(bin, args, {
      cwd: job.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const jobManager = new JobManager({
    configDir: CONFIG_DIR,
    hangTimeoutMs: opts.jobHangTimeoutMs ?? Number(env.CLAUDIAN_JOB_HANG_MS || 5 * 60_000),
    approvalTimeoutMs: opts.approvalTimeoutMs ?? Number(env.CLAUDIAN_APPROVAL_TIMEOUT_MS || 10 * 60_000),
    spawnJobProcess: buildProviderSpawn,
    onTurnComplete: recordBridgeTurn,
    onAudit: (entry) => auditLog(entry),
  });
  const modelCache = new Map();
  const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

  function runCliStdout(bin, args, timeoutMs = 12_000) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout || "");
      });
    });
  }

  const VOICE_OUTPUT_RULES = [
    "You are responding in a live voice call.",
    "Structure every reply so it is effortless to follow by ear:",
    "1) Lead with the direct answer or headline first.",
    "2) Use short, natural spoken sentences and explicit signposts (First, Second, Next).",
    "3) Refer to files by short name (e.g., server.mjs) instead of full directory paths, and summarize command/test results in plain speech.",
    "4) Never output markdown tables, ASCII diagrams, raw URLs, or multi-line code blocks unless explicitly asked.",
    "5) End with one clear next step or single decision question when input is needed.",
  ].join(" ");

  function buildVoiceSystemPrompt(customPrompt, workspaceDir = DEFAULT_WORKSPACE) {
    const base = String(customPrompt || "").trim() || VOICE_OUTPUT_RULES;
    const parts = [base];
    if (workspaceDir && workspaceDir !== DEFAULT_WORKSPACE) {
      parts.push(
        `[Workspace Isolation: Keep local file reads, searches, and edits scoped to ${workspaceDir} to avoid pulling unrelated context from sibling projects. Web search, web fetch, and MCP tools remain fully enabled.]`
      );
    }
    return parts.join("\n\n");
  }

  async function listProviderModels(provider) {
    const key = provider === "antigravity" ? "agy" : provider;
    const cached = modelCache.get(key);
    if (cached && Date.now() - cached.ts < MODEL_CACHE_TTL_MS) {
      return cached.models;
    }

    let models;
    if (key === "agy") {
      try {
        const out = await runCliStdout(AGY_BIN, ["models"]);
        const parsed = [{ id: "", label: "Default (auto)" }];
        for (const raw of out.split("\n")) {
          const line = raw.trim();
          if (!line || line.startsWith("Fetching ")) continue;
          const parts = line.split("\t");
          if (parts.length >= 2 && parts[0].trim()) {
            parsed.push({ id: parts[0].trim(), label: parts.slice(1).join(" ").trim() });
          } else if (/^[a-z0-9._-]+$/i.test(line)) {
            parsed.push({ id: line, label: line });
          }
        }
        models = parsed;
      } catch {
        models = [{ id: "", label: "Default (auto)" }];
      }
    } else if (key === "opencode") {
      try {
        const out = await runCliStdout(OPENCODE_BIN, ["models"]);
        const parsed = [{ id: "", label: "Default (auto)" }];
        for (const raw of out.split("\n")) {
          const line = raw.trim();
          if (/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(line)) {
            parsed.push({ id: line, label: line });
          }
        }
        models = parsed;
      } catch {
        models = [{ id: "", label: "Default (auto)" }];
      }
    } else {
      models = [
        { id: "haiku", label: "Claude Haiku (Fast)" },
        { id: "sonnet", label: "Claude Sonnet" },
        { id: "opus", label: "Claude Opus" },
      ];
    }

    modelCache.set(key, { ts: Date.now(), models });
    return models;
  }

  const ALLOWED_CORS_ORIGINS = new Set([
    "app://obsidian.md",
    "capacitor://localhost",
    "http://localhost",
  ]);
  const DEVICES_FILE = path.join(CONFIG_DIR, "devices.json");
  const AUDIT_FILE = path.join(CONFIG_DIR, "audit.jsonl");
  const failedAuthByIp = new Map();

  function sha256Hex(str) {
    return crypto.createHash("sha256").update(String(str || "")).digest("hex");
  }

  function constantTimeTokenMatch(a, b) {
    const ha = crypto.createHash("sha256").update(String(a || "")).digest();
    const hb = crypto.createHash("sha256").update(String(b || "")).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  function loadDevices() {
    try {
      const parsed = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveDevices(devices) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), { mode: 0o600 });
    try { fs.chmodSync(DEVICES_FILE, 0o600); } catch {}
  }

  function auditLog(entry) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
      try { fs.chmodSync(AUDIT_FILE, 0o600); } catch {}
    } catch {
      // ignore audit write errors
    }
  }

  function resolveWorkspaceCwd(requestedCwd) {
    const raw = typeof requestedCwd === "string" ? requestedCwd.trim() : "";
    if (!raw) return DEFAULT_WORKSPACE;
    const rootReal = fs.realpathSync(WORKSPACES_ROOT);
    const targetReal = fs.realpathSync(raw);
    const stat = fs.statSync(targetReal);
    if (!stat.isDirectory()) throw new Error("Not a directory");
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
      throw new Error("Outside WORKSPACES_ROOT");
    }
    return targetReal;
  }

  function authenticateRequest(req) {
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.slice(7);
    if (!token) return null;

    const devices = loadDevices();
    for (const dev of devices) {
      if (dev.tokenHash && constantTimeTokenMatch(sha256Hex(token), dev.tokenHash)) {
        dev.lastUsedAt = Date.now();
        saveDevices(devices);
        return { deviceId: dev.id, legacy: false };
      }
    }
    if (constantTimeTokenMatch(token, AUTH_TOKEN)) {
      return { deviceId: "legacy", legacy: true };
    }
    return null;
  }

  function setCors(res, req) {
    const origin = req?.headers?.origin;
    if (origin && ALLOWED_CORS_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  }

  function sendJson(res, status, obj, req = null) {
    setCors(res, req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  function readBody(req, maxBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on("data", (c) => {
        total += c.length;
        if (total > maxBytes) {
          req.destroy();
          reject(new Error("Payload too large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function extractFirstUserTitle(jsonlPath) {
    try {
      const fd = fs.openSync(jsonlPath, "r");
      const buf = Buffer.alloc(65536);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString("utf8", 0, bytes).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "user" && ev.message?.content) {
            const text = Array.isArray(ev.message.content)
              ? ev.message.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join(" ")
              : String(ev.message.content);
            const cleaned = text.replace(/\s+/g, " ").trim();
            if (cleaned) return cleaned.slice(0, 60);
          }
        } catch {
          // skip partial/malformed line
        }
      }
    } catch {
      // ignore
    }
    return "Conversation";
  }

  const SESSIONS_INDEX_PATH = path.join(CONFIG_DIR, "sessions.json");
  const SESSIONS_HISTORY_DIR = path.join(CONFIG_DIR, "history");

  function readBridgeSessionsIndex() {
    try {
      if (!fs.existsSync(SESSIONS_INDEX_PATH)) return {};
      return JSON.parse(fs.readFileSync(SESSIONS_INDEX_PATH, "utf8")) || {};
    } catch {
      return {};
    }
  }

  function recordBridgeTurn({ sessionId, cwd, provider, model, userText, assistantText }) {
    if (!sessionId || !/^[a-zA-Z0-9._:-]+$/.test(sessionId)) return;
    try {
      fs.mkdirSync(SESSIONS_HISTORY_DIR, { recursive: true });
      const index = readBridgeSessionsIndex();
      const existing = index[sessionId];
      const cleanTitle = (userText || "").replace(/\s+/g, " ").trim().slice(0, 60) || "Conversation";
      index[sessionId] = {
        id: sessionId,
        sessionId,
        title: existing?.title || cleanTitle,
        cwd: cwd || existing?.cwd || VAULT_DIR,
        provider: provider || existing?.provider || "claude",
        selectedModel: model || existing?.selectedModel || provider || "claude",
        lastActivityAt: Date.now(),
      };
      const tmpIdx = `${SESSIONS_INDEX_PATH}.tmp`;
      fs.writeFileSync(tmpIdx, JSON.stringify(index, null, 2));
      fs.renameSync(tmpIdx, SESSIONS_INDEX_PATH);

      const safeFile = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
      const histPath = path.join(SESSIONS_HISTORY_DIR, `${safeFile}.json`);
      let msgs = [];
      if (fs.existsSync(histPath)) {
        try {
          msgs = JSON.parse(fs.readFileSync(histPath, "utf8")) || [];
        } catch {
          msgs = [];
        }
      }
      if (userText) msgs.push({ role: "user", text: userText });
      if (assistantText) msgs.push({ role: "assistant", text: assistantText });
      const tmpHist = `${histPath}.tmp`;
      fs.writeFileSync(tmpHist, JSON.stringify(msgs));
      fs.renameSync(tmpHist, histPath);
    } catch {
      // non-fatal
    }
  }

  function listClaudianSessions(requestedWorkspace = "") {
    const targetDir =
      requestedWorkspace &&
      fs.existsSync(requestedWorkspace) &&
      fs.statSync(requestedWorkspace).isDirectory()
        ? requestedWorkspace
        : VAULT_DIR;
    const bySessionId = new Map();

    const index = readBridgeSessionsIndex();
    for (const item of Object.values(index)) {
      if (!item?.sessionId) continue;
      if (item.cwd && path.resolve(item.cwd) !== path.resolve(targetDir)) continue;
      bySessionId.set(item.sessionId, {
        id: item.id || item.sessionId,
        title: item.title || "Conversation",
        sessionId: item.sessionId,
        selectedModel: item.selectedModel || item.provider || "claude",
        lastActivityAt: item.lastActivityAt || 0,
      });
    }

    const sessionsRoot = path.join(targetDir, ".claudian", "sessions");
    if (fs.existsSync(sessionsRoot)) {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".meta.json")) {
            try {
              const meta = JSON.parse(fs.readFileSync(full, "utf8"));
              const sid = meta.sessionId || meta.providerState?.providerSessionId;
              if (!sid) continue;
              bySessionId.set(sid, {
                id: meta.id || sid,
                title: meta.title || "Untitled",
                sessionId: sid,
                selectedModel: meta.selectedModel || "haiku",
                lastActivityAt: meta.lastActivityAt || meta.createdAt || 0,
              });
            } catch {
              // skip corrupt
            }
          }
        }
      };
      walk(sessionsRoot);
    }

    const slug = targetDir.replace(/[/_]/g, "-");
    const claudeDir = path.join(homeDir, ".claude", "projects", slug);
    if (fs.existsSync(claudeDir)) {
      const jsonls = fs
        .readdirSync(claudeDir)
        .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
        .map((f) => {
          const full = path.join(claudeDir, f);
          const st = fs.statSync(full);
          return { sid: f.slice(0, -6), full, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 30);

      for (const item of jsonls) {
        const existing = bySessionId.get(item.sid);
        if (existing) {
          existing.lastActivityAt = Math.max(existing.lastActivityAt, item.mtimeMs);
        } else {
          bySessionId.set(item.sid, {
            id: item.sid,
            title: extractFirstUserTitle(item.full),
            sessionId: item.sid,
            selectedModel: "claude",
            lastActivityAt: item.mtimeMs,
          });
        }
      }
    }

    return Array.from(bySessionId.values())
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 30);
  }

  function readSessionMessages(sessionId) {
    if (!sessionId || !/^[a-zA-Z0-9._:-]+$/.test(sessionId)) return [];
    const safeFile = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const histPath = path.join(SESSIONS_HISTORY_DIR, `${safeFile}.json`);
    if (fs.existsSync(histPath)) {
      try {
        const msgs = JSON.parse(fs.readFileSync(histPath, "utf8"));
        if (Array.isArray(msgs) && msgs.length > 0) return msgs;
      } catch {
        // fall through to Claude jsonl
      }
    }
    const projectsRoot = path.join(homeDir, ".claude", "projects");
    const slug = VAULT_DIR.replace(/[/_]/g, "-");
    let jsonlPath = path.join(projectsRoot, slug, `${sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath) && fs.existsSync(projectsRoot)) {
      for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          jsonlPath = candidate;
          break;
        }
      }
    }
    if (!fs.existsSync(jsonlPath)) return [];

    const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
    const messages = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "user" && ev.message?.content) {
          const content = Array.isArray(ev.message.content)
            ? ev.message.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n")
            : String(ev.message.content);
          if (content.trim()) {
            messages.push({ role: "user", text: content.trim() });
          }
        } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
          const text = ev.message.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          if (text) {
            messages.push({ role: "assistant", text });
          }
        }
      } catch {
        // skip malformed line
      }
    }
    return messages;
  }

  const server = http.createServer(async (req, res) => {
    setCors(res, req);
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_CORS_ORIGINS.has(origin)) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const ip = req.socket?.remoteAddress || "unknown";
    const failState = failedAuthByIp.get(ip);
    if (failState && failState.until > Date.now()) {
      const retryAfter = Math.ceil((failState.until - Date.now()) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, { error: "Too many failed authentication attempts" }, req);
      return;
    }

    const authInfo = authenticateRequest(req);

    if (req.method === "GET" && url.pathname === "/health") {
      if (!authInfo) {
        sendJson(res, 200, { ok: true, version: BRIDGE_VERSION }, req);
        return;
      }
      sendJson(
        res,
        200,
        {
          ok: true,
          version: BRIDGE_VERSION,
          vault: VAULT_DIR,
          claude: fs.existsSync(CLAUDE_BIN),
          agy: ENABLE_AGY && fs.existsSync(AGY_BIN),
          opencode: fs.existsSync(OPENCODE_BIN),
          stt: fs.existsSync(STT_WORKER),
          tts: fs.existsSync(KOKORO_WORKER),
        },
        req
      );
      return;
    }

    if (!authInfo) {
      const hasAttemptedToken = Boolean(req.headers.authorization);
      if (hasAttemptedToken) {
        const prev = failedAuthByIp.get(ip) || { count: 0, until: 0 };
        const count = prev.count + 1;
        const delayMs = count >= AUTH_BACKOFF_THRESHOLD ? Math.min(60_000, 1000 * 2 ** (count - AUTH_BACKOFF_THRESHOLD)) : 0;
        failedAuthByIp.set(ip, { count, until: Date.now() + delayMs });
      }
      auditLog({ ip, action: "auth_failed", path: url.pathname, status: 401 });
      sendJson(res, 401, { error: "Unauthorized" }, req);
      return;
    }
    failedAuthByIp.delete(ip);
    if (authInfo.legacy) {
      res.setHeader("X-Claudian-Warning", "Legacy token in use; re-pair device");
    }

    if (req.method === "GET" && url.pathname === "/devices") {
      const devices = loadDevices().map(({ id, name, createdAt, lastUsedAt }) => ({
        id,
        name,
        createdAt,
        lastUsedAt,
      }));
      sendJson(res, 200, { ok: true, devices }, req);
      return;
    }

    if (req.method === "POST" && url.pathname === "/devices") {
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch {}
      const name = String(body.name || "device").trim().slice(0, 64) || "device";
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(24).toString("hex");
      const devices = loadDevices();
      devices.push({ id, name, tokenHash: sha256Hex(token), createdAt: Date.now(), lastUsedAt: null });
      saveDevices(devices);
      auditLog({ deviceId: authInfo.deviceId, ip, action: "device_create", targetId: id, name, status: 200 });
      sendJson(res, 200, { ok: true, device: { id, name }, token }, req);
      return;
    }

    const deviceDelMatch = url.pathname.match(/^\/devices\/([^/]+)$/);
    if (req.method === "DELETE" && deviceDelMatch) {
      const targetId = decodeURIComponent(deviceDelMatch[1]);
      const devices = loadDevices();
      const next = devices.filter((d) => d.id !== targetId);
      if (next.length === devices.length) {
        sendJson(res, 404, { error: "Device not found" }, req);
        return;
      }
      saveDevices(next);
      auditLog({ deviceId: authInfo.deviceId, ip, action: "device_revoke", targetId, status: 200 });
      sendJson(res, 200, { ok: true, revoked: targetId }, req);
      return;
    }

    if (req.method === "GET" && url.pathname === "/apk/version") {
      const { apkPath, metaPath } = resolveApkPaths();
      if (!fs.existsSync(apkPath)) {
        sendJson(res, 404, { error: "APK not built yet" }, req);
        return;
      }
      let versionCode = 1;
      let versionName = "0.1.0";
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const el = meta.elements?.[0];
        if (el?.versionCode) versionCode = Number(el.versionCode);
        if (el?.versionName) versionName = String(el.versionName);
      } catch {
        // use defaults
      }
      const stat = fs.statSync(apkPath);
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex");
      sendJson(res, 200, {
        ok: true,
        versionCode,
        versionName,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        sha256,
      }, req);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/apk") {
      const { apkPath } = resolveApkPaths();
      if (!fs.existsSync(apkPath)) {
        sendJson(res, 404, { error: "APK not built yet" }, req);
        return;
      }
      const stat = fs.statSync(apkPath);
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="claudian-call.apk"',
        "Content-Length": stat.size,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(apkPath).pipe(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/approvals") {
      sendJson(res, 200, { ok: true, approvals: jobManager.listApprovals() }, req);
      return;
    }

    const approvalResolveMatch = url.pathname.match(/^\/approvals\/([^/]+)$/);
    if (req.method === "POST" && approvalResolveMatch) {
      const approvalId = decodeURIComponent(approvalResolveMatch[1]);
      const raw = await readBody(req, 64 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch {}
      const resolved = jobManager.resolveApproval(approvalId, body.decision);
      if (!resolved) {
        sendJson(res, 404, { error: "Approval not found" }, req);
        return;
      }
      sendJson(res, 200, { ok: true, ...resolved }, req);
      return;
    }

    const jobPermCheckMatch = url.pathname.match(/^\/jobs\/([^/]+)\/permission-check$/);
    if (req.method === "POST" && jobPermCheckMatch) {
      const jobId = decodeURIComponent(jobPermCheckMatch[1]);
      const raw = await readBody(req, 256 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch {}
      const result = await jobManager.requestApproval({
        jobId,
        tool: body.tool || "Bash",
        input: body.input || {},
      });
      sendJson(res, 200, { ok: true, ...result }, req);
      return;
    }

    if (req.method === "GET" && url.pathname === "/jobs") {
      sendJson(res, 200, { ok: true, jobs: jobManager.listJobs() }, req);
      return;
    }

    if (req.method === "POST" && url.pathname === "/jobs") {
      const raw = await readBody(req, 1024 * 1024);
      let body;
      try { body = JSON.parse(raw.toString("utf8")); } catch {
        sendJson(res, 400, { error: "Invalid JSON" }, req);
        return;
      }
      const prompt = String(body.prompt || "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "Missing prompt" }, req);
        return;
      }
      let workspaceDir;
      try {
        workspaceDir = resolveWorkspaceCwd(body.cwd);
      } catch {
        sendJson(res, 400, { error: "Invalid workspace path" }, req);
        return;
      }
      const idempotencyKey = String(req.headers["idempotency-key"] || body.idempotencyKey || "").trim() || null;
      const existing = idempotencyKey && jobManager.idempotencyIndex.has(idempotencyKey);
      if (!existing && jobManager.activeCount() + activeAgentCount >= MAX_CONCURRENT_JOBS) {
        sendJson(res, 429, { error: "Bridge is busy (max concurrent jobs reached)" }, req);
        return;
      }
      const provider = String(body.provider || "claude").toLowerCase();
      if (isAgyProvider(provider) && !ENABLE_AGY) {
        sendJson(res, 400, { error: AGY_DISABLED_MESSAGE }, req);
        return;
      }
      const { job, deduplicated } = jobManager.createAndStartJob({
        prompt,
        provider,
        model: body.model || "",
        cwd: workspaceDir,
        sessionId: body.sessionId || null,
        systemPrompt: body.systemPrompt || "",
        idempotencyKey,
      });
      auditLog({ deviceId: authInfo.deviceId, ip, action: "job_create", jobId: job.id, workspace: workspaceDir, provider, status: 200 });
      sendJson(res, 200, { ok: true, job, deduplicated }, req);
      return;
    }

    const jobEventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
    if (req.method === "GET" && jobEventsMatch) {
      const jobId = decodeURIComponent(jobEventsMatch[1]);
      const job = jobManager.getJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Job not found" }, req);
        return;
      }
      setCors(res, req);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const lastId = Number(req.headers["last-event-id"] || url.searchParams.get("lastEventId") || 0) || 0;
      const sendRec = (rec) => {
        if (!res.writableEnded) {
          res.write(`id: ${rec.id}\nevent: ${rec.event}\ndata: ${JSON.stringify(rec.data)}\n\n`);
        }
      };
      const isTerminal = (ev) => ev === "done" || ev === "error" || ev === "cancelled";

      for (const rec of jobManager.readEvents(jobId, lastId)) {
        sendRec(rec);
        if (isTerminal(rec.event)) {
          if (!res.writableEnded) res.end();
          return;
        }
      }
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) {
        if (!res.writableEnded) res.end();
        return;
      }
      const keepalive = setInterval(() => {
        if (!res.writableEnded) { try { res.write(": keepalive\n\n"); } catch {} }
      }, 15_000);
      const unsub = jobManager.subscribe(jobId, (rec) => {
        sendRec(rec);
        if (isTerminal(rec.event)) {
          clearInterval(keepalive);
          unsub();
          if (!res.writableEnded) res.end();
        }
      });
      req.on("close", () => {
        clearInterval(keepalive);
        unsub();
      });
      return;
    }

    const jobCancelMatch = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && jobCancelMatch) {
      const jobId = decodeURIComponent(jobCancelMatch[1]);
      const job = jobManager.cancelJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Job not found" }, req);
        return;
      }
      auditLog({ deviceId: authInfo.deviceId, ip, action: "job_cancel", jobId, status: 200 });
      sendJson(res, 200, { ok: true, job }, req);
      return;
    }

    const jobMsgMatch = url.pathname.match(/^\/jobs\/([^/]+)\/message$/);
    if (req.method === "POST" && jobMsgMatch) {
      const jobId = decodeURIComponent(jobMsgMatch[1]);
      const parentJob = jobManager.getJob(jobId);
      if (!parentJob) {
        sendJson(res, 404, { error: "Job not found" }, req);
        return;
      }
      const raw = await readBody(req, 1024 * 1024);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch {}
      const prompt = String(body.prompt || "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "Missing prompt" }, req);
        return;
      }
      const idempotencyKey = String(req.headers["idempotency-key"] || body.idempotencyKey || "").trim() || null;
      const { job, deduplicated } = jobManager.createAndStartJob({
        prompt,
        provider: parentJob.provider,
        model: parentJob.model,
        cwd: parentJob.cwd,
        sessionId: parentJob.sessionId,
        systemPrompt: body.systemPrompt || "",
        idempotencyKey,
      });
      auditLog({ deviceId: authInfo.deviceId, ip, action: "job_message", jobId: job.id, parentJobId: jobId, status: 200 });
      sendJson(res, 200, { ok: true, job, deduplicated }, req);
      return;
    }

    const jobGetMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobGetMatch) {
      const jobId = decodeURIComponent(jobGetMatch[1]);
      const job = jobManager.getJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Job not found" }, req);
        return;
      }
      sendJson(res, 200, { ok: true, job }, req);
      return;
    }

    if (req.method === "GET" && url.pathname === "/workspaces") {
      const out = [{ path: DEFAULT_WORKSPACE, name: `${path.basename(DEFAULT_WORKSPACE) || DEFAULT_WORKSPACE} (default)` }];
      try {
        for (const entry of fs.readdirSync(WORKSPACES_ROOT, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const full = path.join(WORKSPACES_ROOT, entry.name);
          if (full !== DEFAULT_WORKSPACE) {
            out.push({ path: full, name: entry.name });
          }
        }
      } catch {
        // ignore unreadable root
      }
      sendJson(res, 200, { ok: true, defaultWorkspace: DEFAULT_WORKSPACE, workspaces: out });
      return;
    }

    if (req.method === "POST" && url.pathname === "/workspaces") {
      try {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const rawName = String(body.name || "").trim();
        const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        if (!safeName || safeName === "." || safeName === ".." || safeName.startsWith(".")) {
          sendJson(res, 400, { ok: false, error: "Invalid folder name" });
          return;
        }
        const targetPath = path.join(WORKSPACES_ROOT, safeName);
        fs.mkdirSync(targetPath, { recursive: true });
        auditLog({ deviceId: authInfo.deviceId, ip, action: "workspace_create", workspace: targetPath, status: 200 });
        sendJson(res, 200, { ok: true, workspace: { path: targetPath, name: safeName } }, req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/models") {
      const provider = String(url.searchParams.get("provider") || "claude").toLowerCase();
      if (isAgyProvider(provider) && !ENABLE_AGY) {
        sendJson(res, 400, { ok: false, provider, models: [], error: AGY_DISABLED_MESSAGE });
        return;
      }
      try {
        const models = await listProviderModels(provider);
        sendJson(res, 200, { ok: true, provider, models });
      } catch (err) {
        sendJson(res, 500, { ok: false, provider, models: [], error: err.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      const cwd = url.searchParams.get("cwd") || "";
      sendJson(res, 200, { sessions: listClaudianSessions(cwd) });
      return;
    }

    const msgMatch = url.pathname.match(/^\/sessions\/([a-zA-Z0-9._:-]+)\/messages$/);
    if (req.method === "GET" && msgMatch) {
      sendJson(res, 200, { messages: readSessionMessages(msgMatch[1]) });
      return;
    }

    const recapMatch = url.pathname.match(/^\/sessions\/([a-zA-Z0-9._:-]+)\/recap$/);
    if (req.method === "POST" && recapMatch) {
      try {
        const msgs = readSessionMessages(recapMatch[1]);
        if (msgs.length === 0) {
          sendJson(res, 200, { ok: true, recap: "This conversation has no messages yet." });
          return;
        }
        const recent = msgs
          .slice(-14)
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.text || "").slice(0, 500)}`)
          .join("\n");
        const recapPrompt = [
          "Summarize this conversation for a 5-second spoken catch-up.",
          "Return 3 short, natural spoken sentences (no markdown, no bullets, no file paths):",
          "1) What we were working on, 2) Key progress or decision made, 3) Suggested next step.",
          "",
          recent,
        ].join("\n");
        const out = await new Promise((resolve, reject) => {
          const child = spawn(CLAUDE_BIN, ["-p", recapPrompt, "--model", "haiku", "--output-format", "text"], {
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          const timer = setTimeout(() => {
            try { child.kill("SIGTERM"); } catch {}
            reject(new Error("Recap timed out"));
          }, 25_000);
          child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0 && stdout.trim()) resolve(stdout.trim());
            else reject(new Error(`Recap exited ${code}`));
          });
          child.on("error", (e) => { clearTimeout(timer); reject(e); });
        });
        sendJson(res, 200, { ok: true, recap: out });
      } catch (err) {
        const msgs = readSessionMessages(recapMatch[1]);
        const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.text || "";
        const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant")?.text || "";
        const fallback = `Last topic: ${lastUser.slice(0, 120)}. Latest reply: ${lastAsst.slice(0, 140)}.`;
        sendJson(res, 200, { ok: true, recap: fallback, fallback: true });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/vault/save") {
      try {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const rawTitle = String(body.title || "Voice Note").trim();
        const content = String(body.content || "").trim();
        if (!content) {
          sendJson(res, 400, { ok: false, error: "Empty content" });
          return;
        }
        const dateStr = new Date().toISOString().slice(0, 10);
        const slug = rawTitle
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48) || "note";
        const notesDir = path.join(OBSIDIAN_VAULT_DIR, "Voice Notes");
        fs.mkdirSync(notesDir, { recursive: true });
        const timeSuffix = new Date().toISOString().slice(11, 19).replace(/:/g, "");
        const fileName = `${dateStr} - ${slug}-${timeSuffix}.md`;
        const fullPath = path.join(notesDir, fileName);
        const workspaceName = body.workspace ? path.basename(String(body.workspace)) : "";
        const md = [
          "---",
          `date: ${new Date().toISOString()}`,
          "source: claudian-call",
          workspaceName ? `workspace: ${workspaceName}` : null,
          body.sessionId ? `session_id: ${String(body.sessionId)}` : null,
          "---",
          "",
          `# ${rawTitle}`,
          "",
          content,
          "",
        ]
          .filter((l) => l !== null)
          .join("\n");
        fs.writeFileSync(fullPath, md, "utf8");
        sendJson(res, 200, { ok: true, path: fullPath, relativePath: `Voice Notes/${fileName}` });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/stt") {
      try {
        const body = await readBody(req);
        let wavBuf = body;
        let language = url.searchParams.get("language") || "en";
        const ct = req.headers["content-type"] || "";
        if (ct.includes("application/json")) {
          const parsed = JSON.parse(body.toString("utf8"));
          wavBuf = Buffer.from(parsed.wavBase64, "base64");
          language = parsed.language || language;
        }
        const tmpWav = path.join(os.tmpdir(), `bridge-stt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
        fs.writeFileSync(tmpWav, wavBuf);
        try {
          const result = await sttWorker.request({ wav: tmpWav, language });
          sendJson(res, 200, result);
        } finally {
          fs.unlink(tmpWav, () => {});
        }
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/tts") {
      try {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const tmpWav = path.join(os.tmpdir(), `bridge-tts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
        try {
          const result = await ttsWorker.request({
            text: body.text || "",
            voice: body.voice || "af_heart",
            speed: Number(body.speed || 1.05),
            out_wav: tmpWav,
          });
          if (!result.ok) {
            sendJson(res, 500, result);
            return;
          }
          const wav = fs.readFileSync(tmpWav);
          setCors(res);
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": wav.length,
          });
          res.end(wav);
        } finally {
          fs.unlink(tmpWav, () => {});
        }
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (err) {
        sendJson(res, 400, { error: "Invalid JSON" });
        return;
      }

      const prompt = String(body.prompt || "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "Missing prompt" });
        return;
      }

      let workspaceDir;
      try {
        workspaceDir = resolveWorkspaceCwd(body.cwd);
      } catch (err) {
        auditLog({ deviceId: authInfo.deviceId, ip, action: "chat_rejected", workspace: String(body.cwd || ""), status: 400 });
        sendJson(res, 400, { error: "Invalid workspace path" }, req);
        return;
      }
      if (activeAgentCount >= MAX_CONCURRENT_JOBS) {
        auditLog({ deviceId: authInfo.deviceId, ip, action: "chat_busy", workspace: workspaceDir, status: 429 });
        sendJson(res, 429, { error: "Bridge is busy (max concurrent jobs reached)" }, req);
        return;
      }
      activeAgentCount++;
      const isScopedWorkspace = workspaceDir !== DEFAULT_WORKSPACE;

      setCors(res, req);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const writeEvent = (event, data) => {
        if (!res.writableEnded) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const keepaliveTimer = setInterval(() => {
        if (!res.writableEnded) {
          try {
            res.write(": keepalive\n\n");
          } catch {
            // ignore
          }
        }
      }, 15_000);
      req.on("close", () => clearInterval(keepaliveTimer));
      res.on("finish", () => clearInterval(keepaliveTimer));
      // On Node >= 20 `req` closes before this handler registers, and `finish` never fires when
      // the client aborts, so without this the interval leaks and keeps the process alive.
      res.on("close", () => clearInterval(keepaliveTimer));

      const provider = String(body.provider || "claude").toLowerCase();
      let slotReleased = false;
      const releaseSlot = () => {
        if (!slotReleased) {
          slotReleased = true;
          activeAgentCount = Math.max(0, activeAgentCount - 1);
        }
      };
      if (isAgyProvider(provider) && !ENABLE_AGY) {
        releaseSlot();
        writeEvent("error", { error: AGY_DISABLED_MESSAGE });
        res.end();
        return;
      }
      const finalSystemPrompt = buildVoiceSystemPrompt(body.systemPrompt, workspaceDir);
      const effectivePrompt =
        provider !== "claude" && finalSystemPrompt
          ? `[Instructions: ${finalSystemPrompt}]\n\n${prompt}`
          : prompt;

      let bin = CLAUDE_BIN;
      let args;
      if (provider === "agy" || provider === "antigravity") {
        bin = AGY_BIN;
        args = [
          "-p",
          effectivePrompt,
          "--output-format",
          "stream-json",
          "--mode",
          "auto",
        ];
        if (body.sessionId) args.push("--conversation", String(body.sessionId));
        if (body.model) args.push("--model", String(body.model));
      } else if (provider === "opencode") {
        bin = OPENCODE_BIN;
        args = ["run", effectivePrompt, "--format", "json", "--auto"];
        if (body.sessionId) args.push("-s", String(body.sessionId));
        if (body.model) args.push("-m", String(body.model));
      } else {
        bin = CLAUDE_BIN;
        args = [
          "-p",
          prompt,
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--permission-mode",
          "auto",
        ];
        if (body.sessionId) args.push("--resume", String(body.sessionId));
        if (body.model) args.push("--model", String(body.model));
        if (finalSystemPrompt) {
          args.push("--append-system-prompt", finalSystemPrompt);
        }
      }

      const child = spawn(bin, args, {
        cwd: workspaceDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      activeChildren.add(child);
      child.on("close", () => activeChildren.delete(child));

      let buf = "";
      let fullText = "";
      let activeSessionId = body.sessionId || null;
      let doneSent = false;

      const sendDone = () => {
        if (doneSent) return;
        doneSent = true;
        if (activeSessionId) {
          recordBridgeTurn({
            sessionId: activeSessionId,
            cwd: workspaceDir,
            provider,
            model: body.model || provider,
            userText: prompt,
            assistantText: fullText,
          });
        }
        writeEvent("done", { sessionId: activeSessionId, text: fullText });
      };

      const killChildGracefully = () => {
        if (child.killed) return;
        try {
          child.kill("SIGTERM");
        } catch {
          return;
        }
        setTimeout(() => {
          if (!child.killed) {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, 3000).unref();
      };

      // M2: client disconnect on /chat no longer kills the underlying agent process.

      child.on("error", (err) => {
        releaseSlot();
        auditLog({ deviceId: authInfo.deviceId, ip, action: "chat", workspace: workspaceDir, provider, status: 500 });
        if (!doneSent) {
          writeEvent("error", { error: `Failed to start ${provider}: ${err.message}` });
        }
        if (!res.writableEnded) res.end();
      });

      const formatToolStatus = (name, input) => {
        const tool = String(name || "").trim();
        const lower = tool.toLowerCase();
        const target =
          input?.file_path || input?.path || input?.query || input?.url || input?.pattern || "";
        const shortTarget = target ? path.basename(String(target)).slice(0, 24) : "";
        if (lower.includes("websearch") || lower.includes("search_web")) return "Searching web…";
        if (lower.includes("webfetch") || lower.includes("fetch")) return "Fetching page…";
        if (lower === "read" || lower.includes("read_file")) {
          return shortTarget ? `Reading ${shortTarget}…` : "Reading file…";
        }
        if (lower === "edit" || lower === "write" || lower.includes("edit_file") || lower.includes("write_file")) {
          return shortTarget ? `Editing ${shortTarget}…` : "Editing file…";
        }
        if (lower === "bash" || lower.includes("command")) return "Running command…";
        if (lower === "grep" || lower === "glob") return "Searching codebase…";
        return tool ? `Running ${tool}…` : "Working…";
      };

      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            const sid = ev.session_id || ev.conversation_id || ev.sessionID || ev.result?.conversation_id;
            if (sid && sid !== activeSessionId) {
              activeSessionId = sid;
              writeEvent("session", { sessionId: activeSessionId });
            }

            if (provider === "agy" || provider === "antigravity") {
              if (ev.event === "step_update" && ev.step_update?.tool_name) {
                writeEvent("status", { status: formatToolStatus(ev.step_update.tool_name, ev.step_update.input) });
              }
              if (ev.event === "step_update" && ev.step_update?.text_delta) {
                const delta = String(ev.step_update.text_delta);
                fullText += delta;
                writeEvent("text", { delta, fullText });
              } else if (ev.event === "result") {
                if (ev.result?.response && !fullText) fullText = String(ev.result.response);
                sendDone();
              }
            } else if (provider === "opencode") {
              if (ev.type === "tool_use" || ev.part?.type === "tool") {
                writeEvent("status", {
                  status: formatToolStatus(ev.part?.tool || ev.tool, ev.part?.state?.input || ev.input),
                });
              } else if (ev.type === "text") {
                const delta = String(ev.part?.text || ev.text || "");
                if (delta) {
                  fullText += delta;
                  writeEvent("text", { delta, fullText });
                }
              } else if (ev.type === "error") {
                const msg = ev.error?.data?.message || ev.error?.message || "OpenCode error";
                writeEvent("error", { error: msg });
                doneSent = true;
              }
            } else if (
              ev.type === "stream_event" &&
              ev.event?.type === "content_block_start" &&
              ev.event?.content_block?.type === "tool_use"
            ) {
              writeEvent("status", { status: formatToolStatus(ev.event.content_block.name, null) });
            } else if (
              ev.type === "stream_event" &&
              ev.event?.type === "content_block_delta" &&
              ev.event?.delta?.type === "text_delta" &&
              typeof ev.event.delta.text === "string"
            ) {
              const delta = ev.event.delta.text;
              if (delta) {
                fullText += delta;
                writeEvent("text", { delta, fullText });
              }
            } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
              const nextText = ev.message.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n");
              if (nextText && nextText.length > fullText.length) {
                const delta = nextText.startsWith(fullText)
                  ? nextText.slice(fullText.length)
                  : nextText;
                fullText = nextText;
                writeEvent("text", { delta, fullText });
              }
            } else if (ev.type === "result") {
              if (ev.result && !fullText) fullText = ev.result;
              sendDone();
            }
          } catch {
            // ignore non-json line
          }
        }
      });

      let errTail = "";
      child.stderr.on("data", (c) => {
        errTail = (errTail + c.toString("utf8")).slice(-1000);
      });

      child.on("close", (code) => {
        releaseSlot();
        auditLog({
          deviceId: authInfo.deviceId,
          ip,
          action: "chat",
          workspace: workspaceDir,
          provider,
          sessionId: activeSessionId,
          status: code === 0 ? 200 : 500,
        });
        if (code !== 0 && !fullText && !doneSent) {
          writeEvent("error", { error: errTail || `${provider} exited ${code}` });
        } else {
          sendDone();
        }
        if (!res.writableEnded) res.end();
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  let mdnsSocket = null;

  function encodeDnsName(name) {
    const parts = name.replace(/\.$/, "").split(".").filter(Boolean);
    const bufs = parts.map((label) => {
      const b = Buffer.from(label, "utf8");
      return Buffer.concat([Buffer.from([b.length]), b]);
    });
    return Buffer.concat([...bufs, Buffer.from([0])]);
  }

  function decodeDnsName(msg, offset) {
    const labels = [];
    let pos = offset;
    let jumped = false;
    let nextOffset = offset;
    const seen = new Set();
    while (pos < msg.length) {
      if (seen.has(pos)) break;
      seen.add(pos);
      const len = msg[pos];
      if (len === 0) {
        if (!jumped) nextOffset = pos + 1;
        break;
      }
      if ((len & 0xc0) === 0xc0 && pos + 1 < msg.length) {
        if (!jumped) nextOffset = pos + 2;
        pos = ((len & 0x3f) << 8) | msg[pos + 1];
        jumped = true;
        continue;
      }
      pos += 1;
      labels.push(msg.subarray(pos, pos + len).toString("utf8"));
      pos += len;
    }
    return { name: labels.join(".").toLowerCase(), nextOffset };
  }

  function buildDnsRecord(name, type, ttl, rdata, cacheFlush = false) {
    const header = Buffer.alloc(10);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(cacheFlush ? 0x8001 : 0x0001, 2);
    header.writeUInt32BE(ttl, 4);
    header.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([encodeDnsName(name), header, rdata]);
  }

  function getLanIpv4Addresses() {
    const ips = [];
    const ifaces = os.networkInterfaces();
    for (const entries of Object.values(ifaces)) {
      for (const info of entries || []) {
        if (info.family === "IPv4" && !info.internal) {
          ips.push(info.address);
        }
      }
    }
    return ips;
  }

  function buildMdnsAnnouncement() {
    const rawHost = os.hostname().replace(/[^a-zA-Z0-9-]/g, "-") || "claudian";
    const hostFqdn = `${rawHost}.local`;
    const serviceType = "_claudian._tcp.local";
    const instanceName = `${rawHost}.${serviceType}`;
    const ips = getLanIpv4Addresses();
    if (ips.length === 0) return null;

    const txtParts = [Buffer.from("v=1"), Buffer.from(`port=${PORT}`)].map((b) =>
      Buffer.concat([Buffer.from([b.length]), b])
    );
    const txtRdata = Buffer.concat(txtParts);
    const srvRdata = Buffer.concat([
      Buffer.from([0, 0, 0, 0, (PORT >> 8) & 0xff, PORT & 0xff]),
      encodeDnsName(hostFqdn),
    ]);

    const answers = [
      buildDnsRecord(serviceType, 12, 120, encodeDnsName(instanceName), false),
      buildDnsRecord(instanceName, 33, 120, srvRdata, true),
      buildDnsRecord(instanceName, 16, 120, txtRdata, true),
    ];
    for (const ip of ips) {
      const octets = ip.split(".").map((n) => Number(n) & 0xff);
      if (octets.length === 4) {
        answers.push(buildDnsRecord(hostFqdn, 1, 120, Buffer.from(octets), true));
      }
    }

    const hdr = Buffer.alloc(12);
    hdr.writeUInt16BE(0x8400, 2);
    hdr.writeUInt16BE(answers.length, 6);
    return Buffer.concat([hdr, ...answers]);
  }

  function startMdnsAdvertiser() {
    if (env.CLAUDIAN_DISABLE_MDNS === "1" || opts.mdns === false) return;
    try {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      mdnsSocket = sock;
      sock.on("error", (err) => {
        console.warn("[claudian-bridge] mDNS error:", err?.message || err);
      });
      sock.on("message", (msg) => {
        if (msg.length < 12) return;
        const flags = msg.readUInt16BE(2);
        if ((flags & 0x8000) !== 0) return;
        const qdCount = msg.readUInt16BE(4);
        let offset = 12;
        let matched = false;
        for (let i = 0; i < qdCount && offset < msg.length; i++) {
          const { name, nextOffset } = decodeDnsName(msg, offset);
          offset = nextOffset + 4;
          if (name === "_claudian._tcp.local" || name === "_services._dns-sd._udp.local") {
            matched = true;
            break;
          }
        }
        if (matched) {
          const packet = buildMdnsAnnouncement();
          if (packet) sock.send(packet, 5353, "224.0.0.251");
        }
      });
      sock.bind(5353, () => {
        try {
          sock.addMembership("224.0.0.251");
        } catch {}
        const packet = buildMdnsAnnouncement();
        if (packet) sock.send(packet, 5353, "224.0.0.251");
        console.log("[claudian-bridge] mDNS advertising _claudian._tcp.local");
      });
    } catch (err) {
      console.warn("[claudian-bridge] mDNS disabled:", err?.message || err);
    }
  }

  function stopMdns() {
    if (mdnsSocket) {
      try { mdnsSocket.close(); } catch {}
      mdnsSocket = null;
    }
  }

  // Start listening; resolves once bound (PORT is updated, so port 0 works).
  function start() {
    if (HOST === "0.0.0.0" || (!HOST.startsWith("127.") && !HOST.startsWith("10.") && !HOST.startsWith("192.168.") && !HOST.startsWith("100.") && HOST !== "::1" && HOST !== "localhost")) {
      console.warn(`[claudian-bridge] WARNING: binding to ${HOST} may expose the bridge beyond localhost/private interfaces; set CLAUDIAN_BIND to restrict.`);
    }
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, HOST, () => {
        server.off("error", reject);
        PORT = server.address().port;
        if (opts.cleanupTempFiles !== false) cleanupStaleTempFiles();
        startMdnsAdvertiser();
        console.log(`[claudian-bridge] listening on http://${HOST}:${PORT} (vault=${VAULT_DIR})`);
        console.log(`[claudian-bridge] token saved at ${CONFIG_PATH}`);
        if (opts.warmWorkers !== false) {
          sttWorker.ensure().then(
            () => console.log("[claudian-bridge] sttWorker warmed"),
            (err) => console.warn("[claudian-bridge] sttWorker warmup failed:", err?.message || err),
          );
          ttsWorker.ensure().then(
            () => console.log("[claudian-bridge] ttsWorker warmed"),
            (err) => console.warn("[claudian-bridge] ttsWorker warmup failed:", err?.message || err),
          );
        }
        resolve(api);
      });
    });
  }

  // Full teardown for tests: workers, mDNS, in-flight agent children, sockets.
  function stop() {
    stopMdns();
    jobManager.shutdown();
    sttWorker.dispose();
    ttsWorker.dispose();
    for (const child of activeChildren) {
      try { child.kill("SIGKILL"); } catch {}
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  const api = {
    server,
    start,
    stop,
    stopMdns,
    sttWorker,
    ttsWorker,
    get port() { return PORT; },
    host: HOST,
    env, // the env handed to agent children; tests mutate it to switch fake scenarios
    token: AUTH_TOKEN,
    configDir: CONFIG_DIR,
    configPath: CONFIG_PATH,
    workspacesRoot: WORKSPACES_ROOT,
    workspaceDir: DEFAULT_WORKSPACE,
  };
  return api;
}

// Process-level behavior (signals, global error handlers, self-start) only when
// run as `node server.mjs`, never when imported by tests.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const app = createServer();

  process.on("unhandledRejection", (err) => {
    console.error("[claudian-bridge] unhandledRejection:", err);
  });

  process.on("uncaughtException", (err) => {
    console.error("[claudian-bridge] uncaughtException:", err);
  });

  const shutdown = (signal) => {
    console.log(`[claudian-bridge] received ${signal}, shutting down...`);
    app.stopMdns();
    app.sttWorker.dispose();
    app.ttsWorker.dispose();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  app.start().catch((err) => {
    console.error("[claudian-bridge] failed to listen:", err);
    process.exit(1);
  });
}

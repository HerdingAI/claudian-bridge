// Shared test helpers: start a real bridge on a random port with throwaway dirs, fake
// agent CLIs first on PATH, and stubbed STT/TTS workers (no Python/GPU needed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures");
export const TOKEN = "test-token-0123456789";

// Stand-in for PersistentJsonWorker: records requests, never spawns Python.
// The TTS flavour writes a tiny RIFF/WAVE header to out_wav like the real worker would.
export function stubWorker(name = "stub") {
  return {
    name,
    calls: [],
    disposed: 0,
    ensure: async () => {},
    dispose() { this.disposed++; },
    async request(payload) {
      this.calls.push(payload);
      if (payload.out_wav) {
        fs.writeFileSync(payload.out_wav, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]));
        return { ok: true };
      }
      return { ok: true, text: "stub transcript", language: payload.language };
    },
  };
}

// opts.env is merged over the base env; opts.enableAgy sets CLAUDIAN_ENABLE_AGY.
export async function startBridge(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudian-test-"));
  const home = path.join(root, "home");
  const configDir = path.join(root, "config");
  const workspacesRoot = path.join(root, "workspaces");
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "fake.log");
  for (const d of [home, configDir, workspacesRoot, binDir]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(workspacesRoot, "proj-a"));
  // PATH shims named like the real CLIs so resolveBin() finds them first.
  for (const [name, target] of [["claude", "fake-claude"], ["opencode", "fake-opencode"], ["agy", "fake-agy"]]) {
    fs.symlinkSync(path.join(FIXTURES, target), path.join(binDir, name));
  }
  const bridge = createServer({
    port: 0,
    host: "127.0.0.1",
    homeDir: home,
    configDir,
    token: TOKEN,
    workspaceDir: workspacesRoot,
    workspacesRoot,
    mdns: false,
    warmWorkers: false,
    cleanupTempFiles: false,
    jobHangTimeoutMs: opts.jobHangTimeoutMs,
    authBackoffThreshold: opts.authBackoffThreshold ?? 100,
    sttWorker: opts.sttWorker || stubWorker("stt"),
    ttsWorker: opts.ttsWorker || stubWorker("tts"),
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_LOG: logPath,
      CLAUDIAN_CLAUDE_BIN: path.join(binDir, "claude"),
      CLAUDIAN_OPENCODE_BIN: path.join(binDir, "opencode"),
      CLAUDIAN_AGY_BIN: path.join(binDir, "agy"),
      ...(opts.enableAgy ? { CLAUDIAN_ENABLE_AGY: "1" } : {}),
      ...(opts.env || {}),
    },
  });
  await bridge.start();
  const base = `http://127.0.0.1:${bridge.port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  return {
    bridge,
    base,
    root,
    home,
    configDir,
    workspacesRoot,
    logPath,
    // per-request scenario switch for the fake CLIs
    scenario(name) { bridge.env.FAKE_SCENARIO = name; },
    get(p, headers = auth) { return fetch(base + p, { headers }); },
    post(p, body, headers = auth) {
      return fetch(base + p, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    },
    // POST /chat and collect parsed SSE events until the stream closes.
    async chat(body, { abortAfterEvents } = {}) {
      const ac = new AbortController();
      const res = await fetch(base + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const events = await readSse(res, ac, abortAfterEvents);
      return { res, events, names: events.map((e) => e.event) };
    },
    invocations() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    async close() {
      await bridge.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function readSse(res, ac, abortAfterEvents) {
  const events = [];
  if (!res.body) return events;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = { event: "message", data: null, raw: block };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
          else if (line.startsWith(":")) ev.event = "comment";
        }
        events.push(ev);
        if (abortAfterEvents && events.length >= abortAfterEvents) {
          ac.abort();
          return events;
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err;
  }
  return events;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(fn, timeoutMs = 5000, stepMs = 25) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// Every child any fake CLI ever started (from FAKE_LOG) must be gone.
export async function assertNoLeakedChildren(assert, invocations) {
  const alive = await waitFor(
    () => (invocations.filter((i) => pidAlive(i.pid)).length === 0 ? true : false),
    5000
  );
  assert.ok(alive, `leaked child processes: ${invocations.filter((i) => pidAlive(i.pid)).map((i) => i.pid)}`);
}

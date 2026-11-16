import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { evaluatePermissionPolicy } from "./policy-engine.mjs";

/**
 * Persistent background job manager.
 * States: queued -> running -> needs_approval -> succeeded | failed | cancelled | interrupted
 */
export class JobManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.configDir = opts.configDir;
    this.jobsDir = path.join(this.configDir, "jobs");
    this.indexPath = path.join(this.jobsDir, "index.json");
    this.hangTimeoutMs = opts.hangTimeoutMs ?? 5 * 60_000;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 10 * 60_000;
    this.spawnJobProcess = opts.spawnJobProcess;
    this.onTurnComplete = opts.onTurnComplete || null;
    this.onAudit = opts.onAudit || null;
    this.jobs = new Map();
    this.idempotencyIndex = new Map();
    this.activeChildren = new Map();
    this.hangTimers = new Map();
    this.listenersByJob = new Map();
    this.pendingApprovals = new Map();

    fs.mkdirSync(this.jobsDir, { recursive: true });
    this.#loadAndRecover();
  }

  #loadAndRecover() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      for (const [id, job] of Object.entries(raw || {})) {
        if (job.status === "queued" || job.status === "running" || job.status === "needs_approval") {
          job.status = "interrupted";
          job.error = "the computer restarted while working; the job was interrupted";
          job.updatedAt = Date.now();
          this.jobs.set(id, job);
          this.#appendEvent(job, "error", { error: job.error, interrupted: true });
        } else {
          this.jobs.set(id, job);
        }
        if (job.idempotencyKey) {
          this.idempotencyIndex.set(job.idempotencyKey, id);
        }
      }
      this.#persistIndex();
    } catch {
      // fresh jobs directory
    }
  }

  #persistIndex() {
    if (this.shuttingDown) return;
    const obj = {};
    for (const [id, job] of this.jobs.entries()) {
      obj[id] = job;
    }
    fs.writeFileSync(this.indexPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  }

  #eventsPath(jobId) {
    return path.join(this.jobsDir, `${jobId}.jsonl`);
  }

  #appendEvent(job, event, data) {
    if (this.shuttingDown) return null;
    const id = (job.lastEventId || 0) + 1;
    job.lastEventId = id;
    job.updatedAt = Date.now();
    const record = { id, event, data, ts: job.updatedAt };
    fs.appendFileSync(this.#eventsPath(job.id), JSON.stringify(record) + "\n", { mode: 0o600 });
    this.#persistIndex();
    const subs = this.listenersByJob.get(job.id);
    if (subs) {
      for (const fn of subs) {
        try { fn(record); } catch {}
      }
    }
    return record;
  }

  readEvents(jobId, afterId = 0) {
    try {
      const lines = fs.readFileSync(this.#eventsPath(jobId), "utf8").split("\n").filter(Boolean);
      const out = [];
      for (const line of lines) {
        const rec = JSON.parse(line);
        if (rec.id > afterId) out.push(rec);
      }
      return out;
    } catch {
      return [];
    }
  }

  subscribe(jobId, fn) {
    if (!this.listenersByJob.has(jobId)) this.listenersByJob.set(jobId, new Set());
    this.listenersByJob.get(jobId).add(fn);
    return () => {
      this.listenersByJob.get(jobId)?.delete(fn);
    };
  }

  listJobs() {
    return [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  activeCount() {
    return this.activeChildren.size;
  }

  createAndStartJob({ prompt, provider, model, cwd, sessionId, systemPrompt, idempotencyKey }) {
    if (idempotencyKey && this.idempotencyIndex.has(idempotencyKey)) {
      const existingId = this.idempotencyIndex.get(idempotencyKey);
      const existing = this.jobs.get(existingId);
      if (existing) return { job: existing, deduplicated: true };
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const job = {
      id,
      status: "queued",
      provider,
      model: model || "",
      cwd,
      sessionId: sessionId || null,
      prompt,
      text: "",
      error: null,
      idempotencyKey: idempotencyKey || null,
      createdAt: now,
      updatedAt: now,
      lastEventId: 0,
    };
    this.jobs.set(id, job);
    if (idempotencyKey) this.idempotencyIndex.set(idempotencyKey, id);
    this.#persistIndex();
    this.#startChild(job, systemPrompt);
    return { job, deduplicated: false };
  }

  #resetHangWatchdog(job) {
    const prev = this.hangTimers.get(job.id);
    if (prev) clearTimeout(prev);
    if (this.hangTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      if (job.status !== "running" && job.status !== "queued") return;
      const mins = Math.max(1, Math.round(this.hangTimeoutMs / 60_000));
      job.status = "failed";
      job.error = `no output for ${mins} minute(s)`;
      this.#killChild(job.id);
      this.#appendEvent(job, "error", { error: job.error });
    }, this.hangTimeoutMs);
    timer.unref?.();
    this.hangTimers.set(job.id, timer);
  }

  #clearHangWatchdog(jobId) {
    const t = this.hangTimers.get(jobId);
    if (t) {
      clearTimeout(t);
      this.hangTimers.delete(jobId);
    }
  }

  #killChild(jobId) {
    const child = this.activeChildren.get(jobId);
    if (!child) return;
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, 1500).unref?.();
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)) {
      return job;
    }
    job.status = "cancelled";
    job.error = "cancelled by user";
    this.#clearHangWatchdog(jobId);
    this.#killChild(jobId);
    this.activeChildren.delete(jobId);
    this.#appendEvent(job, "cancelled", { status: "cancelled" });
    return job;
  }

  #startChild(job, systemPrompt) {
    let child;
    try {
      child = this.spawnJobProcess(job, systemPrompt);
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
      this.#appendEvent(job, "error", { error: job.error });
      return;
    }

    job.status = "running";
    this.activeChildren.set(job.id, child);
    this.#appendEvent(job, "status", { status: "running", message: `Started ${job.provider}` });
    this.#resetHangWatchdog(job);

    let buf = "";
    let errTail = "";
    let lastMilestoneAt = 0;

    child.stderr?.on("data", (c) => {
      errTail = (errTail + c.toString("utf8")).slice(-1000);
    });

    child.stdout?.on("data", (chunk) => {
      this.#resetHangWatchdog(job);
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.session_id && !job.sessionId) {
            job.sessionId = ev.session_id;
            this.#appendEvent(job, "session", { sessionId: job.sessionId });
          } else if (ev.sessionID && !job.sessionId) {
            job.sessionId = ev.sessionID;
            this.#appendEvent(job, "session", { sessionId: job.sessionId });
          }

          if (ev.type === "text" && ev.part?.text) {
            job.text += ev.part.text;
            this.#appendEvent(job, "text", { delta: ev.part.text, fullText: job.text });
          } else if (ev.type === "stream_event" && ev.event?.type === "content_block_start") {
            const cb = ev.event.content_block;
            if (cb?.type === "tool_use" && Date.now() - lastMilestoneAt > 2000) {
              lastMilestoneAt = Date.now();
              this.#appendEvent(job, "status", { message: `Using ${cb.name || "tool"}…` });
            }
          } else if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && typeof ev.event?.delta?.text === "string") {
            const delta = ev.event.delta.text;
            if (delta) {
              job.text += delta;
              this.#appendEvent(job, "text", { delta, fullText: job.text });
            }
          } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
            const nextText = ev.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
            if (nextText && nextText.length > job.text.length) {
              const delta = nextText.startsWith(job.text) ? nextText.slice(job.text.length) : nextText;
              job.text = nextText;
              this.#appendEvent(job, "text", { delta, fullText: job.text });
            }
          } else if (ev.type === "result" && ev.result && !job.text) {
            job.text = ev.result;
            this.#appendEvent(job, "text", { delta: ev.result, fullText: job.text });
          }
        } catch {
          // ignore non-json
        }
      }
    });

    child.on("error", (err) => {
      this.#clearHangWatchdog(job.id);
      this.activeChildren.delete(job.id);
      if (job.status === "cancelled" || job.status === "failed") return;
      job.status = "failed";
      job.error = `Failed to start ${job.provider}: ${err.message}`;
      this.#appendEvent(job, "error", { error: job.error });
    });

    child.on("close", (code) => {
      this.#clearHangWatchdog(job.id);
      this.activeChildren.delete(job.id);
      if (job.status === "cancelled" || job.status === "failed") return;

      if (code !== 0) {
        job.status = "failed";
        job.error = errTail.trim() || `${job.provider} exited ${code}`;
        this.#appendEvent(job, "error", { error: job.error, code });
        return;
      }
      if (!job.text.trim()) {
        job.status = "failed";
        job.error = "the agent returned nothing";
        this.#appendEvent(job, "error", { error: job.error });
        return;
      }

      job.status = "succeeded";
      if (this.onTurnComplete && job.sessionId) {
        try {
          this.onTurnComplete({
            sessionId: job.sessionId,
            cwd: job.cwd,
            provider: job.provider,
            model: job.model || job.provider,
            userText: job.prompt,
            assistantText: job.text,
          });
        } catch {}
      }
      this.#appendEvent(job, "done", { sessionId: job.sessionId, text: job.text });
    });
  }

  listApprovals() {
    return [...this.pendingApprovals.values()].map(({ id, jobId, tool, summary, risk, createdAt }) => ({
      id,
      jobId,
      tool,
      summary,
      risk,
      createdAt,
    }));
  }

  requestApproval({ jobId, tool, input = {} }) {
    const job = this.jobs.get(jobId) || null;
    const policy = evaluatePermissionPolicy({ tool, input, workspaceDir: job?.cwd || "" });
    if (policy.decision !== "ask") {
      this.onAudit?.({ action: "permission_policy", jobId, tool, decision: policy.decision, risk: policy.risk, reason: policy.reason });
      return Promise.resolve({ decision: policy.decision, reason: policy.reason, summary: policy.summary, risk: policy.risk });
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    if (job && job.status === "running") {
      job.status = "needs_approval";
      this.#appendEvent(job, "permission_request", {
        id,
        jobId,
        tool,
        summary: policy.summary,
        risk: policy.risk,
      });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingApprovals.has(id)) return;
        this.pendingApprovals.delete(id);
        if (job && job.status === "needs_approval") {
          job.status = "running";
          this.#appendEvent(job, "permission_resolved", { id, decision: "deny", reason: "approval timed out" });
        }
        this.onAudit?.({ action: "permission_timeout", approvalId: id, jobId, tool, decision: "deny", risk: policy.risk });
        resolve({ decision: "deny", reason: "approval timed out", summary: policy.summary, risk: policy.risk });
      }, this.approvalTimeoutMs);
      timer.unref?.();

      this.pendingApprovals.set(id, {
        id,
        jobId,
        tool,
        summary: policy.summary,
        risk: policy.risk,
        createdAt,
        timer,
        resolve,
      });
    });
  }

  resolveApproval(approvalId, decision) {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) return null;
    this.pendingApprovals.delete(approvalId);
    clearTimeout(entry.timer);
    const norm = String(decision || "").toLowerCase() === "allow" ? "allow" : "deny";
    const job = this.jobs.get(entry.jobId);
    if (job && job.status === "needs_approval") {
      job.status = "running";
      this.#appendEvent(job, "permission_resolved", { id: approvalId, decision: norm });
    }
    this.onAudit?.({ action: "permission_decision", approvalId, jobId: entry.jobId, tool: entry.tool, decision: norm, risk: entry.risk });
    entry.resolve({ decision: norm, reason: `user ${norm}`, summary: entry.summary, risk: entry.risk });
    return { id: approvalId, jobId: entry.jobId, decision: norm };
  }

  shutdown() {
    this.shuttingDown = true;
    for (const entry of this.pendingApprovals.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: "deny", reason: "bridge shutdown" });
    }
    this.pendingApprovals.clear();
    for (const id of [...this.hangTimers.keys()]) this.#clearHangWatchdog(id);
    for (const child of this.activeChildren.values()) {
      try { child.kill("SIGKILL"); } catch {}
    }
    this.activeChildren.clear();
  }
}

// Characterization tests for POST /chat, /sessions and /recap using the fake CLIs.
// They assert TODAY's behavior. Tests tagged `KNOWN BUG — flips in M1/M2` lock in a defect on
// purpose: the milestone that fixes it must flip the assertion deliberately.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBridge, TOKEN, pidAlive, waitFor, assertNoLeakedChildren } from "./helpers.mjs";

describe("POST /chat (characterization)", () => {
  let t;
  before(async () => { t = await startBridge(); });
  after(async () => { const inv = t.invocations(); await t.close(); await assertNoLeakedChildren(assert, inv); });
  beforeEach(() => {
    t.scenario("normal");
    delete t.bridge.env.FAKE_IGNORE_SIGTERM;
  });
  const lastClaude = () => t.invocations().filter((i) => !i.bin).at(-1);

  describe("request validation", () => {
    test("invalid JSON -> 400 JSON (not SSE)", async () => {
      const res = await fetch(t.base + "/chat", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{" });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid JSON" });
    });
    test("missing prompt -> 400 JSON", async () => {
      const res = await t.post("/chat", { prompt: "   " });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing prompt" });
    });
  });

  describe("claude happy path", () => {
    test("normal: SSE headers, session, text deltas, done", async () => {
      const { res, events, names } = await t.chat({ prompt: "Reply with exactly: pong" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      assert.deepEqual(names, ["session", "text", "text", "done"]);
      assert.equal(events[0].data.sessionId, "11111111-2222-4333-8444-555555555555");
      assert.deepEqual(events[1].data, { delta: "po", fullText: "po" });
      assert.deepEqual(events[2].data, { delta: "ng", fullText: "pong" });
      assert.deepEqual(events[3].data, { sessionId: "11111111-2222-4333-8444-555555555555", text: "pong" });
    });

    test("spawns claude with the expected argv and the default workspace as cwd", async () => {
      await t.chat({ prompt: "hi there", sessionId: "sess-argv", model: "haiku" });
      const inv = lastClaude();
      assert.equal(inv.argv[0], "-p");
      assert.equal(inv.argv[1], "hi there");
      for (const flag of ["--output-format", "stream-json", "--include-partial-messages", "--verbose", "--permission-mode", "auto"]) {
        assert.ok(inv.argv.includes(flag), `missing ${flag}`);
      }
      assert.equal(inv.argv[inv.argv.indexOf("--resume") + 1], "sess-argv");
      assert.equal(inv.argv[inv.argv.indexOf("--model") + 1], "haiku");
      assert.match(inv.argv[inv.argv.indexOf("--append-system-prompt") + 1], /live voice call/);
      assert.equal(fs.realpathSync(inv.cwd), fs.realpathSync(t.workspacesRoot));
    });

    test("a valid cwd is used and adds the workspace-isolation prompt", async () => {
      const cwd = path.join(t.workspacesRoot, "proj-a");
      await t.chat({ prompt: "hi", cwd });
      const inv = lastClaude();
      assert.equal(fs.realpathSync(inv.cwd), fs.realpathSync(cwd));
      assert.match(inv.argv[inv.argv.indexOf("--append-system-prompt") + 1], /Workspace Isolation/);
    });

    test("a nonexistent cwd silently falls back to the default workspace", async () => {
      await t.chat({ prompt: "hi", cwd: "/definitely/not/here" });
      assert.equal(fs.realpathSync(lastClaude().cwd), fs.realpathSync(t.workspacesRoot));
    });

    test("cwd OUTSIDE the workspaces root is accepted", async () => {
      // KNOWN BUG — flips in M1/M2: any existing directory on the machine is honored as cwd.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
      try {
        await t.chat({ prompt: "hi", cwd: outside });
        assert.equal(fs.realpathSync(lastClaude().cwd), fs.realpathSync(outside));
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    test("custom systemPrompt replaces the voice rules", async () => {
      await t.chat({ prompt: "hi", systemPrompt: "Be a pirate." });
      assert.match(lastClaude().argv.join("\n"), /Be a pirate\./);
      assert.doesNotMatch(lastClaude().argv.join("\n"), /live voice call/);
    });

    test("a new session id from the CLI is announced with a session event", async () => {
      const { events } = await t.chat({ prompt: "hi", sessionId: "my-own-id" });
      // the fake echoes --resume, so no session event: the client's id is kept
      assert.equal(events.filter((e) => e.event === "session").length, 0);
      assert.equal(events.at(-1).data.sessionId, "my-own-id");
    });
  });

  describe("stream scenarios", () => {
    test("long_tools: one status per tool, then text, then done", async () => {
      t.scenario("long_tools");
      const { events, names } = await t.chat({ prompt: "work" });
      const statuses = events.filter((e) => e.event === "status").map((e) => e.data.status);
      // Claude's content_block_start carries no input, so file names are never shown today.
      assert.deepEqual(statuses, ["Reading file…", "Searching codebase…", "Running command…", "Editing file…", "Searching web…"]);
      assert.equal(names.at(-1), "done");
      assert.equal(events.at(-1).data.text, "All done.");
    });

    test("subagents: subagent chatter is spoken as part of the answer", async () => {
      // KNOWN BUG — flips in M1/M2: assistant text with parent_tool_use_id (subagent output)
      // is not filtered and leaks into the user-visible/spoken text.
      t.scenario("subagents");
      const { events, names } = await t.chat({ prompt: "delegate" });
      assert.equal(names.at(-1), "done");
      assert.equal(events.at(-1).data.text, "subagent chatterSubagent finished.");
    });

    test("permission_request (best-guess shape, TODO M3): denial is invisible, just text + done", async () => {
      // KNOWN BUG — flips in M1/M2: permission denials never reach the client as an event.
      t.scenario("permission_request");
      const { events, names } = await t.chat({ prompt: "delete stuff" });
      assert.ok(!names.includes("permission"));
      assert.equal(names.at(-1), "done");
      assert.equal(events.at(-1).data.text, "I need permission to run that.");
    });

    test("slow: events arrive incrementally, not buffered to the end", async () => {
      t.scenario("slow");
      const stamps = [];
      const res = await fetch(t.base + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ prompt: "slow" }),
      });
      const reader = res.body.getReader();
      const t0 = Date.now();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        stamps.push(Date.now() - t0);
      }
      assert.ok(stamps.length >= 3);
      assert.ok(stamps.at(-1) - stamps[0] >= 300, `spread was ${stamps.at(-1) - stamps[0]}ms`);
    });

    test("partial_then_crash: stream ends with `done` and a clean-looking partial answer", async () => {
      // KNOWN BUG — flips in M1/M2: a crashed run (exit 1 after some text) is reported as success.
      t.scenario("partial_then_crash");
      const { events, names } = await t.chat({ prompt: "crash" });
      assert.deepEqual(names, ["session", "text", "text", "done"]);
      assert.equal(events.at(-1).data.text, "Working on it, then");
      assert.ok(!names.includes("error"));
    });

    test("empty: exit 0 with no output ends with `done` and empty text", async () => {
      // KNOWN BUG — flips in M1/M2: silent empty success; should be an error the client can speak.
      t.scenario("empty");
      const { events, names } = await t.chat({ prompt: "nothing" });
      assert.deepEqual(names, ["done"]);
      assert.equal(events[0].data.text, "");
    });

    test("quota_exhausted: the limit message is delivered as normal assistant text + done", async () => {
      // KNOWN BUG — flips in M1/M2: quota errors are not recognized; they get spoken as an answer.
      t.scenario("quota_exhausted");
      const { events, names } = await t.chat({ prompt: "limit" });
      assert.ok(!names.includes("error"));
      assert.equal(names.at(-1), "done");
      assert.match(events.at(-1).data.text, /hit your limit/);
    });

    test("non_utf8: split multi-byte characters and invalid bytes are corrupted to U+FFFD", async () => {
      // KNOWN BUG — flips in M1/M2: chunks are decoded one at a time (no StringDecoder), so a
      // character split across two stdout chunks becomes two replacement characters.
      t.scenario("non_utf8");
      const { events, names } = await t.chat({ prompt: "bytes" });
      assert.equal(names.at(-1), "done");
      const text = events.at(-1).data.text;
      assert.ok(text.includes("�"), "expected replacement characters");
      assert.ok(!text.includes("héllo"), "the intact word must NOT survive today");
    });

    test("huge: 5 MB of agent text survives, but every text event re-sends fullText", async () => {
      // KNOWN BUG — flips in M1/M2: SSE payload is O(n^2) because each event carries fullText.
      t.scenario("huge");
      const { events, names } = await t.chat({ prompt: "big" });
      assert.equal(names.at(-1), "done");
      assert.equal(events.at(-1).data.text.length, 20 * 256 * 1024);
      const textEvents = events.filter((e) => e.event === "text");
      assert.equal(textEvents.length, 20);
      assert.equal(textEvents.at(-1).data.fullText.length, 20 * 256 * 1024);
      assert.equal(textEvents.at(-1).data.delta.length, 256 * 1024);
    });

    test("missing CLI binary -> SSE error event", async () => {
      const t2 = await startBridge({ env: { CLAUDIAN_CLAUDE_BIN: "/nonexistent/claude-bin", PATH: "/nonexistent" } });
      try {
        const { names, events } = await t2.chat({ prompt: "hi" });
        assert.equal(names[0], "error");
        assert.match(events[0].data.error, /Failed to start claude/);
      } finally {
        await t2.close();
      }
    });
  });

  describe("lifecycle and process control", () => {
    // Start a /chat without awaiting response headers: for a silent child Node does not flush the
    // headers until the first write (the 15 s keepalive), so `await fetch` would block.
    function startHungChat(prompt) {
      const before = t.invocations().length;
      const ac = new AbortController();
      let headersAt = null;
      const t0 = Date.now();
      const p = fetch(t.base + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ prompt }),
        signal: ac.signal,
      }).then((r) => { headersAt = Date.now() - t0; return r; }, () => null);
      const child = () => waitFor(() => t.invocations().slice(before)[0], 3000);
      return { ac, p, child, headersAt: () => headersAt };
    }

    // Reap a child the bridge failed to kill, so the suite never leaks processes.
    async function reap(child) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
      assert.ok(await waitFor(() => !pidAlive(child.pid), 3000), "test cleanup failed to kill child");
    }

    test("hang: the client gets nothing and the bridge never gives up on its own", async () => {
      // KNOWN BUG — flips in M1/M2: there is no inactivity timeout, and response headers are not
      // flushed until the first byte (the 15 s keepalive), so a hung CLI looks like a dead
      // connection and holds the child forever. We observe 1.5 s of total silence, then hang up.
      t.scenario("hang");
      const h = startHungChat("hang");
      const child = await h.child();
      assert.ok(child, "child should have started");
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(h.headersAt(), null, "no response headers before the first keepalive");
      assert.ok(pidAlive(child.pid));
      h.ac.abort();
      await h.p;
      await reap(child);
    });

    test("client disconnect does NOT kill the child today: it is orphaned", async () => {
      // KNOWN BUG — flips in M1/M2: `req.on("close", killChildGracefully)` is registered after
      // `await readBody(req)`. On Node >= 20 the request's own 'close' fires as soon as the body is
      // consumed (before the handler gets here), so the listener never runs. Hanging up leaves the
      // agent running (and, for a hung CLI, forever). M2 makes this deliberate: jobs outlive the
      // connection and have an explicit cancel.
      t.scenario("hang");
      const h = startHungChat("disconnect me");
      const child = await h.child();
      assert.ok(child, "child should have started");
      h.ac.abort();
      await h.p;
      await new Promise((r) => setTimeout(r, 3800)); // longer than the (dead) 3 s SIGKILL timer
      assert.ok(pidAlive(child.pid), "child is still alive 3.8 s after the client hung up");
      await reap(child);
    });

    test("a run keeps going after the client hangs up and still records its turn", async () => {
      // KNOWN BUG — flips in M1/M2: accidental job survival. The turn lands in history, but the
      // client has no way to find or resume the run, and a hung child is never reaped.
      t.scenario("slow");
      const { names } = await t.chat({ prompt: "keep going", sessionId: "sess-orphan" }, { abortAfterEvents: 1 });
      assert.deepEqual(names, ["text"]);
      const ok = await waitFor(async () => {
        const { messages } = await (await t.get("/sessions/sess-orphan/messages")).json();
        return messages.length === 2 ? messages : null;
      }, 4000);
      assert.ok(ok, "turn should be recorded even though the client left");
      assert.equal(ok[1].text, "one two three");
    });

    test("two concurrent /chat calls for the same sessionId spawn two agent runs", async () => {
      // KNOWN BUG — flips in M1/M2: no per-session lock / dedup; the same session can run twice.
      t.scenario("slow");
      const before = t.invocations().length;
      const [a, b] = await Promise.all([
        t.chat({ prompt: "same", sessionId: "dup-session" }),
        t.chat({ prompt: "same", sessionId: "dup-session" }),
      ]);
      assert.equal(a.names.at(-1), "done");
      assert.equal(b.names.at(-1), "done");
      assert.equal(t.invocations().length - before, 2);
    });
  });

  describe("opencode provider", () => {
    test("normal: status, text deltas, done; argv uses run --format json --auto", async () => {
      const { names, events } = await t.chat({ prompt: "hi", provider: "opencode", sessionId: "oc-1", model: "anthropic/claude-haiku" });
      assert.deepEqual(names, ["session", "status", "text", "text", "done"]);
      assert.equal(events.at(-1).data.text, "opencode");
      const inv = t.invocations().filter((i) => i.bin === "opencode").at(-1);
      assert.equal(inv.argv[0], "run");
      assert.ok(inv.argv.includes("--auto"));
      assert.equal(inv.argv[inv.argv.indexOf("-s") + 1], "oc-1");
      assert.match(inv.argv[1], /^\[Instructions: .*\]\n\nhi$/s);
    });

    test("error event is forwarded and no `done` follows", async () => {
      t.scenario("error");
      const { names, events } = await t.chat({ prompt: "hi", provider: "opencode" });
      assert.equal(names.at(-1), "error");
      assert.equal(events.at(-1).data.error, "provider exploded");
      assert.ok(!names.includes("done"));
    });
  });

  describe("unknown provider", () => {
    test("falls through to claude", async () => {
      // KNOWN BUG — flips in M1/M2: provider is not validated; anything unknown runs claude.
      const { names } = await t.chat({ prompt: "hi", provider: "totally-made-up" });
      assert.equal(names.at(-1), "done");
      assert.equal(lastClaude().argv[0], "-p");
    });
  });
});

describe("sessions and recap (characterization)", () => {
  let t;
  before(async () => { t = await startBridge(); t.scenario("normal"); });
  after(async () => { const inv = t.invocations(); await t.close(); await assertNoLeakedChildren(assert, inv); });

  test("GET /sessions is empty on a fresh install", async () => {
    assert.deepEqual(await (await t.get("/sessions")).json(), { sessions: [] });
  });

  test("a finished /chat is recorded in sessions.json and history", async () => {
    await t.chat({ prompt: "Remember the number seven", sessionId: "sess-rec-1", model: "haiku" });
    const idx = JSON.parse(fs.readFileSync(path.join(t.configDir, "sessions.json"), "utf8"));
    assert.equal(idx["sess-rec-1"].title, "Remember the number seven");
    assert.equal(idx["sess-rec-1"].provider, "claude");
    const { sessions } = await (await t.get("/sessions")).json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, "sess-rec-1");
    assert.equal(sessions[0].selectedModel, "haiku");
  });

  test("GET /sessions/:id/messages returns the recorded turns", async () => {
    const { messages } = await (await t.get("/sessions/sess-rec-1/messages")).json();
    assert.deepEqual(messages, [
      { role: "user", text: "Remember the number seven" },
      { role: "assistant", text: "pong" },
    ]);
  });

  test("sessions are scoped by cwd", async () => {
    const other = path.join(t.workspacesRoot, "proj-a");
    await t.chat({ prompt: "in proj a", sessionId: "sess-rec-2", cwd: other });
    const a = (await (await t.get(`/sessions?cwd=${encodeURIComponent(other)}`)).json()).sessions.map((s) => s.sessionId);
    const dflt = (await (await t.get("/sessions")).json()).sessions.map((s) => s.sessionId);
    assert.deepEqual(a, ["sess-rec-2"]);
    assert.deepEqual(dflt, ["sess-rec-1"]);
  });

  test("messages for an unknown session are an empty list", async () => {
    assert.deepEqual(await (await t.get("/sessions/nope/messages")).json(), { messages: [] });
  });

  test("a turn is NOT recorded when no session id is known (client sent none, CLI sent one)", async () => {
    // The fake CLI reports its own session id, so it IS recorded under that id.
    await t.chat({ prompt: "fresh" });
    const idx = JSON.parse(fs.readFileSync(path.join(t.configDir, "sessions.json"), "utf8"));
    assert.ok(idx["11111111-2222-4333-8444-555555555555"]);
  });

  test("a crashed run is still recorded as a completed turn", async () => {
    // KNOWN BUG — flips in M1/M2: partial_then_crash writes the truncated answer to history.
    t.scenario("partial_then_crash");
    await t.chat({ prompt: "will crash", sessionId: "sess-crash" });
    const { messages } = await (await t.get("/sessions/sess-crash/messages")).json();
    assert.equal(messages.at(-1).text, "Working on it, then");
    t.scenario("normal");
  });

  test("POST recap with no messages", async () => {
    const body = await (await t.post("/sessions/empty-one/recap", {})).json();
    assert.deepEqual(body, { ok: true, recap: "This conversation has no messages yet." });
  });

  test("POST recap calls claude (text mode, haiku) and returns its output", async () => {
    const body = await (await t.post("/sessions/sess-rec-1/recap", {})).json();
    assert.equal(body.ok, true);
    assert.equal(body.recap, "Recap sentence one. Sentence two. Sentence three.");
    assert.equal(body.fallback, undefined);
    const inv = t.invocations().filter((i) => !i.bin).at(-1);
    assert.equal(inv.argv[inv.argv.indexOf("--output-format") + 1], "text");
    assert.equal(inv.argv[inv.argv.indexOf("--model") + 1], "haiku");
  });

  test("POST recap falls back to a canned summary when claude fails", async () => {
    t.scenario("partial_then_crash");
    const body = await (await t.post("/sessions/sess-rec-1/recap", {})).json();
    assert.equal(body.fallback, true);
    assert.match(body.recap, /^Last topic: Remember the number seven\. Latest reply: pong\.$/);
    t.scenario("normal");
  });
});

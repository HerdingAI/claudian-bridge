// Characterization tests: lock in what the bridge does TODAY for the non-chat routes.
// Where today's behavior is a defect, the test carries `// KNOWN BUG — flips in M1/M2`.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startBridge, TOKEN, assertNoLeakedChildren } from "./helpers.mjs";

describe("bridge HTTP API (characterization)", () => {
  let t;
  before(async () => { t = await startBridge(); });
  after(async () => { const inv = t.invocations(); await t.close(); await assertNoLeakedChildren(assert, inv); });

  describe("public routes", () => {
    test("GET /health unauthenticated returns only ok and version", async () => {
      const res = await t.get("/health", {});
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ["ok", "version"]);
      assert.equal(body.ok, true);
    });

    test("GET /health authenticated returns full shape", async () => {
      const res = await t.get("/health");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ["agy", "claude", "ok", "opencode", "stt", "tts", "vault", "version"]);
      assert.equal(body.ok, true);
      assert.equal(body.vault, t.workspacesRoot);
      assert.equal(body.claude, true);
      assert.equal(body.opencode, true);
      assert.equal(body.agy, false); // Antigravity off by default
    });

    test("CORS allows Obsidian/localhost and omits wildcard", async () => {
      const res = await fetch(t.base + "/health", { headers: { Origin: "app://obsidian.md" } });
      assert.equal(res.headers.get("access-control-allow-origin"), "app://obsidian.md");
    });

    test("OPTIONS preflight returns 204 without auth", async () => {
      const res = await fetch(t.base + "/chat", { method: "OPTIONS" });
      assert.equal(res.status, 204);
    });

    test("GET /apk/version requires auth", async () => {
      const res = await t.get("/apk/version", {});
      assert.equal(res.status, 401);
    });
  });

  describe("auth", () => {
    const protectedRoutes = [
      ["GET", "/workspaces"],
      ["POST", "/workspaces"],
      ["GET", "/models"],
      ["GET", "/sessions"],
      ["GET", "/sessions/abc/messages"],
      ["POST", "/sessions/abc/recap"],
      ["POST", "/vault/save"],
      ["POST", "/stt"],
      ["POST", "/tts"],
      ["POST", "/chat"],
      ["GET", "/no-such-route"],
    ];
    for (const [method, route] of protectedRoutes) {
      test(`${method} ${route} without token -> 401`, async () => {
        const res = await fetch(t.base + route, { method, body: method === "POST" ? "{}" : undefined });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: "Unauthorized" });
      });
      test(`${method} ${route} with wrong token -> 401`, async () => {
        const res = await fetch(t.base + route, {
          method,
          headers: { Authorization: "Bearer nope" },
          body: method === "POST" ? "{}" : undefined,
        });
        assert.equal(res.status, 401);
      });
    }

    test("token in query string is NOT accepted", async () => {
      const res = await fetch(`${t.base}/workspaces?token=${TOKEN}`);
      assert.equal(res.status, 401);
    });

    test("unknown route with a valid token -> 404", async () => {
      const res = await t.get("/no-such-route");
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Not found" });
    });
  });

  describe("/workspaces", () => {
    test("GET lists the default workspace plus child directories", async () => {
      const body = await (await t.get("/workspaces")).json();
      assert.equal(body.ok, true);
      assert.equal(body.defaultWorkspace, t.workspacesRoot);
      assert.equal(body.workspaces[0].path, t.workspacesRoot);
      assert.match(body.workspaces[0].name, /\(default\)$/);
      assert.ok(body.workspaces.some((w) => w.name === "proj-a" && w.path === path.join(t.workspacesRoot, "proj-a")));
    });

    test("POST creates a folder and sanitizes the name", async () => {
      const res = await t.post("/workspaces", { name: "  My New Topic!  " });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.workspace.name, "My-New-Topic");
      assert.ok(fs.statSync(body.workspace.path).isDirectory());
      const list = await (await t.get("/workspaces")).json();
      assert.ok(list.workspaces.some((w) => w.name === "My-New-Topic"));
    });

    for (const bad of ["", "..", ".hidden", "///"]) {
      test(`POST rejects invalid name ${JSON.stringify(bad)}`, async () => {
        const res = await t.post("/workspaces", { name: bad });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, "Invalid folder name");
      });
    }

    test("POST with invalid JSON -> 400", async () => {
      const res = await fetch(t.base + "/workspaces", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{" });
      assert.equal(res.status, 400);
    });

    test("dot-directories are hidden from the list", async () => {
      fs.mkdirSync(path.join(t.workspacesRoot, ".secret"), { recursive: true });
      const list = await (await t.get("/workspaces")).json();
      assert.ok(!list.workspaces.some((w) => w.name === ".secret"));
    });
  });

  describe("/models", () => {
    test("claude returns the static 3-model list", async () => {
      const body = await (await t.get("/models")).json();
      assert.equal(body.provider, "claude");
      assert.deepEqual(body.models.map((m) => m.id), ["haiku", "sonnet", "opus"]);
    });

    test("opencode lists models parsed from the CLI plus Default", async () => {
      const body = await (await t.get("/models?provider=opencode")).json();
      assert.deepEqual(body.models.map((m) => m.id), ["", "anthropic/claude-haiku", "openai/gpt-fake"]);
    });

    test("unknown provider silently falls through to the claude list", async () => {
      // KNOWN BUG — flips in M1/M2: an unknown provider should be a 400, not the claude list.
      const body = await (await t.get("/models?provider=bogus")).json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.models.map((m) => m.id), ["haiku", "sonnet", "opus"]);
    });
  });

  describe("/stt and /tts with stubbed workers", () => {
    test("POST /stt (binary wav) returns the worker result and removes the temp wav", async () => {
      const res = await fetch(t.base + "/stt?language=fr", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" },
        body: Buffer.from("RIFFxxxxWAVE"),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.text, "stub transcript");
      assert.equal(body.language, "fr");
      const call = t.bridge.sttWorker.calls.at(-1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fs.existsSync(call.wav), false);
    });

    test("POST /stt (json wavBase64) works", async () => {
      const res = await t.post("/stt", { wavBase64: Buffer.from("RIFFxxxxWAVE").toString("base64"), language: "de" });
      assert.equal((await res.json()).language, "de");
    });

    test("POST /tts returns audio/wav", async () => {
      const res = await t.post("/tts", { text: "hello" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "audio/wav");
      assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), "RIFF");
      const call = t.bridge.ttsWorker.calls.at(-1);
      assert.equal(call.voice, "af_heart");
      assert.equal(call.speed, 1.05);
    });
  });

  describe("/vault/save", () => {
    test("writes a dated markdown note under Voice Notes", async () => {
      const res = await t.post("/vault/save", { title: "Hello World!", content: "body text", workspace: "/x/proj-a", sessionId: "s1" });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.match(body.relativePath, /^Voice Notes\/\d{4}-\d{2}-\d{2} - hello-world-\d{6}\.md$/);
      const md = fs.readFileSync(body.path, "utf8");
      assert.match(md, /source: claudian-call/);
      assert.match(md, /workspace: proj-a/);
      assert.match(md, /session_id: s1/);
      assert.match(md, /# Hello World!/);
    });

    test("empty content -> 400", async () => {
      const res = await t.post("/vault/save", { title: "x", content: "  " });
      assert.equal(res.status, 400);
    });
  });
});

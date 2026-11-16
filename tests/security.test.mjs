import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startBridge, TOKEN } from "./helpers.mjs";

test("M1 Security Hardening", async (t) => {
  const b = await startBridge();
  t.after(() => b.close());

  await t.test("unauthenticated /health returns only ok and version", async () => {
    const res = await fetch(`${b.base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, "string");
    assert.equal("vault" in body, false);
    assert.equal("claude" in body, false);
  });

  await t.test("authenticated /health returns full status", async () => {
    const res = await b.get("/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.vault, "string");
    assert.equal(typeof body.claude, "boolean");
  });

  await t.test("unauthenticated /apk/version and /apk are rejected with 401", async () => {
    const r1 = await fetch(`${b.base}/apk/version`);
    assert.equal(r1.status, 401);
    const r2 = await fetch(`${b.base}/apk`);
    assert.equal(r2.status, 401);
  });

  await t.test("CORS allows only Obsidian/localhost origins and rejects evil origins", async () => {
    const ok = await fetch(`${b.base}/health`, { headers: { Origin: "app://obsidian.md" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "app://obsidian.md");

    const evil = await fetch(`${b.base}/health`, { headers: { Origin: "https://evil.example.com" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);

    const preflightEvil = await fetch(`${b.base}/chat`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(preflightEvil.status, 403);
  });

  await t.test("cwd rejects path traversal, outside absolute paths, and symlink escapes", async () => {
    const outsideDir = fs.mkdtempSync("/tmp/claudian-outside-");
    const linkPath = path.join(b.workspacesRoot, "escape-link");
    fs.symlinkSync(outsideDir, linkPath);
    t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));

    for (const badCwd of [
      "../etc",
      path.join(b.workspacesRoot, ".."),
      outsideDir,
      linkPath,
      path.join(b.workspacesRoot, "does-not-exist"),
    ]) {
      const res = await b.post("/chat", { prompt: "hi", cwd: badCwd });
      assert.equal(res.status, 400, `expected 400 for bad cwd: ${badCwd}`);
    }
  });

  await t.test("per-device tokens: create, authenticate, list, and revoke", async () => {
    const createRes = await b.post("/devices", { name: "pixel-10" });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.ok(created.device?.id);
    assert.ok(created.token);

    const listRes = await b.get("/devices");
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(listBody.devices.some((d) => d.id === created.device.id && !("tokenHash" in d)));

    const devAuth = { Authorization: `Bearer ${created.token}` };
    const wsRes = await b.get("/workspaces", devAuth);
    assert.equal(wsRes.status, 200);

    const delRes = await fetch(`${b.base}/devices/${created.device.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(delRes.status, 200);

    const revokedRes = await b.get("/workspaces", devAuth);
    assert.equal(revokedRes.status, 401);
  });

  await t.test("audit log is written with mode 0600", async () => {
    await b.post("/workspaces", { name: "audit-ws" });
    const auditPath = path.join(b.configDir, "audit.jsonl");
    assert.ok(fs.existsSync(auditPath));
    const mode = fs.statSync(auditPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
    assert.ok(lines.some((l) => l.includes("audit-ws")));
  });
});

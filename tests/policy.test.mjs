import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { evaluatePermissionPolicy } from "../policy-engine.mjs";

test("M3 Policy Engine", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claudian-policy-ws-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));

  await t.test("reads and edits inside workspace are allowed", () => {
    const r = evaluatePermissionPolicy({ tool: "Read", input: { file_path: path.join(ws, "a.txt") }, workspaceDir: ws });
    assert.equal(r.decision, "allow");
    const w = evaluatePermissionPolicy({ tool: "Edit", input: { file_path: path.join(ws, "a.txt") }, workspaceDir: ws });
    assert.equal(w.decision, "allow");
  });

  await t.test("reads outside workspace (prompt-injection ~/.ssh canary) are denied", () => {
    const r = evaluatePermissionPolicy({ tool: "Read", input: { file_path: path.join(os.homedir(), ".ssh/id_rsa") }, workspaceDir: ws });
    assert.equal(r.decision, "deny");
    assert.equal(r.risk, "high");
  });

  await t.test("shell allowlist vs ask vs destructive high-risk", () => {
    const ok = evaluatePermissionPolicy({ tool: "Bash", input: { command: "git status" }, workspaceDir: ws });
    assert.equal(ok.decision, "allow");

    const ask = evaluatePermissionPolicy({ tool: "Bash", input: { command: "npm install" }, workspaceDir: ws });
    assert.equal(ask.decision, "ask");
    assert.equal(ask.risk, "medium");
    assert.match(ask.summary, /npm install/);

    const danger = evaluatePermissionPolicy({ tool: "Bash", input: { command: "rm -rf /tmp/foo" }, workspaceDir: ws });
    assert.equal(danger.decision, "ask");
    assert.equal(danger.risk, "high");
  });

  await t.test("network fetch asks", () => {
    const net = evaluatePermissionPolicy({ tool: "WebFetch", input: { url: "https://example.com" }, workspaceDir: ws });
    assert.equal(net.decision, "ask");
  });
});

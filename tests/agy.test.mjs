import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startBridge, assertNoLeakedChildren } from "./helpers.mjs";

const MSG = "Antigravity is disabled on this computer (set CLAUDIAN_ENABLE_AGY=1)";

describe("Antigravity disabled (default)", () => {
  let t;
  before(async () => { t = await startBridge(); });
  after(async () => { const inv = t.invocations(); await t.close(); await assertNoLeakedChildren(assert, inv); });

  for (const provider of ["agy", "antigravity"]) {
    test(`/models?provider=${provider} reports disabled`, async () => {
      const res = await t.get(`/models?provider=${provider}`);
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.ok, false);
      assert.deepEqual(body.models, []);
      assert.equal(body.error, MSG);
    });

    test(`/chat provider=${provider} returns SSE error and never spawns agy`, async () => {
      const { events, names } = await t.chat({ prompt: "hi", provider });
      assert.deepEqual(names, ["error"]);
      assert.equal(events[0].data.error, MSG);
      assert.equal(t.invocations().filter((i) => i.bin === "agy").length, 0);
    });
  }

  test("/health agy is false when disabled", async () => {
    const body = await (await t.get("/health")).json();
    assert.equal(body.agy, false);
  });

  test("claude and opencode models still work", async () => {
    const body = await (await t.get("/models?provider=claude")).json();
    assert.equal(body.ok, true);
    assert.equal(body.models.length, 3);
  });
});

describe("Antigravity enabled (CLAUDIAN_ENABLE_AGY=1)", () => {
  let t;
  before(async () => { t = await startBridge({ enableAgy: true }); });
  after(async () => { const inv = t.invocations(); await t.close(); await assertNoLeakedChildren(assert, inv); });

  test("/models?provider=agy lists models from the CLI", async () => {
    const body = await (await t.get("/models?provider=agy")).json();
    assert.equal(body.ok, true);
    assert.ok(body.models.some((m) => m.id === "fake-model"));
  });

  test("/chat provider=agy streams text and done", async () => {
    const { names, events } = await t.chat({ prompt: "hi", provider: "agy" });
    assert.ok(names.includes("text"));
    assert.equal(names.at(-1), "done");
    assert.equal(events.at(-1).data.text, "agy says hi");
  });
});

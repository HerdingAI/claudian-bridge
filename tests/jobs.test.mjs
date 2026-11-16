import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startBridge, TOKEN } from "./helpers.mjs";

test("M2 Background Jobs & JobManager", async (t) => {
  const b = await startBridge({ jobHangTimeoutMs: 1200 });
  t.after(() => b.close());

  await t.test("POST /jobs with Idempotency-Key never spawns a second run", async () => {
    b.scenario("normal");
    const key = "idem-key-123";
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${b.base}/jobs`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({ prompt: "hello job", provider: "claude" }),
        }).then((r) => r.json())
      )
    );
    const ids = new Set(responses.map((r) => r.job?.id));
    assert.equal(ids.size, 1);
    const jobId = [...ids][0];
    assert.ok(jobId);

    // Wait for job completion
    let job;
    for (let i = 0; i < 40; i++) {
      const r = await b.get(`/jobs/${jobId}`);
      job = (await r.json()).job;
      if (["succeeded", "failed", "cancelled"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.status, "succeeded");
  });

  await t.test("GET /jobs/:id/events supports Last-Event-ID replay without duplicates", async () => {
    b.scenario("normal");
    const created = await (
      await fetch(`${b.base}/jobs`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "replay-test-1",
        },
        body: JSON.stringify({ prompt: "replay me", provider: "claude" }),
      })
    ).json();
    const jobId = created.job.id;

    // Wait until finished
    for (let i = 0; i < 40; i++) {
      const j = await (await b.get(`/jobs/${jobId}`)).json();
      if (j.job.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const fullSse = await (await b.get(`/jobs/${jobId}/events`)).text();
    const allIds = [...fullSse.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.ok(allIds.length >= 2);
    for (let i = 1; i < allIds.length; i++) {
      assert.ok(allIds[i] > allIds[i - 1], "event IDs must be strictly increasing");
    }

    const replaySse = await (
      await b.get(`/jobs/${jobId}/events`, {
        Authorization: `Bearer ${TOKEN}`,
        "Last-Event-ID": String(allIds[0]),
      })
    ).text();
    const replayIds = [...replaySse.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(replayIds, allIds.slice(1));
  });

  await t.test("honest outcomes: empty output -> failed, crash -> failed, hang -> failed", async () => {
    b.scenario("empty");
    const emptyJob = await (await b.post("/jobs", { prompt: "empty" })).json();
    let j;
    for (let i = 0; i < 40; i++) {
      j = (await (await b.get(`/jobs/${emptyJob.job.id}`)).json()).job;
      if (j.status !== "queued" && j.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(j.status, "failed");
    assert.match(j.error || "", /nothing/i);

    b.scenario("partial_then_crash");
    const crashJob = await (await b.post("/jobs", { prompt: "crash" })).json();
    for (let i = 0; i < 40; i++) {
      j = (await (await b.get(`/jobs/${crashJob.job.id}`)).json()).job;
      if (j.status !== "queued" && j.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(j.status, "failed");

    b.scenario("hang");
    const hangJob = await (await b.post("/jobs", { prompt: "hang" })).json();
    for (let i = 0; i < 40; i++) {
      j = (await (await b.get(`/jobs/${hangJob.job.id}`)).json()).job;
      if (j.status !== "queued" && j.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(j.status, "failed");
    assert.match(j.error || "", /no output/i);
  });

  await t.test("POST /jobs/:id/cancel terminates running job", async () => {
    b.scenario("hang");
    const created = await (await b.post("/jobs", { prompt: "cancel me" })).json();
    const jobId = created.job.id;
    await new Promise((r) => setTimeout(r, 100));
    const cancelRes = await b.post(`/jobs/${jobId}/cancel`, {});
    assert.equal(cancelRes.status, 200);
    const j = (await (await b.get(`/jobs/${jobId}`)).json()).job;
    assert.equal(j.status, "cancelled");
  });

  await t.test("bridge restart marks previously running jobs as interrupted", async () => {
    const jobsDir = path.join(b.configDir, "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const fakeIndexPath = path.join(jobsDir, "index.json");
    const existing = JSON.parse(fs.existsSync(fakeIndexPath) ? fs.readFileSync(fakeIndexPath, "utf8") : "{}");
    existing["restart-orphan-1"] = {
      id: "restart-orphan-1",
      status: "running",
      provider: "claude",
      cwd: b.workspacesRoot,
      prompt: "orphan",
      createdAt: Date.now() - 5000,
      updatedAt: Date.now() - 1000,
      lastEventId: 1,
    };
    fs.writeFileSync(fakeIndexPath, JSON.stringify(existing, null, 2));

    const { JobManager } = await import("../job-manager.mjs");
    const jm = new JobManager({ configDir: b.configDir, spawnJobProcess: () => { throw new Error("unused"); } });
    const recovered = jm.getJob("restart-orphan-1");
    assert.equal(recovered.status, "interrupted");
    assert.match(recovered.error || "", /restarted/i);
  });
});

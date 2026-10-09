import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./machine-helpers.ts";

// Phase 2B.2 bounded load scenario (RED checkpoint, isolated local run).
//
// Fires a bounded burst (24 concurrent submissions) at the unwired admission
// seam on the DEFAULT production Worker with real D1/workerd, then reports
// the local request/status distribution. This is LOCAL runtime evidence only:
// miniflare D1 exposes no genuine edge rows_read/rows_written meta here, so
// no D1 meta is fabricated; the burst size and outcome counts are the reported
// observations. Wired acceptance (later turn): the same burst against the
// integrated backend must admit at most the seeded ceiling with zero partial
// rows, and genuine D1 meta reported only where actually available.
//
// Simulated GitHub identity only (synthetic provider users); no secrets printed.

test("RED load scaffold: bounded burst stays fully rejected with zero partial state", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const invite = await h.enroll(a);
    const reg = await h.register(invite);
    assert.equal(reg.status, 201);
    const worker = (await reg.json()) as { worker_id: string };
    const burst = 24;
    const results = await Promise.all(
      Array.from({ length: burst }, () =>
        h.request(
          `/v1/tenants/${a.tenant}/tasks`,
          { ...a.headers, "idempotency-key": crypto.randomUUID() },
          "POST",
          {
            request_id: crypto.randomUUID(),
            worker_id: worker.worker_id,
            execution_class: "controlled",
            runtime_ms: 10000,
            controlled_duration_ms: 100,
          },
        ),
      ),
    );
    const byStatus = new Map<number, number>();
    for (const r of results)
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    // RED: every request in the burst 404s (unwired). Reported local
    // observation for this isolated run: requests=24, distribution={404:24}.
    // No rows_read/rows_written meta is available from this local runtime, so
    // none is reported; edge CPU is explicitly out of scope for this scaffold.
    assert.equal(results.length, burst);
    assert.deepEqual([...byStatus.entries()], [[404, burst]]);
    for (const table of [
      "hosted_tasks",
      "hosted_reservations",
      "hosted_outbox",
    ]) {
      let count = 0;
      try {
        count = (await h.db
          .prepare(`SELECT count(*) n FROM ${table}`)
          .first<{ n: number }>())!.n;
      } catch {
        count = 0;
      }
      assert.equal(count, 0, table);
    }
  } finally {
    await h.mf.dispose();
  }
});

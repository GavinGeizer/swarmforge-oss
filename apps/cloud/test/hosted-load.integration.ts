import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fixture } from "./machine-helpers.ts";

// Phase 2B.2 bounded load scenario — CORRECTED RED checkpoint.
//
// The prior turn asserted a 404 distribution and swallowed missing-table SQL
// errors with `catch => 0` (rejected approach, preserved as
// test-report-rejected-7300825.md). This file asserts DESIRED behavior: a
// bounded burst of 6 distinct submissions against a two-task ceiling (three
// workers) must admit EXACTLY two with 202 and deny the other four with real
// quota 409, with zero partial writes. Row counts come from REAL count
// queries; a missing table FAILS the test instead of reporting zero.
// No D1 rows_read/rows_written meta is fabricated: this local runtime exposes
// none, so none is reported; edge CPU is explicitly out of scope.
// Pure-concurrency load seeds NO allowance rows — the meter/allowance mapping
// contract is still undefined, so only the technical entitlement ceiling
// governs until the backend defines it.
//
// Simulated GitHub identity only (synthetic provider users); no secrets printed.

test("bounded burst admits exactly the ceiling with quota 409s and no partial writes", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    // Setup compatibility: shared fixture here applies phase2b1 only, so
    // apply migration 0003 explicitly (assertions unchanged).
    for (const stmt of (
      await readFile(
        new URL("../migrations/0003_hosted_execution.sql", import.meta.url),
        "utf8",
      )
    )
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      await h.db.prepare(stmt).run();
    const now = Date.now();
    await h.db
      .prepare(
        "INSERT INTO hosted_entitlements(entitlement_id,organization_id,version,hosted_control_plane,remote_worker_enrollment,hosted_task_execution,max_concurrent_workers,max_active_tasks,max_task_runtime,valid_from,valid_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        a.tenant,
        1,
        1,
        1,
        1,
        3,
        2,
        60000,
        now - 1000,
        now + 3600000,
        now,
      )
      .run();
    const workers: string[] = [];
    for (let n = 0; n < 3; n++) {
      const invite = await h.enroll(a);
      const reg = await h.register(invite);
      assert.equal(reg.status, 201);
      workers.push(((await reg.json()) as { worker_id: string }).worker_id);
    }
    const burst = workers.flatMap((worker_id) =>
      Array.from({ length: 2 }, () => ({
        request_id: crypto.randomUUID(),
        worker_id,
        execution_class: "controlled",
        runtime_ms: 10000,
        controlled_duration_ms: 100,
      })),
    );
    const results = await Promise.all(
      burst.map((body) =>
        h.request(
          `/v1/tenants/${a.tenant}/tasks`,
          { ...a.headers, "idempotency-key": crypto.randomUUID() },
          "POST",
          body,
        ),
      ),
    );
    // DESIRED: exactly two 202 winners and four 409 denials. TODAY: six 404s.
    const winners = results.filter((r) => r.status === 202).length;
    const denied = results.filter((r) => r.status === 409).length;
    assert.equal(results.length, 6);
    assert.equal(winners, 2);
    assert.equal(denied, 4);
    // REAL counts: missing tables fail here, never report zero.
    const tasks = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks")
      .first<{ n: number }>())!.n;
    const reservations = (await h.db
      .prepare("SELECT count(*) n FROM hosted_reservations")
      .first<{ n: number }>())!.n;
    const outbox = (await h.db
      .prepare("SELECT count(*) n FROM hosted_outbox")
      .first<{ n: number }>())!.n;
    assert.equal(tasks, 2);
    assert.equal(reservations, 2);
    assert.equal(outbox, 2);
  } finally {
    await h.mf.dispose();
  }
});

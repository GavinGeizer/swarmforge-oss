/// <reference types="bun" />
import assert from "node:assert/strict";
import { localFixture } from "../test/local-fixture.ts";

// Synthetic identity + actual Worker handlers/SQL + SQLite + in-process requests.
// Supervisor reports are simulated: no runtime, live D1, HTTP or edge CPU claim.
const h = await localFixture();
const samples: { operation: string; statements: number; elapsed_ms: number }[] =
  [];
async function measured<T>(operation: string, action: () => Promise<T>) {
  const before = h.db.queryCalls;
  const start = performance.now();
  const result = await action();
  samples.push({
    operation,
    statements: h.db.queryCalls - before,
    elapsed_ms: performance.now() - start,
  });
  return result;
}
try {
  const a = await h.login();
  const w = await h.enrolledWorker(a);
  await h.seedPolicy(a.tenant, {
    capabilities: {
      hosted_control_plane: true,
      remote_worker_enrollment: true,
      hosted_task_execution: true,
    },
    max_concurrent_workers: 1,
    max_active_tasks: 1,
    max_task_runtime: 1000,
    maximum_resource_reservations: 1,
    valid_for_ms: 3600000,
    allowances: [
      {
        resource: "compute_ms",
        unit: "millisecond",
        resource_class: "controlled",
        allowed_quantity: "100000",
      },
    ],
  });
  const s = await h.registerSupervisor(a, w.worker_id);
  const supervisorHeaders = { authorization: `Bearer ${s.credential}` };
  const mutate = (
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ) =>
    h.request(
      path,
      { ...headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      body,
    );
  const baselinePageCount = h.db.sqlite.query("PRAGMA page_count").get();
  for (let i = 0; i < 10; i++) {
    const response = await measured("admission", () =>
      mutate(`/v1/tenants/${a.tenant}/tasks`, a.headers, {
        request_id: crypto.randomUUID(),
        worker_id: w.worker_id,
        execution_class: "controlled",
        runtime_ms: 1000,
        controlled_duration_ms: 1,
      }),
    );
    assert.equal(response.status, 202);
    const { task } = (await response.json()) as { task: { task_id: string } };
    const claimed = await measured("claim", () =>
      mutate("/v1/supervisor/claim", supervisorHeaders, {}),
    );
    assert.equal(claimed.status, 200);
    const claim = (await claimed.json()) as {
      task: { task_id: string; lease_id: string; fence: number };
    };
    assert.equal(claim.task.task_id, task.task_id);
    const authority = {
      lease_id: claim.task.lease_id,
      fence: claim.task.fence,
    };
    for (const operation of ["ack", "renew"])
      assert.equal(
        (
          await measured(operation, () =>
            mutate(
              `/v1/supervisor/tasks/${task.task_id}/${operation}`,
              supervisorHeaders,
              authority,
            ),
          )
        ).status,
        200,
      );
    assert.equal(
      (
        await measured("settle", () =>
          mutate(
            `/v1/supervisor/tasks/${task.task_id}/settle`,
            supervisorHeaders,
            {
              ...authority,
              outcome: "completed",
              stop_confirmed: true,
              consumed_runtime_ms: 1,
            },
          ),
        )
      ).status,
      200,
    );
  }
  await measured("scheduled_cleanup", () => h.scheduled());
  assert.deepEqual(
    h.db.sqlite
      .query(
        "SELECT reserved_quantity,consumed_quantity FROM hosted_allowances",
      )
      .get(),
    { reserved_quantity: "0", consumed_quantity: "10" },
  );
  const operations = [...new Set(samples.map((s) => s.operation))].map(
    (operation) => {
      const rows = samples.filter((s) => s.operation === operation);
      return {
        operation,
        samples: rows.length,
        min_statements: Math.min(...rows.map((s) => s.statements)),
        max_statements: Math.max(...rows.map((s) => s.statements)),
        total_local_elapsed_ms: rows.reduce((n, s) => n + s.elapsed_ms, 0),
      };
    },
  );
  console.log(
    JSON.stringify(
      {
        methodology:
          "SQLite production-handler sample, simulated supervisor; not D1 rows or edge CPU",
        logical_tasks: 10,
        baseline_page_count: baselinePageCount,
        task_http_requests: 50,
        operations,
        database_page_count: h.db.sqlite.query("PRAGMA page_count").get(),
        database_page_size: h.db.sqlite.query("PRAGMA page_size").get(),
      },
      null,
      2,
    ),
  );
} finally {
  h.close();
}

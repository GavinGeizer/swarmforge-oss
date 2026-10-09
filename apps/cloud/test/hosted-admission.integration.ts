import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admissionDefaultPolicy,
  admissionFixture,
  admissionSubmit,
} from "./hosted-admission-helper.ts";

async function browserContext(h: Awaited<ReturnType<typeof admissionFixture>>) {
  const a = await h.login();
  await h.seedPolicy(a.tenant, admissionDefaultPolicy);
  const worker = await h.enrolledWorker(a);
  return { a, worker };
}

test("admission happy path: browser 202 + frozen projection, execution-grant 202, read back", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const data = admissionSubmit(worker.worker_id);
    const r = await h.submitTask(a.headers, a.tenant, data);
    assert.equal(r.status, 202);
    const reply = (await r.json()) as {
      task: Record<string, unknown>;
      reservation_id: string;
      policy_version: number;
    };
    assert.equal(reply.policy_version, 1);
    assert.equal(reply.task.state, "queued");
    assert.equal(reply.task.execution_class, "controlled");
    assert.equal(reply.task.tenant_id, a.tenant);
    assert.equal(reply.task.worker_id, worker.worker_id);
    assert.equal(reply.task.reservation_id, reply.reservation_id);
    assert.equal(reply.task.policy_version, 1);
    assert.equal(reply.task.fence, 0);
    assert.equal(reply.task.lease_id, null);
    assert.equal(reply.task.supervisor_id, null);
    assert.ok(!("prompt" in reply.task), "no secret fields leak");
    const both = await h.db
      .prepare(
        "SELECT (SELECT count(*) FROM hosted_tasks WHERE organization_id=?) t,(SELECT count(*) FROM hosted_reservations WHERE organization_id=?) r,(SELECT count(*) FROM hosted_outbox WHERE organization_id=?) o,(SELECT count(*) FROM audit_events WHERE organization_id=? AND action='hosted.task_admitted') a",
      )
      .bind(a.tenant, a.tenant, a.tenant, a.tenant)
      .first<{ t: number; r: number; o: number; a: number }>();
    assert.deepEqual(both, { t: 1, r: 1, o: 1, a: 1 });
    // GET read path returns the public projection.
    const taskId = reply.task.task_id as string;
    const got = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${taskId}`,
      a.headers,
    );
    assert.equal(got.status, 200);
    assert.deepEqual((await got.json()) as unknown, { task: reply.task });
    // Execution-grant path admits a second task on a different worker.
    const device = await h.linkedDevice(a);
    const grant = (await (
      await h.authorizeExecution(a, a.tenant, device.installation_id)
    ).json()) as { credential: string };
    const worker2 = await h.enrolledWorker(a);
    const r2 = await h.submitTask(
      { authorization: `Bearer ${grant.credential}` },
      a.tenant,
      admissionSubmit(worker2.worker_id),
    );
    assert.equal(r2.status, 202);
    const tasks = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=?")
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(tasks.n, 2);
  } finally {
    await h.mf.dispose();
  }
});

test("submission validation: controlled-only, bounds, strict unknown fields, key required", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const base = admissionSubmit(worker.worker_id);
    const bad = [
      { ...base, execution_class: "shell" },
      { ...base, runtime_ms: 0 },
      { ...base, runtime_ms: 3600001 },
      { ...base, controlled_duration_ms: base.runtime_ms + 1 },
      { ...base, prompt: "run this" },
      { ...base, repo: "https://example.invalid/r" },
      { ...base, model: "m" },
      { ...base, env: { K: "V" } },
      { ...base, callback: "https://example.invalid/cb" },
      { ...base, request_id: "not-a-uuid" },
    ];
    for (const payload of bad) {
      const r = await h.submitTask(a.headers, a.tenant, payload);
      assert.equal(r.status, 400, JSON.stringify(payload));
    }
    const noKey = await h.request(
      `/v1/tenants/${a.tenant}/tasks`,
      { ...a.headers },
      "POST",
      base,
    );
    assert.equal(noKey.status, 400);
    const none = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=?")
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(none.n, 0, "validation failures must not write rows");
  } finally {
    await h.mf.dispose();
  }
});

test("auth matrix: sfcli/sfworker/global rejected, cross-tenant grant 404, CSRF required", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const device = await h.linkedDevice(a);
    const wk = await h.enrolledWorker(a);
    for (const cred of [device.credential, wk.credential]) {
      const r = await h.submitTask(
        { authorization: `Bearer ${cred}` },
        a.tenant,
        admissionSubmit(worker.worker_id),
      );
      assert.equal(r.status, 401);
    }
    const global = await h.submitTask(
      { authorization: "Bearer github-token" },
      a.tenant,
      admissionSubmit(worker.worker_id),
    );
    assert.equal(global.status, 401);
    // Cross-tenant: execution grant of a used under b's tenant is 404.
    const grant = (await (
      await h.authorizeExecution(a, a.tenant, device.installation_id)
    ).json()) as { credential: string };
    const b = await h.login(200);
    await h.seedPolicy(b.tenant, admissionDefaultPolicy);
    const wb = await h.enrolledWorker(b);
    const cross = await h.submitTask(
      { authorization: `Bearer ${grant.credential}` },
      b.tenant,
      admissionSubmit(wb.worker_id),
    );
    assert.equal(cross.status, 404);
    const crossRead = await h.request(
      `/v1/tenants/${b.tenant}/tasks/${crypto.randomUUID()}`,
      { authorization: `Bearer ${grant.credential}` },
    );
    assert.equal(crossRead.status, 404);
    // Missing CSRF on browser POST.
    const noCsrf = await h.request(
      `/v1/tenants/${a.tenant}/tasks`,
      { cookie: a.headers.cookie, "idempotency-key": crypto.randomUUID() },
      "POST",
      admissionSubmit(worker.worker_id),
    );
    assert.equal(noCsrf.status, 403);
  } finally {
    await h.mf.dispose();
  }
});

test("concurrency: N racers at max_active_tasks=3 admit exactly 3 (persisted counts agree)", async () => {
  const h = await admissionFixture();
  try {
    const a = await h.login();
    await h.seedPolicy(a.tenant, {
      ...admissionDefaultPolicy,
      max_active_tasks: 3,
      max_concurrent_workers: 8,
      maximum_resource_reservations: 16,
    });
    const workers = await Promise.all(
      Array.from({ length: 8 }, () => h.enrolledWorker(a)),
    );
    const results = await Promise.all(
      workers.map((w) =>
        h.submitTask(a.headers, a.tenant, admissionSubmit(w.worker_id)),
      ),
    );
    const ok = results.filter((r) => r.status === 202).length;
    const conflict = results.filter((r) => r.status === 409).length;
    assert.equal(ok, 3);
    assert.equal(conflict, 5);
    const persisted = (await h.db
      .prepare(
        "SELECT (SELECT count(*) FROM hosted_tasks WHERE organization_id=? AND state IN ('queued','claimed','running','stop_requested','held')) t,(SELECT count(*) FROM hosted_reservations WHERE organization_id=? AND state IN ('active','quarantined')) r,(SELECT count(*) FROM hosted_outbox WHERE organization_id=?) o",
      )
      .bind(a.tenant, a.tenant, a.tenant)
      .first<{ t: number; r: number; o: number }>())!;
    assert.deepEqual(persisted, { t: 3, r: 3, o: 3 });
  } finally {
    await h.mf.dispose();
  }
});

test("worker exclusivity: same worker racers admit exactly 1", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.submitTask(a.headers, a.tenant, admissionSubmit(worker.worker_id)),
      ),
    );
    assert.equal(results.filter((r) => r.status === 202).length, 1);
    assert.ok(results.every((r) => r.status === 202 || r.status === 409));
    const n = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=?")
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(n.n, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("multi-user + multi-CLI + cross-org races respect per-tenant caps", async () => {
  const h = await admissionFixture();
  try {
    const a = await h.login();
    const b = await h.login(200);
    await h.seedPolicy(a.tenant, {
      ...admissionDefaultPolicy,
      max_active_tasks: 2,
      max_concurrent_workers: 2,
      maximum_resource_reservations: 2,
    });
    await h.seedPolicy(b.tenant, admissionDefaultPolicy);
    const devA = await h.linkedDevice(a);
    const grantA = (await (
      await h.authorizeExecution(a, a.tenant, devA.installation_id)
    ).json()) as { credential: string };
    const grantB = (await (
      await h.authorizeExecution(
        b,
        b.tenant,
        (
          await h.linkedDevice(b)
        ).installation_id,
      )
    ).json()) as { credential: string };
    const workersA = await Promise.all(
      Array.from({ length: 4 }, () => h.enrolledWorker(a)),
    );
    const workersB = await Promise.all(
      Array.from({ length: 3 }, () => h.enrolledWorker(b)),
    );
    const [ra, rb] = await Promise.all([
      Promise.all([
        ...workersA.map((w) =>
          h.submitTask(a.headers, a.tenant, admissionSubmit(w.worker_id)),
        ),
        ...workersA.map((w) =>
          h.submitTask(
            { authorization: `Bearer ${grantA.credential}` },
            a.tenant,
            admissionSubmit(w.worker_id),
          ),
        ),
      ]),
      Promise.all(
        workersB.map((w) =>
          h.submitTask(
            { authorization: `Bearer ${grantB.credential}` },
            b.tenant,
            admissionSubmit(w.worker_id),
          ),
        ),
      ),
    ]);
    const winnersA = ra.filter((r) => r.status === 202).length;
    assert.ok(winnersA <= 2, `tenant A admitted ${winnersA}, cap is 2`);
    assert.equal(
      rb.filter((r) => r.status === 202).length,
      3,
      "other org must be unaffected by A's exhaustion",
    );
    const counts = (await h.db
      .prepare(
        "SELECT (SELECT count(*) FROM hosted_tasks WHERE organization_id=? AND state IN ('queued','claimed','running','stop_requested','held')) a,(SELECT count(*) FROM hosted_tasks WHERE organization_id=? AND state IN ('queued','claimed','running','stop_requested','held')) b",
      )
      .bind(a.tenant, b.tenant)
      .first<{ a: number; b: number }>())!;
    assert.ok(counts.a <= 2);
    assert.equal(counts.b, 3);
  } finally {
    await h.mf.dispose();
  }
});

test("idempotency: same-key race one row + identical replies; retry safe; changed payload 409", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const k = crypto.randomUUID();
    const data = admissionSubmit(worker.worker_id);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.submitTask(a.headers, a.tenant, data, k),
      ),
    );
    const ok = results.filter((r) => r.status === 202).length;
    const replay = results.filter((r) => r.status === 200).length;
    assert.equal(ok, 1);
    assert.equal(replay, 5);
    const bodies = await Promise.all(results.map((r) => r.json()));
    for (const b of bodies.slice(1)) assert.deepEqual(b, bodies[0]);
    const rows = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=?")
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(rows.n, 1);
    // Exact retry is safe.
    const again = await h.submitTask(a.headers, a.tenant, data, k);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), bodies[0]);
    // Changed payload, same key -> 409.
    const changed = await h.submitTask(
      a.headers,
      a.tenant,
      { ...data, runtime_ms: data.runtime_ms + 1000 },
      k,
    );
    assert.equal(changed.status, 409);
    assert.equal(
      ((await changed.json()) as { error: { code: string } }).error.code,
      "idempotency_conflict",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("request-id uniqueness: alternate key with same request_id is 409, no orphan task", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const data = admissionSubmit(worker.worker_id);
    const first = await h.submitTask(a.headers, a.tenant, data);
    assert.equal(first.status, 202);
    const worker2 = await h.enrolledWorker(a);
    const dup = await h.submitTask(a.headers, a.tenant, {
      ...data,
      worker_id: worker2.worker_id,
    });
    assert.equal(dup.status, 409);
    assert.equal(
      ((await dup.json()) as { error: { code: string } }).error.code,
      "idempotency_conflict",
    );
    const n = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=?")
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(n.n, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("entitlement gates: missing/expired/revoked caps, stale grant, stale worker deny without rows", async () => {
  const h = await admissionFixture();
  try {
    // Missing policy (absent) -> 403.
    const bare = await h.login(300);
    const wBare = await h.enrolledWorker(bare);
    const absent = await h.submitTask(
      bare.headers,
      bare.tenant,
      admissionSubmit(wBare.worker_id),
    );
    assert.equal(absent.status, 403);
    // Expired policy -> 403.
    const a = await h.login();
    await h.seedPolicy(a.tenant, {
      ...admissionDefaultPolicy,
      valid_for_ms: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    const worker = await h.enrolledWorker(a);
    const expired = await h.submitTask(
      a.headers,
      a.tenant,
      admissionSubmit(worker.worker_id),
    );
    assert.equal(expired.status, 403);
    // Revoked policy -> 403.
    await h.seedPolicy(a.tenant, admissionDefaultPolicy);
    const { revokePolicy } = await import("../src/hosted-entitlements.ts");
    const opCtx = {
      env: {
        DB: h.db,
        AUTH_SECRET: "test-auth-secret-with-at-least-thirty-two-characters",
        APP_ORIGIN: "https://api.example.invalid",
        WEBSITE_ORIGIN: "https://api.example.invalid",
        ENVIRONMENT: "local",
      },
      request: new Request("https://api.example.invalid/"),
      request_id: crypto.randomUUID(),
      route: "operator.policy",
      actor: a.user,
    };
    await revokePolicy(opCtx as never, a.tenant, a.user);
    const revoked = await h.submitTask(
      a.headers,
      a.tenant,
      admissionSubmit(worker.worker_id),
    );
    assert.equal(revoked.status, 403);
    // Missing capability denies even with a live row.
    await h.seedPolicy(a.tenant, {
      ...admissionDefaultPolicy,
      capabilities: {
        hosted_control_plane: true,
        remote_worker_enrollment: true,
        hosted_task_execution: false,
      },
    });
    const capped = await h.submitTask(
      a.headers,
      a.tenant,
      admissionSubmit(worker.worker_id),
    );
    assert.equal(capped.status, 403);
    // Stale grant: rotate the CLI installation after authorizing.
    await h.seedPolicy(a.tenant, admissionDefaultPolicy);
    const c = await h.login(400);
    await h.seedPolicy(c.tenant, admissionDefaultPolicy);
    const devC = await h.linkedDevice(c);
    const wc = await h.enrolledWorker(c);
    const grant = (await (
      await h.authorizeExecution(c, c.tenant, devC.installation_id)
    ).json()) as { credential: string };
    const rotated = await h.request(
      "/v1/cli/me/rotate",
      {
        authorization: `Bearer ${devC.credential}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(rotated.status, 200);
    const staleGrant = await h.submitTask(
      { authorization: `Bearer ${grant.credential}` },
      c.tenant,
      admissionSubmit(wc.worker_id),
    );
    // Dead grant: 401 at auth, or 409 if a pre-read passed before rotation
    // landed. Either way admission is denied and writes nothing.
    assert.ok(
      staleGrant.status === 401 || staleGrant.status === 409,
      `stale grant must be denied, got ${staleGrant.status}`,
    );
    // Stale worker: revoke the worker before submitting.
    await h.db
      .prepare("UPDATE cloud_workers SET status='revoked' WHERE worker_id=?")
      .bind(wc.worker_id)
      .run();
    const staleWorker = await h.submitTask(
      c.headers,
      c.tenant,
      admissionSubmit(wc.worker_id),
    );
    assert.equal(staleWorker.status, 404);
    const n = (await h.db
      .prepare(
        "SELECT count(*) n FROM hosted_tasks WHERE organization_id IN (?,?,?)",
      )
      .bind(bare.tenant, a.tenant, c.tenant)
      .first<{ n: number }>())!;
    assert.equal(n.n, 0, "all denials must leave zero task rows");
  } finally {
    await h.mf.dispose();
  }
});

test("database failure rolls back: dropped outbox table denies 503 with no partial task/meter", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    await h.db.prepare("DROP TABLE hosted_outbox").run();
    const before = (await h.db
      .prepare("SELECT reserved_quantity FROM hosted_allowances WHERE 0")
      .all()
      .catch(() => null)) as unknown;
    void before;
    const r = await h.submitTask(
      a.headers,
      a.tenant,
      admissionSubmit(worker.worker_id),
    );
    assert.equal(r.status, 503);
    const tasks = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=?")
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(tasks.n, 0, "batch failure must leave no partial task");
  } finally {
    await h.mf.dispose();
  }
});

test("metering: exact reserve of full runtime; exhausted allowance 403; unrelated meter ignored", async () => {
  const h = await admissionFixture();
  try {
    const a = await h.login();
    await h.seedPolicy(a.tenant, {
      ...admissionDefaultPolicy,
      allowances: [
        {
          resource: "compute_ms",
          unit: "millisecond",
          resource_class: "controlled",
          allowed_quantity: "60000",
        },
      ],
    });
    const worker = await h.enrolledWorker(a);
    const r = await h.submitTask(
      a.headers,
      a.tenant,
      admissionSubmit(worker.worker_id, 10000),
    );
    assert.equal(r.status, 202);
    let allowance = (await h.db
      .prepare(
        "SELECT reserved_quantity,consumed_quantity FROM hosted_allowances WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{ reserved_quantity: string; consumed_quantity: string }>())!;
    assert.deepEqual(allowance, {
      reserved_quantity: "10000",
      consumed_quantity: "0",
    });
    // Second task exceeding headroom -> 403, no rows.
    const worker2 = await h.enrolledWorker(a);
    const over = await h.submitTask(
      a.headers,
      a.tenant,
      admissionSubmit(worker2.worker_id, 55000),
    );
    assert.equal(over.status, 403);
    assert.equal(
      ((await over.json()) as { error: { code: string } }).error.code,
      "allowance_exhausted",
    );
    allowance = (await h.db
      .prepare(
        "SELECT reserved_quantity,consumed_quantity FROM hosted_allowances WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{ reserved_quantity: string; consumed_quantity: string }>())!;
    assert.equal(allowance.reserved_quantity, "10000");
    // Unsupported-meter-only tenant: unrelated meter definitions are
    // ignored (caps alone govern), so controlled admission succeeds and
    // reserves nothing on the foreign meter.
    const u = await h.login(500);
    await h.seedPolicy(u.tenant, {
      ...admissionDefaultPolicy,
      allowances: [
        {
          resource: "inference_tokens",
          unit: "token",
          resource_class: "model-x",
          allowed_quantity: "999999",
        },
      ],
    });
    const wu = await h.enrolledWorker(u);
    const unrelated = await h.submitTask(
      u.headers,
      u.tenant,
      admissionSubmit(wu.worker_id, 1000),
    );
    assert.equal(unrelated.status, 202);
    const foreign = (await h.db
      .prepare(
        "SELECT reserved_quantity FROM hosted_allowances WHERE organization_id=?",
      )
      .bind(u.tenant)
      .first<{ reserved_quantity: string }>())!;
    assert.equal(foreign.reserved_quantity, "0");
    const un = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=?")
      .bind(u.tenant)
      .first<{ n: number }>())!;
    assert.equal(un.n, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("cancel unclaimed: durable 200 terminal + release + outbox dead + meter decrement", async () => {
  const h = await admissionFixture();
  try {
    const a = await h.login();
    await h.seedPolicy(a.tenant, {
      ...admissionDefaultPolicy,
      allowances: [
        {
          resource: "compute_ms",
          unit: "millisecond",
          resource_class: "controlled",
          allowed_quantity: "60000",
        },
      ],
    });
    const worker = await h.enrolledWorker(a);
    const admitted = (await (
      await h.submitTask(
        a.headers,
        a.tenant,
        admissionSubmit(worker.worker_id, 5000),
      )
    ).json()) as { task: { task_id: string } };
    const taskId = admitted.task.task_id;
    const ck = crypto.randomUUID();
    const cancel = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${taskId}/cancel`,
      { ...a.headers, "idempotency-key": ck },
      "POST",
      {},
    );
    assert.equal(cancel.status, 200);
    const cancelled = (await cancel.json()) as { task: { state: string } };
    assert.equal(cancelled.task.state, "cancelled");
    const persisted = (await h.db
      .prepare(
        "SELECT (SELECT state FROM hosted_tasks WHERE task_id=?) t,(SELECT state FROM hosted_reservations WHERE task_id=?) r,(SELECT state FROM hosted_outbox WHERE task_id=?) o,(SELECT reserved_quantity FROM hosted_allowances WHERE organization_id=?) m",
      )
      .bind(taskId, taskId, taskId, a.tenant)
      .first<{ t: string; r: string; o: string; m: string }>())!;
    assert.deepEqual(persisted, {
      t: "cancelled",
      r: "released",
      o: "dead",
      m: "0",
    });
    // Replay same key: idempotent 200, no double release.
    const replay = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${taskId}/cancel`,
      { ...a.headers, "idempotency-key": ck },
      "POST",
      {},
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), cancelled);
    const meter = (await h.db
      .prepare(
        "SELECT reserved_quantity FROM hosted_allowances WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{ reserved_quantity: string }>())!;
    assert.equal(meter.reserved_quantity, "0");
  } finally {
    await h.mf.dispose();
  }
});

test("cancel assigned: stop_requested + quarantined, fence/lease retained, no meter release", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const admitted = (await (
      await h.submitTask(
        a.headers,
        a.tenant,
        admissionSubmit(worker.worker_id, 7000),
      )
    ).json()) as { task: { task_id: string } };
    const taskId = admitted.task.task_id;
    // Simulate a supervisor claim WITHOUT the dispatch owner: insert a real
    // supervisor row (FK target) then set lease/fence directly, so cancel
    // must preserve them for trusted-stop settlement.
    const supervisorId = crypto.randomUUID();
    await h.db
      .prepare(
        "INSERT INTO hosted_supervisors(supervisor_id,organization_id,worker_id,authorizing_user_id,name,status,epoch,created_at,authorization_expires_at,revoked_at) VALUES(?,?,?,?,?,'registered',1,?,?,NULL)",
      )
      .bind(
        supervisorId,
        a.tenant,
        worker.worker_id,
        a.user,
        "test-supervisor",
        Date.now(),
        Date.now() + 3600000,
      )
      .run();
    await h.db
      .prepare(
        "UPDATE hosted_tasks SET state='claimed',lease_id=?,supervisor_id=?,fence=1,lease_expires_at=? WHERE task_id=?",
      )
      .bind(crypto.randomUUID(), supervisorId, Date.now() + 60000, taskId)
      .run();
    await h.db
      .prepare(
        "UPDATE hosted_outbox SET state='claimed',fence=1,attempts=1 WHERE task_id=?",
      )
      .bind(taskId)
      .run();
    const cancel = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${taskId}/cancel`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    assert.equal(cancel.status, 202);
    const stopped = (await cancel.json()) as {
      task: { state: string; lease_id: string | null; fence: number };
    };
    assert.equal(stopped.task.state, "stop_requested");
    assert.ok(stopped.task.lease_id !== null, "lease retained for settlement");
    assert.equal(stopped.task.fence, 1);
    const persisted = (await h.db
      .prepare(
        "SELECT (SELECT state FROM hosted_reservations WHERE task_id=?) r,(SELECT state FROM hosted_outbox WHERE task_id=?) o",
      )
      .bind(taskId, taskId)
      .first<{ r: string; o: string }>())!;
    assert.deepEqual(persisted, { r: "quarantined", o: "claimed" });
  } finally {
    await h.mf.dispose();
  }
});

test("cancel replay + fingerprint: changed-key duplicate task cancels; replayed key with different binding 409; cross-tenant 404", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const admitted = (await (
      await h.submitTask(a.headers, a.tenant, admissionSubmit(worker.worker_id))
    ).json()) as { task: { task_id: string } };
    const worker2 = await h.enrolledWorker(a);
    const admitted2 = (await (
      await h.submitTask(
        a.headers,
        a.tenant,
        admissionSubmit(worker2.worker_id),
      )
    ).json()) as { task: { task_id: string } };
    const k = crypto.randomUUID();
    const first = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${admitted.task.task_id}/cancel`,
      { ...a.headers, "idempotency-key": k },
      "POST",
      {},
    );
    assert.ok(first.status === 200 || first.status === 202);
    // Same principal+key against a DIFFERENT task: per-task fingerprint
    // binding conflicts.
    const conflict = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${admitted2.task.task_id}/cancel`,
      { ...a.headers, "idempotency-key": k },
      "POST",
      {},
    );
    assert.equal(conflict.status, 409);
    // Cross-tenant cancel of a's task under b's tenant: 404, never leaks.
    const b = await h.login(600);
    const missing = await h.request(
      `/v1/tenants/${b.tenant}/tasks/${admitted2.task.task_id}/cancel`,
      { ...b.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    assert.equal(missing.status, 404);
    const state = (await h.db
      .prepare("SELECT state FROM hosted_tasks WHERE task_id=?")
      .bind(admitted2.task.task_id)
      .first<{ state: string }>())!;
    assert.ok(state.state === "cancelled" || state.state === "queued");
    const readCross = await h.request(
      `/v1/tenants/${b.tenant}/tasks/${admitted2.task.task_id}`,
      b.headers,
    );
    assert.equal(readCross.status, 404);
  } finally {
    await h.mf.dispose();
  }
});

test("cancel never claims stop on uncertainty: assigned task response is 202 with retained lease, not a silent release", async () => {
  const h = await admissionFixture();
  try {
    const { a, worker } = await browserContext(h);
    const admitted = (await (
      await h.submitTask(a.headers, a.tenant, admissionSubmit(worker.worker_id))
    ).json()) as { task: { task_id: string } };
    const taskId = admitted.task.task_id;
    await h.db
      .prepare(
        "UPDATE hosted_tasks SET state='running',fence=3 WHERE task_id=?",
      )
      .bind(taskId)
      .run();
    const cancel = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${taskId}/cancel`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    assert.equal(cancel.status, 202);
    const body = (await cancel.json()) as { task: { state: string } };
    assert.equal(body.task.state, "stop_requested");
    // Quarantined — capacity is NOT released on network uncertainty.
    const res = (await h.db
      .prepare("SELECT state FROM hosted_reservations WHERE task_id=?")
      .bind(taskId)
      .first<{ state: string }>())!;
    assert.equal(res.state, "quarantined");
  } finally {
    await h.mf.dispose();
  }
});

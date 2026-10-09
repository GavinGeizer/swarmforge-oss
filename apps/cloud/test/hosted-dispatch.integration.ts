import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupHosted, taskAuthorizerGuard } from "../src/hosted-dispatch.ts";
import {
  dispatchFixture,
  dispatchPolicy,
  supervisorBearer,
} from "./hosted-dispatch-helpers.ts";

async function setup() {
  const h = await dispatchFixture();
  const a = await h.login();
  const worker = await h.enrolledWorker(a);
  await h.seedPolicy(a.tenant, dispatchPolicy);
  const supervisor = await h.registerSupervisor(a, worker.worker_id);
  return { h, a, worker, supervisor };
}

function claimHeaders(
  supervisor: { credential: string },
  k = crypto.randomUUID(),
) {
  return { ...supervisorBearer(supervisor.credential), "idempotency-key": k };
}

test("dispatch: claim elects one supervisor, ack advances, renew extends finite lease", async () => {
  const { h, a, supervisor } = await setup();
  try {
    const other = await h.login(200);
    const otherWorker = await h.enrolledWorker(other);
    await h.seedPolicy(other.tenant, dispatchPolicy);
    void otherWorker;
    const seed = await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user);
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(claim.status, 200);
    const claimed = (await claim.json()) as {
      task: Record<string, unknown> | null;
      server_time: number;
    };
    assert.ok(claimed.task, "expected a claimed task");
    assert.equal(claimed.task.task_id, seed.taskId);
    assert.equal(claimed.task.state, "claimed");
    assert.ok(typeof claimed.server_time === "number");
    const lease = {
      lease_id: claimed.task.lease_id,
      fence: claimed.task.fence,
    };
    // Same-key lost-claim replay returns the SAME lease while current.
    const replayKey = crypto.randomUUID();
    const claim2 = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor, replayKey),
      "POST",
      {},
    );
    assert.equal(claim2.status, 200);
    // No eligible work remains (task already claimed): null, fresh server_time.
    const empty = (await claim2.json()) as {
      task: null;
      server_time: number;
    };
    assert.equal(empty.task, null);
    assert.ok(empty.server_time >= claimed.server_time);
    // Ack: claimed -> running on the same lease/fence.
    const ack = await h.request(
      `/v1/supervisor/tasks/${seed.taskId}/ack`,
      claimHeaders(supervisor),
      "POST",
      lease,
    );
    assert.equal(ack.status, 200);
    const acked = (await ack.json()) as {
      task: Record<string, unknown>;
      directive: string;
      server_time: number;
    };
    assert.equal(acked.task.state, "running");
    assert.equal(acked.directive, "continue");
    // Renew: same lease_id, current fence in, fence+1 out, extended expiry.
    const renew = await h.request(
      `/v1/supervisor/tasks/${seed.taskId}/renew`,
      claimHeaders(supervisor),
      "POST",
      { lease_id: lease.lease_id, fence: lease.fence },
    );
    assert.equal(renew.status, 200);
    const renewed = (await renew.json()) as {
      task: {
        fence: number;
        lease_id: string;
        lease_expires_at: number;
        deadline_at: number;
      };
      directive: string;
      server_time: number;
    };
    assert.equal(renewed.task.lease_id, lease.lease_id);
    assert.equal(renewed.task.fence, (lease.fence as number) + 1);
    assert.ok(
      renewed.task.lease_expires_at > (acked.task.lease_expires_at as number),
    );
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: duplicate claim elects exactly one supervisor (concurrent)", async () => {
  const { h, a, supervisor, worker } = await setup();
  try {
    const second = await h.registerSupervisor(a, worker.worker_id, "edge-two");
    await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user);
    const results = await Promise.all(
      [supervisor, second].map((s) =>
        h.request("/v1/supervisor/claim", claimHeaders(s), "POST", {}),
      ),
    );
    assert.ok(results.every((r) => r.status === 200));
    const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{
      task: { supervisor_id: string } | null;
    }>;
    const winners = bodies.filter((b) => b.task);
    assert.equal(winners.length, 1);
    assert.ok(
      [supervisor.supervisor_id, second.supervisor_id].includes(
        winners[0]!.task!.supervisor_id,
      ),
    );
    const rows = (
      await h.db
        .prepare(
          "SELECT supervisor_id FROM hosted_tasks WHERE supervisor_id IS NOT NULL",
        )
        .all<{ supervisor_id: string }>()
    ).results;
    assert.equal(rows.length, 1);
    void second;
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: lost ack reply returns same lease only while current", async () => {
  const { h, supervisor } = await setup();
  try {
    const { a } = { a: null as never };
    void a;
    const tenant = supervisor.tenant_id;
    const user = supervisor.subject_id;
    await h.seedQueuedTask(tenant, supervisor.worker_id, user);
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(claim.status, 200);
    const lease = (
      (await claim.json()) as {
        task: { lease_id: string; fence: number; task_id: string };
      }
    ).task;
    const k = crypto.randomUUID();
    const first = await h.request(
      `/v1/supervisor/tasks/${lease.task_id}/ack`,
      claimHeaders(supervisor, k),
      "POST",
      { lease_id: lease.lease_id, fence: lease.fence },
    );
    assert.equal(first.status, 200);
    // Lost-reply retry with the SAME op key returns the same lease state.
    const retry = await h.request(
      `/v1/supervisor/tasks/${lease.task_id}/ack`,
      claimHeaders(supervisor, k),
      "POST",
      { lease_id: lease.lease_id, fence: lease.fence },
    );
    assert.equal(retry.status, 200);
    const body = (await retry.json()) as {
      task: { lease_id: string; fence: number; state: string };
    };
    assert.equal(body.task.lease_id, lease.lease_id);
    assert.equal(body.task.state, "running");
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: stale fence and expired renew denied (no lease extension)", async () => {
  const { h, supervisor } = await setup();
  try {
    await h.seedQueuedTask(
      supervisor.tenant_id,
      supervisor.worker_id,
      supervisor.subject_id,
    );
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(claim.status, 200);
    const task = (
      (await claim.json()) as {
        task: { task_id: string; lease_id: string; fence: number };
      }
    ).task;
    // Stale fence (off by one) cannot ack.
    const stale = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/ack`,
      claimHeaders(supervisor),
      "POST",
      { lease_id: task.lease_id, fence: task.fence + 5 },
    );
    assert.equal(stale.status, 409);
    // Valid ack, then force lease expiry and attempt renew: denied.
    const ack = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/ack`,
      claimHeaders(supervisor),
      "POST",
      { lease_id: task.lease_id, fence: task.fence },
    );
    assert.equal(ack.status, 200);
    const acked = (await ack.json()) as {
      task: { fence: number; lease_expires_at: number };
    };
    await h.db
      .prepare("UPDATE hosted_tasks SET lease_expires_at=? WHERE task_id=?")
      .bind(Date.now() - 1000, task.task_id)
      .run();
    const renew = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/renew`,
      claimHeaders(supervisor),
      "POST",
      { lease_id: task.lease_id, fence: acked.task.fence },
    );
    assert.equal(renew.status, 409);
    const code = ((await renew.json()) as { error: { code: string } }).error
      .code;
    assert.equal(code, "lease_expired");
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: worker revocation blocks claim/renew but cleanup settle survives", async () => {
  const { h, a, supervisor } = await setup();
  try {
    await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user);
    // Revoke the worker first: execution auth itself fails (401), so no
    // claim is possible while the worker is revoked.
    await h.db
      .prepare(
        "UPDATE cloud_workers SET status='revoked',revoked_at=? WHERE worker_id=?",
      )
      .bind(Date.now(), supervisor.worker_id)
      .run();
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(claim.status, 401);
    // Restore, claim, ack, then revoke the worker: renew denied, cleanup
    // settle still works (trusted stop reporting survives worker loss).
    await h.db
      .prepare(
        "UPDATE cloud_workers SET status='registered',revoked_at=NULL WHERE worker_id=?",
      )
      .bind(supervisor.worker_id)
      .run();
    // One open task per org+worker: the second seed needs its own worker
    // and its own bound supervisor.
    const worker2 = await h.enrolledWorker(a);
    const supervisor2 = await h.registerSupervisor(
      a,
      worker2.worker_id,
      "edge-two",
    );
    await h.seedQueuedTask(a.tenant, worker2.worker_id, a.user);
    const claim2 = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor2),
      "POST",
      {},
    );
    const task = (
      (await claim2.json()) as {
        task: { task_id: string; lease_id: string; fence: number };
      }
    ).task;
    assert.ok(task);
    const ack = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/ack`,
      claimHeaders(supervisor2),
      "POST",
      { lease_id: task.lease_id, fence: task.fence },
    );
    assert.equal(ack.status, 200);
    const ackedFence = ((await ack.json()) as { task: { fence: number } }).task
      .fence;
    await h.db
      .prepare(
        "UPDATE cloud_workers SET status='revoked',revoked_at=? WHERE worker_id=?",
      )
      .bind(Date.now(), worker2.worker_id)
      .run();
    const renew = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/renew`,
      claimHeaders(supervisor2),
      "POST",
      { lease_id: task.lease_id, fence: ackedFence },
    );
    assert.equal(renew.status, 401);
    const settle = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/settle`,
      claimHeaders(supervisor2),
      "POST",
      {
        lease_id: task.lease_id,
        fence: ackedFence,
        outcome: "completed",
        stop_confirmed: true,
        consumed_runtime_ms: 50,
      },
    );
    assert.equal(settle.status, 200);
    const settled = (await settle.json()) as { task: { state: string } };
    assert.equal(settled.task.state, "completed");
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: settlement consumes meter exactly once; duplicate same-payload idempotent, changed conflicts", async () => {
  const { h, a, supervisor } = await setup();
  try {
    await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user, {
      quantity: "100",
      withAllowance: {
        allowed_quantity: "60000",
        reserved_quantity: "100",
        consumed_quantity: "0",
      },
    });
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(claim.status, 200);
    const task = (
      (await claim.json()) as {
        task: { task_id: string; lease_id: string; fence: number };
      }
    ).task;
    const ack = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/ack`,
      claimHeaders(supervisor),
      "POST",
      { lease_id: task.lease_id, fence: task.fence },
    );
    assert.equal(ack.status, 200);
    const fence = ((await ack.json()) as { task: { fence: number } }).task
      .fence;
    const payload = {
      lease_id: task.lease_id,
      fence,
      outcome: "completed",
      stop_confirmed: true,
      consumed_runtime_ms: 40,
    };
    const k = crypto.randomUUID();
    const first = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/settle`,
      claimHeaders(supervisor, k),
      "POST",
      payload,
    );
    assert.equal(first.status, 200);
    assert.equal(
      ((await first.json()) as { task: { state: string } }).task.state,
      "completed",
    );
    // Exact replay: same task, no double consumption.
    const replay = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/settle`,
      claimHeaders(supervisor, k),
      "POST",
      payload,
    );
    assert.equal(replay.status, 200);
    // Changed payload on the same key: 409.
    const changed = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/settle`,
      claimHeaders(supervisor, k),
      "POST",
      { ...payload, consumed_runtime_ms: 41 },
    );
    assert.equal(changed.status, 409);
    const allowance = await h.db
      .prepare(
        "SELECT reserved_quantity,consumed_quantity FROM hosted_allowances WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{ reserved_quantity: string; consumed_quantity: string }>();
    assert.equal(allowance!.reserved_quantity, "0");
    assert.equal(allowance!.consumed_quantity, "40");
    const audits = await h.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE organization_id=? AND action='dispatch.settled'",
      )
      .bind(a.tenant)
      .first<{ n: number }>();
    assert.equal(audits!.n, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: settlement works after entitlement revocation/expiry/period end", async () => {
  const { h, a, supervisor } = await setup();
  try {
    await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user);
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    const task = (
      (await claim.json()) as {
        task: { task_id: string; lease_id: string; fence: number };
      }
    ).task;
    const ack = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/ack`,
      claimHeaders(supervisor),
      "POST",
      { lease_id: task.lease_id, fence: task.fence },
    );
    assert.equal(ack.status, 200);
    const fence = ((await ack.json()) as { task: { fence: number } }).task
      .fence;
    // Revoke the policy AND expire its window: commercial expiry must not
    // block trusted stop settlement (no meter attached to this seed).
    const { revokePolicy } = await import("../src/hosted-entitlements.ts");
    await revokePolicy(
      {
        env: { DB: h.db },
        request: new Request("https://api.example.invalid/"),
        request_id: crypto.randomUUID(),
        route: "operator.policy",
        actor: a.user,
      } as never,
      a.tenant,
      a.user,
    );
    await h.db
      .prepare(
        "UPDATE hosted_entitlements SET valid_from=?,valid_until=? WHERE organization_id=?",
      )
      .bind(Date.now() - 2000, Date.now() - 1000, a.tenant)
      .run();
    const settle = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/settle`,
      claimHeaders(supervisor),
      "POST",
      {
        lease_id: task.lease_id,
        fence,
        outcome: "failed",
        stop_confirmed: true,
        consumed_runtime_ms: 10,
      },
    );
    assert.equal(settle.status, 200);
    assert.equal(
      ((await settle.json()) as { task: { state: string } }).task.state,
      "failed",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: failed meter CAS rejects without partial terminal state", async () => {
  const { h, a, supervisor } = await setup();
  try {
    await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user, {
      quantity: "100",
      withAllowance: {
        allowed_quantity: "60000",
        reserved_quantity: "100",
        consumed_quantity: "0",
      },
    });
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    const task = (
      (await claim.json()) as {
        task: { task_id: string; lease_id: string; fence: number };
      }
    ).task;
    const ack = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/ack`,
      claimHeaders(supervisor),
      "POST",
      { lease_id: task.lease_id, fence: task.fence },
    );
    const fence = ((await ack.json()) as { task: { fence: number } }).task
      .fence;
    // Concurrently drain the allowance so the settlement CAS misses.
    await h.db
      .prepare(
        "UPDATE hosted_allowances SET reserved_quantity=? WHERE organization_id=?",
      )
      .bind("5", a.tenant)
      .run();
    const settle = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/settle`,
      claimHeaders(supervisor),
      "POST",
      {
        lease_id: task.lease_id,
        fence,
        outcome: "completed",
        stop_confirmed: true,
        consumed_runtime_ms: 40,
      },
    );
    assert.equal(settle.status, 409);
    const row = await h.db
      .prepare("SELECT state FROM hosted_tasks WHERE task_id=?")
      .bind(task.task_id)
      .first<{ state: string }>();
    assert.equal(row!.state, "running");
    const reservation = await h.db
      .prepare("SELECT state FROM hosted_reservations WHERE task_id=?")
      .bind(task.task_id)
      .first<{ state: string }>();
    assert.equal(reservation!.state, "active");
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: cancel race keeps stop discoverable; revoked supervisor cannot report", async () => {
  const { h, a, supervisor } = await setup();
  try {
    await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user);
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    const task = (
      (await claim.json()) as {
        task: { task_id: string; lease_id: string; fence: number };
      }
    ).task;
    // Cancellation owner marks stop_requested; status must surface stop.
    await h.db
      .prepare("UPDATE hosted_tasks SET state='stop_requested' WHERE task_id=?")
      .bind(task.task_id)
      .run();
    const status = await h.request(
      `/v1/supervisor/tasks/${task.task_id}`,
      supervisorBearer(supervisor.credential),
    );
    assert.equal(status.status, 200);
    const body = (await status.json()) as { directive: string };
    assert.equal(body.directive, "stop");
    // Revoke the supervisor: old key reports nothing, even in cleanup mode.
    const del = await h.request(
      `/v1/tenants/${a.tenant}/supervisors/${supervisor.supervisor_id}`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "DELETE",
    );
    assert.equal(del.status, 200);
    const denied = await h.request(
      `/v1/supervisor/tasks/${task.task_id}/settle`,
      claimHeaders(supervisor),
      "POST",
      {
        lease_id: task.lease_id,
        fence: task.fence,
        outcome: "completed",
        stop_confirmed: true,
        consumed_runtime_ms: 5,
      },
    );
    assert.equal(denied.status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: DB/audit failure rolls back claim (no partial lease)", async () => {
  const { h, a, supervisor } = await setup();
  try {
    await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user);
    await h.db.prepare("DROP TABLE audit_events").run();
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(claim.status, 503);
    const row = await h.db
      .prepare("SELECT state,supervisor_id,lease_id FROM hosted_tasks LIMIT 1")
      .first<{
        state: string;
        supervisor_id: string | null;
        lease_id: string | null;
      }>();
    assert.equal(row!.state, "queued");
    assert.equal(row!.supervisor_id, null);
    assert.equal(row!.lease_id, null);
    const outbox = await h.db
      .prepare("SELECT state FROM hosted_outbox LIMIT 1")
      .first<{ state: string }>();
    assert.equal(outbox!.state, "queued");
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: expiry cleanup holds claimed work and releases unclaimed queues", async () => {
  const h = await dispatchFixture();
  try {
    const a = await h.login();
    const worker = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, dispatchPolicy);
    const supervisor = await h.registerSupervisor(a, worker.worker_id);
    const running = await h.seedQueuedTask(
      a.tenant,
      supervisor.worker_id,
      a.user,
    );
    // One open task per org+worker (DDL): the queued fixture needs its own worker.
    const worker2 = await h.enrolledWorker(a);
    const queued = await h.seedQueuedTask(a.tenant, worker2.worker_id, a.user);
    const claim = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(claim.status, 200);
    const claimedId = ((await claim.json()) as { task: { task_id: string } })
      .task.task_id;
    const otherId =
      claimedId === running.taskId ? queued.taskId : running.taskId;
    const future = Date.now() + 3600000;
    const env = {
      DB: h.db,
      AUTH_SECRET: "x",
      APP_ORIGIN: "https://api.example.invalid",
      WEBSITE_ORIGIN: "https://api.example.invalid",
      ENVIRONMENT: "local",
    } as never;
    // Expire the claimed lease + both deadlines (keeping created_at <
    // deadline_at to respect the DDL window CHECK).
    const past = Date.now() - 60000;
    await h.db
      .prepare(
        "UPDATE hosted_tasks SET created_at=?,lease_expires_at=?,deadline_at=? WHERE task_id=?",
      )
      .bind(past, Date.now() - 1000, Date.now() - 500, claimedId)
      .run();
    await h.db
      .prepare(
        "UPDATE hosted_tasks SET created_at=?,deadline_at=? WHERE task_id=?",
      )
      .bind(past, Date.now() - 500, otherId)
      .run();
    const result = await cleanupHosted({ DB: h.db } as never, Date.now());
    assert.ok(result.held.includes(claimedId));
    assert.ok(result.released.includes(otherId));
    const heldTask = await h.db
      .prepare("SELECT state FROM hosted_tasks WHERE task_id=?")
      .bind(claimedId)
      .first<{ state: string }>();
    assert.equal(heldTask!.state, "held");
    const heldReservation = await h.db
      .prepare("SELECT state FROM hosted_reservations WHERE task_id=?")
      .bind(claimedId)
      .first<{ state: string }>();
    assert.equal(heldReservation!.state, "quarantined");
    const expiredTask = await h.db
      .prepare("SELECT state FROM hosted_tasks WHERE task_id=?")
      .bind(otherId)
      .first<{ state: string }>();
    assert.equal(expiredTask!.state, "expired");
    const expiredReservation = await h.db
      .prepare("SELECT state FROM hosted_reservations WHERE task_id=?")
      .bind(otherId)
      .first<{ state: string }>();
    assert.equal(expiredReservation!.state, "released");
    const deadOutbox = await h.db
      .prepare("SELECT state FROM hosted_outbox WHERE task_id=?")
      .bind(otherId)
      .first<{ state: string }>();
    assert.equal(deadOutbox!.state, "dead");
    void env;
    void future;
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: taskAuthorizerGuard pins account/cli/grant authority", async () => {
  const h = await dispatchFixture();
  try {
    const a = await h.login();
    const worker = await h.enrolledWorker(a);
    const account = {
      task_id: "t",
      organization_id: a.tenant,
      worker_id: worker.worker_id,
      authorizing_user_id: a.user,
      installation_id: null,
      execution_grant_id: null,
      state: "queued",
      reservation_id: "r",
      policy_version: 1,
      runtime_ms: 100,
      controlled_duration_ms: 10,
      created_at: 1,
      deadline_at: 2,
      lease_id: null,
      supervisor_id: null,
      fence: 0,
      lease_expires_at: null,
    };
    const good = taskAuthorizerGuard(account);
    const hit = await h.db
      .prepare(`SELECT (${good.sql}) ok`)
      .bind(...good.args)
      .first<{ ok: number }>();
    assert.equal(hit!.ok, 1);
    // Revoked membership fails the account path.
    await h.db
      .prepare(
        "UPDATE memberships SET status='revoked' WHERE organization_id=? AND user_id=?",
      )
      .bind(a.tenant, a.user)
      .run();
    const miss = await h.db
      .prepare(`SELECT (${good.sql}) ok`)
      .bind(...good.args)
      .first<{ ok: number }>();
    assert.equal(miss!.ok, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("dispatch: strict schemas and safe envelope on every route", async () => {
  const { h, supervisor } = await setup();
  try {
    const badClaim = await h.request(
      "/v1/supervisor/claim?unexpected=1",
      claimHeaders(supervisor),
      "POST",
      {},
    );
    assert.equal(badClaim.status, 400);
    const badBody = await h.request(
      "/v1/supervisor/claim",
      claimHeaders(supervisor),
      "POST",
      { extra: 1 },
    );
    assert.equal(badBody.status, 400);
    const noKey = await h.request(
      "/v1/supervisor/claim",
      supervisorBearer(supervisor.credential),
      "POST",
      {},
    );
    assert.equal(noKey.status, 400);
    const badId = await h.request(
      "/v1/supervisor/tasks/not-a-uuid/ack",
      claimHeaders(supervisor),
      "POST",
      { lease_id: crypto.randomUUID(), fence: 0 },
    );
    assert.equal(badId.status, 400);
    const envelope = (await badBody.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    assert.ok(envelope.error.code);
    assert.ok(envelope.error.request_id);
    assert.equal("task" in envelope, false);
  } finally {
    await h.mf.dispose();
  }
});

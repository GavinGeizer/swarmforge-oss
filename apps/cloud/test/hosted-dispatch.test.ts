import { test } from "bun:test";
import assert from "node:assert/strict";
import { cleanupIdentity } from "../src/abuse.ts";
import { hash } from "../src/crypto.ts";
import { hostedAuthorityRoute } from "../src/hosted-authority.ts";
import {
  cleanupHosted,
  hostedDispatchRoute,
  hostedRecoveryRoute,
} from "../src/hosted-dispatch.ts";
import { entitlementsRoute } from "../src/hosted-entitlements.ts";
import { supervisorRoute } from "../src/hosted-supervisors.ts";
import { claimReplySchema, leaseReplySchema } from "../src/hosted-types.ts";
import { localFixture } from "./local-fixture.ts";

const policy = {
  capabilities: {
    hosted_control_plane: true,
    remote_worker_enrollment: true,
    hosted_task_execution: true,
  },
  max_concurrent_workers: 8,
  max_active_tasks: 8,
  max_task_runtime: 60000,
  maximum_resource_reservations: 16,
  valid_for_ms: 86400000,
};
async function setup() {
  const h = await localFixture({
    handlers: [
      hostedDispatchRoute,
      hostedRecoveryRoute,
      supervisorRoute,
      hostedAuthorityRoute,
      entitlementsRoute,
    ],
  });
  const a = await h.login();
  const w = await h.enrolledWorker(a);
  await h.seedPolicy(a.tenant, policy);
  const s = await h.registerSupervisor(a, w.worker_id);
  return { h, a, w, s };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function seed(x: Setup, meter = true) {
  const { h, a, w } = x,
    now = Date.now(),
    task = crypto.randomUUID(),
    reservation = crypto.randomUUID(),
    outbox = crypto.randomUUID(),
    allowance = meter ? crypto.randomUUID() : null;
  if (allowance)
    await h.db
      .prepare(
        "INSERT INTO hosted_allowances(allowance_id,organization_id,entitlement_id,resource,unit,resource_class,allowed_quantity,consumed_quantity,reserved_quantity,period_start,period_end,created_at) SELECT ?,?,entitlement_id,'compute_ms','millisecond','controlled','60000','0','10000',?,?,? FROM hosted_entitlements WHERE organization_id=? ORDER BY version DESC LIMIT 1",
      )
      .bind(allowance, a.tenant, now, now + 86400000, now, a.tenant)
      .run();
  await h.db.batch([
    h.db
      .prepare(
        "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,authorizing_user_id,authorizing_session_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,'account',?,?,?,'controlled','queued',?,1,10000,100,?,?)",
      )
      .bind(
        task,
        a.tenant,
        w.worker_id,
        a.user,
        a.sessionId,
        crypto.randomUUID(),
        a.user,
        crypto.randomUUID(),
        await hash(task),
        reservation,
        now,
        now + 60000,
      ),
    h.db
      .prepare(
        "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,allowance_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,'task_execution','10000','active',?,?)",
      )
      .bind(
        reservation,
        a.tenant,
        task,
        w.worker_id,
        allowance,
        now,
        now + 60000,
      ),
    h.db
      .prepare(
        "INSERT INTO hosted_outbox(outbox_id,organization_id,task_id,state,payload_json,created_at) VALUES(?,?,?,'queued','{}',?)",
      )
      .bind(outbox, a.tenant, task, now),
  ]);
  return { task, reservation, outbox, allowance };
}
function headers(x: Setup, k = crypto.randomUUID()) {
  return { authorization: `Bearer ${x.s.credential}`, "idempotency-key": k };
}
async function claimReply(x: Setup, k = crypto.randomUUID()) {
  const r = await x.h.request(
    "/v1/supervisor/claim",
    headers(x, k),
    "POST",
    {},
  );
  assert.equal(r.status, 200, await r.clone().text());
  return claimReplySchema.parse(await r.json());
}
async function claim(x: Setup, k = crypto.randomUUID()) {
  const reply = await claimReply(x, k);
  assert.ok(reply.task);
  assert.ok(reply.task.lease_id);
  return { ...reply.task, lease_id: reply.task.lease_id };
}
async function running(x: Setup) {
  const v = await seed(x);
  const t = await claim(x);
  const lease = { lease_id: t.lease_id, fence: t.fence };
  assert.equal(
    (
      await x.h.request(
        `/v1/supervisor/tasks/${v.task}/ack`,
        headers(x),
        "POST",
        lease,
      )
    ).status,
    200,
  );
  return { ...v, lease };
}
function report(
  v: { lease: { lease_id: string; fence: number } },
  consumption = 100,
) {
  return {
    ...v.lease,
    outcome: "completed",
    stop_confirmed: true,
    consumed_runtime_ms: consumption,
  };
}
async function snapshot(x: Setup, task: string) {
  return {
    task: await x.h.db
      .prepare("SELECT * FROM hosted_tasks WHERE task_id=?")
      .bind(task)
      .first(),
    reservation: await x.h.db
      .prepare("SELECT * FROM hosted_reservations WHERE task_id=?")
      .bind(task)
      .first(),
    outbox: await x.h.db
      .prepare("SELECT * FROM hosted_outbox WHERE task_id=?")
      .bind(task)
      .first(),
    ledger: (
      await x.h.db
        .prepare("SELECT * FROM hosted_allowances ORDER BY allowance_id")
        .all()
    ).results,
    operations: (
      await x.h.db
        .prepare("SELECT * FROM hosted_operations ORDER BY operation_id")
        .all()
    ).results,
    audits: (
      await x.h.db.prepare("SELECT * FROM audit_events ORDER BY event_id").all()
    ).results,
  };
}
async function persisted(x: Setup) {
  const tables = [
    "hosted_tasks",
    "hosted_reservations",
    "hosted_outbox",
    "hosted_allowances",
    "hosted_operations",
    "audit_events",
  ] as const;
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await x.h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
          .results,
      ]),
    ),
  );
}

function queryBudget(x: Setup) {
  const prepare = x.h.db.prepare.bind(x.h.db);
  let maxArgs = 0;
  x.h.db.prepare = (sql) => {
    const statement = prepare(sql),
      bind = statement.bind.bind(statement);
    statement.bind = (...args) => {
      maxArgs = Math.max(maxArgs, args.length);
      return bind(...args);
    };
    return statement;
  };
  const start = x.h.db.queryCalls;
  return () => ({ statements: x.h.db.queryCalls - start, maxArgs });
}

test("dispatch SQL: batch-entry ledger race leaves every settlement row unchanged", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await x.h.db
        .prepare(
          "UPDATE hosted_allowances SET reserved_quantity=? WHERE allowance_id=?",
        )
        .bind("9000", v.allowance)
        .run();
      before = await snapshot(x, v.task);
    };
    const r = await x.h.request(
      `/v1/supervisor/tasks/${v.task}/settle`,
      headers(x),
      "POST",
      report(v),
    );
    assert.equal(r.status, 409);
    assert.deepEqual(await snapshot(x, v.task), before);
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: renewal keeps fence, bounds deadline and same-key replay never extends twice", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    await x.h.db
      .prepare("UPDATE hosted_tasks SET deadline_at=? WHERE task_id=?")
      .bind(Date.now() + 10000, v.task)
      .run();
    const k = crypto.randomUUID();
    const r = await x.h.request(
      `/v1/supervisor/tasks/${v.task}/renew`,
      headers(x, k),
      "POST",
      v.lease,
    );
    assert.equal(r.status, 200);
    const first = leaseReplySchema.parse(await r.json()).task;
    assert.equal(first.fence, v.lease.fence);
    assert.ok(
      first.lease_expires_at !== null &&
        first.lease_expires_at <= first.deadline_at,
    );
    const before = await snapshot(x, v.task);
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/renew`,
          headers(x, k),
          "POST",
          v.lease,
        )
      ).status,
      200,
    );
    assert.deepEqual(await snapshot(x, v.task), before);
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: reused claim key after terminal task cannot claim a new task", async () => {
  const x = await setup();
  try {
    const v = await seed(x),
      k = crypto.randomUUID(),
      t = await claim(x, k),
      lease = { lease_id: t.lease_id, fence: t.fence };
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x),
          "POST",
          report({ lease }),
        )
      ).status,
      200,
    );
    const second = await seed(x, false),
      before = await snapshot(x, second.task);
    assert.equal((await claimReply(x, k)).task, null);
    assert.deepEqual(await snapshot(x, second.task), before);
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: conflicting ACK and renewal keys on another resource have zero effects", async () => {
  const x = await setup();
  try {
    const v = await running(x),
      renewKey = crypto.randomUUID(),
      ackKey = crypto.randomUUID();
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/renew`,
          headers(x, renewKey),
          "POST",
          v.lease,
        )
      ).status,
      200,
    );
    await x.h.db
      .prepare(
        "UPDATE hosted_operations SET idempotency_key=? WHERE operation='dispatch.ack' AND task_id=?",
      )
      .bind(ackKey, v.task)
      .run();
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x),
          "POST",
          report(v),
        )
      ).status,
      200,
    );
    const second = await seed(x, false),
      t = await claim(x),
      lease = { lease_id: t.lease_id, fence: t.fence };
    let before = await snapshot(x, second.task);
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${second.task}/ack`,
          headers(x, ackKey),
          "POST",
          lease,
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(x, second.task), before);
    before = await snapshot(x, second.task);
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${second.task}/renew`,
          headers(x, renewKey),
          "POST",
          lease,
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(x, second.task), before);
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: forced concurrent different settlements elect exactly one payload", async () => {
  const x = await setup();
  try {
    const v = await running(x),
      k = crypto.randomUUID();
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    x.h.db.beforeBatch = async () => {
      if (++arrivals === 2) release();
      await barrier;
    };
    const rs = await Promise.all(
      [100, 200].map((n) =>
        x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x, k),
          "POST",
          report(v, n),
        ),
      ),
    );
    x.h.db.beforeBatch = undefined;
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const r = await x.h.db
      .prepare("SELECT * FROM hosted_reservations WHERE task_id=?")
      .bind(v.task)
      .first();
    const a = await x.h.db
      .prepare("SELECT * FROM hosted_allowances WHERE allowance_id=?")
      .bind(v.allowance)
      .first();
    assert.ok(a);
    assert.equal(a.reserved_quantity, "0");
    assert.ok(r);
    assert.equal(a.consumed_quantity, r.consumed_quantity);
    assert.ok(["100", "200"].includes(String(a.consumed_quantity)));
    assert.equal(
      (await x.h.db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='dispatch.settled'",
        )
        .first<Record<string, unknown>>())!.n,
      1,
    );
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: session revocation at batch election denies ACK without any effects and status says stop", async () => {
  const x = await setup();
  try {
    const v = await seed(x),
      t = await claim(x),
      lease = { lease_id: t.lease_id, fence: t.fence };
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await x.h.db
        .prepare("UPDATE sessions SET revoked_at=? WHERE session_id=?")
        .bind(Date.now(), x.a.sessionId)
        .run();
      before = await snapshot(x, v.task);
    };
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/ack`,
          headers(x),
          "POST",
          lease,
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(x, v.task), before);
    const status = await x.h.request(
      `/v1/supervisor/tasks/${v.task}`,
      headers(x),
    );
    assert.equal(status.status, 200);
    assert.equal(leaseReplySchema.parse(await status.json()).directive, "stop");
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x),
          "POST",
          report({ lease }),
        )
      ).status,
      200,
    );
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: newest policy loss at election denies renewal and cleanup remains usable", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await x.h.db
        .prepare(
          "UPDATE hosted_entitlements SET hosted_task_execution=0 WHERE organization_id=?",
        )
        .bind(x.a.tenant)
        .run();
      before = await snapshot(x, v.task);
    };
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/renew`,
          headers(x),
          "POST",
          v.lease,
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(x, v.task), before);
    const status = await x.h.request(
      `/v1/supervisor/tasks/${v.task}`,
      headers(x),
    );
    assert.equal(leaseReplySchema.parse(await status.json()).directive, "stop");
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x),
          "POST",
          report(v),
        )
      ).status,
      200,
    );
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: queued expiry releases meter; assigned expiry retains capacity and combined cron stays bounded", async () => {
  const x = await setup();
  try {
    const v = await seed(x);
    await x.h.db
      .prepare(
        "UPDATE hosted_tasks SET created_at=?,deadline_at=? WHERE task_id=?",
      )
      .bind(Date.now() - 60000, Date.now() - 1, v.task)
      .run();
    const start = x.h.db.queryCalls;
    await cleanupIdentity(x.h.env);
    const result = await cleanupHosted(x.h.env);
    assert.ok(result.released.includes(v.task));
    assert.ok(x.h.db.queryCalls - start <= 50);
    const a = await x.h.db
      .prepare(
        "SELECT reserved_quantity FROM hosted_allowances WHERE allowance_id=?",
      )
      .bind(v.allowance)
      .first();
    assert.ok(a);
    assert.equal(a.reserved_quantity, "0");
    const v2 = await running(x);
    await x.h.db
      .prepare("UPDATE hosted_tasks SET lease_expires_at=? WHERE task_id=?")
      .bind(Date.now() - 1, v2.task)
      .run();
    const held = await cleanupHosted(x.h.env);
    assert.ok(held.held.includes(v2.task));
    assert.equal(
      (await x.h.db
        .prepare("SELECT state FROM hosted_reservations WHERE task_id=?")
        .bind(v2.task)
        .first<Record<string, unknown>>())!.state,
      "quarantined",
    );
    assert.equal(
      (await x.h.db
        .prepare(
          "SELECT reserved_quantity FROM hosted_allowances WHERE allowance_id=?",
        )
        .bind(v2.allowance)
        .first<Record<string, unknown>>())!.reserved_quantity,
      "10000",
    );
  } finally {
    x.h.close();
  }
});
test("dispatch SQL: revoked old assignment requires audited operator recovery with current lease", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    assert.equal(
      (
        await x.h.request(
          `/v1/tenants/${x.a.tenant}/supervisors/${x.s.supervisor_id}`,
          { ...x.a.headers, "idempotency-key": crypto.randomUUID() },
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x),
          "POST",
          report(v),
        )
      ).status,
      401,
    );
    const fresh = await x.h.registerSupervisor(x.a, x.w.worker_id);
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          {
            authorization: `Bearer ${fresh.credential}`,
            "idempotency-key": crypto.randomUUID(),
          },
          "POST",
          report(v),
        )
      ).status,
      409,
    );
    const path = `/v1/tenants/${x.a.tenant}/tasks/${v.task}/recover`,
      k = crypto.randomUUID(),
      input = {
        ...report(v),
        stop_evidence:
          "OS process table and watchdog lease log independently checked",
      };
    const before = await snapshot(x, v.task);
    assert.equal(
      (await x.h.request(path, headers(x), "POST", input)).status,
      401,
    );
    assert.deepEqual(await snapshot(x, v.task), before);
    assert.equal(
      (
        await x.h.request(
          path,
          { ...x.a.headers, "idempotency-key": k },
          "POST",
          input,
        )
      ).status,
      200,
    );
    const saved = await snapshot(x, v.task);
    assert.equal(
      (
        await x.h.request(
          path,
          { ...x.a.headers, "idempotency-key": k },
          "POST",
          input,
        )
      ).status,
      200,
    );
    assert.deepEqual(await snapshot(x, v.task), saved);
    assert.equal(
      (
        await x.h.request(
          path,
          { ...x.a.headers, "idempotency-key": k },
          "POST",
          { ...input, consumed_runtime_ms: 101 },
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(x, v.task), saved);
    const event = await x.h.db
      .prepare(
        "SELECT * FROM audit_events WHERE action='dispatch.operator_recovered'",
      )
      .first();
    assert.ok(event);
    assert.equal(event.organization_id, x.a.tenant);
    assert.match(String(event.metadata), /operator_verified_os_stop/);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: a delayed batch cannot renew an execution lease that expires during the request", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    await x.h.db
      .prepare("UPDATE hosted_tasks SET lease_expires_at=? WHERE task_id=?")
      .bind(Date.now() + 20, v.task)
      .run();
    const before = await snapshot(x, v.task);
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await Bun.sleep(40);
    };
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/renew`,
          headers(x),
          "POST",
          v.lease,
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(x, v.task), before);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: claim replay requires the original recorded lease and fence", async () => {
  const x = await setup();
  try {
    const v = await seed(x),
      k = crypto.randomUUID();
    await claim(x, k);
    await x.h.db
      .prepare(
        "UPDATE hosted_tasks SET lease_id=?,fence=fence+1 WHERE task_id=?",
      )
      .bind(crypto.randomUUID(), v.task)
      .run();
    const before = await snapshot(x, v.task);
    const r = await x.h.request(
      "/v1/supervisor/claim",
      headers(x, k),
      "POST",
      {},
    );
    assert.equal(r.status, 409);
    assert.deepEqual(await snapshot(x, v.task), before);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: credential rebind at election cannot mutate a previous supervisor assignment", async () => {
  const x = await setup();
  try {
    const v = await seed(x),
      t = await claim(x),
      lease = { lease_id: t.lease_id, fence: t.fence },
      s2 = await x.h.registerSupervisor(x.a, x.w.worker_id);
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await x.h.db
        .prepare(
          "UPDATE hosted_supervisor_credentials SET supervisor_id=? WHERE credential_id=?",
        )
        .bind(s2.supervisor_id, x.s.credential_id)
        .run();
      before = await snapshot(x, v.task);
    };
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/ack`,
          headers(x),
          "POST",
          lease,
        )
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(x, v.task), before);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: reply clocks come from the database after mutation despite Worker clock skew", async () => {
  const x = await setup();
  const workerNow = Date.now;
  try {
    const v = await seed(x);
    // SQLite keeps its real clock. Only the request process is five seconds slow.
    await x.h.db
      .prepare(
        "UPDATE hosted_entitlements SET valid_from=valid_from-10000 WHERE organization_id=?",
      )
      .bind(x.a.tenant)
      .run();
    Date.now = () => workerNow() - 5000;
    const check = async (
      request: () => Promise<Response>,
      kind: "claim" | "lease",
    ) => {
      const before = x.h.db.sqlite
        .query(
          "SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) now",
        )
        .get() as { now: number };
      const response = await request();
      assert.equal(response.status, 200, await response.clone().text());
      const reply =
        kind === "claim"
          ? claimReplySchema.parse(await response.json())
          : leaseReplySchema.parse(await response.json());
      const after = x.h.db.sqlite
        .query(
          "SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) now",
        )
        .get() as { now: number };
      assert.ok(
        reply.server_time >= before.now && reply.server_time <= after.now,
      );
      return reply;
    };
    const key = crypto.randomUUID();
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await Bun.sleep(30);
    };
    const claimed = await check(
      () => x.h.request("/v1/supervisor/claim", headers(x, key), "POST", {}),
      "claim",
    );
    assert.ok(claimed.task?.lease_id);
    const lease = {
      lease_id: claimed.task.lease_id,
      fence: claimed.task.fence,
    };
    await check(
      () => x.h.request("/v1/supervisor/claim", headers(x, key), "POST", {}),
      "claim",
    );
    for (const op of ["ack", "renew"])
      await check(
        () =>
          x.h.request(
            `/v1/supervisor/tasks/${v.task}/${op}`,
            headers(x),
            "POST",
            lease,
          ),
        "lease",
      );
    await check(
      () => x.h.request(`/v1/supervisor/tasks/${v.task}`, headers(x)),
      "lease",
    );
    await check(
      () => x.h.request("/v1/supervisor/claim", headers(x), "POST", {}),
      "claim",
    );
    await x.h.db
      .prepare(
        "UPDATE hosted_entitlements SET hosted_task_execution=0 WHERE organization_id=?",
      )
      .bind(x.a.tenant)
      .run();
    const stopped = await check(
      () => x.h.request(`/v1/supervisor/tasks/${v.task}`, headers(x)),
      "lease",
    );
    assert.ok("directive" in stopped && stopped.directive === "stop");
  } finally {
    Date.now = workerNow;
    x.h.close();
  }
});

test("dispatch SQL: full mixed cleanup leaves excess work and metered holds intact within combined D1 limits", async () => {
  const x = await setup();
  try {
    const assigned = [await running(x)];
    for (let i = 0; i < 2; i++) {
      const w = await x.h.enrolledWorker(x.a),
        s = await x.h.registerSupervisor(x.a, w.worker_id);
      assigned.push(await running({ ...x, w, s }));
    }
    const queued = [];
    for (let i = 0; i < 3; i++)
      queued.push(await seed({ ...x, w: await x.h.enrolledWorker(x.a) }));
    const now = Date.now();
    for (const v of assigned)
      await x.h.db
        .prepare("UPDATE hosted_tasks SET lease_expires_at=? WHERE task_id=?")
        .bind(now - 1, v.task)
        .run();
    for (const v of queued)
      await x.h.db
        .prepare(
          "UPDATE hosted_tasks SET created_at=?,deadline_at=? WHERE task_id=?",
        )
        .bind(now - 60000, now - 1, v.task)
        .run();
    const budget = queryBudget(x);
    await cleanupIdentity(x.h.env, now, 0);
    const result = await cleanupHosted(x.h.env, now);
    const measured = budget();
    assert.ok(measured.statements <= 33, JSON.stringify(measured));
    assert.ok(measured.maxArgs <= 100, JSON.stringify(measured));
    assert.equal(result.held.length, 2);
    assert.equal(result.released.length, 2);
    for (const v of [...assigned, ...queued]) {
      const s = await snapshot(x, v.task);
      assert.ok(s.task && s.reservation && s.outbox);
      const held = result.held.includes(v.task),
        released = result.released.includes(v.task);
      assert.equal(
        s.task.state,
        held
          ? "held"
          : released
            ? "expired"
            : assigned.some((a) => a.task === v.task)
              ? "running"
              : "queued",
      );
      assert.equal(
        s.reservation.state,
        held ? "quarantined" : released ? "released" : "active",
      );
      assert.equal(
        s.outbox.state,
        released
          ? "dead"
          : assigned.some((a) => a.task === v.task)
            ? "acked"
            : "queued",
      );
      const allowance = s.ledger.find((a) => a.allowance_id === v.allowance);
      assert.ok(allowance);
      assert.equal(allowance.reserved_quantity, released ? "0" : "10000");
      assert.equal(allowance.consumed_quantity, "0");
    }
    const saved = await persisted(x);
    assert.equal(
      (saved.hosted_operations as Record<string, unknown>[]).filter(
        (op) => op.operation === "dispatch.expire",
      ).length,
      4,
    );
    assert.equal(
      (saved.audit_events as Record<string, unknown>[]).filter(
        (event) => event.action === "dispatch.expired",
      ).length,
      4,
    );
    console.info(
      `dispatch cleanup budget: ${measured.statements} combined statements, ${measured.maxArgs} maximum bindings`,
    );
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: queued cleanup ledger CAS miss persists no task, reservation, outbox, operation or audit effects", async () => {
  const x = await setup();
  try {
    const v = await seed(x),
      now = Date.now();
    await x.h.db
      .prepare(
        "UPDATE hosted_tasks SET created_at=?,deadline_at=? WHERE task_id=?",
      )
      .bind(now - 60000, now - 1, v.task)
      .run();
    let before: Awaited<ReturnType<typeof persisted>> | undefined;
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await x.h.db
        .prepare(
          "UPDATE hosted_allowances SET reserved_quantity='9000' WHERE allowance_id=?",
        )
        .bind(v.allowance)
        .run();
      before = await persisted(x);
    };
    assert.deepEqual(await cleanupHosted(x.h.env, now), {
      held: [],
      released: [],
    });
    assert.deepEqual(await persisted(x), before);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: same-key competing claims replay one pinned assignment and leave the other task queued", async () => {
  const x = await setup();
  try {
    const first = await seed(x),
      second = await seed({ ...x, w: await x.h.enrolledWorker(x.a) }),
      key = crypto.randomUUID();
    let arrivals = 0,
      release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    x.h.db.beforeBatch = async () => {
      if (++arrivals === 2) release();
      await barrier;
    };
    const replies = await Promise.all([claimReply(x, key), claimReply(x, key)]);
    x.h.db.beforeBatch = undefined;
    assert.ok(replies[0]?.task && replies[1]?.task);
    assert.deepEqual(replies[0].task, replies[1].task);
    const saved = await persisted(x),
      tasks = saved.hosted_tasks as Record<string, unknown>[];
    assert.equal(tasks.filter((task) => task.state === "claimed").length, 1);
    assert.equal(tasks.filter((task) => task.state === "queued").length, 1);
    assert.equal(
      (saved.hosted_operations as Record<string, unknown>[]).filter(
        (op) => op.operation === "dispatch.claim",
      ).length,
      1,
    );
    assert.equal(
      (saved.audit_events as Record<string, unknown>[]).filter(
        (event) => event.action === "dispatch.claimed",
      ).length,
      1,
    );
    assert.ok(
      [first.task, second.task].some((id) => id === replies[0].task!.task_id),
    );
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: CLI task survives issuer logout but rejects installation epoch, user and authorization-window changes", async () => {
  for (const mutation of ["epoch", "user", "window"] as const) {
    const x = await setup();
    try {
      const linked = await x.h.linked(x.a);
      const grantResponse = await x.h.request(
        `/v1/tenants/${x.a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
        { ...x.a.headers, "idempotency-key": crypto.randomUUID() },
        "POST",
        {},
      );
      assert.equal(
        grantResponse.status,
        201,
        await grantResponse.clone().text(),
      );
      const grant = (await grantResponse.json()) as { grant_id: string };
      const v = await seed(x);
      await x.h.db
        .prepare(
          "UPDATE hosted_tasks SET execution_grant_id=?,installation_id=? WHERE task_id=?",
        )
        .bind(grant.grant_id, linked.installation_id, v.task)
        .run();
      await x.h.db
        .prepare("UPDATE sessions SET revoked_at=? WHERE session_id=?")
        .bind(Date.now(), x.a.sessionId)
        .run();
      const t = await claim(x),
        lease = { lease_id: t.lease_id, fence: t.fence };
      assert.equal(
        (
          await x.h.request(
            `/v1/supervisor/tasks/${v.task}/ack`,
            headers(x),
            "POST",
            lease,
          )
        ).status,
        200,
      );
      const other = mutation === "user" ? await x.h.login(200) : null;
      let before: Awaited<ReturnType<typeof persisted>> | undefined;
      x.h.db.beforeBatch = async () => {
        x.h.db.beforeBatch = undefined;
        if (mutation === "user")
          await x.h.db
            .prepare(
              "UPDATE cli_installations SET user_id=? WHERE installation_id=?",
            )
            .bind(other!.user, linked.installation_id)
            .run();
        else
          await x.h.db
            .prepare(
              `UPDATE cli_installations SET ${mutation === "epoch" ? "epoch=epoch+1" : "authorization_expires_at=authorization_expires_at-1000"} WHERE installation_id=?`,
            )
            .bind(linked.installation_id)
            .run();
        before = await persisted(x);
      };
      assert.equal(
        (
          await x.h.request(
            `/v1/supervisor/tasks/${v.task}/renew`,
            headers(x),
            "POST",
            lease,
          )
        ).status,
        409,
      );
      assert.deepEqual(await persisted(x), before);
      assert.equal(
        (
          await x.h.request(
            `/v1/supervisor/tasks/${v.task}/settle`,
            headers(x),
            "POST",
            report({ lease }),
          )
        ).status,
        200,
      );
    } finally {
      x.h.close();
    }
  }
});

test("dispatch SQL: newest capability policy replacement at each execution election has zero persistent effects", async () => {
  for (const operation of ["claim", "ack", "renew"] as const) {
    for (const capability of [
      "hosted_control_plane",
      "remote_worker_enrollment",
      "hosted_task_execution",
    ] as const) {
      const x = await setup();
      try {
        const v = await seed(x),
          t = operation === "claim" ? null : await claim(x),
          lease = t ? { lease_id: t.lease_id, fence: t.fence } : null;
        let before: Awaited<ReturnType<typeof persisted>> | undefined;
        x.h.db.beforeBatch = async () => {
          x.h.db.beforeBatch = undefined;
          await x.h.seedPolicy(x.a.tenant, {
            ...policy,
            capabilities: { ...policy.capabilities, [capability]: false },
          });
          before = await persisted(x);
        };
        const response = await x.h.request(
          operation === "claim"
            ? "/v1/supervisor/claim"
            : `/v1/supervisor/tasks/${v.task}/${operation}`,
          headers(x),
          "POST",
          lease ?? {},
        );
        assert.equal(
          response.status,
          operation === "claim" ? 200 : 409,
          `${operation}/${capability}`,
        );
        if (operation === "claim")
          assert.equal(
            claimReplySchema.parse(await response.json()).task,
            null,
          );
        assert.deepEqual(await persisted(x), before);
      } finally {
        x.h.close();
      }
    }
  }
});

test("dispatch SQL: supervisor cannot advance an assignment attached to another worker", async () => {
  for (const operation of ["ack", "renew"] as const) {
    const x = await setup();
    try {
      const w = await x.h.enrolledWorker(x.a),
        second = await seed({ ...x, w });
      const lease2 = { lease_id: crypto.randomUUID(), fence: 1 };
      // DB assignment drift must not bypass the supervisor's worker tuple.
      await x.h.db
        .prepare(
          "UPDATE hosted_tasks SET state='claimed',supervisor_id=?,lease_id=?,fence=1,lease_expires_at=? WHERE task_id=?",
        )
        .bind(
          x.s.supervisor_id,
          lease2.lease_id,
          Date.now() + 30000,
          second.task,
        )
        .run();
      await x.h.db
        .prepare(
          "UPDATE hosted_outbox SET state='claimed',claimed_by=?,lease_id=?,fence=1,claim_expires_at=? WHERE task_id=?",
        )
        .bind(
          x.s.supervisor_id,
          lease2.lease_id,
          Date.now() + 30000,
          second.task,
        )
        .run();
      const before = await persisted(x);
      const k = crypto.randomUUID();
      const response = await x.h.request(
        `/v1/supervisor/tasks/${second.task}/${operation}`,
        headers(x, k),
        "POST",
        lease2,
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await persisted(x), before);
    } finally {
      x.h.close();
    }
  }
});

test("dispatch SQL: a delayed ACK or renewal loses a reused key to a later task without persistent effects", async () => {
  for (const operation of ["ack", "renew"] as const) {
    const x = await setup();
    try {
      const first = await seed(x),
        t = await claim(x),
        lease = { lease_id: t.lease_id, fence: t.fence },
        k = crypto.randomUUID();
      let arrival!: () => void, release!: () => void;
      const arrived = new Promise<void>((r) => {
          arrival = r;
        }),
        blocked = new Promise<void>((r) => {
          release = r;
        });
      x.h.db.beforeBatch = async () => {
        x.h.db.beforeBatch = undefined;
        arrival();
        await blocked;
      };
      const loser = x.h.request(
        `/v1/supervisor/tasks/${first.task}/${operation}`,
        headers(x, k),
        "POST",
        lease,
      );
      await arrived;
      assert.equal(
        (
          await x.h.request(
            `/v1/supervisor/tasks/${first.task}/settle`,
            headers(x),
            "POST",
            report({ lease }),
          )
        ).status,
        200,
      );
      const second = await seed(x),
        t2 = await claim(x),
        lease2 = { lease_id: t2.lease_id, fence: t2.fence };
      assert.equal(
        (
          await x.h.request(
            `/v1/supervisor/tasks/${second.task}/${operation}`,
            headers(x, k),
            "POST",
            lease2,
          )
        ).status,
        200,
      );
      const before = await persisted(x);
      release();
      assert.equal((await loser).status, 409);
      assert.deepEqual(await persisted(x), before);
    } finally {
      x.h.close();
    }
  }
});

test("dispatch SQL: every response path including SQL clock fallback fits D1 statement and parameter limits", async () => {
  const x = await setup();
  try {
    const v = await seed(x),
      key = crypto.randomUUID();
    const measured: Record<string, { statements: number; maxArgs: number }> =
      {};
    const bounded = async (name: string, request: () => Promise<Response>) => {
      const budget = queryBudget(x),
        response = await request(),
        result = budget();
      measured[name] = result;
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok(result.statements <= 50, JSON.stringify({ name, ...result }));
      assert.ok(result.maxArgs <= 100, JSON.stringify({ name, ...result }));
      return response;
    };
    const claimed = claimReplySchema.parse(
      await (
        await bounded("claim", () =>
          x.h.request("/v1/supervisor/claim", headers(x, key), "POST", {}),
        )
      ).json(),
    );
    assert.ok(claimed.task?.lease_id);
    const lease = {
      lease_id: claimed.task.lease_id,
      fence: claimed.task.fence,
    };
    await bounded("claim_replay", () =>
      x.h.request("/v1/supervisor/claim", headers(x, key), "POST", {}),
    );
    await bounded("empty_claim", () =>
      x.h.request("/v1/supervisor/claim", headers(x), "POST", {}),
    );
    const ackKey = crypto.randomUUID(),
      renewKey = crypto.randomUUID();
    for (const [name, k] of [
      ["ack", ackKey],
      ["renew", renewKey],
    ] as const) {
      await bounded(name, () =>
        x.h.request(
          `/v1/supervisor/tasks/${v.task}/${name}`,
          headers(x, k),
          "POST",
          lease,
        ),
      );
      await bounded(`${name}_replay`, () =>
        x.h.request(
          `/v1/supervisor/tasks/${v.task}/${name}`,
          headers(x, k),
          "POST",
          lease,
        ),
      );
    }
    await bounded("status", () =>
      x.h.request(`/v1/supervisor/tasks/${v.task}`, headers(x)),
    );
    await x.h.db
      .prepare(
        "UPDATE hosted_entitlements SET hosted_task_execution=0 WHERE organization_id=?",
      )
      .bind(x.a.tenant)
      .run();
    await bounded("stop_status", () =>
      x.h.request(`/v1/supervisor/tasks/${v.task}`, headers(x)),
    );
    const settleKey = crypto.randomUUID();
    await bounded("settle", () =>
      x.h.request(
        `/v1/supervisor/tasks/${v.task}/settle`,
        headers(x, settleKey),
        "POST",
        report({ lease }),
      ),
    );
    await bounded("settle_replay", () =>
      x.h.request(
        `/v1/supervisor/tasks/${v.task}/settle`,
        headers(x, settleKey),
        "POST",
        report({ lease }),
      ),
    );
    console.info(`dispatch response budgets: ${JSON.stringify(measured)}`);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: operator recovery requires current privileged browser, CSRF, strict proof, key, tenant and assignment", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    await x.h.request(
      `/v1/tenants/${x.a.tenant}/supervisors/${x.s.supervisor_id}`,
      { ...x.a.headers, "idempotency-key": crypto.randomUUID() },
      "DELETE",
    );
    const other = await x.h.login(200),
      path = `/v1/tenants/${x.a.tenant}/tasks/${v.task}/recover`,
      validHeaders = { ...x.a.headers, "idempotency-key": crypto.randomUUID() },
      input = {
        ...report(v),
        stop_evidence: "OS process table and watchdog inspected by operator",
      };
    const before = await persisted(x);
    for (const [route, h, data, want] of [
      [path, { ...validHeaders, "x-csrf-token": "" }, input, 403],
      [path, { ...validHeaders, "idempotency-key": "" }, input, 400],
      [path, validHeaders, { ...input, stop_confirmed: false }, 400],
      [path, validHeaders, { ...input, stop_evidence: "" }, 400],
      [
        path,
        validHeaders,
        { ...input, stop_evidence: "sfsuper_fakecredential" },
        400,
      ],
      [path, validHeaders, { ...input, extra: true }, 400],
      [path, validHeaders, { ...input, lease_id: crypto.randomUUID() }, 409],
      [path, validHeaders, { ...input, fence: input.fence + 1 }, 409],
      [
        path,
        { ...other.headers, "idempotency-key": crypto.randomUUID() },
        input,
        404,
      ],
      [
        `/v1/tenants/${other.tenant}/tasks/${v.task}/recover`,
        { ...other.headers, "idempotency-key": crypto.randomUUID() },
        input,
        404,
      ],
    ] as const) {
      assert.equal((await x.h.request(route, h, "POST", data)).status, want);
      assert.deepEqual(await persisted(x), before);
    }
    await x.h.db
      .prepare(
        "UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?",
      )
      .bind(x.a.tenant, x.a.user)
      .run();
    assert.equal(
      (await x.h.request(path, validHeaders, "POST", input)).status,
      403,
    );
    assert.deepEqual(await persisted(x), before);
    await x.h.db
      .prepare(
        "UPDATE memberships SET role='owner' WHERE organization_id=? AND user_id=?",
      )
      .bind(x.a.tenant, x.a.user)
      .run();
    let boundary: Awaited<ReturnType<typeof persisted>> | undefined;
    x.h.db.beforeBatch = async () => {
      x.h.db.beforeBatch = undefined;
      await x.h.db
        .prepare("UPDATE sessions SET revoked_at=? WHERE session_id=?")
        .bind(Date.now(), x.a.sessionId)
        .run();
      boundary = await persisted(x);
    };
    assert.equal(
      (await x.h.request(path, validHeaders, "POST", input)).status,
      409,
    );
    assert.deepEqual(await persisted(x), boundary);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: valid cleanup settles held work after worker, commercial and task-authorizer loss without new execution", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    await x.h.db
      .prepare("UPDATE hosted_tasks SET lease_expires_at=? WHERE task_id=?")
      .bind(Date.now() - 1, v.task)
      .run();
    await x.h.db
      .prepare(
        "UPDATE cloud_workers SET status='revoked',revoked_at=? WHERE worker_id=?",
      )
      .bind(Date.now(), x.w.worker_id)
      .run();
    await x.h.db
      .prepare("UPDATE sessions SET revoked_at=? WHERE session_id=?")
      .bind(Date.now(), x.a.sessionId)
      .run();
    await x.h.db
      .prepare(
        "UPDATE hosted_entitlements SET hosted_task_execution=0 WHERE organization_id=?",
      )
      .bind(x.a.tenant)
      .run();
    assert.deepEqual(await cleanupHosted(x.h.env), {
      held: [v.task],
      released: [],
    });
    const before = await persisted(x);
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/renew`,
          headers(x),
          "POST",
          v.lease,
        )
      ).status,
      401,
    );
    assert.deepEqual(await persisted(x), before);
    const status = await x.h.request(
      `/v1/supervisor/tasks/${v.task}`,
      headers(x),
    );
    assert.equal(status.status, 200);
    assert.equal(leaseReplySchema.parse(await status.json()).directive, "stop");
    const k = crypto.randomUUID();
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x, k),
          "POST",
          report(v),
        )
      ).status,
      200,
    );
    const saved = await snapshot(x, v.task);
    assert.equal(saved.task?.state, "completed");
    assert.equal(saved.outbox?.state, "dead");
    assert.equal(saved.reservation?.state, "consumed");
    assert.equal(
      saved.ledger.find((a) => a.allowance_id === v.allowance)
        ?.reserved_quantity,
      "0",
    );
    assert.equal(
      saved.ledger.find((a) => a.allowance_id === v.allowance)
        ?.consumed_quantity,
      "100",
    );
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x, k),
          "POST",
          report(v),
        )
      ).status,
      200,
    );
    assert.deepEqual(await snapshot(x, v.task), saved);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: expired supervisor credentials deny status and cleanup with zero persistent effects", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    await x.h.db
      .prepare(
        "UPDATE hosted_supervisor_credentials SET expires_at=? WHERE credential_id=?",
      )
      .bind(Date.now() - 1, x.s.credential_id)
      .run();
    const before = await persisted(x);
    assert.equal(
      (await x.h.request(`/v1/supervisor/tasks/${v.task}`, headers(x))).status,
      401,
    );
    assert.equal(
      (
        await x.h.request(
          `/v1/supervisor/tasks/${v.task}/settle`,
          headers(x),
          "POST",
          report(v),
        )
      ).status,
      401,
    );
    assert.deepEqual(await persisted(x), before);
  } finally {
    x.h.close();
  }
});

test("dispatch SQL: independently verified operator recovery fits D1 limits and settles only the revoked assignment", async () => {
  const x = await setup();
  try {
    const v = await running(x);
    assert.equal(
      (
        await x.h.request(
          `/v1/tenants/${x.a.tenant}/supervisors/${x.s.supervisor_id}`,
          { ...x.a.headers, "idempotency-key": crypto.randomUUID() },
          "DELETE",
        )
      ).status,
      200,
    );
    const budget = queryBudget(x),
      path = `/v1/tenants/${x.a.tenant}/tasks/${v.task}/recover`,
      k = crypto.randomUUID(),
      input = {
        ...report(v),
        stop_evidence:
          "Independently inspected OS process table and watchdog log",
      };
    assert.equal(
      (
        await x.h.request(
          path,
          { ...x.a.headers, "idempotency-key": k },
          "POST",
          input,
        )
      ).status,
      200,
    );
    const measured = budget();
    assert.ok(
      measured.statements <= 50 && measured.maxArgs <= 100,
      JSON.stringify(measured),
    );
    console.info(
      `dispatch operator recovery budget: ${measured.statements} statements, ${measured.maxArgs} maximum bindings`,
    );
    const saved = await persisted(x);
    assert.equal(
      (saved.hosted_tasks as Record<string, unknown>[])[0]?.state,
      "completed",
    );
    assert.equal(
      (saved.hosted_outbox as Record<string, unknown>[])[0]?.state,
      "dead",
    );
    assert.equal(
      (saved.hosted_allowances as Record<string, unknown>[])[0]
        ?.reserved_quantity,
      "0",
    );
    assert.equal(
      (saved.hosted_allowances as Record<string, unknown>[])[0]
        ?.consumed_quantity,
      "100",
    );
    assert.equal(
      (
        await x.h.request(
          path,
          { ...x.a.headers, "idempotency-key": k },
          "POST",
          input,
        )
      ).status,
      200,
    );
    assert.deepEqual(await persisted(x), saved);
  } finally {
    x.h.close();
  }
});

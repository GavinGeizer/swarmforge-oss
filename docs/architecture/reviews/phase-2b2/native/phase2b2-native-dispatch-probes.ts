import assert from "node:assert/strict";
import { cleanupIdentity } from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/src/abuse.ts";
import { hash } from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/src/crypto.ts";
import { hostedAuthorityRoute } from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/src/hosted-authority.ts";
import {
  cleanupHosted,
  hostedDispatchRoute,
  hostedRecoveryRoute,
} from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/src/hosted-dispatch.ts";
import { entitlementsRoute } from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/src/hosted-entitlements.ts";
import { supervisorRoute } from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/src/hosted-supervisors.ts";
import { claimReplySchema, leaseReplySchema } from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/src/hosted-types.ts";
import { localFixture } from "/tmp/swarmforge-phase2b2-dispatch/apps/cloud/test/local-fixture.ts";

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


{
  const x=await setup();
  try {
    const admin=await x.h.login(200);
    const now=Date.now();
    x.h.db.sqlite.query("INSERT INTO memberships VALUES(?,?,'admin','active',?,?)").run(x.a.tenant,admin.user,now,now);
    // Issue B's supervisor credential through the actual registration route;
    // only membership seeding/downgrade below uses the test database seam.
    x.s=await x.h.registerSupervisor({...admin,tenant:x.a.tenant},x.w.worker_id);
    const v=await running(x);
    x.h.db.sqlite.query("UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?").run(x.a.tenant,x.a.user);
    const before=await persisted(x);
    const r=await x.h.request(`/v1/supervisor/tasks/${v.task}/renew`,headers(x),"POST",v.lease);
    console.log(JSON.stringify({probe:"worker_enroller_loses_admin",status:r.status,response:await r.json(),persistedChanged:JSON.stringify(await persisted(x))!==JSON.stringify(before)}));
  } finally{x.h.close();}
}
{
  const x=await setup();
  try {
    const v=await seed(x);
    x.h.db.sqlite.query("UPDATE hosted_entitlements SET valid_from=valid_from-60000").run();
    const realNow=Date.now; Date.now=()=>realNow()-31000;
    let r:Response;
    try{r=await x.h.request("/v1/supervisor/claim",headers(x),"POST",{});}finally{Date.now=realNow;}
    console.log(JSON.stringify({probe:"claim_precomputed_lease_elapsed_at_election",status:r!.status,response:await r!.json(),task:x.h.db.sqlite.query("SELECT state,lease_expires_at FROM hosted_tasks").get(),outbox:x.h.db.sqlite.query("SELECT state,attempts FROM hosted_outbox").get(),operations:x.h.db.sqlite.query("SELECT count(*) n FROM hosted_operations WHERE operation='dispatch.claim'").get(),dbClock:x.h.db.sqlite.query("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) now").get()}));
  }finally{x.h.close();}
}
{
  const x=await setup();
  try{
    const v=await running(x);
    x.h.db.sqlite.query("UPDATE hosted_reservations SET quantity='1' WHERE task_id=?").run(v.task);
    const r=await x.h.request(`/v1/supervisor/tasks/${v.task}/settle`,headers(x),"POST",report(v,0));
    console.log(JSON.stringify({probe:"settlement_reservation_quantity_not_runtime",status:r.status,task:x.h.db.sqlite.query("SELECT state FROM hosted_tasks").get(),reservation:x.h.db.sqlite.query("SELECT state,quantity FROM hosted_reservations").get(),allowance:x.h.db.sqlite.query("SELECT reserved_quantity,consumed_quantity FROM hosted_allowances").get()}));
  }finally{x.h.close();}
}

{
  const x=await setup();
  try{
    const v=await seed(x);
    const before=await persisted(x);
    x.h.db.beforeBatch=async()=>{x.h.db.beforeBatch=undefined;await Bun.sleep(31050);};
    const r=await x.h.request("/v1/supervisor/claim",headers(x),"POST",{});
    console.log(JSON.stringify({probe:"claim_real_31_second_batch_delay",status:r.status,response:await r.json(),persistedChanged:JSON.stringify(await persisted(x))!==JSON.stringify(before),task:x.h.db.sqlite.query("SELECT state,lease_expires_at FROM hosted_tasks").get(),outbox:x.h.db.sqlite.query("SELECT state,attempts FROM hosted_outbox").get(),dbClock:x.h.db.sqlite.query("SELECT CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) now").get()}));
  }finally{x.h.close();}
}

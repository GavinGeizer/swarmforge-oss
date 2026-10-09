// Durable disagreement-resolution probe: forced CAS-miss interleaving on
// production settle() at exact 55faf47057bd8dc87dc996d259949251189205f1.
// READ-ONLY vs product source: imports production modules + fixture only,
// writes test D1 rows only. Preserved raw JSON written to sibling .json file
// by the runner shell (do NOT delete this probe before preservation).
//
// Disagreement: Reviewer B claims a conditional-UPDATE CAS miss inside the
// settle batch auto-aborts with zero changes (D1 batch rollback), refuting
// the lead's CAS-miss finding; B's test changed the allowance BEFORE the
// settle pre-read, so the 409 came from the preflight check, not a CAS miss.
// Lead's production handler wraps Bun SQLite db.batch in sqlite.transaction;
// the claimed repro forces reserved 10000->9000 AFTER the allowance pre-read
// and IMMEDIATELY BEFORE the batch, yielding 200/completed with ledger drift.
// This probe forces the REAL D1 interleaving: DB facade whose batch() applies
// a real UPDATE to reserved_quantity exactly once (after all pre-reads, at
// batch entry), then runs the real batch. Compares HTTP/task/reservation/
// ledger. Also: same-key double settle with both prior-SELECTs missing and
// both allowance reads barriered before either batch; authority-loss probe
// (revoked session vs live user) for claim/renew.
import { dispatchFixture, dispatchPolicy } from "./hosted-dispatch-helpers.ts";
import { hostedDispatchRoute } from "../src/hosted-dispatch.ts";

const raw = [];
const note = (k, v) => raw.push([k, v]);

const h = await dispatchFixture();
try {
  const a = await h.login();
  const worker = await h.enrolledWorker(a);
  await h.seedPolicy(a.tenant, dispatchPolicy);
  const supervisor = await h.registerSupervisor(a, worker.worker_id);
  // 10k runtime task + reservation qty 10000, controlled allowance seeded.
  const seed = await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user, {
    runtime_ms: 10000,
    controlled_duration_ms: 100,
    quantity: "10000",
    withAllowance: { allowed_quantity: "60000", reserved_quantity: "10000", consumed_quantity: "0" },
  });
  note("seed", seed);
  // Claim + ack to running via HTTP (live path).
  const claim = await h.request("/v1/supervisor/claim",
    { authorization: `Bearer ${supervisor.credential}`, "idempotency-key": crypto.randomUUID() }, "POST", {});
  note("claim-status", claim.status);
  const claimed = await claim.json();
  note("claimed-task", claimed.task);
  const lease = { lease_id: claimed.task.lease_id, fence: claimed.task.fence };
  const ack = await h.request(`/v1/supervisor/tasks/${seed.taskId}/ack`,
    { authorization: `Bearer ${supervisor.credential}`, "idempotency-key": crypto.randomUUID() }, "POST", lease);
  note("ack-status", ack.status);

  // Build a direct ctx for production settle() with a REAL-D1 batch facade:
  // pre-reads hit real D1; at batch entry, once, apply the forced
  // interleaving UPDATE reserved 10000->9000, then run the real batch.
  const { supervisorAuth } = await import("../src/hosted-supervisors.ts");
  const settleBody = { lease_id: lease.lease_id, fence: lease.fence, outcome: "completed", stop_confirmed: true, consumed_runtime_ms: 100 };
  const settleKey = crypto.randomUUID();
  const mkCtx = (dbFacade) => ({
    request: new Request(`https://api.example.invalid/v1/supervisor/tasks/${seed.taskId}/settle`, {
      method: "POST",
      headers: { authorization: `Bearer ${supervisor.credential}`, "idempotency-key": settleKey, "content-type": "application/json" },
      body: JSON.stringify(settleBody),
    }),
    env: { ...h.mf ? {} : {}, DB: dbFacade, AUTH_SECRET: "test-auth-secret-with-at-least-thirty-two-characters", APP_ORIGIN: "https://api.example.invalid", WEBSITE_ORIGIN: "https://api.example.invalid", ENVIRONMENT: "local" },
    request_id: crypto.randomUUID(), route: "probe.settle", actor: null,
  });
  const realDb = h.db;
  let injected = false;
  const facade = {
    prepare: (sql) => realDb.prepare(sql),
    batch: async (stmts) => {
      if (!injected) {
        injected = true;
        await realDb.prepare("UPDATE hosted_allowances SET reserved_quantity=? WHERE allowance_id=?").bind("9000", seed.allowanceId).run();
        note("forced-interleaving", "reserved 10000->9000 applied at batch entry, after pre-reads");
      }
      return realDb.batch(stmts);
    },
  };
  let httpStatus = null, httpBody = null;
  try {
    const resp = await hostedDispatchRoute(mkCtx(facade));
    httpStatus = resp.status;
    httpBody = await resp.json();
  } catch (e) {
    httpStatus = e.status ?? ("threw:" + (e.constructor?.name ?? typeof e));
    httpBody = { code: e.code ?? null, message: e.message ?? String(e) };
  }
  note("settle-http-status", httpStatus);
  note("settle-http-body", httpBody);
  const task = await realDb.prepare("SELECT task_id,state,supervisor_id,lease_id,fence FROM hosted_tasks WHERE task_id=?").bind(seed.taskId).first();
  const reservation = await realDb.prepare("SELECT task_id,state,quantity,consumed_quantity,consumed_runtime_ms FROM hosted_reservations WHERE task_id=?").bind(seed.taskId).first();
  const ledger = await realDb.prepare("SELECT reserved_quantity,consumed_quantity FROM hosted_allowances WHERE allowance_id=?").bind(seed.allowanceId).first();
  note("db-task", task);
  note("db-reservation", reservation);
  note("db-ledger", ledger);
  // Transaction-fact check: did terminal state land while ledger CAS missed?
  const terminalLanded = task && ["completed", "failed", "cancelled"].includes(task.state);
  note("terminal-landed", terminalLanded);
  note("verdict-hint", terminalLanded && ledger && ledger.reserved_quantity === "9000"
    ? "PARTIAL: terminal landed, ledger CAS missed (no rollback of siblings) — lead confirmed"
    : (!terminalLanded && httpStatus === 409 ? "ATOMIC: clean 409, no terminal state — B confirmed" : "MIXED: inspect raw"));

  // Second probe: two same-key settles, both prior-SELECTs missing, both
  // allowance reads barriered before either batch. (Barriered variant needs
  // a second running task; seed one.)
  const seed2 = await h.seedQueuedTask(a.tenant, supervisor.worker_id, a.user, {
    runtime_ms: 10000, controlled_duration_ms: 100, quantity: "100",
    withAllowance: undefined,
  });
  note("seed2", seed2.taskId);
} finally {
  await h.mf.dispose();
}
console.log(JSON.stringify(raw));


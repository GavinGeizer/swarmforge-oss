import { z } from "zod";
import {
  authentication,
  body,
  type Context,
  csrf,
  HttpError,
  json,
  membership,
  notFound,
} from "./common.ts";
import { hash, open, seal } from "./crypto.ts";
import {
  type HostedPrincipal,
  hostedAuth,
  hostedPrincipalGuard,
} from "./hosted-authority.ts";
import {
  activePolicyGuard,
  currentPolicy,
  evaluatePolicy,
} from "./hosted-entitlements.ts";
import {
  type AdmissionReply,
  admissionReplySchema,
  type HostedTask,
  type HostedTaskRow,
  hostedTaskSchema,
  taskSubmitSchema,
} from "./hosted-types.ts";
import { auditStatement, browserGuard, key } from "./machines.ts";
import { idSchema } from "./schemas.ts";

// Atomic hosted task admission / read / cancel.
//
// Ownership: this module only. Frozen peers (schema, hosted-types,
// authority, entitlements, supervisors, dispatch, public index, fixtures)
// are read-only imports; report to the lead before altering a shared name.
//
// All mutations run as ONE conditional D1 batch each: quota/policy/worker/
// principal checks live inside INSERT...SELECT...WHERE predicates over
// indexed state scans (never app-side counters), and every dependent write
// (reservation, outbox, meter move, audit, idempotent operation row) is
// gated on the freshly inserted task row. A racing loser writes NOTHING:
// no partial task, no phantom meter update. D1 serializes batch writes, so
// concurrent same/multi-user/multi-CLI/org requests cannot exceed caps.
//
// Meter note: quantities stay canonical bounded digit strings (DDL + Zod
// bound them to Number.MAX_SAFE_INTEGER, so in-SQL CAST arithmetic is
// exact). The check (headroom for the full runtime in a covering period)
// and the reserve (+runtime) both happen inside the SAME batch under
// serialization, which is strictly stronger than a read-then-CAS window:
// there is no stale-expected-value miss path, and a batch no-op leaves
// zero writes (equivalent to a CAS miss with no partial state).

const openStates = "'queued','claimed','running','stop_requested','held'";

const taskReadReplySchema = z.object({ task: hostedTaskSchema }).strict();

interface ResolvedPrincipal {
  kind: "account" | "execution";
  key: string;
  userId: string;
  installationId: string | null;
  grantId: string | null;
  sessionId: string | null;
  guardSql: string;
  guardArgs: (string | number)[];
}

async function resolvePrincipal(
  ctx: Context,
  tenant: string,
  csrfRequired: boolean,
): Promise<ResolvedPrincipal> {
  if (ctx.request.headers.has("authorization")) {
    // Execution-grant path. hostedAuth accepts ONLY sfexec_ (sfcli_,
    // sfworker_, sfsuper_ and global bearers are 401 here). Exact scopes
    // are verified there; every live grant carries all four task scopes.
    const p: HostedPrincipal = await hostedAuth(ctx);
    if (p.organization_id !== tenant) throw notFound();
    const guard = hostedPrincipalGuard(p);
    const session = await ctx.env.DB.prepare(
      "SELECT session_id FROM hosted_execution_grants WHERE grant_id=?",
    )
      .bind(p.grant_id)
      .first<{ session_id: string }>()
      .catch(() => null);
    return {
      kind: "execution",
      key: `execution:${p.grant_id}`,
      userId: p.user_id,
      installationId: p.installation_id,
      grantId: p.grant_id,
      sessionId: session?.session_id ?? null,
      guardSql: guard.sql,
      guardArgs: guard.args,
    };
  }
  await authentication(ctx);
  if (csrfRequired) await csrf(ctx);
  await membership(ctx, tenant);
  const s = ctx.session!;
  const guard = browserGuard(ctx, tenant, false);
  return {
    kind: "account",
    key: `account:${s.user_id}:${s.session_id}`,
    userId: s.user_id,
    installationId: null,
    grantId: null,
    sessionId: s.session_id,
    guardSql: guard.sql,
    guardArgs: guard.args,
  };
}

function projectTask(tenant: string, row: HostedTaskRow): HostedTask {
  void tenant;
  return hostedTaskSchema.parse({
    task_id: row.task_id,
    tenant_id: row.organization_id,
    worker_id: row.worker_id,
    execution_class: row.execution_class,
    state: row.state,
    reservation_id: row.reservation_id,
    policy_version: row.policy_version,
    runtime_ms: row.runtime_ms,
    controlled_duration_ms: row.controlled_duration_ms,
    created_at: row.created_at,
    deadline_at: row.deadline_at,
    lease_id: row.lease_id,
    supervisor_id: row.supervisor_id,
    fence: row.fence,
    lease_expires_at: row.lease_expires_at,
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

// --- Admission ---

async function admit(ctx: Context, tenant: string): Promise<Response> {
  const input = taskSubmitSchema.parse(await body(ctx));
  const k = key(ctx);
  const principal = await resolvePrincipal(ctx, tenant, true);
  const now = Date.now();

  // Advisory pin: newest server policy version. The batch rechecks the SAME
  // pinned row (version + all 3 caps + window + unrevoked + still newest);
  // evaluate() alone never grants authority.
  const policy = await currentPolicy(ctx, tenant, now);
  const decision = evaluatePolicy(policy, "hosted_task_execution", now);
  if (!decision.allowed)
    throw new HttpError(
      403,
      decision.denial ?? "policy_absent",
      "Execution is not entitled for this tenant",
    );
  const pinned = {
    version: policy!.version,
    hosted_control_plane: true,
    remote_worker_enrollment: true,
    hosted_task_execution: true,
  };
  if (input.runtime_ms > policy!.max_task_runtime)
    throw new HttpError(
      403,
      "runtime_exceeds_policy",
      "Requested runtime exceeds the entitled ceiling",
    );
  // Advisory worker presence; the batch rechecks liveness at mutation time.
  const workerAdvisory = await ctx.env.DB.prepare(
    "SELECT worker_id FROM cloud_workers WHERE worker_id=? AND organization_id=? AND status='registered' AND authorization_expires_at>?",
  )
    .bind(input.worker_id, tenant, now)
    .first<{ worker_id: string }>()
    .catch(() => null);
  if (!workerAdvisory) throw notFound();

  const fingerprint = await hash(
    canonical({
      operation: "task.create",
      tenant,
      request_id: input.request_id,
      worker_id: input.worker_id,
      execution_class: input.execution_class,
      runtime_ms: input.runtime_ms,
      controlled_duration_ms: input.controlled_duration_ms,
    }),
  );
  const taskId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const deadline = now + input.runtime_ms;
  const policyGuard = activePolicyGuard(tenant, pinned, now);
  const replyPreview: AdmissionReply = admissionReplySchema.parse({
    task: {
      task_id: taskId,
      tenant_id: tenant,
      worker_id: input.worker_id,
      execution_class: "controlled",
      state: "queued",
      reservation_id: reservationId,
      policy_version: pinned.version,
      runtime_ms: input.runtime_ms,
      controlled_duration_ms: input.controlled_duration_ms,
      created_at: now,
      deadline_at: deadline,
      lease_id: null,
      supervisor_id: null,
      fence: 0,
      lease_expires_at: null,
    },
    reservation_id: reservationId,
    policy_version: pinned.version,
  });
  const cipher = await seal(ctx.env.AUTH_SECRET, JSON.stringify(replyPreview));
  const payload = canonical({
    task_id: taskId,
    tenant_id: tenant,
    worker_id: input.worker_id,
    execution_class: "controlled",
    runtime_ms: input.runtime_ms,
    controlled_duration_ms: input.controlled_duration_ms,
    deadline_at: deadline,
    policy_version: pinned.version,
  });
  const meterTriple: [string, string, string] = [
    "compute_ms",
    "millisecond",
    "controlled",
  ];
  const chosenAllowance = `SELECT a2.allowance_id FROM hosted_allowances a2 WHERE a2.organization_id=? AND a2.resource=? AND a2.unit=? AND a2.resource_class=? AND a2.period_start<=? AND a2.period_end>=? ORDER BY a2.period_start ASC LIMIT 1`;

  let batch: Awaited<ReturnType<Context["env"]["DB"]["batch"]>>;
  try {
    batch = await ctx.env.DB.batch([
      // S1: conditional task insert. Quotas are indexed state scans gated
      // here (open tasks, DISTINCT open workers, active+quarantined
      // reservations vs nullable caps). Bare ON CONFLICT DO NOTHING turns
      // request-id / principal-scope / worker-exclusivity race losers into
      // no-ops instead of batch-aborting throws.
      ctx.env.DB.prepare(
        `INSERT INTO hosted_tasks(task_id,organization_id,worker_id,authorizing_user_id,installation_id,execution_grant_id,authorizing_session_id,request_id,operation,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at,lease_id,supervisor_id,fence,lease_expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'controlled','queued',?,?,?,?,?,?,NULL,NULL,0,NULL WHERE ${principal.guardSql} AND ${policyGuard.sql} AND ?<=(SELECT e.max_task_runtime FROM hosted_entitlements e WHERE e.organization_id=? AND e.version=?) AND EXISTS(SELECT 1 FROM cloud_workers w WHERE w.worker_id=? AND w.organization_id=? AND w.status='registered' AND w.authorization_expires_at>?) AND (? IS NULL OR (SELECT count(*) FROM hosted_tasks WHERE organization_id=? AND state IN (${openStates}))<?) AND (? IS NULL OR (SELECT count(DISTINCT worker_id) FROM hosted_tasks WHERE organization_id=? AND state IN (${openStates}))<?) AND (? IS NULL OR (SELECT count(*) FROM hosted_reservations WHERE organization_id=? AND state IN ('active','quarantined'))<?) AND (NOT EXISTS(SELECT 1 FROM hosted_allowances a WHERE a.organization_id=? AND a.resource=? AND a.unit=? AND a.resource_class=?) OR EXISTS(SELECT 1 FROM hosted_allowances a WHERE a.organization_id=? AND a.resource=? AND a.unit=? AND a.resource_class=? AND a.period_start<=? AND a.period_end>=? AND (CAST(a.allowed_quantity AS INTEGER)-CAST(a.reserved_quantity AS INTEGER)-CAST(a.consumed_quantity AS INTEGER))>=?)) ON CONFLICT DO NOTHING`,
      ).bind(
        taskId,
        tenant,
        input.worker_id,
        principal.userId,
        principal.installationId,
        principal.grantId,
        principal.sessionId,
        input.request_id,
        "task.create",
        principal.kind,
        principal.kind === "account"
          ? principal.sessionId!
          : principal.grantId!,
        k,
        fingerprint,
        reservationId,
        pinned.version,
        input.runtime_ms,
        input.controlled_duration_ms,
        now,
        deadline,
        ...principal.guardArgs,
        ...policyGuard.args,
        input.runtime_ms,
        tenant,
        pinned.version,
        input.worker_id,
        tenant,
        now,
        policy!.max_active_tasks,
        tenant,
        policy!.max_active_tasks,
        policy!.max_concurrent_workers,
        tenant,
        policy!.max_concurrent_workers,
        policy!.maximum_resource_reservations,
        tenant,
        policy!.maximum_resource_reservations,
        tenant,
        ...meterTriple,
        tenant,
        ...meterTriple,
        now,
        deadline,
        input.runtime_ms,
      ),
      // S2: reserve the FULL runtime against the earliest covering meter
      // row only (no meter row -> no-op). Bound <= MAX_SAFE_INTEGER by
      // DDL+Zod, so CAST arithmetic is exact; canonical strings preserved.
      ctx.env.DB.prepare(
        `UPDATE hosted_allowances SET reserved_quantity=printf('%d',CAST(reserved_quantity AS INTEGER)+?) WHERE allowance_id=(${chosenAllowance}) AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=?)`,
      ).bind(
        input.runtime_ms,
        tenant,
        ...meterTriple,
        now,
        deadline,
        taskId,
        tenant,
      ),
      // S3/S4/S5: reservation + outbox + idempotent operation row, each
      // gated on OUR fresh task_id — a race loser writes nothing here.
      ctx.env.DB.prepare(
        `INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,allowance_id,kind,worker_slots,task_slots,quantity,consumed_quantity,consumed_runtime_ms,state,created_at,expires_at,released_at) SELECT ?,?,?,?,(${chosenAllowance}),'task_execution',1,1,?,NULL,NULL,'active',?,?,NULL WHERE EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=?)`,
      ).bind(
        reservationId,
        tenant,
        taskId,
        input.worker_id,
        tenant,
        ...meterTriple,
        now,
        deadline,
        String(input.runtime_ms),
        now,
        deadline,
        taskId,
        tenant,
      ),
      ctx.env.DB.prepare(
        `INSERT INTO hosted_outbox(outbox_id,organization_id,task_id,state,payload_json,created_at,claimed_by,claim_expires_at,lease_id,fence,attempts) SELECT ?,?,?,'queued',?,?,NULL,NULL,NULL,0,0 WHERE EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=?)`,
      ).bind(outboxId, tenant, taskId, payload, now, taskId, tenant),
      ctx.env.DB.prepare(
        `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,task_id,result_ciphertext,status,created_at,expires_at) SELECT ?,?,?,NULL,'task.create',?,?,?,?,202,?,? WHERE EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=?) ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
      ).bind(
        operationId,
        tenant,
        principal.key,
        k,
        fingerprint,
        taskId,
        cipher,
        now,
        now + 86400000,
        taskId,
        tenant,
      ),
      auditStatement(
        ctx,
        "hosted.task_admitted",
        `task:${taskId}`,
        tenant,
        principal.userId,
        "FROM hosted_tasks WHERE task_id=?",
        [taskId],
      ),
      ctx.env.DB.prepare(
        `SELECT o.fingerprint AS op_fingerprint,o.task_id AS op_task,o.result_ciphertext AS op_cipher,o.status AS op_status,t.* FROM hosted_operations o JOIN hosted_tasks t ON t.task_id=o.task_id AND t.organization_id=o.organization_id WHERE o.organization_id=? AND o.principal_key=? AND o.operation='task.create' AND o.idempotency_key=?`,
      ).bind(tenant, principal.key, k),
    ]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Genuine conflict (FK/worker race) or outage: classify read-only.
    // Batch atomicity guarantees nothing was committed on throw.
    throw await diagnoseAdmission(ctx, tenant, principal, input, k, now);
  }
  const saved = batch.at(-1)?.results[0] as
    | (HostedTaskRow & {
        op_fingerprint: string;
        op_task: string;
        op_cipher: string;
        op_status: number;
      })
    | undefined;
  if (!saved)
    throw await diagnoseAdmission(ctx, tenant, principal, input, k, now);
  if (saved.op_fingerprint !== fingerprint)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key was already used with a different request",
    );
  if (saved.op_task !== taskId) {
    // Exact-key replay: recheck CURRENT authority before returning the
    // sealed winner (never allocate, never resurrect dead authority).
    const live = await ctx.env.DB.prepare(
      `SELECT (${principal.guardSql}) AS ok`,
    )
      .bind(...principal.guardArgs)
      .first<{ ok: number }>()
      .catch(() => null);
    if (!live || live.ok !== 1)
      throw new HttpError(
        409,
        "authorization_conflict",
        "Current authority no longer permits this operation",
      );
  }
  const reply = admissionReplySchema.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, saved.op_cipher)),
  );
  return json(
    admissionReplySchema,
    reply,
    saved.op_task === taskId ? 202 : 200,
  );
}

async function diagnoseAdmission(
  ctx: Context,
  tenant: string,
  principal: ResolvedPrincipal,
  input: { request_id: string; worker_id: string; runtime_ms: number },
  k: string,
  now: number,
): Promise<HttpError> {
  try {
    const org = await ctx.env.DB.prepare(
      "SELECT status FROM organizations WHERE organization_id=?",
    )
      .bind(tenant)
      .first<{ status: string }>();
    if (!org || org.status !== "active") return notFound();
    // Same request_id under any scope/key: alternate-key duplicate.
    const prior = await ctx.env.DB.prepare(
      "SELECT task_id FROM hosted_tasks WHERE organization_id=? AND request_id=?",
    )
      .bind(tenant, input.request_id)
      .first<{ task_id: string }>();
    if (prior)
      return new HttpError(
        409,
        "idempotency_conflict",
        "Request identifier is already in use",
      );
    const worker = await ctx.env.DB.prepare(
      "SELECT status,authorization_expires_at FROM cloud_workers WHERE worker_id=? AND organization_id=?",
    )
      .bind(input.worker_id, tenant)
      .first<{ status: string; authorization_expires_at: number }>();
    if (!worker) return notFound();
    if (
      worker.status !== "registered" ||
      worker.authorization_expires_at <= now
    )
      return new HttpError(
        409,
        "worker_unavailable",
        "Worker cannot accept hosted tasks",
      );
    const busy = await ctx.env.DB.prepare(
      `SELECT task_id FROM hosted_tasks WHERE organization_id=? AND worker_id=? AND state IN (${openStates}) LIMIT 1`,
    )
      .bind(tenant, input.worker_id)
      .first<{ task_id: string }>();
    if (busy)
      return new HttpError(
        409,
        "worker_busy",
        "Worker already holds an active hosted task",
      );
    const policy = await currentPolicy(ctx, tenant, Date.now());
    const decision = evaluatePolicy(
      policy,
      "hosted_task_execution",
      Date.now(),
    );
    if (!decision.allowed)
      return new HttpError(
        403,
        decision.denial ?? "policy_absent",
        "Execution is not entitled for this tenant",
      );
    if (input.runtime_ms > policy!.max_task_runtime)
      return new HttpError(
        403,
        "runtime_exceeds_policy",
        "Requested runtime exceeds the entitled ceiling",
      );
    const open = await ctx.env.DB.prepare(
      `SELECT count(*) n FROM hosted_tasks WHERE organization_id=? AND state IN (${openStates})`,
    )
      .bind(tenant)
      .first<{ n: number }>();
    if (
      policy!.max_active_tasks !== null &&
      (open?.n ?? 0) >= policy!.max_active_tasks
    )
      return new HttpError(409, "limit_exceeded", "Active task limit reached");
    const workers = await ctx.env.DB.prepare(
      `SELECT count(DISTINCT worker_id) n FROM hosted_tasks WHERE organization_id=? AND state IN (${openStates})`,
    )
      .bind(tenant)
      .first<{ n: number }>();
    if (
      policy!.max_concurrent_workers !== null &&
      (workers?.n ?? 0) >= policy!.max_concurrent_workers
    )
      return new HttpError(409, "limit_exceeded", "Worker limit reached");
    const reservations = await ctx.env.DB.prepare(
      "SELECT count(*) n FROM hosted_reservations WHERE organization_id=? AND state IN ('active','quarantined')",
    )
      .bind(tenant)
      .first<{ n: number }>();
    if (
      policy!.maximum_resource_reservations !== null &&
      (reservations?.n ?? 0) >= policy!.maximum_resource_reservations
    )
      return new HttpError(409, "limit_exceeded", "Reservation limit reached");
    const metered = await ctx.env.DB.prepare(
      "SELECT allowance_id FROM hosted_allowances WHERE organization_id=? AND resource='compute_ms' AND unit='millisecond' AND resource_class='controlled' LIMIT 1",
    )
      .bind(tenant)
      .first<{ allowance_id: string }>();
    if (metered) {
      const covered = await ctx.env.DB.prepare(
        "SELECT allowance_id FROM hosted_allowances WHERE organization_id=? AND resource='compute_ms' AND unit='millisecond' AND resource_class='controlled' AND period_start<=? AND period_end>=? AND (CAST(allowed_quantity AS INTEGER)-CAST(reserved_quantity AS INTEGER)-CAST(consumed_quantity AS INTEGER))>=? LIMIT 1",
      )
        .bind(tenant, now, now + input.runtime_ms, input.runtime_ms)
        .first<{ allowance_id: string }>();
      if (!covered) {
        const anyCovered = await ctx.env.DB.prepare(
          "SELECT allowance_id FROM hosted_allowances WHERE organization_id=? AND resource='compute_ms' AND unit='millisecond' AND resource_class='controlled' AND period_start<=? AND period_end>=? LIMIT 1",
        )
          .bind(tenant, now, now + input.runtime_ms)
          .first<{ allowance_id: string }>();
        return new HttpError(
          403,
          anyCovered ? "allowance_exhausted" : "allowance_unavailable",
          "Metered allowance cannot cover the requested runtime",
        );
      }
    }
    const live = await ctx.env.DB.prepare(
      `SELECT (${principal.guardSql}) AS ok`,
    )
      .bind(...principal.guardArgs)
      .first<{ ok: number }>();
    if (!live || live.ok !== 1)
      return new HttpError(
        409,
        "authorization_conflict",
        "Current authority no longer permits this operation",
      );
    void k;
    // No classifiable cause: genuine DB anomaly/outage. Deny, never fake
    // success (batch atomicity means nothing was committed).
    return new HttpError(
      503,
      "temporarily_unavailable",
      "Admission is temporarily unavailable",
    );
  } catch (error) {
    if (error instanceof HttpError) return error;
    return new HttpError(
      503,
      "temporarily_unavailable",
      "Admission is temporarily unavailable",
    );
  }
}

// --- Read ---

async function readTask(
  ctx: Context,
  tenant: string,
  task: string,
): Promise<Response> {
  await resolvePrincipal(ctx, tenant, false);
  const row = await ctx.env.DB.prepare(
    "SELECT * FROM hosted_tasks WHERE task_id=? AND organization_id=?",
  )
    .bind(task, tenant)
    .first<HostedTaskRow>();
  if (!row) throw notFound();
  return json(taskReadReplySchema, { task: projectTask(tenant, row) });
}

// --- Cancel ---

const terminal = new Set(["completed", "failed", "cancelled", "expired"]);

async function cancelTask(
  ctx: Context,
  tenant: string,
  task: string,
): Promise<Response> {
  z.object({})
    .strict()
    .parse(await body(ctx));
  const k = key(ctx);
  const principal = await resolvePrincipal(ctx, tenant, true);
  const now = Date.now();
  const fingerprint = await hash(
    canonical({ operation: "task.cancel", tenant, task_id: task }),
  );
  const operationId = crypto.randomUUID();

  let batch: Awaited<ReturnType<Context["env"]["DB"]["batch"]>>;
  try {
    batch = await ctx.env.DB.batch([
      // C1: idempotent cancel intent, gated on task-in-tenant + live
      // principal. NO policy/entitlement predicate: emergency cleanup must
      // work under revocation/expiry.
      ctx.env.DB.prepare(
        `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,task_id,result_ciphertext,status,created_at,expires_at) SELECT ?,?,?,?, 'task.cancel',?,?,?,NULL,202,?,? WHERE EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=?) AND ${principal.guardSql} ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
      ).bind(
        operationId,
        tenant,
        principal.key,
        task,
        k,
        fingerprint,
        task,
        now,
        now + 86400000,
        task,
        tenant,
        ...principal.guardArgs,
      ),
      // C2/C3: unclaimed, never-leased work cancels synchronously and
      // releases its reservation atomically. C3 is gated on the task having
      // reached cancelled (the unclaimed path): assigned work quarantines
      // via C7 instead and is never released here. Meter decrement (C4) is
      // cleanup-safe: no policy predicate, guarded by the release itself.
      ctx.env.DB.prepare(
        `UPDATE hosted_tasks SET state='cancelled' WHERE task_id=? AND organization_id=? AND state='queued' AND lease_id IS NULL AND supervisor_id IS NULL AND EXISTS(SELECT 1 FROM hosted_outbox WHERE task_id=hosted_tasks.task_id AND organization_id=? AND state='queued')`,
      ).bind(task, tenant, tenant),
      ctx.env.DB.prepare(
        "UPDATE hosted_reservations SET state='released',released_at=? WHERE task_id=? AND organization_id=? AND state='active' AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=? AND state='cancelled')",
      ).bind(now, task, tenant, task, tenant),
      // C4: decrement the meter ONLY when C3 flipped active->released in
      // THIS batch (changes()=1), plus fresh-op and released_at markers so
      // replays and same-ms concurrent cancels cannot double-release.
      // Quantities stay canonical strings; CAST is exact (bounded).
      ctx.env.DB.prepare(
        `UPDATE hosted_allowances SET reserved_quantity=printf('%d',CAST(reserved_quantity AS INTEGER)-(SELECT t.runtime_ms FROM hosted_tasks t WHERE t.task_id=?)) WHERE allowance_id=(SELECT r.allowance_id FROM hosted_reservations r WHERE r.task_id=? AND r.organization_id=?) AND changes()=1 AND EXISTS(SELECT 1 FROM hosted_reservations WHERE task_id=? AND organization_id=? AND state='released' AND released_at=?) AND EXISTS(SELECT 1 FROM hosted_operations WHERE operation_id=?) AND (SELECT t2.runtime_ms FROM hosted_tasks t2 WHERE t2.task_id=?)<=CAST(reserved_quantity AS INTEGER)`,
      ).bind(task, task, tenant, task, tenant, now, operationId, task),
      ctx.env.DB.prepare(
        "UPDATE hosted_outbox SET state='dead' WHERE task_id=? AND organization_id=? AND state='queued' AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=? AND state='cancelled')",
      ).bind(task, tenant, task, tenant),
      // C6/C7: assigned (claimed/running/held, or queued-but-leased) work
      // moves to stop_requested and quarantines capacity. Fence, lease,
      // supervisor assignment and outbox are RETAINED for the current
      // supervisor's trusted-stop settlement; dispatch owns lease cleanup.
      // Unclaimed tasks already flipped to cancelled above, so the two
      // paths are disjoint under serialization.
      ctx.env.DB.prepare(
        `UPDATE hosted_tasks SET state='stop_requested' WHERE task_id=? AND organization_id=? AND state IN ('queued','claimed','running','held')`,
      ).bind(task, tenant),
      ctx.env.DB.prepare(
        "UPDATE hosted_reservations SET state='quarantined' WHERE task_id=? AND organization_id=? AND state='active' AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=? AND state='stop_requested')",
      ).bind(task, tenant, task, tenant),
      auditStatement(
        ctx,
        "hosted.task_cancelled",
        `task:${task}`,
        tenant,
        principal.userId,
        "FROM hosted_operations WHERE operation_id=?",
        [operationId],
      ),
      ctx.env.DB.prepare(
        "SELECT t.*,o.fingerprint AS op_fingerprint FROM hosted_tasks t LEFT JOIN hosted_operations o ON o.organization_id=? AND o.principal_key=? AND o.operation='task.cancel' AND o.idempotency_key=? WHERE t.task_id=? AND t.organization_id=?",
      ).bind(tenant, principal.key, k, task, tenant),
    ]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw await diagnoseCancel(ctx, tenant, principal, task);
  }
  const saved = batch.at(-1)?.results[0] as
    | (HostedTaskRow & { op_fingerprint: string | null })
    | undefined;
  if (!saved) {
    // Task missing (op gated on task existence): tenant access fails 404.
    const org = await ctx.env.DB.prepare(
      "SELECT status FROM organizations WHERE organization_id=?",
    )
      .bind(tenant)
      .first<{ status: string }>()
      .catch(() => null);
    if (!org || org.status !== "active") throw notFound();
    throw notFound();
  }
  if (!saved.op_fingerprint)
    throw await diagnoseCancel(ctx, tenant, principal, task);
  if (saved.op_fingerprint !== fingerprint)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key was already used with a different request",
    );
  // Cancellation responses never promise physical termination; the state
  // machine + retained fence/lease carry the stop duty. Terminal states
  // settle to 200; outstanding stop duty returns 202.
  const current = projectTask(tenant, saved);
  return json(
    taskReadReplySchema,
    { task: current },
    terminal.has(current.state) ? 200 : 202,
  );
}

async function diagnoseCancel(
  ctx: Context,
  tenant: string,
  principal: ResolvedPrincipal,
  task: string,
): Promise<HttpError> {
  try {
    const org = await ctx.env.DB.prepare(
      "SELECT status FROM organizations WHERE organization_id=?",
    )
      .bind(tenant)
      .first<{ status: string }>();
    if (!org || org.status !== "active") return notFound();
    const row = await ctx.env.DB.prepare(
      "SELECT task_id FROM hosted_tasks WHERE task_id=? AND organization_id=?",
    )
      .bind(task, tenant)
      .first<{ task_id: string }>();
    if (!row) return notFound();
    const live = await ctx.env.DB.prepare(
      `SELECT (${principal.guardSql}) AS ok`,
    )
      .bind(...principal.guardArgs)
      .first<{ ok: number }>();
    if (!live || live.ok !== 1)
      return new HttpError(
        409,
        "authorization_conflict",
        "Current authority no longer permits this operation",
      );
    return new HttpError(
      503,
      "temporarily_unavailable",
      "Cancellation is temporarily unavailable",
    );
  } catch (error) {
    if (error instanceof HttpError) return error;
    return new HttpError(
      503,
      "temporarily_unavailable",
      "Cancellation is temporarily unavailable",
    );
  }
}

export async function hostedAdmissionRoute(
  ctx: Context,
): Promise<Response | null> {
  const url = new URL(ctx.request.url);
  const method = ctx.request.method;
  const cancel = url.pathname.match(
    /^\/v1\/tenants\/([^/]+)\/tasks\/([^/]+)\/cancel$/,
  );
  if (cancel && method === "POST") {
    z.object({}).strict().parse(Object.fromEntries(url.searchParams));
    return cancelTask(
      ctx,
      idSchema.parse(cancel[1]),
      idSchema.parse(cancel[2]),
    );
  }
  const one = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/tasks\/([^/]+)$/);
  if (one && method === "GET") {
    z.object({}).strict().parse(Object.fromEntries(url.searchParams));
    return readTask(ctx, idSchema.parse(one[1]), idSchema.parse(one[2]));
  }
  const many = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/tasks$/);
  if (many && method === "POST") {
    z.object({}).strict().parse(Object.fromEntries(url.searchParams));
    return admit(ctx, idSchema.parse(many[1]));
  }
  return null;
}

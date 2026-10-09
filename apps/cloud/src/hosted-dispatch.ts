import { z } from "zod";
import { body, type Context, HttpError, json } from "./common.ts";
import { hash, seal } from "./crypto.ts";
import {
  addQuantities,
  formatQuantity,
  isControlledMeter,
  parseQuantity,
} from "./hosted-entitlements.ts";
import {
  type HostedSupervisorPrincipal,
  type SupervisorAuthMode,
  supervisorAuth,
  supervisorGuard,
} from "./hosted-supervisors.ts";
import {
  claimReplySchema,
  type HostedTask,
  hostedTaskSchema,
  leaseReplySchema,
  leaseRequestSchema,
  settlementRequestSchema,
} from "./hosted-types.ts";
import { auditStatement, key } from "./machines.ts";
import { idSchema } from "./schemas.ts";

// Phase 2B.2 durable dispatch: supervisor-only claim/ack/renew/settle plus
// assigned-task status and server-owned expiry maintenance. Registration,
// admission, cancellation, entitlements and global routing belong to other
// owners; this module owns the outbox lease lifecycle only.
//
// Delivery model: admission-once vs network-delivery-at-least-once. The
// outbox row is the durable intent; claim elects ONE supervisor per task via
// CAS (queued -> claimed with a monotonic fence and finite lease). Ack is the
// root client's durability point (claim -> persist mapping -> ack -> start):
// a lost claim/ack reply returns the SAME lease only while still current, it
// never mints a new authoritative lease. Renewal cannot renew an expired
// lease; absolute deadlines never extend. Settlement consumes/releases the
// reservation exactly once after trusted stop confirmation. No automatic
// re-execution or reassignment for uncertain runtime: expiry holds capacity
// (quarantined) and exposes trusted cleanup work instead.

export const dispatchLeaseTtl = 30000;
export const dispatchOperationTtl = 86400000;

const emptyQuerySchema = z.object({}).strict();
const emptyBodySchema = z.object({}).strict();

const taskStatusSchema = z
  .object({
    task: hostedTaskSchema,
    directive: z.enum(["continue", "stop"]),
    server_time: z.number().int(),
  })
  .strict();

export interface DispatchTaskRow {
  task_id: string;
  organization_id: string;
  worker_id: string;
  authorizing_user_id: string;
  installation_id: string | null;
  execution_grant_id: string | null;
  state: string;
  reservation_id: string;
  policy_version: number;
  runtime_ms: number;
  controlled_duration_ms: number;
  created_at: number;
  deadline_at: number;
  lease_id: string | null;
  supervisor_id: string | null;
  fence: number;
  lease_expires_at: number | null;
}

// Task-authorizer guard: the task's recorded authorizer must STILL be live.
// Account path: authorizing user active with active membership in the active
// org. CLI path (installation, no grant): installation active with current
// user/membership/org. Execution-grant path: reuse the approved
// hostedPrincipalGuard (live grant + current installation epoch/user/window).
// A task whose authorizer lost authority can never be claimed/renewed;
// cleanup settlement tolerates authorizer loss (trusted stop reporting must
// survive) but still requires task/fence ownership.
export function taskAuthorizerGuard(
  task: DispatchTaskRow,
  now: number = Date.now(),
): { sql: string; args: (string | number)[] } {
  if (task.execution_grant_id) {
    return {
      sql: `EXISTS(SELECT 1 FROM hosted_execution_grants g JOIN cli_installations i USING(installation_id) WHERE g.grant_id=? AND g.organization_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND i.status='active' AND i.organization_id=g.organization_id AND g.epoch=i.epoch AND g.user_id=i.user_id AND g.authorization_expires_at=i.authorization_expires_at AND g.authorization_expires_at>? AND EXISTS(SELECT 1 FROM users u JOIN memberships m USING(user_id) JOIN organizations o USING(organization_id) WHERE u.user_id=g.user_id AND m.organization_id=g.organization_id AND u.status='active' AND m.status='active' AND o.status='active'))`,
      args: [task.execution_grant_id, task.organization_id, now, now],
    };
  }
  if (task.installation_id) {
    return {
      sql: `EXISTS(SELECT 1 FROM cli_installations i JOIN users u ON u.user_id=i.user_id JOIN memberships m ON m.user_id=u.user_id AND m.organization_id=i.organization_id JOIN organizations o ON o.organization_id=i.organization_id WHERE i.installation_id=? AND i.organization_id=? AND i.status='active' AND u.status='active' AND m.status='active' AND o.status='active')`,
      args: [task.installation_id, task.organization_id],
    };
  }
  return {
    sql: `EXISTS(SELECT 1 FROM users u JOIN memberships m USING(user_id) JOIN organizations o USING(organization_id) WHERE u.user_id=? AND m.organization_id=? AND u.status='active' AND m.status='active' AND o.status='active')`,
    args: [task.authorizing_user_id, task.organization_id],
  };
}

function taskProjection(row: DispatchTaskRow): HostedTask {
  return hostedTaskSchema.parse({
    task_id: row.task_id,
    tenant_id: row.organization_id,
    worker_id: row.worker_id,
    execution_class: "controlled",
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

// Stop is discoverable, never destructive: cancellation, held/quarantined
// recovery and expired policy/lease all surface directive "stop" while the
// task row keeps its authoritative state.
function directiveFor(row: DispatchTaskRow, now: number): "continue" | "stop" {
  if (
    row.state === "stop_requested" ||
    row.state === "held" ||
    row.state === "cancelled" ||
    row.state === "expired" ||
    row.deadline_at <= now
  )
    return "stop";
  return "continue";
}

// Cleanup-safe ownership guard: task belongs to this tenant + supervisor with
// the presented lease/fence. Used by status/settle in cleanup mode where
// worker revocation and commercial policy expiry are tolerated.
function ownershipGuard(
  taskId: string,
  auth: HostedSupervisorPrincipal,
  leaseId: string | null,
  fence: number | null,
) {
  let sql =
    "EXISTS(SELECT 1 FROM hosted_tasks t WHERE t.task_id=? AND t.organization_id=? AND t.supervisor_id=?";
  const args: (string | number)[] = [
    taskId,
    auth.organization_id,
    auth.supervisor_id,
  ];
  if (leaseId !== null) {
    sql += " AND t.lease_id=?";
    args.push(leaseId);
  }
  if (fence !== null) {
    sql += " AND t.fence=?";
    args.push(fence);
  }
  sql += ")";
  return { sql, args };
}

async function readTask(
  ctx: Context,
  taskId: string,
): Promise<DispatchTaskRow | null> {
  return ctx.env.DB.prepare("SELECT * FROM hosted_tasks WHERE task_id=?")
    .bind(taskId)
    .first<DispatchTaskRow>();
}

async function claim(ctx: Context, auth: HostedSupervisorPrincipal) {
  emptyBodySchema.parse(await body(ctx));
  const k = key(ctx),
    now = Date.now(),
    fp = await hash("{}"),
    principalKey = `supervisor:${auth.credential_id}`,
    guard = supervisorGuard(auth, now, "execution");
  // Candidate: oldest queued task for THIS supervisor's bound worker whose
  // outbox is queued, the worker still enrolled, and authorizer still live.
  // Read-then-CAS: the UPDATE below is the election; losers find no row and
  // fall to replay/empty.
  const candidate = await ctx.env.DB.prepare(
    `SELECT t.* FROM hosted_tasks t JOIN hosted_outbox o ON o.task_id=t.task_id AND o.organization_id=t.organization_id JOIN cloud_workers w ON w.worker_id=t.worker_id AND w.organization_id=t.organization_id WHERE t.organization_id=? AND t.worker_id=? AND t.state='queued' AND o.state='queued' AND w.status='registered' AND w.authorization_expires_at>? AND t.deadline_at>? ORDER BY o.created_at LIMIT 1`,
  )
    .bind(auth.organization_id, auth.worker_id, now, now)
    .first<DispatchTaskRow>();
  if (candidate) {
    const authorizer = taskAuthorizerGuard(candidate, now);
    const live = await ctx.env.DB.prepare(`SELECT (${authorizer.sql}) ok`)
      .bind(...authorizer.args)
      .first<{ ok: number }>();
    if (!live?.ok) {
      return json(claimReplySchema, { task: null, server_time: Date.now() });
    }
  }
  const leaseId = crypto.randomUUID(),
    opId = crypto.randomUUID();
  // The authorizer decision is pinned into the election batch: revocation
  // between the pre-read and the writes closes here, not as a TOCTOU.
  const authorizer = candidate ? taskAuthorizerGuard(candidate, now) : null;
  // CAS election: exactly one supervisor wins per task. Claimed/running work
  // also carries the worker binding so a revoked worker cannot be claimed.
  const result = await ctx.env.DB.batch(
    candidate && authorizer
      ? [
          ctx.env.DB.prepare(
            `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,task_id,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,200,?,? WHERE ${guard.sql} AND (${authorizer.sql}) ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
          ).bind(
            opId,
            auth.organization_id,
            principalKey,
            candidate.task_id,
            "dispatch.claim",
            k,
            fp,
            candidate.task_id,
            now,
            now + dispatchOperationTtl,
            ...guard.args,
            ...authorizer.args,
          ),
          ctx.env.DB.prepare(
            `UPDATE hosted_outbox SET state='claimed',claimed_by=?,claim_expires_at=?,lease_id=?,fence=fence+1,attempts=attempts+1 WHERE task_id=? AND organization_id=? AND state='queued' AND ${guard.sql} AND (${authorizer.sql})`,
          ).bind(
            auth.supervisor_id,
            now + dispatchLeaseTtl,
            leaseId,
            candidate.task_id,
            auth.organization_id,
            ...guard.args,
            ...authorizer.args,
          ),
          ctx.env.DB.prepare(
            `UPDATE hosted_tasks SET state='claimed',lease_id=?,supervisor_id=?,fence=(SELECT fence FROM hosted_outbox WHERE task_id=?),lease_expires_at=? WHERE task_id=? AND state='queued' AND EXISTS(SELECT 1 FROM hosted_outbox WHERE task_id=? AND lease_id=?) AND EXISTS(SELECT 1 FROM cloud_workers WHERE worker_id=hosted_tasks.worker_id AND organization_id=? AND status='registered') AND ${guard.sql} AND (${authorizer.sql})`,
          ).bind(
            leaseId,
            auth.supervisor_id,
            candidate.task_id,
            now + dispatchLeaseTtl,
            candidate.task_id,
            candidate.task_id,
            leaseId,
            auth.organization_id,
            ...guard.args,
            ...authorizer.args,
          ),
          auditStatement(
            ctx,
            "dispatch.claimed",
            `task:${candidate.task_id}`,
            auth.organization_id,
            auth.authorizing_user_id,
            "FROM hosted_tasks WHERE task_id=? AND state='claimed' AND supervisor_id=?",
            [candidate.task_id, auth.supervisor_id],
          ),
          ctx.env.DB.prepare(
            "SELECT * FROM hosted_tasks WHERE task_id=? AND supervisor_id=? AND lease_id=?",
          ).bind(candidate.task_id, auth.supervisor_id, leaseId),
        ]
      : [
          ctx.env.DB.prepare(
            "SELECT * FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation='dispatch.claim' AND idempotency_key=?",
          ).bind(auth.organization_id, principalKey, k),
        ],
  );
  const won = candidate
    ? (result.at(-1)?.results[0] as DispatchTaskRow | undefined)
    : undefined;
  if (won) {
    const task = taskProjection(won);
    return json(claimReplySchema, {
      task,
      server_time: Date.now(),
    });
  }
  // Lost-claim reply recovery: the same op key replays the CURRENT lease for
  // the operation's task, only while that lease is still authoritative (same
  // supervisor, unexpired, fence match). Never a new lease.
  const prior = await ctx.env.DB.prepare(
    "SELECT task_id,fingerprint FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation='dispatch.claim' AND idempotency_key=?",
  )
    .bind(auth.organization_id, principalKey, k)
    .first<{ task_id: string | null; fingerprint: string }>();
  if (prior?.task_id && prior.fingerprint === fp) {
    const current = await ctx.env.DB.prepare(
      "SELECT * FROM hosted_tasks WHERE task_id=? AND organization_id=? AND supervisor_id=? AND state IN ('claimed','running') AND lease_expires_at>?",
    )
      .bind(prior.task_id, auth.organization_id, auth.supervisor_id, Date.now())
      .first<DispatchTaskRow>();
    if (current) {
      return json(claimReplySchema, {
        task: taskProjection(current),
        server_time: Date.now(),
      });
    }
  }
  return json(claimReplySchema, { task: null, server_time: Date.now() });
}

async function ack(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  taskId: string,
) {
  const input = leaseRequestSchema.parse(await body(ctx));
  const k = key(ctx),
    now = Date.now(),
    fp = await hash(JSON.stringify(input)),
    principalKey = `supervisor:${auth.credential_id}`,
    guard = supervisorGuard(auth, now, "execution"),
    opId = crypto.randomUUID();
  const task = await readTask(ctx, taskId);
  if (!task || task.organization_id !== auth.organization_id) {
    throw new HttpError(404, "not_found", "Resource not found");
  }
  if (
    task.supervisor_id !== auth.supervisor_id ||
    task.lease_id !== input.lease_id ||
    task.fence !== input.fence
  ) {
    throw new HttpError(409, "lease_conflict", "Lease is not current");
  }
  if (task.lease_expires_at === null || task.lease_expires_at <= now) {
    throw new HttpError(409, "lease_expired", "Lease has expired");
  }
  const authorizer = taskAuthorizerGuard(task, now);
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,task_id,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,200,?,? WHERE ${guard.sql} AND (${authorizer.sql}) ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
    ).bind(
      opId,
      auth.organization_id,
      principalKey,
      taskId,
      "dispatch.ack",
      k,
      fp,
      taskId,
      now,
      now + dispatchOperationTtl,
      ...guard.args,
      ...authorizer.args,
    ),
    // Ack never reallocates: state claimed -> running on the SAME lease/fence,
    // deadline unchanged. Stale fences cannot alter task state.
    ctx.env.DB.prepare(
      `UPDATE hosted_tasks SET state='running' WHERE task_id=? AND supervisor_id=? AND lease_id=? AND fence=? AND state='claimed' AND lease_expires_at>? AND ${guard.sql} AND (${authorizer.sql})`,
    ).bind(
      taskId,
      auth.supervisor_id,
      input.lease_id,
      input.fence,
      now,
      ...guard.args,
      ...authorizer.args,
    ),
    ctx.env.DB.prepare(
      "UPDATE hosted_outbox SET state='acked' WHERE task_id=? AND lease_id=? AND fence=? AND state='claimed'",
    ).bind(taskId, input.lease_id, input.fence),
    auditStatement(
      ctx,
      "dispatch.acked",
      `task:${taskId}`,
      auth.organization_id,
      auth.authorizing_user_id,
      "FROM hosted_tasks WHERE task_id=? AND supervisor_id=? AND lease_id=?",
      [taskId, auth.supervisor_id, input.lease_id],
    ),
    ctx.env.DB.prepare(
      "SELECT fingerprint,task_id FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation='dispatch.ack' AND idempotency_key=?",
    ).bind(auth.organization_id, principalKey, k),
    ctx.env.DB.prepare("SELECT * FROM hosted_tasks WHERE task_id=?").bind(
      taskId,
    ),
  ]);
  const op = result.at(-2)?.results[0] as
    | { fingerprint: string; task_id: string }
    | undefined;
  if (!op || op.fingerprint !== fp || op.task_id !== taskId) {
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key is already used or expired",
    );
  }
  const current = result.at(-1)?.results[0] as DispatchTaskRow | undefined;
  if (!current || current.supervisor_id !== auth.supervisor_id) {
    throw new HttpError(409, "lease_conflict", "Lease is not current");
  }
  return json(leaseReplySchema, {
    task: taskProjection(current),
    directive: directiveFor(current, Date.now()),
    server_time: Date.now(),
  });
}

async function renew(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  taskId: string,
) {
  const input = leaseRequestSchema.parse(await body(ctx));
  const k = key(ctx),
    now = Date.now(),
    fp = await hash(JSON.stringify(input)),
    principalKey = `supervisor:${auth.credential_id}`,
    guard = supervisorGuard(auth, now, "execution"),
    opId = crypto.randomUUID();
  const task = await readTask(ctx, taskId);
  if (!task || task.organization_id !== auth.organization_id) {
    throw new HttpError(404, "not_found", "Resource not found");
  }
  if (
    task.supervisor_id !== auth.supervisor_id ||
    task.lease_id !== input.lease_id ||
    task.fence !== input.fence
  ) {
    throw new HttpError(409, "lease_conflict", "Lease is not current");
  }
  // Renewal cannot renew an expired lease; failed renewal triggers local stop.
  if (task.lease_expires_at === null || task.lease_expires_at <= now) {
    throw new HttpError(409, "lease_expired", "Lease has expired; stop work");
  }
  const authorizer = taskAuthorizerGuard(task, now);
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,task_id,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,200,?,? WHERE ${guard.sql} AND (${authorizer.sql}) ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
    ).bind(
      opId,
      auth.organization_id,
      principalKey,
      taskId,
      "dispatch.renew",
      k,
      fp,
      taskId,
      now,
      now + dispatchOperationTtl,
      ...guard.args,
      ...authorizer.args,
    ),
    // Finite extension of the CURRENT lease only: same lease_id, fence+1 both
    // sides, deadline never moves. Authority rechecked in-batch.
    ctx.env.DB.prepare(
      `UPDATE hosted_tasks SET fence=fence+1,lease_expires_at=? WHERE task_id=? AND supervisor_id=? AND lease_id=? AND fence=? AND state IN ('claimed','running') AND lease_expires_at>? AND deadline_at>? AND ${guard.sql} AND (${authorizer.sql})`,
    ).bind(
      now + dispatchLeaseTtl,
      taskId,
      auth.supervisor_id,
      input.lease_id,
      input.fence,
      now,
      now,
      ...guard.args,
      ...authorizer.args,
    ),
    ctx.env.DB.prepare(
      "UPDATE hosted_outbox SET fence=fence+1,claim_expires_at=? WHERE task_id=? AND lease_id=? AND fence=?",
    ).bind(now + dispatchLeaseTtl, taskId, input.lease_id, input.fence),
    auditStatement(
      ctx,
      "dispatch.renewed",
      `task:${taskId}`,
      auth.organization_id,
      auth.authorizing_user_id,
      "FROM hosted_tasks WHERE task_id=? AND supervisor_id=? AND lease_id=?",
      [taskId, auth.supervisor_id, input.lease_id],
    ),
    ctx.env.DB.prepare(
      "SELECT fingerprint,task_id FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation='dispatch.renew' AND idempotency_key=?",
    ).bind(auth.organization_id, principalKey, k),
    ctx.env.DB.prepare("SELECT * FROM hosted_tasks WHERE task_id=?").bind(
      taskId,
    ),
  ]);
  const op = result.at(-2)?.results[0] as
    | { fingerprint: string; task_id: string }
    | undefined;
  if (!op || op.fingerprint !== fp || op.task_id !== taskId) {
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key is already used or expired",
    );
  }
  const current = result.at(-1)?.results[0] as DispatchTaskRow | undefined;
  if (
    !current ||
    current.supervisor_id !== auth.supervisor_id ||
    current.lease_id !== input.lease_id
  ) {
    // Authority loss between pre-read and batch (or a concurrent fence move):
    // deny renewal so the supervisor stops. Never establish stop here.
    throw new HttpError(
      409,
      "lease_conflict",
      "Lease is not current; stop work",
    );
  }
  return json(leaseReplySchema, {
    task: taskProjection(current),
    directive: directiveFor(current, Date.now()),
    server_time: Date.now(),
  });
}

// Cleanup-safe meter settlement: read-and-CAS ALL ledger changes in the SAME
// batch and reject on miss with no partial terminal state. The foundation
// allowanceCasStatement requires a live policy window (RESERVE ONLY), so
// settlement uses its own ownership-guarded CAS: the allowance row must still
// belong to this tenant; commercial policy revocation/expiry/period-end NEVER
// blocks trusted stop settlement.
function settlementLedger(
  ctx: Context,
  allowanceId: string,
  tenant: string,
  expectedReserved: string,
  expectedConsumed: string,
  newReserved: string,
  newConsumed: string,
) {
  parseQuantity(expectedReserved);
  parseQuantity(expectedConsumed);
  parseQuantity(newReserved);
  parseQuantity(newConsumed);
  return ctx.env.DB.prepare(
    "UPDATE hosted_allowances SET reserved_quantity=?,consumed_quantity=? WHERE allowance_id=? AND organization_id=? AND reserved_quantity=? AND consumed_quantity=?",
  ).bind(
    newReserved,
    newConsumed,
    allowanceId,
    tenant,
    expectedReserved,
    expectedConsumed,
  );
}

async function settle(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  mode: SupervisorAuthMode,
  taskId: string,
) {
  const input = settlementRequestSchema.parse(await body(ctx));
  const k = key(ctx),
    now = Date.now(),
    fp = await hash(JSON.stringify(input)),
    principalKey = `supervisor:${auth.credential_id}`,
    guard = supervisorGuard(auth, now, mode),
    own = ownershipGuard(taskId, auth, input.lease_id, input.fence),
    opId = crypto.randomUUID();
  const task = await readTask(ctx, taskId);
  if (!task || task.organization_id !== auth.organization_id) {
    throw new HttpError(404, "not_found", "Resource not found");
  }
  if (
    task.supervisor_id !== auth.supervisor_id ||
    task.lease_id !== input.lease_id ||
    task.fence !== input.fence
  ) {
    throw new HttpError(409, "lease_conflict", "Lease is not current");
  }
  const terminal =
    task.state === "completed" ||
    task.state === "failed" ||
    task.state === "cancelled";
  // Duplicate terminal report with the SAME payload is idempotent; a changed
  // terminal report conflicts. Read the recorded operation first.
  const prior = await ctx.env.DB.prepare(
    "SELECT fingerprint,result_ciphertext FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation='dispatch.settle' AND idempotency_key=?",
  )
    .bind(auth.organization_id, principalKey, k)
    .first<{ fingerprint: string; result_ciphertext: string | null }>();
  if (prior) {
    if (prior.fingerprint !== fp) {
      throw new HttpError(
        409,
        "idempotency_conflict",
        "Idempotency key is already used with a different payload",
      );
    }
    if (terminal && prior.result_ciphertext) {
      return json(z.object({ task: hostedTaskSchema }).strict(), {
        task: taskProjection(task),
      });
    }
  }
  if (terminal) {
    throw new HttpError(
      409,
      "settlement_conflict",
      "Task already reached terminal state",
    );
  }
  // Bounded measured consumption: consumed_runtime_ms <= task runtime_ms, and
  // the meter delta must fit the reserved quantity. Ledger math is exact
  // BigInt strings; overflow or over-consumption rejects with no partial
  // terminal state.
  if (input.consumed_runtime_ms > task.runtime_ms) {
    throw new HttpError(
      409,
      "settlement_conflict",
      "Measured consumption exceeds task runtime",
    );
  }
  const reservation = await ctx.env.DB.prepare(
    "SELECT * FROM hosted_reservations WHERE reservation_id=? AND organization_id=? AND task_id=?",
  )
    .bind(task.reservation_id, auth.organization_id, taskId)
    .first<{
      reservation_id: string;
      organization_id: string;
      task_id: string;
      worker_id: string | null;
      allowance_id: string | null;
      quantity: string;
      state: string;
    }>();
  if (!reservation) {
    throw new HttpError(
      503,
      "temporarily_unavailable",
      "Reservation is unavailable",
    );
  }
  if (reservation.state !== "active" && reservation.state !== "quarantined") {
    throw new HttpError(
      409,
      "settlement_conflict",
      "Reservation already settled",
    );
  }
  let ledger: ReturnType<Context["env"]["DB"]["prepare"]> | null = null;
  let newReserved = "0";
  let newConsumed = "0";
  if (reservation.allowance_id) {
    const allowance = await ctx.env.DB.prepare(
      "SELECT * FROM hosted_allowances WHERE allowance_id=? AND organization_id=?",
    )
      .bind(reservation.allowance_id, auth.organization_id)
      .first<{
        allowance_id: string;
        organization_id: string;
        entitlement_id: string;
        resource: string;
        unit: string;
        resource_class: string;
        allowed_quantity: string;
        consumed_quantity: string;
        reserved_quantity: string;
      }>();
    if (
      !allowance ||
      !isControlledMeter(
        allowance.resource,
        allowance.unit,
        allowance.resource_class,
      )
    ) {
      throw new HttpError(
        503,
        "temporarily_unavailable",
        "Metered allowance is unavailable",
      );
    }
    // consumed_runtime_ms is measured milliseconds on the controlled meter:
    // consumed grows by the measured delta, reserved releases the task's
    // whole reserved quantity exactly once. consumed must stay <= reserved
    // envelope after settlement (no phantom consumption).
    const measured = formatQuantity(BigInt(input.consumed_runtime_ms));
    const reservedQty = parseQuantity(reservation.quantity);
    if (BigInt(input.consumed_runtime_ms) > reservedQty) {
      throw new HttpError(
        409,
        "settlement_conflict",
        "Measured consumption exceeds reserved quantity",
      );
    }
    // Clean 409 (not a 503 throw) when concurrent activity drained the
    // allowance below this task's reserved envelope.
    if (parseQuantity(allowance.reserved_quantity) < reservedQty) {
      throw new HttpError(
        409,
        "settlement_conflict",
        "Allowance reservation changed; settlement cannot complete",
      );
    }
    newReserved = formatQuantity(
      parseQuantity(allowance.reserved_quantity) - reservedQty,
    );
    newConsumed = addQuantities(allowance.consumed_quantity, measured);
    ledger = settlementLedger(
      ctx,
      allowance.allowance_id,
      auth.organization_id,
      allowance.reserved_quantity,
      allowance.consumed_quantity,
      newReserved,
      newConsumed,
    );
  }
  const outcomeState =
    input.outcome === "completed"
      ? "completed"
      : input.outcome === "failed"
        ? "failed"
        : "cancelled";
  // Execution settlement rechecks the CURRENT task authorizer (account user,
  // CLI installation, or live execution grant); cleanup settlement tolerates
  // authorizer loss and pins ownership only.
  const authorizer =
    mode === "execution" ? taskAuthorizerGuard(task, now) : null;
  const replyCipher = await seal(
    ctx.env.AUTH_SECRET,
    JSON.stringify({ task_id: taskId, outcome: input.outcome }),
  );
  const statements = [
    ctx.env.DB.prepare(
      `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,task_id,result_ciphertext,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,200,?,? WHERE ${guard.sql} AND (${own.sql}) ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
    ).bind(
      opId,
      auth.organization_id,
      principalKey,
      taskId,
      "dispatch.settle",
      k,
      fp,
      taskId,
      replyCipher,
      now,
      now + dispatchOperationTtl,
      ...guard.args,
      ...own.args,
    ),
    // Terminal transition fires ONLY on the current lease/fence with trusted
    // stop confirmation; stale fences cannot alter task/reservation state.
    // In execution mode the worker binding and authorizer are rechecked; in
    // cleanup mode ownership alone suffices (worker/policy may be gone).
    ...(mode === "execution" && authorizer
      ? [
          ctx.env.DB.prepare(
            `UPDATE hosted_tasks SET state=? WHERE task_id=? AND supervisor_id=? AND lease_id=? AND fence=? AND state IN ('claimed','running','stop_requested','held') AND EXISTS(SELECT 1 FROM cloud_workers WHERE worker_id=hosted_tasks.worker_id AND organization_id=? AND status='registered') AND (${authorizer.sql}) AND ${guard.sql}`,
          ).bind(
            outcomeState,
            taskId,
            auth.supervisor_id,
            input.lease_id,
            input.fence,
            auth.organization_id,
            ...authorizer.args,
            ...guard.args,
          ),
        ]
      : [
          ctx.env.DB.prepare(
            `UPDATE hosted_tasks SET state=? WHERE task_id=? AND (${own.sql}) AND state IN ('claimed','running','stop_requested','held') AND ${guard.sql}`,
          ).bind(outcomeState, taskId, ...own.args, ...guard.args),
        ]),
    ctx.env.DB.prepare(
      "UPDATE hosted_reservations SET state=?,consumed_quantity=?,consumed_runtime_ms=?,released_at=? WHERE reservation_id=? AND task_id=? AND state IN ('active','quarantined') AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND state=?)",
    ).bind(
      input.outcome === "cancelled" ? "released" : "consumed",
      formatQuantity(BigInt(input.consumed_runtime_ms)),
      input.consumed_runtime_ms,
      now,
      task.reservation_id,
      taskId,
      taskId,
      outcomeState,
    ),
    ...(ledger ? [ledger] : []),
    ctx.env.DB.prepare(
      "UPDATE hosted_outbox SET state='dead' WHERE task_id=? AND organization_id=? AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND state IN ('completed','failed','cancelled'))",
    ).bind(taskId, auth.organization_id, taskId),
    auditStatement(
      ctx,
      "dispatch.settled",
      `task:${taskId}`,
      auth.organization_id,
      auth.authorizing_user_id,
      "FROM hosted_tasks WHERE task_id=? AND state=?",
      [taskId, outcomeState],
    ),
    ctx.env.DB.prepare("SELECT * FROM hosted_tasks WHERE task_id=?").bind(
      taskId,
    ),
  ];
  const result = await ctx.env.DB.batch(statements);
  const current = result.at(-1)?.results[0] as DispatchTaskRow | undefined;
  if (!current || current.state !== outcomeState) {
    // Ledger CAS miss, concurrent fence move, or authority loss: nothing
    // terminal landed (all writes conditional on the terminal task row), so
    // surface a clean conflict with no partial state.
    throw new HttpError(
      409,
      "settlement_conflict",
      "Settlement could not complete with current authority and ledger",
    );
  }
  void newReserved;
  void newConsumed;
  return json(z.object({ task: hostedTaskSchema }).strict(), {
    task: taskProjection(current),
  });
}

async function status(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  mode: SupervisorAuthMode,
  taskId: string,
) {
  emptyQuerySchema.parse(
    Object.fromEntries(new URL(ctx.request.url).searchParams),
  );
  const task = await readTask(ctx, taskId);
  if (!task || task.organization_id !== auth.organization_id) {
    throw new HttpError(404, "not_found", "Resource not found");
  }
  // Own assignment only: the supervisor must own this task.
  if (task.supervisor_id !== auth.supervisor_id) {
    throw new HttpError(404, "not_found", "Resource not found");
  }
  // In execution mode the worker binding is rechecked; cleanup mode keeps
  // stop discoverable after worker revocation or policy expiry.
  if (mode === "execution") {
    const worker = await ctx.env.DB.prepare(
      "SELECT status FROM cloud_workers WHERE worker_id=? AND organization_id=?",
    )
      .bind(task.worker_id, auth.organization_id)
      .first<{ status: string }>();
    if (!worker || worker.status !== "registered") {
      throw new HttpError(401, "unauthenticated", "Worker is not available");
    }
  }
  return json(taskStatusSchema, {
    task: taskProjection(task),
    directive: directiveFor(task, Date.now()),
    server_time: Date.now(),
  });
}

// Server-owned expiry maintenance. Bounded for the 50-free-queries-per-
// invocation budget INCLUDING reads: each class scans at most 6 rows, held
// transitions cost 3 statements each and unclaimed releases cost 4 (the
// reservation update keys on task_id, no extra detail read). Worst case:
// 2 scans + 6*3 + 6*4 = 44 statements. The remainder waits for the next
// scheduled invocation; crash/partition recovery converges instead of
// holding work forever. Claimed/running work past lease-expiry or deadline,
// or cancelled-but-unsettled work, moves to held/stop_requested with
// quarantined reservations: capacity is retained, never released on TTL,
// and stop stays discoverable. Queued unclaimed work past deadline may
// atomically expire: task expired, reservation released, outbox dead, audit
// — all in one batch. No automatic re-execution.
export async function cleanupHosted(
  env: Context["env"],
  now: number = Date.now(),
) {
  const expired = (
    await env.DB.prepare(
      "SELECT task_id FROM hosted_tasks WHERE state IN ('claimed','running') AND (lease_expires_at<=? OR deadline_at<=?) ORDER BY deadline_at LIMIT 6",
    )
      .bind(now, now)
      .all<{ task_id: string }>()
  ).results;
  const unclaimed = (
    await env.DB.prepare(
      "SELECT task_id FROM hosted_tasks WHERE state='queued' AND deadline_at<=? ORDER BY deadline_at LIMIT 6",
    )
      .bind(now)
      .all<{ task_id: string }>()
  ).results;
  const held: string[] = [];
  for (const row of expired) {
    const result = await env.DB.batch([
      env.DB.prepare(
        "UPDATE hosted_tasks SET state='held' WHERE task_id=? AND state IN ('claimed','running') AND (lease_expires_at<=? OR deadline_at<=?)",
      ).bind(row.task_id, now, now),
      env.DB.prepare(
        "UPDATE hosted_reservations SET state='quarantined' WHERE task_id=? AND state='active' AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND state='held')",
      ).bind(row.task_id, row.task_id),
      env.DB.prepare(
        "INSERT INTO audit_events SELECT ?,?,organization_id, 'dispatch.expired',?, 'success',?,?,'{}' FROM hosted_tasks WHERE task_id=? AND state='held'",
      ).bind(
        crypto.randomUUID(),
        null,
        `task:${row.task_id}`,
        crypto.randomUUID(),
        now,
        row.task_id,
      ),
    ]);
    if (result[0]?.meta?.changes) held.push(row.task_id);
  }
  const released: string[] = [];
  for (const row of unclaimed) {
    const result = await env.DB.batch([
      env.DB.prepare(
        "UPDATE hosted_tasks SET state='expired' WHERE task_id=? AND state='queued' AND deadline_at<=?",
      ).bind(row.task_id, now),
      env.DB.prepare(
        "UPDATE hosted_reservations SET state='released',released_at=? WHERE task_id=? AND state='active' AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND state='expired')",
      ).bind(now, row.task_id, row.task_id),
      env.DB.prepare(
        "UPDATE hosted_outbox SET state='dead' WHERE task_id=? AND state='queued' AND EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND state='expired')",
      ).bind(row.task_id, row.task_id),
      env.DB.prepare(
        "INSERT INTO audit_events SELECT ?,?,?, 'dispatch.expired',?, 'success',?,?,'{}' FROM hosted_tasks WHERE task_id=? AND state='expired'",
      ).bind(
        crypto.randomUUID(),
        null,
        null,
        `task:${row.task_id}`,
        crypto.randomUUID(),
        now,
        row.task_id,
      ),
    ]);
    if (result[0]?.meta?.changes) released.push(row.task_id);
  }
  return { held, released };
}

// Trusted-operator recovery seam (concrete proposal, no new public endpoint):
// a revoked supervisor's held/quarantined task can be recovered by the tenant
// operator running a local script that (1) reads task_id + fence from audit/
// dispatch history, (2) INDEPENDENTLY verifies runtime stop out-of-band
// (ssh/host agent attestation: no supervisor process for the lease_id, fence
// recorded in the runtime watchdog log), and (3) reauthorizes a FRESH
// supervisor credential (register/rotate under owner/admin browser). The
// fresh supervisor then settles in cleanup mode with the verified fence and
// stop_confirmed:true. This keeps untrusted endpoints closed: no revoked key
// ever reports, and stop evidence is operator-verified, not self-attested.
// Operational gap: until the cancellation owner lands held-duty surfacing,
// held tasks are visible only via GET status (supervisor-scoped) and audit;
// a tenant-wide held-task listing would close the loop.

export async function hostedDispatchRoute(
  ctx: Context,
): Promise<Response | null> {
  const url = new URL(ctx.request.url),
    path = url.pathname,
    method = ctx.request.method;
  if (path === "/v1/supervisor/claim" && method === "POST") {
    emptyQuerySchema.parse(Object.fromEntries(url.searchParams));
    const auth = await supervisorAuth(ctx, "execution");
    return claim(ctx, auth);
  }
  const taskMatch = path.match(
    /^\/v1\/supervisor\/tasks\/([^/]+)(?:\/(ack|renew|settle))?$/,
  );
  if (taskMatch) {
    const taskId = idSchema.parse(taskMatch[1]);
    const op = taskMatch[2] ?? null;
    if (op === null && method === "GET") {
      emptyQuerySchema.parse(Object.fromEntries(url.searchParams));
      // Status is stop-discoverability: cleanup mode keeps it available
      // after worker revocation or commercial policy expiry. Supervisor
      // credential/authorization itself is always fully verified.
      const probe = await supervisorAuth(ctx, "cleanup");
      const worker = await ctx.env.DB.prepare(
        "SELECT status FROM cloud_workers WHERE worker_id=(SELECT worker_id FROM hosted_tasks WHERE task_id=?)",
      )
        .bind(taskId)
        .first<{ status: string }>();
      const mode: SupervisorAuthMode =
        worker && worker.status !== "registered" ? "cleanup" : "execution";
      const auth =
        mode === "execution" ? await supervisorAuth(ctx, "execution") : probe;
      return status(ctx, auth, mode, taskId);
    }
    if ((op === "ack" || op === "renew") && method === "POST") {
      const auth = await supervisorAuth(ctx, "execution");
      return op === "ack" ? ack(ctx, auth, taskId) : renew(ctx, auth, taskId);
    }
    if (op === "settle" && method === "POST") {
      // Settle mode: execution when the worker chain is live, cleanup when
      // only trusted stop reporting remains. Probe cleanup-capable auth
      // first (it verifies the supervisor credential fully), then decide.
      const probe = await supervisorAuth(ctx, "cleanup");
      const task = await readTask(ctx, taskId);
      let mode: SupervisorAuthMode = "execution";
      if (task && task.organization_id === probe.organization_id) {
        const worker = await ctx.env.DB.prepare(
          "SELECT status,authorization_expires_at FROM cloud_workers WHERE worker_id=? AND organization_id=?",
        )
          .bind(task.worker_id, probe.organization_id)
          .first<{ status: string; authorization_expires_at: number }>();
        if (
          !worker ||
          worker.status !== "registered" ||
          worker.authorization_expires_at <= Date.now()
        ) {
          mode = "cleanup";
        }
      }
      const auth =
        mode === "execution" ? await supervisorAuth(ctx, "execution") : probe;
      return settle(ctx, auth, mode, taskId);
    }
    throw new HttpError(405, "method_not_allowed", "Method is not supported");
  }
  return null;
}

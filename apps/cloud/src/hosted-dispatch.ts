import { z } from "zod";
import {
  authentication,
  body,
  type Context,
  csrf,
  HttpError,
  json,
  membership,
} from "./common.ts";
import { hash, open, seal } from "./crypto.ts";
import {
  hostedPrincipalGuard,
  hostedSqlNow as sqlNow,
} from "./hosted-authority.ts";
import {
  activePolicyGuard,
  currentPolicy,
  evaluatePolicy,
  formatQuantity,
  isControlledMeter,
  parseQuantity,
} from "./hosted-entitlements.ts";
import {
  type HostedSupervisorPrincipal,
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
import { browserGuard, key } from "./machines.ts";
import { idSchema } from "./schemas.ts";

export const dispatchLeaseTtl = 30000;
export const dispatchOperationTtl = 86400000;
export const dispatchCleanupLimit = 2;
// Two scans + at most 2 held batches (4 each) and 2 metered queued batches
// (6 each) = 22 statements. Identity cleanup costs <=11 including its probe;
// scheduled integration therefore costs <=33, below Free D1's 50 statements.
export const dispatchCleanupMaxStatements = 22;
const emptySchema = z.object({}).strict();
const taskReplySchema = z.object({ task: hostedTaskSchema }).strict();
// Election windows use the shared statement-time clock. A delayed request
// cannot gain authority from its earlier pre-read timestamp.
type SqlValue = string | number | null;
interface Guard {
  sql: string;
  args: SqlValue[];
}
export interface DispatchTaskRow {
  task_id: string;
  organization_id: string;
  worker_id: string;
  authorizing_user_id: string;
  authorizing_session_id: string | null;
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
interface OperationRow {
  operation_id: string;
  resource_id: string | null;
  task_id: string | null;
  fingerprint: string;
  result_ciphertext: string | null;
  expires_at: number;
}
interface ReservationRow {
  reservation_id: string;
  organization_id: string;
  task_id: string;
  worker_id: string | null;
  allowance_id: string | null;
  quantity: string;
  state: string;
}
interface AllowanceRow {
  allowance_id: string;
  organization_id: string;
  resource: string;
  unit: string;
  resource_class: string;
  reserved_quantity: string;
  consumed_quantity: string;
}
interface TimedTaskRow extends DispatchTaskRow {
  server_time: number;
}

// Use the approved grant predicate. A CLI grant's browser issuer session is
// audit history; account-direct execution depends on its recorded live session.
export function taskAuthorizerGuard(
  task: DispatchTaskRow,
  now = Date.now(),
): Guard {
  if (task.execution_grant_id && task.installation_id) {
    return combine(
      hostedPrincipalGuard(
        {
          grant_id: task.execution_grant_id,
          organization_id: task.organization_id,
          user_id: task.authorizing_user_id,
          installation_id: task.installation_id,
        },
        now,
      ),
      {
        sql: `EXISTS(SELECT 1 FROM hosted_execution_grants WHERE grant_id=? AND expires_at>${sqlNow} AND authorization_expires_at>${sqlNow})`,
        args: [task.execution_grant_id],
      },
    );
  }
  if (
    task.execution_grant_id ||
    task.installation_id ||
    !task.authorizing_session_id
  )
    return { sql: "0", args: [] };
  return {
    sql: `EXISTS(SELECT 1 FROM sessions s JOIN users u USING(user_id) JOIN memberships m ON m.user_id=u.user_id JOIN organizations o USING(organization_id) WHERE s.session_id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.expires_at>${sqlNow} AND u.status='active' AND m.organization_id=? AND m.status='active' AND o.status='active')`,
    args: [
      task.authorizing_session_id,
      task.authorizing_user_id,
      now,
      task.organization_id,
    ],
  };
}
function projection(t: DispatchTaskRow): HostedTask {
  return hostedTaskSchema.parse({
    task_id: t.task_id,
    tenant_id: t.organization_id,
    worker_id: t.worker_id,
    execution_class: "controlled",
    state: t.state,
    reservation_id: t.reservation_id,
    policy_version: t.policy_version,
    runtime_ms: t.runtime_ms,
    controlled_duration_ms: t.controlled_duration_ms,
    created_at: t.created_at,
    deadline_at: t.deadline_at,
    lease_id: t.lease_id,
    supervisor_id: t.supervisor_id,
    fence: t.fence,
    lease_expires_at: t.lease_expires_at,
  });
}
function conflict(code = "lease_conflict"): never {
  throw new HttpError(
    409,
    code,
    "Operation cannot complete with the current authority, lease, ledger or key",
  );
}
function sameLease(
  t: DispatchTaskRow,
  auth: HostedSupervisorPrincipal,
  input: z.infer<typeof leaseRequestSchema>,
) {
  if (
    t.supervisor_id !== auth.supervisor_id ||
    t.worker_id !== auth.worker_id ||
    t.lease_id !== input.lease_id ||
    t.fence !== input.fence
  )
    conflict();
}
function taskWitness(t: DispatchTaskRow): Guard {
  return {
    sql: "EXISTS(SELECT 1 FROM hosted_tasks t WHERE t.task_id=? AND t.organization_id=? AND t.worker_id=? AND t.authorizing_user_id=? AND t.authorizing_session_id IS ? AND t.installation_id IS ? AND t.execution_grant_id IS ? AND t.reservation_id=? AND t.policy_version=? AND t.runtime_ms=? AND t.controlled_duration_ms=? AND t.deadline_at=? AND t.state=? AND t.supervisor_id IS ? AND t.lease_id IS ? AND t.fence=? AND t.lease_expires_at IS ?)",
    args: [
      t.task_id,
      t.organization_id,
      t.worker_id,
      t.authorizing_user_id,
      t.authorizing_session_id,
      t.installation_id,
      t.execution_grant_id,
      t.reservation_id,
      t.policy_version,
      t.runtime_ms,
      t.controlled_duration_ms,
      t.deadline_at,
      t.state,
      t.supervisor_id,
      t.lease_id,
      t.fence,
      t.lease_expires_at,
    ],
  };
}
// A valid UPDATE matching zero rows does not roll back a D1 batch. The fresh
// operation INSERT is the sole election: it checks every current expectation.
// Every successor mutation requires this request's newly generated operation ID,
// so a failed election or a conflicting durable key commits zero side effects.
const elected = "EXISTS(SELECT 1 FROM hosted_operations WHERE operation_id=?)";
function combine(...guards: Guard[]): Guard {
  return {
    sql: guards.map((g) => `(${g.sql})`).join(" AND "),
    args: guards.flatMap((g) => g.args),
  };
}
function trustedSupervisorGuard(
  auth: HostedSupervisorPrincipal,
  now: number,
  mode: "execution" | "cleanup",
): Guard {
  return combine(supervisorGuard(auth, now, mode), {
    sql: `EXISTS(SELECT 1 FROM hosted_supervisor_credentials c JOIN hosted_supervisors s ON s.supervisor_id=c.supervisor_id AND s.organization_id=c.organization_id WHERE c.credential_id=? AND c.supervisor_id=? AND c.organization_id=? AND c.epoch=? AND s.worker_id=? AND s.authorizing_user_id=? AND c.expires_at>${sqlNow} AND s.authorization_expires_at>${sqlNow})`,
    args: [
      auth.credential_id,
      auth.supervisor_id,
      auth.organization_id,
      auth.epoch,
      auth.worker_id,
      auth.authorizing_user_id,
    ],
  });
}
async function readTask(ctx: Context, id: string) {
  return ctx.env.DB.prepare(
    `SELECT t.*,${sqlNow} server_time FROM hosted_tasks t WHERE task_id=?`,
  )
    .bind(id)
    .first<TimedTaskRow>();
}
async function emptyClaim(ctx: Context) {
  // Empty and stop replies also use D1's clock, after the completed election.
  const clock = await ctx.env.DB.prepare(`SELECT ${sqlNow} server_time`).first<{
    server_time: number;
  }>();
  if (!clock) throw new Error("Database clock unavailable");
  return json(claimReplySchema, { task: null, server_time: clock.server_time });
}
async function taskFor(ctx: Context, id: string, tenant: string) {
  const t = await readTask(ctx, id);
  if (!t || t.organization_id !== tenant)
    throw new HttpError(404, "not_found", "Resource not found");
  return t;
}
async function policyGuard(
  ctx: Context,
  tenant: string,
  now: number,
  runtime = 0,
): Promise<Guard> {
  const p = await currentPolicy(ctx, tenant, now);
  if (
    !p ||
    [
      "hosted_control_plane",
      "remote_worker_enrollment",
      "hosted_task_execution",
    ].some((c) => !evaluatePolicy(p, c as "hosted_task_execution", now).allowed)
  )
    conflict("policy_denied");
  return combine(
    activePolicyGuard(
      tenant,
      {
        version: p.version,
        hosted_control_plane: true,
        remote_worker_enrollment: true,
        hosted_task_execution: true,
      },
      now,
    ),
    {
      sql: `EXISTS(SELECT 1 FROM hosted_entitlements WHERE organization_id=? AND version=? AND valid_from<=${sqlNow} AND valid_until>${sqlNow} AND max_task_runtime>=?)`,
      args: [tenant, p.version, runtime],
    },
  );
}
async function executionGuard(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  t: DispatchTaskRow,
  now: number,
): Promise<Guard> {
  return combine(
    { sql: "?=?", args: [t.worker_id, auth.worker_id] },
    trustedSupervisorGuard(auth, now, "execution"),
    taskAuthorizerGuard(t, now),
    await policyGuard(ctx, auth.organization_id, now, t.runtime_ms),
    {
      sql: `EXISTS(SELECT 1 FROM cloud_workers WHERE worker_id=? AND organization_id=? AND status='registered' AND authorization_expires_at>? AND authorization_expires_at>${sqlNow})`,
      args: [t.worker_id, t.organization_id, now],
    },
  );
}
async function prior(
  ctx: Context,
  tenant: string,
  principal: string,
  operation: string,
  k: string,
) {
  return ctx.env.DB.prepare(
    "SELECT operation_id,resource_id,task_id,fingerprint,result_ciphertext,expires_at FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation=? AND idempotency_key=?",
  )
    .bind(tenant, principal, operation, k)
    .first<OperationRow>();
}
function verifyPrior(
  op: OperationRow,
  fp: string,
  resource: string | null,
  now: number,
) {
  if (
    op.fingerprint !== fp ||
    op.resource_id !== resource ||
    op.task_id !== resource ||
    op.expires_at <= now
  )
    conflict("idempotency_conflict");
}
async function operation(
  ctx: Context,
  tenant: string,
  principal: string,
  name: string,
  k: string,
  fp: string,
  resource: string | null,
  guard: Guard,
  now: number,
  cipher: string | null = null,
) {
  const id = crypto.randomUUID();
  return {
    id,
    statement: ctx.env.DB.prepare(
      `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,task_id,result_ciphertext,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,200,?,? WHERE ${guard.sql} ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
    ).bind(
      id,
      tenant,
      principal,
      resource,
      name,
      k,
      fp,
      resource,
      cipher,
      now,
      now + dispatchOperationTtl,
      ...guard.args,
    ),
  };
}
function event(
  ctx: Context,
  id: string,
  tenant: string,
  user: string | null,
  action: string,
  task: string,
  now: number,
  metadata: Record<string, unknown> = {},
) {
  return ctx.env.DB.prepare(
    `INSERT INTO audit_events(event_id,actor_user_id,organization_id,action,resource,outcome,request_id,at,metadata) SELECT ?,?,?,?,?,'success',?,?,? WHERE ${elected}`,
  ).bind(
    crypto.randomUUID(),
    user,
    tenant,
    action,
    `task:${task}`,
    ctx.request_id,
    now,
    JSON.stringify(metadata),
    id,
  );
}
async function authoritative(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  t: DispatchTaskRow,
  now: number,
) {
  if (
    !["claimed", "running"].includes(t.state) ||
    t.deadline_at <= now ||
    t.lease_expires_at === null ||
    t.lease_expires_at <= now
  )
    conflict("lease_expired");
  const g = combine(await executionGuard(ctx, auth, t, now), taskWitness(t));
  // Capture the task and server clock in the same final SQL authority read.
  const live = await ctx.env.DB.prepare(
    `SELECT t.*,${sqlNow} server_time FROM hosted_tasks t WHERE t.task_id=? AND (${g.sql}) AND t.deadline_at>${sqlNow} AND t.lease_expires_at>${sqlNow}`,
  )
    .bind(t.task_id, ...g.args)
    .first<TimedTaskRow>();
  if (!live) conflict("authority_lost");
  return live;
}
async function leaseReply(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  t: DispatchTaskRow,
) {
  const now = Date.now();
  const current = await authoritative(ctx, auth, t, now);
  return json(leaseReplySchema, {
    task: projection(current),
    directive: "continue",
    server_time: current.server_time,
  });
}

async function claim(ctx: Context, auth: HostedSupervisorPrincipal) {
  emptySchema.parse(await body(ctx));
  const k = key(ctx),
    fp = await hash("{}"),
    principal = `supervisor:${auth.credential_id}`,
    now = Date.now(),
    name = "dispatch.claim";
  const saved = await prior(ctx, auth.organization_id, principal, name, k);
  if (saved) {
    if (saved.fingerprint !== fp || saved.expires_at <= now)
      conflict("idempotency_conflict");
    if (!saved.task_id) return emptyClaim(ctx);
    const t = await taskFor(ctx, saved.task_id, auth.organization_id);
    if (!["claimed", "running"].includes(t.state)) return emptyClaim(ctx);
    if (t.supervisor_id !== auth.supervisor_id) conflict();
    await verifyClaimLease(ctx, saved, t);
    const current = await authoritative(ctx, auth, t, now);
    return json(claimReplySchema, {
      task: projection(current),
      server_time: current.server_time,
    });
  }
  const p = await policyGuard(ctx, auth.organization_id, now);
  const t = await ctx.env.DB.prepare(
    "SELECT t.* FROM hosted_tasks t JOIN hosted_outbox o ON o.task_id=t.task_id AND o.organization_id=t.organization_id WHERE t.organization_id=? AND t.worker_id=? AND t.state='queued' AND t.lease_id IS NULL AND t.supervisor_id IS NULL AND o.state='queued' AND t.deadline_at>? ORDER BY o.created_at,t.task_id LIMIT 1",
  )
    .bind(auth.organization_id, auth.worker_id, now)
    .first<DispatchTaskRow>();
  const lease = crypto.randomUUID(),
    expires = t ? Math.min(t.deadline_at, now + dispatchLeaseTtl) : 0;
  const g = t
    ? combine(await executionGuard(ctx, auth, t, now), taskWitness(t), {
        sql: `EXISTS(SELECT 1 FROM hosted_outbox o JOIN hosted_tasks t ON t.task_id=o.task_id AND t.organization_id=o.organization_id WHERE o.task_id=? AND o.organization_id=? AND o.state='queued' AND o.lease_id IS NULL AND o.claimed_by IS NULL AND o.fence=? AND o.fence<9007199254740991 AND o.attempts<9007199254740991 AND t.deadline_at>${sqlNow})`,
        args: [t.task_id, t.organization_id, t.fence],
      })
    : combine(trustedSupervisorGuard(auth, now, "execution"), p);
  const op = await operation(
    ctx,
    auth.organization_id,
    principal,
    name,
    k,
    fp,
    t?.task_id ?? null,
    g,
    now,
    t
      ? await seal(
          ctx.env.AUTH_SECRET,
          JSON.stringify({ lease_id: lease, fence: t.fence + 1 }),
        )
      : null,
  );
  const ss = [op.statement];
  if (t)
    ss.push(
      ctx.env.DB.prepare(
        `UPDATE hosted_tasks SET state='claimed',supervisor_id=?,lease_id=?,fence=fence+1,lease_expires_at=? WHERE task_id=? AND organization_id=? AND ${elected}`,
      ).bind(
        auth.supervisor_id,
        lease,
        expires,
        t.task_id,
        t.organization_id,
        op.id,
      ),
      ctx.env.DB.prepare(
        `UPDATE hosted_outbox SET state='claimed',claimed_by=?,lease_id=?,fence=fence+1,claim_expires_at=?,attempts=attempts+1 WHERE task_id=? AND organization_id=? AND ${elected}`,
      ).bind(
        auth.supervisor_id,
        lease,
        expires,
        t.task_id,
        t.organization_id,
        op.id,
      ),
      event(
        ctx,
        op.id,
        t.organization_id,
        auth.authorizing_user_id,
        "dispatch.claimed",
        t.task_id,
        now,
      ),
    );
  const results = await ctx.env.DB.batch(ss);
  const stored = await prior(ctx, auth.organization_id, principal, name, k);
  if (!stored) {
    if (t) return emptyClaim(ctx);
    conflict("authority_lost");
  }
  if (stored.fingerprint !== fp || stored.expires_at <= Date.now())
    conflict("idempotency_conflict");
  if (!stored.task_id) return emptyClaim(ctx);
  const current = await taskFor(ctx, stored.task_id, auth.organization_id);
  // A concurrent loser on a different principal observes empty work. A same-key
  // loser may replay the elected assignment; it never writes its candidate.
  if (
    !results[0]?.meta.changes &&
    stored.operation_id !== op.id &&
    stored.resource_id !== t?.task_id
  )
    conflict("idempotency_conflict");
  if (!["claimed", "running"].includes(current.state)) return emptyClaim(ctx);
  if (current.supervisor_id !== auth.supervisor_id) conflict();
  await verifyClaimLease(ctx, stored, current);
  const live = await authoritative(ctx, auth, current, Date.now());
  return json(claimReplySchema, {
    task: projection(live),
    server_time: live.server_time,
  });
}
async function verifyClaimLease(
  ctx: Context,
  op: OperationRow,
  t: DispatchTaskRow,
) {
  if (op.resource_id !== t.task_id || !op.result_ciphertext)
    conflict("idempotency_conflict");
  const recorded = leaseRequestSchema.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, op.result_ciphertext)),
  );
  if (recorded.lease_id !== t.lease_id || recorded.fence !== t.fence)
    conflict();
}
async function advance(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  id: string,
  kind: "ack" | "renew",
) {
  const input = leaseRequestSchema.parse(await body(ctx)),
    k = key(ctx),
    fp = await hash(JSON.stringify(input)),
    principal = `supervisor:${auth.credential_id}`,
    name = `dispatch.${kind}`,
    now = Date.now();
  const t = await taskFor(ctx, id, auth.organization_id);
  sameLease(t, auth, input);
  const saved = await prior(ctx, auth.organization_id, principal, name, k);
  if (saved) {
    verifyPrior(saved, fp, id, now);
    return leaseReply(ctx, auth, t);
  }
  if (
    t.lease_expires_at === null ||
    t.lease_expires_at <= now ||
    t.deadline_at <= now
  )
    conflict("lease_expired");
  if (
    !(kind === "ack"
      ? t.state === "claimed"
      : ["claimed", "running"].includes(t.state))
  )
    conflict();
  const g = combine(
    taskWitness(t),
    await executionGuard(ctx, auth, t, now),
    {
      sql: "EXISTS(SELECT 1 FROM hosted_outbox WHERE task_id=? AND organization_id=? AND claimed_by=? AND lease_id=? AND fence=? AND state IN ('claimed','acked'))",
      args: [
        id,
        t.organization_id,
        auth.supervisor_id,
        input.lease_id,
        input.fence,
      ],
    },
    {
      sql: `EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=? AND lease_expires_at>${sqlNow} AND deadline_at>${sqlNow})`,
      args: [id, t.organization_id],
    },
  );
  const expires = Math.min(t.deadline_at, now + dispatchLeaseTtl);
  const op = await operation(
    ctx,
    t.organization_id,
    principal,
    name,
    k,
    fp,
    id,
    g,
    now,
  );
  await ctx.env.DB.batch([
    op.statement,
    kind === "ack"
      ? ctx.env.DB.prepare(
          `UPDATE hosted_tasks SET state='running' WHERE task_id=? AND organization_id=? AND ${elected}`,
        ).bind(id, t.organization_id, op.id)
      : ctx.env.DB.prepare(
          `UPDATE hosted_tasks SET lease_expires_at=? WHERE task_id=? AND organization_id=? AND ${elected}`,
        ).bind(expires, id, t.organization_id, op.id),
    kind === "ack"
      ? ctx.env.DB.prepare(
          `UPDATE hosted_outbox SET state='acked' WHERE task_id=? AND organization_id=? AND ${elected}`,
        ).bind(id, t.organization_id, op.id)
      : ctx.env.DB.prepare(
          `UPDATE hosted_outbox SET claim_expires_at=? WHERE task_id=? AND organization_id=? AND ${elected}`,
        ).bind(expires, id, t.organization_id, op.id),
    event(
      ctx,
      op.id,
      t.organization_id,
      auth.authorizing_user_id,
      kind === "ack" ? "dispatch.acked" : "dispatch.renewed",
      id,
      now,
    ),
  ]);
  const electedOp = await prior(ctx, t.organization_id, principal, name, k);
  if (!electedOp) conflict("authority_lost");
  verifyPrior(electedOp, fp, id, Date.now());
  const current = await taskFor(ctx, id, t.organization_id);
  sameLease(current, auth, input);
  return leaseReply(ctx, auth, current);
}
interface SettlementPlan {
  reservation: ReservationRow;
  allowance: AllowanceRow | null;
  newReserved: string;
  newConsumed: string;
  guard: Guard;
}
async function settlementPlan(
  ctx: Context,
  t: DispatchTaskRow,
  consumption: number,
): Promise<SettlementPlan> {
  if (consumption > t.runtime_ms) conflict("settlement_conflict");
  const r = await ctx.env.DB.prepare(
    "SELECT * FROM hosted_reservations WHERE reservation_id=? AND organization_id=? AND task_id=?",
  )
    .bind(t.reservation_id, t.organization_id, t.task_id)
    .first<ReservationRow>();
  if (!r || !["active", "quarantined"].includes(r.state))
    conflict("settlement_conflict");
  const quantity = parseQuantity(r.quantity),
    measured = BigInt(consumption);
  if (measured > quantity) conflict("settlement_conflict");
  const guards: Guard[] = [
    {
      sql: "EXISTS(SELECT 1 FROM hosted_reservations WHERE reservation_id=? AND organization_id=? AND task_id=? AND worker_id IS ? AND allowance_id IS ? AND quantity=? AND state=?)",
      args: [
        r.reservation_id,
        r.organization_id,
        r.task_id,
        r.worker_id,
        r.allowance_id,
        r.quantity,
        r.state,
      ],
    },
  ];
  let a: AllowanceRow | null = null,
    newReserved = "0",
    newConsumed = "0";
  if (r.allowance_id) {
    a = await ctx.env.DB.prepare(
      "SELECT * FROM hosted_allowances WHERE allowance_id=? AND organization_id=?",
    )
      .bind(r.allowance_id, t.organization_id)
      .first<AllowanceRow>();
    if (!a || !isControlledMeter(a.resource, a.unit, a.resource_class))
      conflict("settlement_conflict");
    if (parseQuantity(a.reserved_quantity) < quantity)
      conflict("settlement_conflict");
    newReserved = formatQuantity(parseQuantity(a.reserved_quantity) - quantity);
    newConsumed = formatQuantity(parseQuantity(a.consumed_quantity) + measured);
    guards.push({
      sql: "EXISTS(SELECT 1 FROM hosted_allowances WHERE allowance_id=? AND organization_id=? AND resource=? AND unit=? AND resource_class=? AND reserved_quantity=? AND consumed_quantity=?)",
      args: [
        a.allowance_id,
        a.organization_id,
        a.resource,
        a.unit,
        a.resource_class,
        a.reserved_quantity,
        a.consumed_quantity,
      ],
    });
  }
  guards.push({
    sql: "EXISTS(SELECT 1 FROM hosted_outbox WHERE task_id=? AND organization_id=? AND claimed_by IS ? AND lease_id IS ? AND fence=? AND state IN ('claimed','acked'))",
    args: [t.task_id, t.organization_id, t.supervisor_id, t.lease_id, t.fence],
  });
  return {
    reservation: r,
    allowance: a,
    newReserved,
    newConsumed,
    guard: combine(...guards),
  };
}
function settlementStatements(
  ctx: Context,
  t: DispatchTaskRow,
  plan: SettlementPlan,
  id: string,
  input: z.infer<typeof settlementRequestSchema>,
  now: number,
) {
  const r = plan.reservation;
  const ss = [
    ctx.env.DB.prepare(
      `UPDATE hosted_tasks SET state=? WHERE task_id=? AND organization_id=? AND ${elected}`,
    ).bind(input.outcome, t.task_id, t.organization_id, id),
    ctx.env.DB.prepare(
      `UPDATE hosted_reservations SET state=?,consumed_quantity=?,consumed_runtime_ms=?,released_at=? WHERE reservation_id=? AND organization_id=? AND task_id=? AND ${elected}`,
    ).bind(
      input.outcome === "cancelled" ? "released" : "consumed",
      formatQuantity(BigInt(input.consumed_runtime_ms)),
      input.consumed_runtime_ms,
      now,
      r.reservation_id,
      t.organization_id,
      t.task_id,
      id,
    ),
  ];
  if (plan.allowance)
    ss.push(
      ctx.env.DB.prepare(
        `UPDATE hosted_allowances SET reserved_quantity=?,consumed_quantity=? WHERE allowance_id=? AND organization_id=? AND ${elected}`,
      ).bind(
        plan.newReserved,
        plan.newConsumed,
        plan.allowance.allowance_id,
        t.organization_id,
        id,
      ),
    );
  ss.push(
    ctx.env.DB.prepare(
      `UPDATE hosted_outbox SET state='dead' WHERE task_id=? AND organization_id=? AND ${elected}`,
    ).bind(t.task_id, t.organization_id, id),
  );
  return ss;
}
async function settle(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  id: string,
) {
  const input = settlementRequestSchema.parse(await body(ctx)),
    k = key(ctx),
    fp = await hash(JSON.stringify(input)),
    principal = `supervisor:${auth.credential_id}`,
    name = "dispatch.settle",
    now = Date.now();
  const t = await taskFor(ctx, id, auth.organization_id);
  sameLease(t, auth, input);
  const saved = await prior(ctx, t.organization_id, principal, name, k);
  if (saved) {
    verifyPrior(saved, fp, id, now);
    if (t.state !== input.outcome) conflict("settlement_conflict");
    return json(taskReplySchema, { task: projection(t) });
  }
  if (!["claimed", "running", "held", "stop_requested"].includes(t.state))
    conflict("settlement_conflict");
  // Cleanup always verifies CURRENT trusted supervisor authority. Commercial,
  // task-authorizer and worker loss cannot prevent verified physical-stop reporting.
  const plan = await settlementPlan(ctx, t, input.consumed_runtime_ms),
    g = combine(
      trustedSupervisorGuard(auth, now, "cleanup"),
      taskWitness(t),
      plan.guard,
    ),
    op = await operation(
      ctx,
      t.organization_id,
      principal,
      name,
      k,
      fp,
      id,
      g,
      now,
    );
  await ctx.env.DB.batch([
    op.statement,
    ...settlementStatements(ctx, t, plan, op.id, input, now),
    event(
      ctx,
      op.id,
      t.organization_id,
      auth.authorizing_user_id,
      "dispatch.settled",
      id,
      now,
      {
        outcome: input.outcome,
        consumed_runtime_ms: input.consumed_runtime_ms,
        lease_id: input.lease_id,
        fence: input.fence,
      },
    ),
  ]);
  const stored = await prior(ctx, t.organization_id, principal, name, k);
  if (!stored) conflict("settlement_conflict");
  verifyPrior(stored, fp, id, Date.now());
  const current = await taskFor(ctx, id, t.organization_id);
  sameLease(current, auth, input);
  if (current.state !== input.outcome) conflict("settlement_conflict");
  return json(taskReplySchema, { task: projection(current) });
}
async function status(
  ctx: Context,
  auth: HostedSupervisorPrincipal,
  id: string,
) {
  let t = await taskFor(ctx, id, auth.organization_id);
  if (t.supervisor_id !== auth.supervisor_id)
    throw new HttpError(404, "not_found", "Resource not found");
  let directive: "continue" | "stop" = "stop";
  try {
    t = await authoritative(ctx, auth, t, Date.now());
    directive = "continue";
  } catch {
    // A missing, failed or malformed policy cannot hide trusted stop duty.
    directive = "stop";
    t = await taskFor(ctx, id, auth.organization_id);
    if (t.supervisor_id !== auth.supervisor_id)
      throw new HttpError(404, "not_found", "Resource not found");
  }
  return json(leaseReplySchema, {
    task: projection(t),
    directive,
    server_time: t.server_time,
  });
}

export const hostedRecoveryRequestSchema = settlementRequestSchema
  .extend({
    stop_evidence: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (v) =>
          !/(?:sfsuper_|sfexec_|sfcli_|sfworker_|Bearer\s)[A-Za-z0-9_-]+/i.test(
            v,
          ) &&
          Array.from(v).every(
            (c) => c.charCodeAt(0) >= 32 || c === "\n" || c === "\t",
          ),
        "Stop evidence must be nonsecret text",
      ),
  })
  .strict();
function recoverable(t: DispatchTaskRow, now: number): Guard {
  return {
    sql: "EXISTS(SELECT 1 FROM hosted_tasks t JOIN hosted_supervisors s ON s.supervisor_id=t.supervisor_id AND s.organization_id=t.organization_id WHERE t.task_id=? AND t.organization_id=? AND t.state IN ('held','stop_requested') AND t.lease_id=? AND t.fence=? AND (t.lease_expires_at<=? OR t.deadline_at<=? OR s.status='revoked' OR s.revoked_at IS NOT NULL OR s.authorization_expires_at<=? OR NOT EXISTS(SELECT 1 FROM hosted_supervisor_credentials c WHERE c.supervisor_id=s.supervisor_id AND c.organization_id=s.organization_id AND c.epoch=s.epoch AND c.revoked_at IS NULL AND c.expires_at>?)))",
    args: [
      t.task_id,
      t.organization_id,
      t.lease_id,
      t.fence,
      now,
      now,
      now,
      now,
    ],
  };
}
export async function hostedRecoveryRoute(
  ctx: Context,
): Promise<Response | null> {
  const url = new URL(ctx.request.url),
    match = url.pathname.match(
      /^\/v1\/tenants\/([^/]+)\/tasks\/([^/]+)\/recover$/,
    );
  if (!match) return null;
  if (ctx.request.method !== "POST")
    throw new HttpError(405, "method_not_allowed", "Method is not supported");
  emptySchema.parse(Object.fromEntries(url.searchParams));
  const tenant = idSchema.parse(match[1]),
    id = idSchema.parse(match[2]);
  await authentication(ctx);
  await membership(ctx, tenant, true);
  await csrf(ctx);
  const input = hostedRecoveryRequestSchema.parse(await body(ctx)),
    k = key(ctx),
    fp = await hash(JSON.stringify(input)),
    now = Date.now(),
    principal = `session:${ctx.session!.session_id}`,
    name = "dispatch.recover",
    t = await taskFor(ctx, id, tenant);
  if (t.lease_id !== input.lease_id || t.fence !== input.fence) conflict();
  const saved = await prior(ctx, tenant, principal, name, k);
  if (saved) {
    verifyPrior(saved, fp, id, now);
    if (t.state !== input.outcome) conflict("settlement_conflict");
    return json(taskReplySchema, { task: projection(t) });
  }
  if (!["held", "stop_requested"].includes(t.state))
    conflict("recovery_conflict");
  const plan = await settlementPlan(ctx, t, input.consumed_runtime_ms),
    op = await operation(
      ctx,
      tenant,
      principal,
      name,
      k,
      fp,
      id,
      combine(
        browserGuard(ctx, tenant, true),
        {
          sql: `EXISTS(SELECT 1 FROM sessions WHERE session_id=? AND user_id=? AND expires_at>${sqlNow})`,
          args: [ctx.session!.session_id, ctx.session!.user_id],
        },
        taskWitness(t),
        recoverable(t, now),
        plan.guard,
      ),
      now,
    );
  await ctx.env.DB.batch([
    op.statement,
    ...settlementStatements(ctx, t, plan, op.id, input, now),
    event(
      ctx,
      op.id,
      tenant,
      ctx.session!.user_id,
      "dispatch.operator_recovered",
      id,
      now,
      {
        assertion: "operator_verified_os_stop",
        stop_evidence: input.stop_evidence,
        outcome: input.outcome,
        consumed_runtime_ms: input.consumed_runtime_ms,
        lease_id: input.lease_id,
        fence: input.fence,
      },
    ),
  ]);
  const stored = await prior(ctx, tenant, principal, name, k);
  if (!stored) conflict("recovery_conflict");
  verifyPrior(stored, fp, id, Date.now());
  const current = await taskFor(ctx, id, tenant);
  if (current.state !== input.outcome) conflict("recovery_conflict");
  return json(taskReplySchema, { task: projection(current) });
}

interface CleanupRow extends DispatchTaskRow {
  reservation_state: string;
  quantity: string;
  allowance_id: string | null;
  reserved_quantity: string | null;
  consumed_quantity: string | null;
  resource: string | null;
  unit: string | null;
  resource_class: string | null;
  outbox_state: string;
  outbox_fence: number;
  outbox_lease: string | null;
  outbox_supervisor: string | null;
}
const cleanupSelect =
  "SELECT t.*,r.state reservation_state,r.quantity,r.allowance_id,a.reserved_quantity,a.consumed_quantity,a.resource,a.unit,a.resource_class,o.state outbox_state,o.fence outbox_fence,o.lease_id outbox_lease,o.claimed_by outbox_supervisor FROM hosted_tasks t JOIN hosted_reservations r ON r.task_id=t.task_id AND r.organization_id=t.organization_id JOIN hosted_outbox o ON o.task_id=t.task_id AND o.organization_id=t.organization_id LEFT JOIN hosted_allowances a ON a.allowance_id=r.allowance_id AND a.organization_id=t.organization_id";
export async function cleanupHosted(env: Context["env"], now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid cleanup boundary");
  const heldRows = (
    await env.DB.prepare(
      `${cleanupSelect} WHERE t.state IN ('claimed','running','stop_requested') AND (t.lease_expires_at<=? OR t.deadline_at<=? OR EXISTS(SELECT 1 FROM hosted_supervisors s WHERE s.supervisor_id=t.supervisor_id AND (s.status='revoked' OR s.authorization_expires_at<=?))) AND r.state='active' ORDER BY t.deadline_at,t.task_id LIMIT ${dispatchCleanupLimit}`,
    )
      .bind(now, now, now)
      .all<CleanupRow>()
  ).results;
  const queuedRows = (
    await env.DB.prepare(
      `${cleanupSelect} WHERE t.state='queued' AND t.lease_id IS NULL AND t.supervisor_id IS NULL AND t.deadline_at<=? AND r.state='active' AND o.state='queued' ORDER BY t.deadline_at,t.task_id LIMIT ${dispatchCleanupLimit}`,
    )
      .bind(now)
      .all<CleanupRow>()
  ).results;
  const held: string[] = [],
    released: string[] = [];
  const ctx = { env, request_id: crypto.randomUUID() } as Context;
  for (const t of [...heldRows, ...queuedRows]) {
    const queued = t.state === "queued";
    let newReserved: string | null = null;
    const guards = [
      taskWitness(t),
      queued
        ? ({
            sql: "EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND organization_id=? AND deadline_at<=? AND lease_id IS NULL AND supervisor_id IS NULL)",
            args: [t.task_id, t.organization_id, now],
          } as Guard)
        : ({
            sql: "EXISTS(SELECT 1 FROM hosted_tasks t WHERE t.task_id=? AND t.organization_id=? AND (t.lease_expires_at<=? OR t.deadline_at<=? OR EXISTS(SELECT 1 FROM hosted_supervisors s WHERE s.supervisor_id=t.supervisor_id AND s.organization_id=t.organization_id AND (s.status='revoked' OR s.authorization_expires_at<=?))))",
            args: [t.task_id, t.organization_id, now, now, now],
          } as Guard),
      {
        sql: "EXISTS(SELECT 1 FROM hosted_reservations WHERE reservation_id=? AND organization_id=? AND task_id=? AND state='active' AND allowance_id IS ? AND quantity=?)",
        args: [
          t.reservation_id,
          t.organization_id,
          t.task_id,
          t.allowance_id,
          t.quantity,
        ],
      } as Guard,
      {
        sql: "EXISTS(SELECT 1 FROM hosted_outbox WHERE task_id=? AND organization_id=? AND state=? AND fence=? AND lease_id IS ? AND claimed_by IS ?)",
        args: [
          t.task_id,
          t.organization_id,
          t.outbox_state,
          t.outbox_fence,
          t.outbox_lease,
          t.outbox_supervisor,
        ],
      } as Guard,
    ];
    if (queued && t.allowance_id) {
      if (
        t.reserved_quantity === null ||
        t.consumed_quantity === null ||
        !isControlledMeter(
          t.resource ?? "",
          t.unit ?? "",
          t.resource_class ?? "",
        )
      )
        continue;
      const quantity = parseQuantity(t.quantity),
        reserved = parseQuantity(t.reserved_quantity);
      if (reserved < quantity) continue;
      newReserved = formatQuantity(reserved - quantity);
      guards.push({
        sql: "EXISTS(SELECT 1 FROM hosted_allowances WHERE allowance_id=? AND organization_id=? AND reserved_quantity=? AND consumed_quantity=? AND resource='compute_ms' AND unit='millisecond' AND resource_class='controlled')",
        args: [
          t.allowance_id,
          t.organization_id,
          t.reserved_quantity,
          t.consumed_quantity,
        ],
      });
    }
    const op = await operation(
      ctx,
      t.organization_id,
      "maintenance",
      "dispatch.expire",
      crypto.randomUUID(),
      await hash(
        JSON.stringify({
          task_id: t.task_id,
          state: t.state,
          lease_id: t.lease_id,
          fence: t.fence,
        }),
      ),
      t.task_id,
      combine(...guards),
      now,
    );
    const ss = [
      op.statement,
      env.DB.prepare(
        `UPDATE hosted_tasks SET state=? WHERE task_id=? AND organization_id=? AND ${elected}`,
      ).bind(queued ? "expired" : "held", t.task_id, t.organization_id, op.id),
      env.DB.prepare(
        `UPDATE hosted_reservations SET state=?,released_at=? WHERE reservation_id=? AND organization_id=? AND task_id=? AND ${elected}`,
      ).bind(
        queued ? "released" : "quarantined",
        queued ? now : null,
        t.reservation_id,
        t.organization_id,
        t.task_id,
        op.id,
      ),
    ];
    if (queued) {
      if (t.allowance_id)
        ss.push(
          env.DB.prepare(
            `UPDATE hosted_allowances SET reserved_quantity=? WHERE allowance_id=? AND organization_id=? AND ${elected}`,
          ).bind(newReserved, t.allowance_id, t.organization_id, op.id),
        );
      ss.push(
        env.DB.prepare(
          `UPDATE hosted_outbox SET state='dead' WHERE task_id=? AND organization_id=? AND ${elected}`,
        ).bind(t.task_id, t.organization_id, op.id),
      );
    }
    ss.push(
      event(
        ctx,
        op.id,
        t.organization_id,
        null,
        "dispatch.expired",
        t.task_id,
        now,
      ),
    );
    const result = await env.DB.batch(ss);
    if (result[0]?.meta.changes) (queued ? released : held).push(t.task_id);
  }
  return { held, released };
}
export async function hostedDispatchRoute(
  ctx: Context,
): Promise<Response | null> {
  const url = new URL(ctx.request.url),
    path = url.pathname,
    method = ctx.request.method;
  if (path === "/v1/supervisor/claim" && method === "POST") {
    emptySchema.parse(Object.fromEntries(url.searchParams));
    return claim(ctx, await supervisorAuth(ctx, "execution"));
  }
  const match = path.match(
    /^\/v1\/supervisor\/tasks\/([^/]+)(?:\/(ack|renew|settle))?$/,
  );
  if (!match) return null;
  emptySchema.parse(Object.fromEntries(url.searchParams));
  const id = idSchema.parse(match[1]),
    op = match[2];
  if (!op && method === "GET")
    return status(ctx, await supervisorAuth(ctx, "cleanup"), id);
  if ((op === "ack" || op === "renew") && method === "POST")
    return advance(ctx, await supervisorAuth(ctx, "execution"), id, op);
  if (op === "settle" && method === "POST")
    return settle(ctx, await supervisorAuth(ctx, "cleanup"), id);
  throw new HttpError(405, "method_not_allowed", "Method is not supported");
}

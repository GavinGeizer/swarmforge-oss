import { z } from "zod";
import {
  authentication,
  type Context,
  cursor,
  HttpError,
  json,
  membership,
  page,
} from "./common.ts";
import { type HostedPrincipal, hostedAuth } from "./hosted-authority.ts";
import {
  controlledConsumption,
  currentPolicy,
  evaluatePolicy,
  parseQuantity,
} from "./hosted-entitlements.ts";
import { hostedSupervisorScopes } from "./hosted-types.ts";
import { idSchema } from "./schemas.ts";

// PRIVATE hosted operational visibility only. No router/lifecycle edits here:
// the lead wires hostedStatusRoute into the global router after prerequisites.
// Read-only tenant-scoped aggregates for operator cleanup. No public ops
// endpoints, no secrets: never surfaces raw tokens, credential hashes,
// ciphertext, prompts, env, or diagnostic stacks.
//
// Auth: current browser-session membership, or an sfexec_ execution grant via
// hostedAuth with correct scope/tenant. sfcli_/sfworker_/sfsuper_/global
// bearer credentials never authorize this route. Session revocation and the
// current CLI epoch are enforced by authentication()/hostedAuth on every call.
// Emergency read needs no entitlement cap and no current policy: a missing
// policy yields allowed=false with denial, never a read denial.
//
// Authority vs observed availability: a registered supervisor credential is
// AUTHORITY (it may mint claims), not proof the supervisor is ONLINE.
// Observed availability comes only from audit activity (claims/renews/reports
// attributed to the supervisor) and is labeled as such. A supervisor with
// valid authority but no recent audit activity is "authorized, not observed".

const statusItemSchema = z
  .object({
    task_id: idSchema,
    state: z.string(),
    worker_id: idSchema,
    fence: z.number().int(),
    lease_id: z.string().nullable(),
    lease_expires_at: z.number().int().nullable(),
  })
  .strict();

const supervisorEntrySchema = z
  .object({
    supervisor_id: idSchema,
    worker_id: idSchema,
    name: z.string(),
    // Authority lifecycle (server-owned registration state).
    status: z.enum(["registered", "revoked"]),
    // Credential authority: 'valid' means an unrevoked, unexpired
    // hosted-supervisor credential row exists. This is AUTHORITY, not liveness.
    credential_authority: z.enum(["valid", "expired", "revoked", "absent"]),
    credential_expires_at: z.number().int().nullable(),
    // Observed availability: last audit action attributed to this supervisor
    // (claim/renew/report/cleanup), or null when never observed. Labeled as
    // observed, never conflated with authority above.
    last_observed_action: z.string().nullable(),
    last_observed_at: z.number().int().nullable(),
    worker_status: z.enum(["registered", "revoked"]),
    worker_epoch: z.number().int(),
    admin_chain_user_id: idSchema,
    execution_eligible: z.boolean(),
    cleanup_eligible: z.boolean(),
  })
  .strict();

export const hostedStatusSchema = z
  .object({
    tenant_id: idSchema,
    // Current policy snapshot; null version when no policy row exists yet.
    policy_version: z.number().int().nullable(),
    policy_allowed: z.boolean(),
    policy_denial: z.string().nullable(),
    max_concurrent_workers: z.number().int().nullable(),
    max_active_tasks: z.number().int().nullable(),
    max_task_runtime: z.number().int().nullable(),
    maximum_resource_reservations: z.number().int().nullable(),
    // Controlled-meter ledger usage (canonical bounded integer strings,
    // exact-parsed with parseQuantity; null when no controlled-meter
    // allowance is defined). No product quota/price semantics.
    consumed_quantity: z.string().nullable(),
    reserved_quantity: z.string().nullable(),
    active_reservations: z.number().int(),
    quarantined_reservations: z.number().int(),
    task_states: z.record(z.string(), z.number().int()),
    held_tasks: z.number().int(),
    stop_requested_tasks: z.number().int(),
    expired_leases: z.number().int(),
    unclaimed_outbox: z.number().int(),
    outbox_attempts: z.number().int(),
    failure_audits: z.number().int(),
    cleanup_audits: z.number().int(),
    stop_audits: z.number().int(),
    // Last observed dispatch audit activity for this tenant, when known.
    last_dispatch_action: z.string().nullable(),
    last_dispatch_at: z.number().int().nullable(),
    // Bounded operator-cleanup pages (<=50 items each, stable ordering).
    stop_duty: z.array(statusItemSchema),
    held_page: z.array(statusItemSchema),
    lease_page: z.array(statusItemSchema),
    supervisors: z.array(supervisorEntrySchema),
    next_cursor: z.string().nullable(),
    // Supervisor IDs have a separate signed cursor scope.
    next_supervisor_cursor: z.string().nullable(),
  })
  .strict();

export type HostedStatus = z.infer<typeof hostedStatusSchema>;

const statusQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
    supervisor_cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

const taskStates = [
  "queued",
  "claimed",
  "running",
  "stop_requested",
  "held",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;

async function scalar(
  ctx: Context,
  sql: string,
  args: (string | number)[],
): Promise<number> {
  // Counts validate: any DB failure throws (fail-closed 503 via the router
  // envelope). Counts are never catch-error-to-0; no fake counters.
  const row = await ctx.env.DB.prepare(sql)
    .bind(...args)
    .first<{ n: number }>();
  if (row === null || typeof row.n !== "number")
    throw new HttpError(
      503,
      "temporarily_unavailable",
      "Status store is temporarily unavailable",
    );
  return row.n;
}

type StatusItem = z.infer<typeof statusItemSchema>;

async function taskPage(
  ctx: Context,
  tenant: string,
  where: string,
  args: (string | number)[],
  limit: number,
  afterTask: string,
): Promise<{ items: StatusItem[]; next: string | null }> {
  const rows = (
    await ctx.env.DB.prepare(
      `SELECT task_id,state,worker_id,fence,lease_id,lease_expires_at FROM hosted_tasks WHERE organization_id=? AND ${where} AND task_id>? ORDER BY task_id LIMIT ?`,
    )
      .bind(tenant, ...args, afterTask, limit + 1)
      .all<{
        task_id: string;
        state: string;
        worker_id: string;
        fence: number;
        lease_id: string | null;
        lease_expires_at: number | null;
      }>()
  ).results;
  const slice = rows.slice(0, limit);
  return {
    items: slice.map((r) => statusItemSchema.parse(r)),
    next: rows.length > limit ? slice[slice.length - 1]!.task_id : null,
  };
}

export async function hostedStatusRoute(ctx: Context) {
  const url = new URL(ctx.request.url);
  const match = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/hosted-status$/);
  if (!match || ctx.request.method !== "GET") return null;
  const tenant = idSchema.parse(match[1]);
  statusQuerySchema.parse(Object.fromEntries(url.searchParams));

  // Auth exactly mirrors the entitlements route: bearer sfexec_ via
  // hostedAuth (correct scope + same tenant), else current browser-session
  // membership. sfcli_/sfworker_/sfsuper_/global bearers all fail inside
  // hostedAuth (401) or never match a prefix; cross-org access is 404.
  let principal: HostedPrincipal | null = null;
  if (ctx.request.headers.has("authorization")) {
    principal = await hostedAuth(ctx);
    if (principal.organization_id !== tenant)
      throw new HttpError(404, "not_found", "Resource not found");
  } else {
    await authentication(ctx);
    await membership(ctx, tenant);
  }
  void principal;

  // These observations do not pretend to measure D1 rows read or CPU.
  const counted = async <T>(work: Promise<T> | T): Promise<T> => await work;
  const now = Date.now();

  // Emergency read: policy absence/expiry/revocation classifies
  // allowed/denial but never denies the read itself. currentPolicy throws
  // 503 only on a real table outage (fail-closed for new work, and for this
  // read too: stale visibility must not masquerade as current).
  const policy = await counted(currentPolicy(ctx, tenant));
  const decision = evaluatePolicy(policy, "hosted_task_execution", now);
  const consumption = await counted(controlledConsumption(ctx, tenant));
  if (consumption) {
    parseQuantity(consumption.consumed_quantity);
    parseQuantity(consumption.reserved_quantity);
  }

  const activeReservations = await counted(
    scalar(
      ctx,
      "SELECT count(*) n FROM hosted_reservations WHERE organization_id=? AND state='active'",
      [tenant],
    ),
  );
  const quarantinedReservations = await counted(
    scalar(
      ctx,
      "SELECT count(*) n FROM hosted_reservations WHERE organization_id=? AND state='quarantined'",
      [tenant],
    ),
  );
  const stateRows = await counted(
    (
      await ctx.env.DB.prepare(
        "SELECT state,count(*) n FROM hosted_tasks WHERE organization_id=? GROUP BY state",
      )
        .bind(tenant)
        .all<{ state: string; n: number }>()
    ).results,
  );
  const task_states: Record<string, number> = {};
  for (const s of taskStates) task_states[s] = 0;
  for (const r of stateRows) task_states[r.state] = r.n;

  const heldTasks = await counted(
    scalar(
      ctx,
      "SELECT count(*) n FROM hosted_tasks WHERE organization_id=? AND state='held'",
      [tenant],
    ),
  );
  const stopRequested = await counted(
    scalar(
      ctx,
      "SELECT count(*) n FROM hosted_tasks WHERE organization_id=? AND state='stop_requested'",
      [tenant],
    ),
  );
  const expiredLeases = await counted(
    scalar(
      ctx,
      "SELECT count(*) n FROM hosted_tasks WHERE organization_id=? AND state IN ('queued','claimed','running','stop_requested','held') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
      [tenant, now],
    ),
  );
  const unclaimedOutbox = await counted(
    scalar(
      ctx,
      "SELECT count(*) n FROM hosted_outbox WHERE organization_id=? AND state='queued'",
      [tenant],
    ),
  );
  const outboxAttempts = await counted(
    scalar(
      ctx,
      "SELECT COALESCE(sum(attempts),0) n FROM hosted_outbox WHERE organization_id=? AND state IN ('queued','claimed')",
      [tenant],
    ),
  );

  // Counts name actual production events. Settlement records confirmed stop;
  // its outcome metadata distinguishes failed execution from cleanup success.
  const failureAudits = await scalar(
    ctx,
    "SELECT count(*) n FROM audit_events WHERE organization_id=? AND action='dispatch.settled' AND json_extract(metadata,'$.outcome')='failed'",
    [tenant],
  );
  const cleanupAudits = await scalar(
    ctx,
    "SELECT count(*) n FROM audit_events WHERE organization_id=? AND action IN ('dispatch.settled','dispatch.operator_recovered')",
    [tenant],
  );
  const stopAudits = await scalar(
    ctx,
    "SELECT count(*) n FROM audit_events WHERE organization_id=? AND action IN ('hosted.task_cancelled','dispatch.expired','supervisor.revoked')",
    [tenant],
  );
  const lastDispatch = await ctx.env.DB.prepare(
    "SELECT action,at FROM audit_events WHERE organization_id=? AND action IN ('dispatch.claimed','dispatch.acked','dispatch.renewed','dispatch.settled','dispatch.expired','dispatch.operator_recovered','supervisor.registered','supervisor.revoked','supervisor.rotated','hosted.task_admitted','hosted.task_cancelled') ORDER BY at DESC,event_id DESC LIMIT 1",
  )
    .bind(tenant)
    .first<{ action: string; at: number }>();

  // A single ordered union page advances task IDs once. Category projections
  // share that page, so disjoint UUID ranges cannot skip one another.
  const paginationContext = (selected: string | null): Context => {
    const queryUrl = new URL(ctx.request.url);
    queryUrl.searchParams.delete("supervisor_cursor");
    queryUrl.searchParams.delete("cursor");
    if (selected) queryUrl.searchParams.set("cursor", selected);
    return {
      ...ctx,
      request: new Request(queryUrl, { headers: ctx.request.headers }),
    };
  };
  const { limit, after } = await page(
    paginationContext(url.searchParams.get("cursor")),
    tenant,
    "hosted-status-tasks",
  );
  const supervisorPagination = await page(
    paginationContext(url.searchParams.get("supervisor_cursor")),
    tenant,
    "hosted-status-supervisors",
  );
  if (after) idSchema.parse(after);
  if (supervisorPagination.after) idSchema.parse(supervisorPagination.after);
  const bounded = Math.min(limit, 50);
  const combined = await taskPage(
    ctx,
    tenant,
    "(state IN ('stop_requested','held') OR (state IN ('queued','claimed','running') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?))",
    [now],
    bounded,
    after,
  );
  const stopDuty = combined.items.filter((t) => t.state === "stop_requested");
  const heldPage = combined.items.filter((t) => t.state === "held");
  const leasePage = combined.items.filter(
    (t) => t.lease_expires_at !== null && t.lease_expires_at <= now,
  );

  // A credential must match the current supervisor epoch, audience and
  // exact scopes. Cleanup retains the current owner/admin chain while worker
  // revocation denies execution. Neither field claims an online process.
  const observedPredicate = `(a.action='supervisor.rotated' AND a.resource='supervisor:' || s.supervisor_id) OR (a.action IN ('dispatch.claimed','dispatch.acked','dispatch.renewed','dispatch.settled','dispatch.expired','dispatch.operator_recovered') AND EXISTS(SELECT 1 FROM hosted_tasks t WHERE t.organization_id=s.organization_id AND t.supervisor_id=s.supervisor_id AND a.resource='task:' || t.task_id))`;
  const supervisorRows = (
    await ctx.env.DB.prepare(
      `SELECT s.supervisor_id,s.worker_id,s.name,s.status,s.revoked_at,s.authorization_expires_at,w.status worker_status,w.epoch worker_epoch,w.authorization_expires_at worker_authorization_expires_at,s.authorizing_user_id admin_chain_user_id,
      EXISTS(SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.user_id JOIN organizations o ON o.organization_id=m.organization_id WHERE u.user_id=s.authorizing_user_id AND u.status='active' AND m.organization_id=s.organization_id AND m.status='active' AND m.role IN ('owner','admin') AND o.status='active') admin_chain_active,
      (SELECT c.expires_at FROM hosted_supervisor_credentials c WHERE c.organization_id=s.organization_id AND c.supervisor_id=s.supervisor_id AND c.audience='hosted-supervisor' AND c.epoch=s.epoch AND c.scopes=? AND c.revoked_at IS NULL ORDER BY c.expires_at DESC LIMIT 1) credential_expires_at,
      (SELECT count(*) FROM hosted_supervisor_credentials c WHERE c.organization_id=s.organization_id AND c.supervisor_id=s.supervisor_id) credential_count,
      (SELECT a.action FROM audit_events a WHERE a.organization_id=s.organization_id AND (${observedPredicate}) ORDER BY a.at DESC,a.event_id DESC LIMIT 1) last_observed_action,
      (SELECT a.at FROM audit_events a WHERE a.organization_id=s.organization_id AND (${observedPredicate}) ORDER BY a.at DESC,a.event_id DESC LIMIT 1) last_observed_at
      FROM hosted_supervisors s JOIN cloud_workers w ON w.organization_id=s.organization_id AND w.worker_id=s.worker_id
      WHERE s.organization_id=? AND s.supervisor_id>? ORDER BY s.supervisor_id LIMIT ?`,
    )
      .bind(
        JSON.stringify(hostedSupervisorScopes),
        tenant,
        supervisorPagination.after,
        bounded + 1,
      )
      .all<{
        supervisor_id: string;
        worker_id: string;
        name: string;
        status: "registered" | "revoked";
        revoked_at: number | null;
        authorization_expires_at: number;
        worker_status: "registered" | "revoked";
        worker_epoch: number;
        worker_authorization_expires_at: number;
        admin_chain_user_id: string;
        admin_chain_active: number;
        credential_expires_at: number | null;
        credential_count: number;
        last_observed_action: string | null;
        last_observed_at: number | null;
      }>()
  ).results;
  const supSlice = supervisorRows.slice(0, bounded);
  const supervisors = supSlice.map((r) => {
    const credential_authority =
      r.status === "revoked" || r.revoked_at !== null
        ? "revoked"
        : r.credential_expires_at === null
          ? r.credential_count > 0
            ? "revoked"
            : "absent"
          : r.credential_expires_at <= now || r.authorization_expires_at <= now
            ? "expired"
            : "valid";
    const cleanup_eligible =
      credential_authority === "valid" && r.admin_chain_active === 1;
    return supervisorEntrySchema.parse({
      supervisor_id: r.supervisor_id,
      worker_id: r.worker_id,
      name: r.name,
      status: r.status,
      credential_authority,
      credential_expires_at: r.credential_expires_at,
      last_observed_action: r.last_observed_action,
      last_observed_at: r.last_observed_at,
      worker_status: r.worker_status,
      worker_epoch: r.worker_epoch,
      admin_chain_user_id: r.admin_chain_user_id,
      cleanup_eligible,
      execution_eligible:
        cleanup_eligible &&
        r.worker_status === "registered" &&
        r.worker_authorization_expires_at > now &&
        decision.allowed,
    });
  });
  const next_cursor = combined.next
    ? await cursor(ctx, tenant, "hosted-status-tasks", combined.next)
    : null;
  const next_supervisor_cursor =
    supervisorRows.length > bounded
      ? await cursor(
          ctx,
          tenant,
          "hosted-status-supervisors",
          supSlice.at(-1)!.supervisor_id,
        )
      : null;

  return json(hostedStatusSchema, {
    tenant_id: tenant,
    policy_version: policy?.version ?? null,
    policy_allowed: decision.allowed,
    policy_denial: decision.denial,
    max_concurrent_workers: policy?.max_concurrent_workers ?? null,
    max_active_tasks: policy?.max_active_tasks ?? null,
    max_task_runtime: policy?.max_task_runtime ?? null,
    maximum_resource_reservations:
      policy?.maximum_resource_reservations ?? null,
    consumed_quantity: consumption?.consumed_quantity ?? null,
    reserved_quantity: consumption?.reserved_quantity ?? null,
    active_reservations: activeReservations,
    quarantined_reservations: quarantinedReservations,
    task_states,
    held_tasks: heldTasks,
    stop_requested_tasks: stopRequested,
    expired_leases: expiredLeases,
    unclaimed_outbox: unclaimedOutbox,
    outbox_attempts: outboxAttempts,
    failure_audits: failureAudits,
    cleanup_audits: cleanupAudits,
    stop_audits: stopAudits,
    last_dispatch_action: lastDispatch?.action ?? null,
    last_dispatch_at: lastDispatch?.at ?? null,
    stop_duty: stopDuty,
    held_page: heldPage,
    lease_page: leasePage,
    supervisors,
    next_cursor,
    next_supervisor_cursor,
  });
}

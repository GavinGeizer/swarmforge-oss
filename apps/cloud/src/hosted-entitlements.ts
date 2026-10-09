import { z } from "zod";
import {
  authentication,
  type Context,
  HttpError,
  json,
  membership,
} from "./common.ts";
import { type HostedPrincipal, hostedAuth } from "./hosted-authority.ts";
import {
  type HostedAllowance,
  type HostedEntitlementRow,
  type HostedPolicy,
  hostedPolicySchema,
  maxMeterQuantity,
  maxTaskRuntimeMs,
} from "./hosted-types.ts";
import { idSchema } from "./schemas.ts";

// Server-owned entitlement policy engine. Policies are written by the trusted
// operator seam only (scripts/hosted-policy-local.mjs or direct production
// putPolicy); there is NO website policy-write route and no billing mapping.
// Absent, expired, revoked, or out-of-window policy denies new work by
// default. Allowance quantities use canonical bounded integer strings with
// exact BigInt arithmetic (bounded by Number.MAX_SAFE_INTEGER); Number() and
// SQLite CAST are never used for quantities (CAST rounds past int64).

export interface PolicyInput {
  capabilities: {
    hosted_control_plane: boolean;
    remote_worker_enrollment: boolean;
    hosted_task_execution: boolean;
  };
  max_concurrent_workers: number | null;
  max_active_tasks: number | null;
  max_task_runtime: number;
  maximum_resource_reservations: number | null;
  valid_for_ms: number;
  allowances?: Array<{
    resource: string;
    unit: string;
    resource_class: string;
    allowed_quantity: string;
  }>;
}

const allowanceInputSchema = z
  .object({
    resource: z.string().min(1).max(128),
    unit: z.string().min(1).max(128),
    resource_class: z.string().min(1).max(128),
    allowed_quantity: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,15})$/)
      .refine(
        (v) => v.length <= 15 || v <= maxMeterQuantity,
        "quantity exceeds Number.MAX_SAFE_INTEGER",
      ),
  })
  .strict();

export const policyInputSchema = z
  .object({
    capabilities: z
      .object({
        hosted_control_plane: z.boolean(),
        remote_worker_enrollment: z.boolean(),
        hosted_task_execution: z.boolean(),
      })
      .strict(),
    max_concurrent_workers: z.number().int().min(0).nullable(),
    max_active_tasks: z.number().int().min(0).nullable(),
    max_task_runtime: z.number().int().min(1).max(maxTaskRuntimeMs),
    maximum_resource_reservations: z.number().int().min(0).nullable(),
    valid_for_ms: z
      .number()
      .int()
      .positive()
      .max(365 * 86400000),
    allowances: z.array(allowanceInputSchema).max(16).optional(),
  })
  .strict();

export const policyRecordSchema = z
  .object({
    entitlement_id: idSchema,
    organization_id: idSchema,
    version: z.number().int().positive(),
    capabilities: z
      .object({
        hosted_control_plane: z.boolean(),
        remote_worker_enrollment: z.boolean(),
        hosted_task_execution: z.boolean(),
      })
      .strict(),
    max_concurrent_workers: z.number().int().min(0).nullable(),
    max_active_tasks: z.number().int().min(0).nullable(),
    max_task_runtime: z.number().int().min(1).max(maxTaskRuntimeMs),
    maximum_resource_reservations: z.number().int().min(0).nullable(),
    valid_from: z.number().int(),
    valid_until: z.number().int(),
    revoked_at: z.number().int().nullable(),
    created_at: z.number().int(),
    created_by: z.string().nullable(),
  })
  .strict();
export type PolicyRecord = z.infer<typeof policyRecordSchema>;

// Exact bounded BigInt arithmetic for canonical quantities. Throws on
// malformed input or overflow past Number.MAX_SAFE_INTEGER.
export function parseQuantity(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value))
    throw new Error("invalid quantity");
  const n = BigInt(value);
  if (n > BigInt(maxMeterQuantity)) throw new Error("quantity overflow");
  return n;
}

export function formatQuantity(value: bigint): string {
  if (value < 0n || value > BigInt(maxMeterQuantity))
    throw new Error("quantity overflow");
  return value.toString();
}

export function addQuantities(a: string, b: string): string {
  return formatQuantity(parseQuantity(a) + parseQuantity(b));
}

// Downstream single-batch admission rechecks the ACTIVE policy row inside the
// conditional DML. This guard composes into admission/claim SQL; an evaluate
// call alone is advisory and never grants authority.
export function activePolicyGuard(tenant: string, now = Date.now()) {
  return {
    sql: `EXISTS(SELECT 1 FROM hosted_entitlements e WHERE e.organization_id=? AND e.revoked_at IS NULL AND e.valid_from<=? AND e.valid_until>?)`,
    args: [tenant, now, now],
  };
}

export async function currentPolicy(
  ctx: Context,
  tenant: string,
  now = Date.now(),
): Promise<PolicyRecord | null> {
  let row: HostedEntitlementRow | null = null;
  try {
    // Latest version wins; revocation/expiry are classified by
    // evaluatePolicy (still fail-closed: allowed=false). Returning the row
    // (instead of filtering revoked) gives operators a precise denial reason.
    row = await ctx.env.DB.prepare(
      "SELECT * FROM hosted_entitlements WHERE organization_id=? ORDER BY version DESC LIMIT 1",
    )
      .bind(tenant)
      .first<HostedEntitlementRow>();
  } catch {
    // Policy-table outage fails closed for new work (throws below via 503).
    throw new HttpError(
      503,
      "policy_unavailable",
      "Entitlement policy is temporarily unavailable",
    );
  }
  if (!row) return null;
  void now;
  return policyRecordSchema.parse({
    entitlement_id: row.entitlement_id,
    organization_id: row.organization_id,
    version: row.version,
    capabilities: {
      hosted_control_plane: row.hosted_control_plane === 1,
      remote_worker_enrollment: row.remote_worker_enrollment === 1,
      hosted_task_execution: row.hosted_task_execution === 1,
    },
    max_concurrent_workers: row.max_concurrent_workers,
    max_active_tasks: row.max_active_tasks,
    max_task_runtime: row.max_task_runtime,
    maximum_resource_reservations: row.maximum_resource_reservations,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by: row.created_by,
  });
}

export interface EntitlementDecision {
  allowed: boolean;
  policy_version: number | null;
  denial: string | null;
}

// Advisory evaluation only. Admission re-evaluates inside its atomic batch.
export function evaluatePolicy(
  policy: PolicyRecord | null,
  capability:
    | "hosted_control_plane"
    | "remote_worker_enrollment"
    | "hosted_task_execution",
  now = Date.now(),
): EntitlementDecision {
  if (!policy)
    return { allowed: false, policy_version: null, denial: "policy_absent" };
  if (policy.revoked_at !== null)
    return {
      allowed: false,
      policy_version: policy.version,
      denial: "policy_revoked",
    };
  if (!(now >= policy.valid_from && now < policy.valid_until))
    return {
      allowed: false,
      policy_version: policy.version,
      denial: "policy_expired",
    };
  if (!policy.capabilities[capability])
    return {
      allowed: false,
      policy_version: policy.version,
      denial: "capability_denied",
    };
  return { allowed: true, policy_version: policy.version, denial: null };
}

// Trusted operator write seam. NOT exposed over HTTP; invoked by the local
// operator helper or tests with a service Context. Revokes any currently
// active policy and inserts the successor version atomically; audit rolls back
// with the batch on failure.
export async function putPolicy(
  ctx: Context,
  tenant: string,
  input: PolicyInput,
  operator: string,
): Promise<PolicyRecord> {
  const parsed = policyInputSchema.parse(input);
  const now = Date.now();
  const current = await ctx.env.DB.prepare(
    "SELECT COALESCE(MAX(version),0) v FROM hosted_entitlements WHERE organization_id=?",
  )
    .bind(tenant)
    .first<{ v: number }>();
  const version = (current?.v ?? 0) + 1;
  const entitlementId = crypto.randomUUID();
  const record: PolicyRecord = {
    entitlement_id: entitlementId,
    organization_id: tenant,
    version,
    capabilities: parsed.capabilities,
    max_concurrent_workers: parsed.max_concurrent_workers,
    max_active_tasks: parsed.max_active_tasks,
    max_task_runtime: parsed.max_task_runtime,
    maximum_resource_reservations: parsed.maximum_resource_reservations,
    valid_from: now,
    valid_until: now + parsed.valid_for_ms,
    revoked_at: null,
    created_at: now,
    created_by: operator,
  };
  const allowanceRows = (parsed.allowances ?? []).map((a) => ({
    allowance_id: crypto.randomUUID(),
    resource: a.resource,
    unit: a.unit,
    resource_class: a.resource_class,
    allowed_quantity: a.allowed_quantity,
  }));
  const statements = [
    ctx.env.DB.prepare(
      "UPDATE hosted_entitlements SET revoked_at=? WHERE organization_id=? AND revoked_at IS NULL",
    ).bind(now, tenant),
    ctx.env.DB.prepare(
      "INSERT INTO hosted_entitlements(entitlement_id,organization_id,version,hosted_control_plane,remote_worker_enrollment,hosted_task_execution,max_concurrent_workers,max_active_tasks,max_task_runtime,maximum_resource_reservations,valid_from,valid_until,revoked_at,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      entitlementId,
      tenant,
      version,
      record.capabilities.hosted_control_plane ? 1 : 0,
      record.capabilities.remote_worker_enrollment ? 1 : 0,
      record.capabilities.hosted_task_execution ? 1 : 0,
      record.max_concurrent_workers,
      record.max_active_tasks,
      record.max_task_runtime,
      record.maximum_resource_reservations,
      record.valid_from,
      record.valid_until,
      null,
      record.created_at,
      operator,
    ),
    ...allowanceRows.map((a) =>
      ctx.env.DB.prepare(
        "INSERT INTO hosted_allowances(allowance_id,organization_id,entitlement_id,resource,unit,resource_class,allowed_quantity,consumed_quantity,reserved_quantity,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        a.allowance_id,
        tenant,
        entitlementId,
        a.resource,
        a.unit,
        a.resource_class,
        a.allowed_quantity,
        "0",
        "0",
        record.valid_from,
        record.valid_until,
        now,
      ),
    ),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      operator,
      tenant,
      "hosted.policy_updated",
      `policy:${entitlementId}`,
      "success",
      ctx.request_id,
      now,
      JSON.stringify({ reason: `version ${version}` }),
    ),
    ctx.env.DB.prepare(
      "SELECT version FROM hosted_entitlements WHERE entitlement_id=?",
    ).bind(entitlementId),
  ];
  const result = await ctx.env.DB.batch(statements);
  if (!result.at(-1)?.results.length)
    throw new HttpError(503, "policy_unavailable", "Policy write failed");
  return record;
}

export async function revokePolicy(
  ctx: Context,
  tenant: string,
  operator: string,
): Promise<{ revoked: number }> {
  const now = Date.now();
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE hosted_entitlements SET revoked_at=? WHERE organization_id=? AND revoked_at IS NULL",
    ).bind(now, tenant),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,?,?, 'hosted.policy_revoked',?, 'success',?,?,'{}' FROM hosted_entitlements WHERE organization_id=? AND revoked_at=? LIMIT 1",
    ).bind(
      crypto.randomUUID(),
      operator,
      tenant,
      `policy:${tenant}`,
      ctx.request_id,
      now,
      tenant,
      now,
    ),
    ctx.env.DB.prepare(
      "SELECT count(*) n FROM hosted_entitlements WHERE organization_id=? AND revoked_at=?",
    ).bind(tenant, now),
  ]);
  return {
    revoked: (result.at(-1)?.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

const entitlementViewSchema = z
  .object({
    policy: hostedPolicySchema.nullable(),
    allowed: z.boolean(),
    denial: z.string().nullable(),
    policy_version: z.number().int().positive().nullable(),
    reserved_tasks: z.number().int().min(0),
    reserved_reservations: z.number().int().min(0),
  })
  .strict();

async function counts(ctx: Context, tenant: string) {
  const tasks = await ctx.env.DB.prepare(
    "SELECT count(*) n FROM hosted_tasks WHERE organization_id=? AND state IN ('queued','claimed','running','stop_requested','held')",
  )
    .bind(tenant)
    .first<{ n: number }>();
  const reservations = await ctx.env.DB.prepare(
    "SELECT count(*) n FROM hosted_reservations WHERE organization_id=? AND state IN ('active','quarantined')",
  )
    .bind(tenant)
    .first<{ n: number }>();
  return { tasks: tasks?.n ?? 0, reservations: reservations?.n ?? 0 };
}

export async function entitlementsRoute(ctx: Context) {
  const url = new URL(ctx.request.url);
  const match = url.pathname.match(/^\/v1\/tenants\/([^/]+)\/entitlements$/);
  if (!match || ctx.request.method !== "GET") return null;
  const tenant = idSchema.parse(match[1]);
  // Browser session or execution grant; sfcli_/sfworker_ never reach here
  // because hostedAuth rejects their prefixes and machineAuth never grants
  // these routes (lead-owned router keeps them separate until integration).
  let principal: HostedPrincipal | null = null;
  if (ctx.request.headers.has("authorization")) {
    principal = await hostedAuth(ctx);
    if (principal.organization_id !== tenant)
      throw new HttpError(404, "not_found", "Resource not found");
  } else {
    await authentication(ctx);
    await membership(ctx, tenant);
  }
  const policy = await currentPolicy(ctx, tenant);
  const decision = evaluatePolicy(policy, "hosted_task_execution");
  const reserved = await counts(ctx, tenant);
  const view = entitlementViewSchema.parse({
    policy: policy
      ? {
          organization_id: policy.organization_id,
          version: policy.version,
          capabilities: policy.capabilities,
          max_concurrent_workers: policy.max_concurrent_workers,
          max_active_tasks: policy.max_active_tasks,
          max_task_runtime: policy.max_task_runtime,
          maximum_resource_reservations: policy.maximum_resource_reservations,
          valid_from: policy.valid_from,
          valid_until: policy.valid_until,
          revoked_at: policy.revoked_at,
        }
      : null,
    allowed: decision.allowed,
    denial: decision.denial,
    policy_version: decision.policy_version,
    reserved_tasks: reserved.tasks,
    reserved_reservations: reserved.reservations,
  });
  void principal;
  return json(entitlementViewSchema, view);
}

export type { HostedAllowance, HostedPolicy };

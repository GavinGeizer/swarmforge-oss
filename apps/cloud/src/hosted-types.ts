import { z } from "zod";
import { idSchema } from "./schemas.ts";

// Phase 2B.2 hosted foundation shared DTOs. Field/type/API names are frozen by
// the shared protocol; report to the lead before altering an external JSON name.

// --- Policy ---

export const hostedCapabilities = [
  "hosted_control_plane",
  "remote_worker_enrollment",
  "hosted_task_execution",
] as const;
export type HostedCapability = (typeof hostedCapabilities)[number];

export const hostedCapabilitySchema = z.enum(hostedCapabilities);

export const hostedPolicySchema = z
  .object({
    organization_id: idSchema,
    version: z.number().int().positive(),
    capabilities: z.record(hostedCapabilitySchema, z.boolean()),
    max_concurrent_workers: z.number().int().min(0).nullable(),
    max_active_tasks: z.number().int().min(0).nullable(),
    max_task_runtime: z.number().int().positive().nullable(),
    maximum_resource_reservations: z.number().int().min(0).nullable(),
    valid_from: z.number().int(),
    valid_until: z.number().int(),
    revoked_at: z.number().int().nullable(),
  })
  .strict();
export type HostedPolicy = z.infer<typeof hostedPolicySchema>;

// Canonical bounded integer-string quantity: digits only, no leading zeros
// unless "0", max 19 digits (safe exact arithmetic, no floats).
export const hostedQuantitySchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);

export const hostedAllowanceSchema = z
  .object({
    allowance_id: idSchema,
    organization_id: idSchema,
    entitlement_id: idSchema,
    resource: z.string().min(1).max(128),
    unit: z.string().min(1).max(128),
    resource_class: z.string().min(1).max(128),
    allowed_quantity: hostedQuantitySchema,
    consumed_quantity: hostedQuantitySchema,
    reserved_quantity: hostedQuantitySchema,
    period_start: z.number().int(),
    period_end: z.number().int(),
  })
  .strict()
  .refine((v) => v.period_end > v.period_start, {
    message: "period_end must exceed period_start",
  });
export type HostedAllowance = z.infer<typeof hostedAllowanceSchema>;

export const hostedEntitlementViewSchema = z
  .object({
    policy: hostedPolicySchema.nullable(),
    allowed: z.boolean(),
    denial: z.string().nullable(),
    reserved_tasks: z.number().int().min(0),
    reserved_reservations: z.number().int().min(0),
    consumed_quantity: hostedQuantitySchema.nullable(),
  })
  .strict();
export type HostedEntitlementView = z.infer<typeof hostedEntitlementViewSchema>;

// --- Credentials ---

export const hostedCliScopes = [
  "tasks:create",
  "tasks:read",
  "tasks:cancel",
  "entitlements:read",
] as const;
export const hostedSupervisorScopes = [
  "supervisor:claim",
  "supervisor:renew",
  "supervisor:report",
  "supervisor:cleanup",
] as const;

export const hostedExecutionCredentialReplySchema = z
  .object({
    credential: z.string().regex(/^sfexec_[A-Za-z0-9_-]{43}$/),
    credential_id: idSchema,
    grant_id: idSchema,
    installation_id: idSchema,
    subject_id: idSchema,
    tenant_id: idSchema,
    scopes: z.tuple([
      z.literal("tasks:create"),
      z.literal("tasks:read"),
      z.literal("tasks:cancel"),
      z.literal("entitlements:read"),
    ]),
    expires_at: z.number().int(),
    authorization_expires_at: z.number().int(),
  })
  .strict();
export type HostedExecutionCredentialReply = z.infer<
  typeof hostedExecutionCredentialReplySchema
>;

export const hostedSupervisorCredentialReplySchema = z
  .object({
    credential: z.string().regex(/^sfsuper_[A-Za-z0-9_-]{43}$/),
    credential_id: idSchema,
    supervisor_id: idSchema,
    worker_id: idSchema,
    subject_id: idSchema,
    tenant_id: idSchema,
    scopes: z.tuple([
      z.literal("supervisor:claim"),
      z.literal("supervisor:renew"),
      z.literal("supervisor:report"),
      z.literal("supervisor:cleanup"),
    ]),
    expires_at: z.number().int(),
    authorization_expires_at: z.number().int(),
  })
  .strict();
export type HostedSupervisorCredentialReply = z.infer<
  typeof hostedSupervisorCredentialReplySchema
>;

// --- Tasks / admission / dispatch ---

export const taskSubmitSchema = z
  .object({
    request_id: idSchema,
    worker_id: idSchema,
    execution_class: z.literal("controlled"),
    runtime_ms: z.number().int().positive(),
    controlled_duration_ms: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.controlled_duration_ms <= v.runtime_ms, {
    message: "controlled_duration_ms must not exceed runtime_ms",
  });
export type TaskSubmit = z.infer<typeof taskSubmitSchema>;

export const hostedTaskStateSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "stop_requested",
  "held",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type HostedTaskState = z.infer<typeof hostedTaskStateSchema>;

export const hostedTaskSchema = z
  .object({
    task_id: idSchema,
    tenant_id: idSchema,
    worker_id: idSchema,
    execution_class: z.literal("controlled"),
    state: hostedTaskStateSchema,
    reservation_id: idSchema,
    policy_version: z.number().int().positive(),
    runtime_ms: z.number().int().positive(),
    controlled_duration_ms: z.number().int().positive(),
    created_at: z.number().int(),
    deadline_at: z.number().int(),
    lease_id: idSchema.nullable(),
    supervisor_id: idSchema.nullable(),
    fence: z.number().int().min(0),
    lease_expires_at: z.number().int().nullable(),
  })
  .strict();
export type HostedTask = z.infer<typeof hostedTaskSchema>;

export const admissionReplySchema = z
  .object({
    task: hostedTaskSchema,
    reservation_id: idSchema,
    policy_version: z.number().int().positive(),
  })
  .strict();
export type AdmissionReply = z.infer<typeof admissionReplySchema>;

export const claimReplySchema = z
  .object({ task: hostedTaskSchema.nullable(), server_time: z.number().int() })
  .strict();
export type ClaimReply = z.infer<typeof claimReplySchema>;

export const leaseRequestSchema = z
  .object({ lease_id: idSchema, fence: z.number().int().min(0) })
  .strict();
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;

export const leaseReplySchema = z
  .object({
    task: hostedTaskSchema,
    directive: z.enum(["continue", "stop"]),
    server_time: z.number().int(),
  })
  .strict();
export type LeaseReply = z.infer<typeof leaseReplySchema>;

export const settlementRequestSchema = leaseRequestSchema
  .extend({
    outcome: z.enum(["completed", "failed", "cancelled"]),
    stop_confirmed: z.literal(true),
    consumed_runtime_ms: z.number().int().min(0),
  })
  .strict();
export type SettlementRequest = z.infer<typeof settlementRequestSchema>;

// --- DB row types (D1 storage projections) ---

export interface HostedEntitlementRow {
  entitlement_id: string;
  organization_id: string;
  version: number;
  hosted_control_plane: number;
  remote_worker_enrollment: number;
  hosted_task_execution: number;
  max_concurrent_workers: number | null;
  max_active_tasks: number | null;
  max_task_runtime: number | null;
  maximum_resource_reservations: number | null;
  valid_from: number;
  valid_until: number;
  revoked_at: number | null;
  created_at: number;
  created_by: string | null;
}

export interface HostedAllowanceRow {
  allowance_id: string;
  organization_id: string;
  entitlement_id: string;
  resource: string;
  unit: string;
  resource_class: string;
  allowed_quantity: string;
  consumed_quantity: string;
  reserved_quantity: string;
  period_start: number;
  period_end: number;
  created_at: number;
}

export interface HostedExecutionGrantRow {
  grant_id: string;
  token_hash: string;
  installation_id: string;
  organization_id: string;
  user_id: string;
  session_id: string;
  scopes: string;
  epoch: number;
  idempotency_key: string;
  fingerprint: string;
  result_ciphertext: string;
  created_at: number;
  expires_at: number;
  authorization_expires_at: number;
  revoked_at: number | null;
}

export interface HostedSupervisorRow {
  supervisor_id: string;
  organization_id: string;
  worker_id: string;
  authorizing_user_id: string;
  name: string;
  status: "registered" | "revoked";
  epoch: number;
  created_at: number;
  authorization_expires_at: number;
  revoked_at: number | null;
}

export interface HostedSupervisorCredentialRow {
  credential_id: string;
  token_hash: string;
  supervisor_id: string;
  audience: "hosted-supervisor";
  scopes: string;
  epoch: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface HostedSupervisorRotationRow {
  previous_credential_id: string;
  idempotency_key: string;
  result_ciphertext: string;
  created_at: number;
  expires_at: number;
}

export interface HostedTaskRow {
  task_id: string;
  organization_id: string;
  worker_id: string;
  request_id: string;
  operation: string;
  principal_kind: "account" | "cli" | "execution";
  principal_id: string;
  idempotency_key: string;
  fingerprint: string;
  execution_class: "controlled";
  state: HostedTaskState;
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

export interface HostedReservationRow {
  reservation_id: string;
  organization_id: string;
  task_id: string;
  kind: "task_execution";
  quantity: string;
  state: "active" | "quarantined" | "consumed" | "released";
  created_at: number;
  expires_at: number;
  released_at: number | null;
}

export interface HostedOutboxRow {
  outbox_id: string;
  organization_id: string;
  task_id: string;
  state: "queued" | "claimed" | "acked" | "dead";
  payload_json: string;
  created_at: number;
  claimed_by: string | null;
  claim_expires_at: number | null;
  lease_id: string | null;
  fence: number;
  attempts: number;
}

export interface HostedOperationRow {
  operation_id: string;
  organization_id: string;
  principal_key: string;
  resource_id: string | null;
  operation: string;
  idempotency_key: string;
  fingerprint: string;
  task_id: string | null;
  result_ciphertext: string | null;
  status: number;
  created_at: number;
  expires_at: number;
}

export const hostedTableNames = [
  "hosted_entitlements",
  "hosted_allowances",
  "hosted_execution_grants",
  "hosted_supervisors",
  "hosted_supervisor_credentials",
  "hosted_supervisor_rotations",
  "hosted_tasks",
  "hosted_reservations",
  "hosted_outbox",
  "hosted_operations",
] as const;
export type HostedTableName = (typeof hostedTableNames)[number];

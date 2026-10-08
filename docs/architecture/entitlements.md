# Centralized capability entitlements

## Model and ownership

License eligibility and hosted entitlement are separate. Free self-hosting uses current CLI/configured safety limits without a hosted verification request, subscription cache or commercial identity provider. Local functionality cannot be revoked by a hosted billing outage or by subscription expiry. The application does not adjudicate legal eligibility.

A hosted entitlement snapshot belongs to one tenant, is versioned, expires, and is derived by the server from plan configuration plus authoritative subscription/override state. Stripe is a future input adapter; neither the engine nor the policy interface contains Stripe types. A billing adapter normalizes provider events into the projection; it cannot grant resource access by itself.

| Kind | Capabilities / resources | Semantics |
| --- | --- | --- |
| Boolean | `local_orchestration`, `github_repository_access`, `hosted_control_plane`, `remote_worker_enrollment`, `managed_compute`, `managed_inference` | Whether this service operation is permitted. Repository permission and tenant membership must also hold. First two are available locally without commercial verification. |
| Numeric limit | `max_concurrent_workers`, `max_active_tasks` | Nonnegative safe integer ceiling. Counts/reservations computed atomically by the authority; zero denies new capacity. |
| Metered allowance | `monthly_compute_allowance`, future `monthly_inference_allowance` | Explicit unit, period bounds, permitted amount and consumed/reserved quantities. No silently assumed currency/token conversion. Proposed compute unit is billable compute seconds by resource class; weighted conversion requires owner approval. |

Unlimited is explicit `null` in a known enabled limit/allowance field, never missing data or Infinity. Unknown capabilities, malformed values, absent hosted policy and stale snapshots deny new hosted work. Meter values use nonnegative decimal strings to avoid JSON integer overflow; counts use safe integers. Different units/models/resource classes must not be combined without an explicit rate/weight schedule.

## Provider contract (future hosted admission consumer)

```ts
type BooleanCapability =
  | "local_orchestration" | "github_repository_access"
  | "hosted_control_plane" | "remote_worker_enrollment"
  | "managed_compute" | "managed_inference";
type CountLimit = "max_concurrent_workers" | "max_active_tasks";
type MeteredResource = "monthly_compute_allowance" | "monthly_inference_allowance";
interface EntitlementSnapshot {
  tenant_id: string;
  version: string;
  valid_until: number;
  capabilities: Record<BooleanCapability, boolean>;
  limits: Record<CountLimit, number | null>;
  allowances: Partial<Record<MeteredResource, {
    unit: string;
    allowed: string | null;
    period_start: number;
    period_end: number;
  }>>;
}
interface EntitlementProvider {
  getSnapshot(tenantId: string): Promise<EntitlementSnapshot>;
  evaluate(request: {
    tenant_id: string;
    capabilities: readonly BooleanCapability[];
    limits?: Partial<Record<CountLimit, number>>; // requested increments
    resources?: Partial<Record<MeteredResource, string>>; // requested increments
  }): Promise<{
    allowed: boolean;
    version: string;
    reasons: readonly string[];
  }>;
}
```

Not added to `src` because no hosted admission path exists. Snapshot/evaluation is advisory until a server-side reservation transaction succeeds. A signed/cached result or CLI tier flag is not permission to provision. Required capability sets are chosen by the server based on task execution class, never only on names submitted by the client.

## Atomic enforcement and lifecycle

- Authenticate principal, verify active membership and tenant-owned repository/compute references first. Resolve the tenant's plan snapshot on the authority.
- In a conditional, serialized transaction, verify snapshot/version/period, count existing reservations, reserve worker/task slots and meter headroom, and create the tenant-owned task plus durable dispatch/outbox. Repeated idempotency keys return the same task/reservation. No evaluate-then-insert race.
- Reserve a worker slot before provisioning, an active-task slot before execution, and managed compute/inference allowance before consuming resources. Deny exhausted concurrent limits with 409 and exhausted allowances/disabled capabilities with 403; overload is 429. Limits across several supervisors require shared reservations, not per-process maxima.
- Customer-enrolled workers do not incur managed-compute allowance merely by reporting usage. Managed inference is never allowed on BYOK AI tasks because the caller chose a different model reference.
- Supervisor/worker runtime holds finite task leases, deadline and enforceable budgets. Recheck policy before increasing resources/renewing leases. Cancellations, revocations and safe destruction remain available after payment lapses; no entitlement check may strand billable resources.
- Settle reservations from trustworthy supervisor/provider evidence. Cancellation stops accrual only when execution/compute really stopped; retained VM billing may continue according to the product policy. Idempotent retry and crash recovery must not leak reservations or release them twice.
- Revocation or downgrade denies new work immediately after the authoritative update. Handling existing work/grace windows is an owner decision; bound resources technically even while business policy is unresolved. Policy outages fail closed for new paid work, allow cleanup, and do not affect local mode.

## Accounting authority

Current `Store.usage` is a useful observed-token source with idempotent maximum snapshots. Current cost estimates and budget alerts cannot charge customers or enforce monthly allowances. OpenCode's bounded history can miss old usage; pricing `complete` is not metering completeness.

Future usage records need tenant/task/run/worker/source/event identity, unit/resource class, interval, quantities, observation coverage, received timestamp, rate/version where applicable and reconciliation state. Trusted supervisor compute intervals and managed-inference proxy/provider counters are authoritative. Customer-worker reports are hints. Deduplicate by `(tenant_id, source_id, event_id)` and reject changed payload reuse; retain per-run monotonic cumulative snapshots where supported, distinguish corrections from new consumption, and never lower consumption on an untrusted report. Handle late data, retries, clock skew, provider reconciliation and period assignment explicitly. Export invoice data only after reconciliation and an owner-approved pricing policy.

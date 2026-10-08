# Proposed cloud API contracts (not implemented)

Version prefix `/v1`. All routes in this document are future contracts; existing local `/mcp`, `/health`, `/events` and artifact APIs are unchanged. JSON names reuse current `worker_id`, `team_id`, `task_id`, `run_id` and `request_id` conventions. Hosted REST is a scoped application boundary, not a public mirror of the unrestricted local MCP instance.

## Common wire and authorization rules

- HTTPS only. `Content-Type: application/json` for bodies; reject unknown fields, malformed IDs, floats for counts, invalid units and oversize bodies. Normal JSON body limit 128 KiB, response/page limit 100 records. Prompts max 32,000 characters, roles max 64. IDs opaque bounded strings; timestamps are Unix milliseconds (as in current events). Quantities are nonnegative decimal strings. List replies use `{items: T[], next_cursor: string|null}`; cursors are opaque and bound to tenant/filter/version, never global local event IDs.
- **Account auth:** website session cookie (HttpOnly, Secure, SameSite, CSRF token on mutations) or SwarmForge account bearer. **CLI auth:** cloud audience CLI bearer with explicit scopes. **Worker auth:** worker-ingress bearer with issued tenant/worker/registration epoch and assignments. **Supervisor auth:** separate internal audience, least scopes and tenant assignment. Accept no GitHub user/App token or current instance bearer as a cloud credential.
- Authentication establishes principal; authorization queries current membership/resource ownership. Roles proposed: viewer reads operational state; operator creates/cancels tasks; admin manages workers; owner/admin reads subscription. Cloud scope and membership must both permit an action. A tenant route parameter is only a requested scope; client `team_id` is never ownership. Every resource read/write is tenant-qualified. Machine principals cannot enumerate orgs, billing, other workers or tasks not assigned to them.
- `Idempotency-Key` required on creation, enrollment approval, cancellation and usage ingestion. ASCII ID 1–128 characters. Scope `(tenant, principal credential, method, route, key)`; for pre-auth linking/registration use initiating-secret/enrollment identity instead of a tenant supplied by the client. Store canonical payload fingerprint, result and status atomically. Same payload returns same result, changed payload returns 409. Retain task/usage deduplication for resource lifetime; short-lived linking/enrollment keys expire with their secrets. Cancellation/revocation are also resource-idempotent. Reads do not require keys.
- Do not cache identity/credential replies; all private responses `Cache-Control: no-store`. Never return reusable credentials in query parameters or logs. Secret-bearing response retry caches must be encrypted, bound to the initiating authenticated context and bounded by expiry; never globally retrievable by key alone. Public link-start rate limits and challenge verification apply before allocations.
- Common error schema:

```ts
interface ApiError {
  error: {
    code: string;
    message: string; // safe, no credentials/resource ownership disclosure
    request_id: string;
    details?: { capability?: string; limit?: string; retry_after_ms?: number };
  };
}
```

Common codes for **every route**, in addition to route-specific errors below: 400 `invalid_request`; 401 `unauthenticated` (invalid/expired/revoked issuer/audience); 403 `forbidden` (authenticated principal lacks permission/scope); 404 `not_found` for absent or another-tenant resources; 409 `idempotency_conflict`; 413 `body_too_large`; 429 `rate_limited` with Retry-After; 503 `temporarily_unavailable`. Invalid credentials do not fall through to local anonymous mode. Backend failures deny new paid work; resource cleanup remains possible through its authoritative path.

Shared response objects:

```ts
type ExecutionClass = "customer_compute_customer_ai" | "managed_compute_customer_ai"
  | "managed_compute_managed_ai";
interface CloudWorker {
  worker_id: string;
  tenant_id: string;
  ownership: "customer" | "managed"; // server-derived
  registration_epoch: number;
  state: "registered" | "online" | "offline" | "revoked";
  created_at: number;
  last_heartbeat_at: number | null;
}
interface CloudTask {
  task_id: string;
  tenant_id: string;
  team_id: string; // grouping only
  role: string;
  execution_class: ExecutionClass;
  state: "queued" | "running" | "completed" | "failed" | "cancellation_requested" | "cancelled";
  worker_id: string | null;
  run_id: string | null;
  created_at: number;
  cancellation_requested_at: number | null;
}
```

Cloud task identity is distinct from an existing worker's descriptive task label; map it explicitly to local lifecycle/dispatch records. A task is not “completed” until authoritative run outcome and required preservation rules are satisfied. Worker registration state is connectivity, not current VM lifecycle state.

## Account identity

**`GET /v1/me`**, account/CLI auth, `identity:read`. No request body. Reply 200:

```ts
{ subject_id: string; display_name: string;
  memberships: { tenant_id: string; role: "owner"|"admin"|"operator"|"viewer" }[];
  next_cursor: string|null }
```

Optional query `cursor`, `limit` (1–100); membership list filtered to this subject's active memberships. No subscription or repository tokens. Wrong worker/supervisor audience returns 401; disabled subject 403 `account_disabled`. Read-idempotent. Identity sign-up/login implementation and provider choice are outside Phase 1.

## CLI linking (separate from GitHub Device Flow)

**`POST /v1/cli-links`**, no existing cloud credential, rate-limited public start. Request `{client_name: string, requested_scopes: string[]}` with allowed client scopes only; includes idempotency key scoped to a client-generated initiating secret passed as `Authorization: LinkInitiator <secret>` (min 32 random bytes). The secret is hashed by server, never echoed. Reply 201:

```ts
{ link_id: string; user_code: string; verification_url: string;
  expires_at: number; poll_interval_seconds: number }
```

Technical defaults: 10-minute expiry, 5-second polling. Verification URL has no polling secret. Unknown scopes 400 `invalid_scope`. No tenant owned yet. Retrying requires the same initiating secret/key/payload; start cannot grant cloud authority.

**`POST /v1/cli-links/{link_id}/approve`**, website account session + CSRF, no CLI/worker approval. Request `{user_code: string, tenant_id: string}`. Reply 200 `{link_id: string, state: "approved", tenant_id: string}`. Verify unexpired code, same link, current tenant membership and requested scopes against approver's role; server binds subject/tenant. Codes are single-use, hashed and attempt-limited. Idempotency required. Errors: 400 `invalid_code`, 409 `link_already_consumed`, 410 `link_expired`, 403 `membership_required`. Do not reveal which other account approved a conflicting code.

**`POST /v1/cli-links/{link_id}/exchange`**, `Authorization: LinkInitiator <secret>`; body `{}`. Reply pending 202 `{state: "pending", poll_interval_seconds: number}`; approved 200:

```ts
{ credential: string; credential_id: string; subject_id: string;
  tenant_id: string; scopes: string[]; expires_at: number }
```

Credential is cloud-api audience, server-derived permissions. Atomic consume; one logical credential issued. Required idempotency key + matching initiating secret permit bounded encrypted replay of the successful exchange until link expiry; another key after consume returns 409 `link_already_consumed`. 410 `link_expired`, 403 `link_denied`, 429 `slow_down`. Returned cloud credential must never be passed to workers or to GitHub. Credential lifetime/renewal/rotation require a separate later design; expired CLI credentials can re-link. Browser/CLI logout and revocation must be shipped with linking, even though not enumerated as new implementation here.

## Worker enrollment, registration and revocation

**`POST /v1/tenants/{tenant_id}/worker-enrollments`**, account/CLI admin, `workers:enroll`, tenant membership required. Body `{name: string}`. Reply 201 `{enrollment_id: string, enrollment_secret: string, expires_at: number}`; secret one-use, 10 minutes, stored hashed. Required entitlement `remote_worker_enrollment`; not a worker concurrency reservation. Idempotency required; same authorized context can retrieve encrypted response replay until expiry. 403 `capability_denied`. Managed supervisors use a separate internal provision/registration authority checked against `managed_compute`, not this customer enrollment bypass.

**`POST /v1/workers/register`**, `Authorization: Enrollment <secret>`; body:

```ts
{ enrollment_id: string; name: string; runtime_version: string;
  capabilities: string[] } // untrusted runtime hints; no tenant/ownership/provider/credential selection
```

Reply 201 `{worker: CloudWorker, credential: string, credential_id: string, expires_at: number, heartbeat_interval_seconds: number}`. Atomically consume enrollment, recheck tenant capability and admin approval revocation, derive customer ownership/tenant, create registration epoch. Idempotency identity is enrollment, not caller's tenant. Same key/context bounded encrypted replay returns same credential; changed request or second consume returns 409 `enrollment_consumed`; 410 `enrollment_expired`. Initial proposed credential lifetime 1 hour and heartbeat 60 seconds; rotation protocol must be delivered before unattended production enrollment. Enrollment proves possession of an invitation, not machine integrity or billable capacity.

**`DELETE /v1/tenants/{tenant_id}/workers/{worker_id}`**, account/CLI admin, `workers:revoke`, tenant ownership required. No body. Reply 200 `{worker_id: string, state: "revoked", revoked_at: number, stop_requested: boolean}`. Idempotency key required; repeated revocation returns same revoked timestamp. Atomically invalidate credentials/epoch/leases and queue external stop. Cross-tenant resource 404. No paid entitlement required for revocation/cleanup; response does not promise physical termination. No client `force` flag that bypasses source/artifact safeguards.

## Heartbeats

**`POST /v1/tenants/{tenant_id}/workers/{worker_id}/heartbeats`**, worker-ingress auth, `heartbeat:write`, issued worker/tenant/epoch must match route. Body:

```ts
{ sequence: number; sent_at: number; runtime_version: string;
  active_runs: {task_id: string; run_id: string; lease_id: string}[] }
```

At most 100 active-run entries. Reply 200 `{accepted_sequence: number, server_time: number, lease_expires_at: number, directive: "continue"|"stop"}`. Every run is checked against this worker's tenant-owned assignment. Monotonic sequence is the idempotency identity: exact retry returns same acknowledgement, changed payload at same sequence 409 `sequence_conflict`, older sequence 409 `stale_sequence`; ordinary Idempotency-Key optional. Client clock does not extend a lease. Revoked credential 401; wrong assignment/lease 403 `assignment_denied`; missing/inaccessible resource 404. Payment denial can issue stop/deny lease renewal while still accepting stop confirmation; heartbeat is not billable compute proof. Task delivery/lease claim and result upload require a later bounded worker protocol; this endpoint does not deliver unrestricted tasks.

## Task creation and cancellation

**`POST /v1/tenants/{tenant_id}/tasks`**, account/CLI operator, `tasks:create`, active membership and `hosted_control_plane`. Body:

```ts
{ request_id: string; team_id?: string; role?: string; prompt: string;
  timeout_seconds?: number; execution_class: ExecutionClass;
  repository_ref?: string; compute_profile_ref?: string; inference_ref: string;
  artifacts?: {path: string; required: boolean}[] }
```

Use current artifact path validation/100 declaration cap and prompt bounds; no raw credentials, arbitrary provider URLs or cloud storage locators. References must be resolved in this tenant, and repository operations separately authorized. `request_id` must match Idempotency-Key; conflict 400 `request_id_mismatch`. Client-provided role/profile/class cannot exceed plan rights. Customer-worker class requires eligible enrolled capacity, managed classes require `managed_compute`, managed-AI also `managed_inference`. Inference references encode customer versus managed ownership and cannot silently switch.

Reply 202 `{task: CloudTask, entitlement_version: string, reservation_id: string}` only after atomic task/capacity/allowance reservation plus durable delivery intent. A duplicate returns the original task/reservation, with no new resources. Future supervisor dispatch is asynchronous; accepted does not mean VM provisioned. Errors: 403 `capability_denied`/`allowance_exhausted`/`repository_denied`; 404 unknown/other-tenant references; 409 `limit_exceeded`/`no_eligible_worker`; 503 `policy_unavailable`. D1/outbox reservation persistence and supervisor dispatch must exist before implementing this endpoint.

**`POST /v1/tenants/{tenant_id}/tasks/{task_id}/cancel`**, account/CLI operator, `tasks:cancel`, tenant ownership required. Body `{reason?: string}` (max 1,000 characters). Reply 202 `{task: CloudTask}` with cancellation_requested after durable stop intent; already settled reply 200 with actual terminal state. Idempotency key required; repeated cancel causes no duplicate release/stop, changed payload at same key 409. Entitlement expiry never blocks cancellation. Worker cannot cancel unassigned tasks through this account route. Actual cancellation depends on external supervisor confirmation; preserve existing finalization and Git safety; usage reservations settle only after authoritative stop evidence.

## Entitlement evaluation

**`POST /v1/tenants/{tenant_id}/entitlements/evaluate`**, account/CLI member, `entitlements:read`. Request:

```ts
{ capabilities: BooleanCapability[];
  limits?: Partial<Record<CountLimit, number>>;
  resources?: Partial<Record<MeteredResource, string>> }
```

Types defined in [entitlements](entitlements.md). Reply 200 `{allowed: boolean, version: string, valid_until: number, reasons: string[], limits: Record<CountLimit, number|null>, allowances: object}` where allowances maps known resources to `{unit, allowed, consumed, reserved, period_start, period_end}`. All data belongs to selected tenant. Unknown capability/unit or invalid amounts 400 `invalid_capability`/`invalid_quantity`; unavailable/stale policy 503 `policy_unavailable`. This is read-idempotent and makes no reservation; task/resource endpoints re-evaluate and reserve server-side. A denied evaluation returns allowed:false, not authentication failure. No client assertion of plan or numeric remaining resources is accepted.

## Subscription status

**`GET /v1/tenants/{tenant_id}/subscription`**, account/CLI owner/admin, `subscription:read`, membership required. No body. Reply 200:

```ts
{ tenant_id: string; edition: "byok_all"|"byok_ai"|"fully_managed"|null;
  status: "none"|"trialing"|"active"|"past_due"|"cancelled"|"suspended";
  period_start: number|null; period_end: number|null;
  cancel_at_period_end: boolean; entitlement_version: string;
  updated_at: number }
```

Read-idempotent; no Stripe IDs, card details, checkout operation, model keys or webhook secrets. No subscription is `none`, never implicit Free license verification. Status is a normalized projection; capability policy decides what trial/past_due means after owner decisions. Workers/supervisors cannot read it. Unavailable projection 503. Checkout/customer portal/webhook routes and implementation are outside Phase 1; website will own payment actions later.

## Usage reporting and reading

**`POST /v1/tenants/{tenant_id}/usage-reports`**, worker `usage:report` for its assignments or trusted supervisor-ingress `usage:write` for its server-issued tenant scope. Body:

```ts
{ events: { event_id: string; task_id: string; run_id: string; worker_id: string;
    resource: "compute"|"inference"; unit: string; resource_class: string;
    quantity: string; interval_start: number; interval_end: number;
    sequence?: number; observation: "complete"|"partial"|"unknown" }[] }
```

1–100 events; server derives `source_id` from credential/provider binding. Caller cannot supply tenant authority, unit prices, charge amount or trust/reconciliation state. Each task/run/worker/interval matches assignment and allowed resource/unit; client time is validated for skew/lease and cannot move arbitrary charges between periods. Batch validates and writes atomically; reply 202 `{accepted_event_ids: string[], duplicate_event_ids: string[], reconciliation: "pending"}`. Required key scopes request; durable `(tenant, source, event)` dedupe persists beyond response cache. Same event payload is a duplicate; changed event 409 `usage_conflict`; invalid interval/unit/quantity 400; unassigned report 403 `assignment_denied` or inaccessible task 404. Rejecting a whole batch prevents ambiguous partial acceptance. Workers' reports are untrusted observations, never permission to increase allowances or bill another tenant. Trusted supervisor/provider reconciliation and inference proxy are required for billing. Already-executed usage can be ingested after subscription lapses; revoked workers are rejected, supervisor reconciliation remains possible.

**`GET /v1/tenants/{tenant_id}/usage`**, account/CLI member, `usage:read`; query optional `task_id`, `period_start`, `period_end`, `cursor`, `limit` with bounded date range. Reply 200 `{items: {resource: string, unit: string, resource_class: string, consumed: string, reserved: string, observation: "complete"|"partial"|"unknown", reconciliation: "pending"|"reconciled"}[], next_cursor: string|null}`. Tenant-qualified task filters, inaccessible tasks 404, invalid range 400. Read-idempotent; no raw provider credentials, internal cost breakdown, prompt or other tenants' data.

## Contract acceptance before Phase 2 rollout

Tests must reject cross-tenant IDs on every resource route (including usage, cursors, artifacts and references), wrong machine audiences, revoked epochs, expired linking/enrollment secrets, double consumes, changed idempotency payloads, parallel quota admissions, fabricated usage and stale subscriptions. Exercise CSRF, rate limits, credential-safe response/logging and account membership revocation. No route is considered delivered merely because its schema exists. Task leasing/delivery/result reporting, credential rotation and reliable external stop are required dependencies, intentionally not implemented in Phase 1.

Phase 2B.1 implementation: [CLI linking and worker identity API](phase-2b1-api.md), [operational procedures](../cloud/IDENTITY.md). Historical future contracts above remain proposals where the implementation document does not mark a route implemented.

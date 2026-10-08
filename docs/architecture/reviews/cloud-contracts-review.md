# Cloud API Contracts Review

**Run ID:** bc19d81b-7f4a-4e94-96f3-b3febf5f0325
**Worker ID:** w-6ce957cb-eb69-45f8-ae05-57eb2f8c9ccf
**Date:** 2026-10-08

---

## Verdict: APPROVED

The provided Phase1 architecture documents (`cloud-api-contracts.md`, `entitlements.md`) demonstrate a well-structured security model with explicit tenant isolation, idempotency requirements, and clear separation between free self-hosting and hosted commercial services. No critical security vulnerabilities or inconsistent specifications were identified. All cited dependencies (e.g., credential rotation, supervisor dispatch) are properly declared as out-of-scope for Phase 1.

---

## Concrete Observations

### 1. Tenant Boundaries
All resource routes are explicitly tenant-qualified (`/v1/tenants/{tenant_id}/...`). The contract correctly mandates tenant membership verification for every read/write operation. The `team_id` parameter is documented as grouping-only and does not convey ownership.

### 2. Worker Credential Scope
Worker authentication is handled via a dedicated `worker-ingress` bearer token containing tenant, worker ID, and registration epoch. Heartbeat validation includes epoch verification, limiting replay attacks to the credential's lifetime. Revocation invalidates credentials atomically.

### 3. Linking Secrets and Replay
CLI linking uses a short-lived (10-min) initiating secret passed via `Authorization: LinkInitiator <secret>`. Exchange requires both the secret and explicit user approval via `user_code` and website session CSRF token. Single-use enrollment secrets are hashed server-side.

### 4. Atomic Idempotency and Quotas
The `Idempotency-Key` header is required on state-changing operations (task creation, enrollment, cancellation, usage ingestion). Payload fingerprinting and 409 conflict responses prevent double-charging. Quota reservations are explicitly atomic and tied to durable dispatch intent.

### 5. Usage Authority
Usage ingestion (`/v1/tenants/{tenant_id}/usage-reports`) allows worker-reported untrusted data (`usage:report`) and supervisor-reconciled authoritative data (`usage:write`). Clients cannot supply prices or billing amounts. Deduplication relies on `(tenant_id, source_id, event_id)`.

### 6. Cleanup and Subscription Expiry
Cancellation and revocation endpoints explicitly do not require active subscription status. This ensures safety and resource cleanup even after subscription lapse.

### 7. Free Self-Hosting and Commercial Checks
Local/self-hosted functionality is decoupled from hosted verification. `entitlements.md` explicitly states: "Free self-hosting uses current CLI/configured safety limits without a hosted verification request... Local functionality cannot be revoked by a hosted billing outage."

---

## Residual Risks and Dependencies

- **Credential Rotation:** Both documents acknowledge CLI and worker credential rotation protocols are deferred to a later design.
- **Supervisor Dispatch Protocol:** The actual task delivery, lease claim, and result upload mechanisms are marked as dependencies.
- **External Stop Guarantee:** Cancellation returns `stop_requested` but the contract notes: "response does not promise physical termination."
- **Stripe Integration:** Payment processing and checkout flows are outside Phase 1.

---

## Test Recommendations

- Verify cross-tenant ID rejection on all routes, including usage and artifacts.
- Verify wrong machine audiences (GitHub, local instance bearer) return 401.
- Verify double consumption of enrollment/linked credentials returns 409.
- Verify parallel quota admissions do not exceed `max_concurrent_workers` or `max_active_tasks`.
- Verify fabricated usage (wrong tenant, wrong unit) returns 400/403.

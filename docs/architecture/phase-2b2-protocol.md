# Phase 2B.2 shared implementation contract

This is the engineering interface contract. The user specification is authoritative.
Working implementations must preserve these names/semantics; owners report necessary
changes to the lead before altering a shared interface.

## Authority and safe workload

Existing sfcli_/sfworker_ grants/scopes remain unchanged. Browser-authorized
`sfexec_` credentials (audience `hosted-cli`, scopes tasks:create/tasks:read/tasks:cancel/
entitlements:read) bind an existing CLI installation, its epoch, user, active tenant
and finite authorization. Only the installation's own user may authorize it via an
authenticated session/CSRF. CLI rotation/logout/revocation invalidates execution
grants. These credentials do not perform identity/worker/admin operations.

`sfsuper_` supervisor credentials use audience `hosted-supervisor`, scopes
supervisor:claim/supervisor:renew/supervisor:report/supervisor:cleanup, separate tables,
hashes, epochs, revocation and finite authorization. An owner/admin browser explicitly
registers a supervisor bound to an enrolled tenant worker. Claims/renewal additionally
check that worker and task authorizer/installation remain active. Cleanup uses a
current supervisor credential and task/fence ownership without commercial entitlement
checks; worker revocation cannot prohibit trusted stop reporting. A revoked/expired
supervisor credential is rejected; trusted operator recovery must reauthorize cleanup.

All newly admitted tasks use `execution_class: "controlled"` only, with bounded
integer `runtime_ms` and `controlled_duration_ms`; duration cannot exceed runtime.
No arbitrary shell, prompt, repo/reference, model/provider key, environment, callback
URL or snapshot enters hosted execution. `untrusted_execution_enabled` is structurally
false. Public BYOK repository/model workloads are not enabled by setting capabilities.

## JSON interfaces

Identifiers are UUIDs, times Unix milliseconds, numbers safe integers. Strict schemas
reject unknown fields; generated request IDs and existing common error envelopes,
no-store/CORS/CSRF/body/query safeguards apply. Every mutation requires Idempotency-Key.
Keys bind tenant + current principal/resource + operation and canonical fingerprint.
Replays recheck current authority and never allocate additional capacity.

Task submission body:

```json
{"request_id":"UUID","worker_id":"UUID","execution_class":"controlled","runtime_ms":10000,"controlled_duration_ms":100}
```

Public task projection (no raw credentials, prompt or secrets):

```ts
interface HostedTask {
  task_id: string; tenant_id: string; worker_id: string;
  execution_class: "controlled";
  state: "queued"|"claimed"|"running"|"stop_requested"|"held"|"completed"|"failed"|"cancelled"|"expired";
  reservation_id: string; policy_version: number;
  runtime_ms: number; controlled_duration_ms: number;
  created_at: number; deadline_at: number;
  lease_id: string|null; supervisor_id: string|null; fence: number;
  lease_expires_at: number|null;
}
interface AdmissionReply { task: HostedTask; reservation_id: string; policy_version: number }
interface ClaimReply { task: HostedTask|null } // task carries lease/id/fence/expiry
interface LeaseRequest { lease_id: string; fence: number }
interface LeaseReply { task: HostedTask; directive: "continue"|"stop" }
interface SettlementRequest extends LeaseRequest {
  outcome: "completed"|"failed"|"cancelled";
  stop_confirmed: true;
  consumed_runtime_ms: number;
}
```

Before starting: claim → persist SQLite mapping → acknowledge → start. Ack and renew
return LeaseReply. Lease expiry/authority loss requests stop and denies renewal;
it never establishes stop. Settlement records only current lease/fence, same supervisor,
trusted stop proof and bounded measured consumption. Cleanup settlement can reference
an expired execution lease; stale fences cannot alter task/reservation state. Repeated
same-payload terminal reporting is idempotent. A changed terminal report conflicts.

## Routes

- POST /v1/tenants/:tenant/cli-installations/:installation/execution-authorizations
  (own browser session/CSRF) → execution credential + grant/installation/tenant/user IDs,
  exact scopes, expires_at and authorization_expires_at.
- GET /v1/tenants/:tenant/entitlements (browser/hosted-cli) → current policy/denial and
  reserved/consumed counts; no public policy-write route.
- POST /v1/tenants/:tenant/tasks (browser/hosted-cli) → AdmissionReply, 202.
- GET /v1/tenants/:tenant/tasks/:task (browser/hosted-cli) → {task}.
- POST /v1/tenants/:tenant/tasks/:task/cancel (browser/hosted-cli) body {} → {task},
  202 for durable stop request or 200 when already terminal; no entitlement requirement.
- GET /v1/tenants/:tenant/hosted-status (browser/hosted-cli) → tenant-private quota,
  reservations, outbox/lease/stop and supervisor availability observations.
- POST /v1/tenants/:tenant/supervisors (owner/admin browser/CSRF), body {worker_id,name}
  → supervisor credential + supervisor/worker/tenant/user IDs, exact scopes,
  expires_at and authorization_expires_at.
- DELETE /v1/tenants/:tenant/supervisors/:supervisor (owner/admin browser/CSRF)
  → revoke execution authority and durable stop duty; no unsafe capacity release.
- GET /v1/supervisor/me (supervisor only) → identity, tenant/worker IDs, scopes/expiry.
- POST /v1/supervisor/me/rotate (supervisor only) → successor credential; exact retry
  recovery only while successor and authorization remain valid.
- POST /v1/supervisor/claim body {} → ClaimReply (null when no eligible work).
- POST /v1/supervisor/tasks/:task/ack body LeaseRequest → LeaseReply.
- POST /v1/supervisor/tasks/:task/renew body LeaseRequest → LeaseReply.
- POST /v1/supervisor/tasks/:task/settle body SettlementRequest → {task}.
- GET /v1/supervisor/tasks/:task → LeaseReply, including stop duty after cancellation,
  expired policy/lease or revoked worker. Own assignment only.

## Schema and SQL contract

One foundation owner creates `0003_hosted_execution.sql` and
`apps/cloud/src/hosted-types.ts`. Tables: hosted_entitlements, hosted_allowances,
hosted_execution_grants, hosted_supervisors, hosted_supervisor_credentials,
hosted_supervisor_rotations, hosted_tasks, hosted_reservations, hosted_outbox and
hosted_operations. Field/DDL details are frozen at the schema checkpoint before the
dispatch owner starts. No existing machine_credentials audience CHECK is widened.

Policy capabilities: hosted_control_plane, remote_worker_enrollment,
hosted_task_execution. Numeric limits: max_concurrent_workers, max_active_tasks,
max_task_runtime (milliseconds), maximum_resource_reservations. Zero/absent policy
denies new work; finite technical safety ceilings are not pricing/product quotas.
Metered allowance definitions use explicit unit, period and canonical bounded integer
quantity strings (exact integer arithmetic). No floats, loose digit GLOB validation,
process-local reservation counters or client-selected plan names grant authority.

Admission batch conditionally inserts task only when principal/worker/policy/quotas
remain valid; all dependent reservation/outbox/audit writes are conditional on that
new task. A batch failure rolls everything back. Indexed active/quarantined
reservation counts are authoritative; cancellation/expiry never removes uncertain
execution from those counts. Unclaimed work may be atomically expired/cancelled and
released. Audit, release, consumption and terminal state settle together once.

Outbox claim is CAS with a monotonic fence and finite lease, plus scoped retry record.
Ack never reallocates. Renewal cannot renew an expired lease. Deadline is absolute
and never extends; policy/worker/task-authorizer authority is rechecked. Failed renewal
or partition triggers local stop. No automatic execution retry until old runtime stop
is confirmed; orphan recovery holds capacity and exposes trusted cleanup work.

## Root integration contract

The worker client owner extracts shared `src/private-credential-file.ts` exports:
readPrivateCredential<T>(path,schema), savePrivateCredential<T>(path,value,schema),
deletePrivateCredential<T>(path,schema). Existing CLI wrappers keep behavior unchanged.
Worker and supervisor files have separate schemas, paths and audiences. Pending
rotation/settlement keys are durable so lost replies retry the same operation.

The Bun adapter uses existing Coordinator/Store and runtime provider interfaces,
persists cloud task/lease/fence → local worker mapping before start, and holds uncertain
states. It never equates Coordinator cancelled/paused with verified stop. Controlled
runtime runs without inheriting provider/repository/model/cloud bearer credentials;
only fixed inert operations and finite deadlines are permitted. A runtime watchdog
survives supervisor process failure or otherwise fails closed before lease expiry.
No hosted imports or contact are added to default self-hosted startup.

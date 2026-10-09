# Atomic admission: minimal D1 entitlements / reservations / admission / outbox design (read-only investigation)

Baseline: `fec66971536cb117b36c85faabd98883d6491cb2` on assigned branch
`swarmforge/phase2b2-hosted-20261009/architecture-atomic-admission/w-452f4e44-e8fb-4036-a854-2e66b4ce3dd8`, verified attached HEAD, repo clean, no code changed.
Scope: design only. No implementation, migration, deploy, secret access, lockfile change.
Time-boxed to actionable design (~10 min investigation depth).

## 1. What the sources actually say (evidence)

- Entitlement model is documented, not implemented. `docs/architecture/entitlements.md` defines boolean capabilities (`local_orchestration`, `github_repository_access`, `hosted_control_plane`, `remote_worker_enrollment`, `managed_compute`, `managed_inference`), count limits (`max_concurrent_workers`, `max_active_tasks`), metered allowances (`monthly_compute_allowance`, future `monthly_inference_allowance`), with explicit `null`=unlimited, decimal-string meters, server-owned versioned expiring snapshot, advisory-until-reserved. No `max_task_runtime` / `maximum_resource_reservations` exist yet; the question adds them — they are new fields, not current schema.
- Cloud contracts are proposals except Phase 2A/2B.1. `docs/architecture/cloud-api-contracts.md` proposes `POST /v1/tenants/{id}/tasks` (202 only after atomic task/capacity/allowance reservation + durable delivery intent, `request_id`==`Idempotency-Key`, 403 capability/allowance, 409 limit/no-worker, 503 policy-unavailable), `POST .../cancel`, `POST .../entitlements/evaluate` (read-only, no reservation), `POST .../usage-reports` (atomic batch, `(tenant,source,event)` dedupe, whole-batch reject). `docs/architecture/phase-2b1-api.md` marks only linking/enrollment implemented; heartbeats/tasks/usage/VM/billing are explicitly not implemented.
- Implemented D1 pattern is conditional serialized batch. `0001_identity.sql` + `0002_machine_identity.sql` use UUID PKs, hashed secrets, `CHECK(status/role/state/expiry)`, FKs, unique `(org,session,operation,key)` dedupe, fingerprints + AES-GCM encrypted replay caches, indexes. `apps/cloud/src/enrollment.ts:200-231` does `UPDATE ... WHERE consumed_at IS NULL AND ... authority ... AND (SELECT count(*) ...)<100` + `INSERT INTO cloud_workers SELECT ... WHERE ...` + `credentialInsert ... WHERE EXISTS(...)` + conditional `auditStatement` (`INSERT OR IGNORE ... SELECT ... WHERE source`) + final verifying `SELECT`; empty final select => 403. Same shape in `links.ts`, `machines.ts:263-299` (epoch CAS rotation). `common.ts:129-149` plain `audit()` is *not* rollback-safe alone; `machines.ts:143-165 auditStatement` is the rollback-safe pattern (audit row appears iff source row matches).
- Local lifecycle is not a hosted admission authority. `src/store.ts`: `workers(team_id,request_id)` unique, fingerprint + legacy fingerprints for idempotent `create()` (`store.ts:217-311`), `usage(worker_id,message_id)` max-merge (`store.ts:616-631`) — explicitly a hint source per `entitlements.md:66-70` (misses bounded history, `complete`!=metering completeness). `coordinator.ts:861-952` `quiesce()`: `stopWorkerRuntime` success=stopped, rejection=uncertainty (pause/missing retained, not proven stopped); `src/providers/freestyle.ts:344-352` verified systemd stop. `src/settings/load.ts:318-367` local `limits.max_workers/max_provisioning/max_queue/default_timeout_seconds/...` are operator config, not subscription caps (`product-tiers.md:29` confirms).
- Edge/D1 bounds. `docs/architecture/deployment.md:19-34` + `docs/cloud/DEPLOYMENT.md`: Workers Free 100k req/day, 10ms CPU, 50 queries/invocation, D1 5M rows-read/100k rows-written per day, 500MB/DB, 7-day Time Travel. 50 workers x 1/min heartbeat = 72k req/day before anything else. `abuse.ts` D1-backed per-minute HMAC buckets + 10-min cron `cleanupIdentity` (bounded 500-row statements, preserves revocation history). `cloudflare.config.ts` local/preview only, no production mode.
- Auth invariant: tenant from current D1 membership/binding, never client claim. `common.ts:172-188 membership()`, `machines.ts:84-103 browserGuard/machineGuard`, `enrollment.ts:270-280` route enforces tenant-qualified IDs, 404 cross-tenant, no authority cache, privileged writes recheck inside batch.

## 2. Recommended minimal schema (migration `0003`, additive only)

Design goals: server-owned, versioned, explicit units, no prices/grants, survives concurrent same/multi-user/multi-CLI/org replays, audit rollback, no TTL-only release of uncertain execution, dev/hostile separation.

```sql
-- Server-owned capability snapshot history. One ACTIVE row per org enforced by app
-- conditional insert (no partial-unique in D1); history retained for audit/replay.
CREATE TABLE entitlement_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  version INTEGER NOT NULL CHECK(version > 0),
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL CHECK(valid_until > valid_from),
  revoked_at INTEGER,
  -- booleans as 0/1; hosted admission checks these, local dev checks local_orchestration only
  local_orchestration INTEGER NOT NULL CHECK(local_orchestration IN (0,1)),
  hosted_control_plane INTEGER NOT NULL CHECK(hosted_control_plane IN (0,1)),
  remote_worker_enrollment INTEGER NOT NULL CHECK(remote_worker_enrollment IN (0,1)),
  managed_compute INTEGER NOT NULL CHECK(managed_compute IN (0,1)),
  managed_inference INTEGER NOT NULL CHECK(managed_inference IN (0,1)),
  -- count ceilings; NULL = explicit unlimited on an enabled path, never missing/Infinity
  max_concurrent_workers INTEGER CHECK(max_concurrent_workers IS NULL OR max_concurrent_workers >= 0),
  max_active_tasks INTEGER CHECK(max_active_tasks IS NULL OR max_active_tasks >= 0),
  max_task_runtime_seconds INTEGER CHECK(max_task_runtime_seconds IS NULL OR max_task_runtime_seconds > 0),
  maximum_resource_reservations INTEGER CHECK(maximum_resource_reservations IS NULL OR maximum_resource_reservations >= 0),
  created_at INTEGER NOT NULL, created_by TEXT,
  UNIQUE(organization_id, version)
);
CREATE INDEX entitlement_snap_org_valid ON entitlement_snapshots(organization_id, valid_from, valid_until);

-- Explicit metered units. No currency/price. allowed TEXT decimal string or NULL=unlimited.
-- Example units to standardize (owner decision): `compute_seconds_by_class`, `inference_tokens_by_model`.
CREATE TABLE entitlement_allowances (
  allowance_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  snapshot_id TEXT NOT NULL REFERENCES entitlement_snapshots(snapshot_id),
  resource TEXT NOT NULL CHECK(resource IN ('monthly_compute_allowance','monthly_inference_allowance')),
  unit TEXT NOT NULL CHECK(unit IN ('compute_seconds_by_class','inference_tokens_by_model')),
  resource_class TEXT NOT NULL, -- e.g. 'cpu-s','gpu-s' or model id; never blank
  allowed TEXT CHECK(allowed IS NULL OR allowed GLOB '[0-9]*'),
  period_start INTEGER NOT NULL, period_end INTEGER NOT NULL CHECK(period_end > period_start),
  UNIQUE(organization_id, resource, resource_class, period_start)
);
CREATE INDEX allowance_period ON entitlement_allowances(organization_id, resource, period_start, period_end);

-- Tenant-owned task + admission state. Idempotency scope binds principal credential.
CREATE TABLE hosted_tasks (
  task_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  snapshot_id TEXT NOT NULL REFERENCES entitlement_snapshots(snapshot_id),
  snapshot_version INTEGER NOT NULL,
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('account','cli')),
  principal_id TEXT NOT NULL, -- session_id or installation_id; worker/supervisor cannot create
  operation TEXT NOT NULL DEFAULT 'task.create',
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  execution_class TEXT NOT NULL CHECK(execution_class IN ('customer_compute_customer_ai','managed_compute_customer_ai','managed_compute_managed_ai')),
  state TEXT NOT NULL CHECK(state IN ('held','queued','running','completed','failed','cancel_requested','cancelled')),
  worker_id TEXT REFERENCES cloud_workers(worker_id),
  lease_id TEXT, lease_expires_at INTEGER,
  compute_reserve TEXT NOT NULL DEFAULT '0' CHECK(compute_reserve GLOB '[0-9]*'),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(organization_id, principal_id, operation, idempotency_key)
);
CREATE INDEX hosted_task_org_state ON hosted_tasks(organization_id, state, task_id);
CREATE INDEX hosted_task_lease ON hosted_tasks(lease_expires_at) WHERE state IN ('held','queued','running','cancel_requested');

-- Finite reservations. Released only by authoritative settle/cancel/reconcile, never TTL alone.
CREATE TABLE task_reservations (
  reservation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  task_id TEXT NOT NULL UNIQUE REFERENCES hosted_tasks(task_id),
  kind TEXT NOT NULL CHECK(kind IN ('worker_slot','task_slot','compute_allowance')),
  quantity TEXT NOT NULL CHECK(quantity GLOB '[0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('held','consumed','released')),
  expires_at INTEGER NOT NULL, released_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX reservation_org_state ON task_reservations(organization_id, kind, state);

-- Durable dispatch intent. Supervisor polls/claims; edge never executes.
CREATE TABLE dispatch_outbox (
  outbox_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  task_id TEXT NOT NULL REFERENCES hosted_tasks(task_id),
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','acked','dead')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL, claimed_by TEXT, claim_expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  UNIQUE(task_id)
);
CREATE INDEX outbox_claim ON dispatch_outbox(organization_id, state, created_at);
```

What this deliberately omits: prices, plan names, default grants, Stripe IDs, BYOK secrets, provider keys, heartbeat telemetry, full logs, token rows. Usage ledger (authoritative supervisor/proxy counters) is the next migration, not this one; customer-worker reports stay hints.

## 3. Atomic admission transaction (single D1 `batch`, ~7 statements, <50-query cap)

All reads/writes in one `DB.batch([...])`. Client inputs validated by Zod first (strict, 128KiB body, `request_id`==`Idempotency-Key`, UUIDs, safe-int counts, decimal-string quantities, `execution_class`/refs tenant-qualified). Server time `now` only; client clock never extends leases.

1. `INSERT INTO hosted_tasks SELECT ... WHERE <membership+snapshot-valid+capability>` with count-guard subselects:
   `AND (max_active_tasks IS NULL OR (SELECT count(*) FROM hosted_tasks WHERE organization_id=? AND state IN ('held','queued','running','cancel_requested')) < max_active_tasks)` and equivalent worker-slot / `maximum_resource_reservations` guards, plus allowance headroom guard against a compact period summary (see §5). `ON CONFLICT(organization_id,principal_id,operation,idempotency_key) DO NOTHING`.
2. `INSERT INTO task_reservations SELECT ... WHERE EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=? AND ...)` — one row per kind needed (worker_slot always; compute_allowance only for managed classes).
3. `INSERT INTO dispatch_outbox SELECT ... WHERE EXISTS(...)` — durable intent before 202.
4. Conditional `auditStatement` (`INSERT OR IGNORE ... SELECT ... WHERE source`) — failed audit rolls back admission because batch is atomic.
5. Final `SELECT hosted_tasks + reservations + outbox WHERE task_id=? AND organization_id=? AND principal guard` — empty => deny (409 limit / 403 capability / 410 expired / 503 policy), non-empty + fingerprint match => return same `task/reservation_id/snapshot_version`; fingerprint mismatch => 409 `idempotency_conflict`.
6. Same-key retry under concurrent same/multi-CLI/org: `DO NOTHING` + final select returns winner; losers never create second task. Different principal => different scope => different row (no cross-principal replay). Different org => different `organization_id` scope => 404, never leak.

Cancel path is separate batch: `UPDATE hosted_tasks SET state='cancel_requested' WHERE ... AND state IN (...)` + `INSERT outbox stop-intent (upsert to claimed)` + conditional audit + final select. Cancel never checks entitlement (cleanup allowed after downgrade) and never releases `task_reservations` to `released` until supervisor confirms terminal state or reconcile proves no execution started.

## 4. SQL invariants (enforce in DDL + conditional DML, not app memory)

- Server ownership: every `INSERT...SELECT ... WHERE` rechecks `memberships.status='active' AND organizations.status='active' AND users.status='active'` (or authorizer owner/admin for worker-linked capacity) + snapshot `valid_from<=now<valid_until AND revoked_at IS NULL`. No client `tenant_id`/`version`/`remaining` trusted.
- Version pinning: `hosted_tasks.snapshot_version` = snapshot used at admission; renewals/re-issues re-resolve current snapshot, never silently inherit.
- Expiry/revocation fail-closed for new work (403/503), fail-open for cleanup (cancel/revoke/stop always permitted). Restoring identical authority may resume unexpired grants; permanent removal revokes installation/worker + snapshot.
- State machine: `held->queued->running->completed/failed/cancel_requested->cancelled`; reservations `held->consumed|released`; outbox `queued->claimed->acked/dead`. No backwards transitions; `UPDATE ... WHERE state IN (...)` guards each step.
- No TTL-only release: `lease_expires_at` / `reservations.expires_at` trigger supervisor stop-duty + reaper `claimed` retry, never `UPDATE ... SET released WHERE expires_at<now` on `running/held` with uncertain execution. Release requires terminal evidence (supervisor ack with run outcome) or reconcile proving dispatch never left `queued` + outbox `dead`. This mirrors local `quiesce` uncertainty: rejection means paused/retained, not stopped.
- Decimal meters as TEXT + `GLOB '[0-9]*'` + app-side decimal compare; counts as safe integers; unknown capability/unit => 400; stale/missing policy => 503, no new paid work.
- Audit-or-rollback: every mutating batch ends with conditional audit insert; batch atomicity gives rollback on DB failure. Public denials that never allocate rows do not write audit (matches `abuse.ts` budgets).

## 5. Counters vs count-scan vs triggers

- Recommended for pilot: **count-scanning with covering partial indexes** (`hosted_task_org_state`, `reservation_org_state`). Correct under D1 serialized writes, no second source of truth to drift, fits Free quotas at pilot scale (a handful of indexed `count(*)` per admission, well under 50-query cap). Matches existing `<25 invitations` / `<100 workers` guard style.
- **Counter table** (e.g. `org_counters(active_tasks, ...)` with atomic `UPDATE ... SET n=n+1 WHERE n<max`): fewer rows read at high concurrency but introduces leak/double-release failure modes on crash/retry; every increment needs a paired transactional decrement tied to authoritative settle, otherwise counters drift from reality. Adopt only with measured D1 row-read pressure and a tested reconcile job; keep scanning as correctness oracle in tests.
- **Triggers**: do not use. Hidden write amplification, harder security review, interacts poorly with D1 batch visibility/Time Travel expectations, and obscures the explicit authority rechecks reviewers must see. All invariants stay in visible `CHECK` + conditional DML.
- No exactly-once execution: guarantee is **at-most-one admission + at-least-once dispatch with idempotent claim**. Outbox `claimed` requires supervisor identity + `claim_expires_at`; duplicate delivery after crash returns same `task_id/lease_id`; supervisor dedupes by `(task_id, lease_id)`; execution side-effects remain non-idempotent by nature and must be reconciled, not promised away.

## 6. Task/admission policy schema + routes (exact, minimal)

Zod-strict, tenant-qualified, `Cache-Control: no-store`, safe `{error:{code,message,request_id}}`:

- `POST /v1/tenants/{tenant_id}/tasks` (account/CLI operator, `tasks:create`, `hosted_control_plane`): body `{request_id, team_id?, role?, prompt(1..32000), timeout_seconds?(1..max_task_runtime_seconds), execution_class, repository_ref?, compute_profile_ref?, inference_ref, artifacts?(<=100 workspace-relative)}`; `request_id` must equal `Idempotency-Key`. 202 `{task, entitlement_version, reservation_id, lease}` after §3 batch. Errors: 403 `capability_denied|allowance_exhausted|repository_denied`, 409 `limit_exceeded|no_eligible_worker|idempotency_conflict`, 410 snapshot/grant expired, 503 `policy_unavailable`.
- `POST /v1/tenants/{tenant_id}/tasks/{task_id}/cancel` (operator, `tasks:cancel`): `{reason?<=1000}` + key; 202 `cancel_requested` then terminal on supervisor evidence; idempotent repeats same state.
- `GET /v1/tenants/{tenant_id}/tasks/{task_id}` + list with tenant-bound signed cursors (reuse `common.ts:page/cursor`).
- `POST /v1/tenants/{tenant_id}/entitlements/evaluate` (member, read-only, no reservation): returns `{allowed, version, valid_until, reasons, limits, allowances{unit,allowed,consumed,reserved,period}}`.
- Supervisor-only (new audience `supervisor-ingress`, never CLI/worker/GitHub/instance bearer): `POST /v1/supervisor/outbox/claim` (`{task_id, supervisor_id}` -> lease + payload, bounded `claim_expires_at`), `POST /v1/supervisor/outbox/ack` (`{task_id, lease_id, outcome}` -> settle + `consumed|released` + conditional audit), `POST /v1/supervisor/tasks/{id}/heartbeat` (monotonic seq, same 409 `sequence_conflict|stale_sequence` semantics as proposed heartbeats). Heartbeat renews lease but never creates capacity.
- Dev/hostile separation: `local_orchestration=true` gates local `Store.create()` path with operator `limits.*`; `hosted_control_plane=false` denies all cloud task routes even if local works. No shared bearer across these paths; worker `worker-identity` never gains `tasks:create`.

## 7. Integration tests to require (real D1 + workerd, concurrent)

Reuse `apps/cloud/test/*integration.ts` harness + Bun CLI bridge pattern from Phase 2B.1: parallel same-key admission (1 winner, N identical replies), parallel limit exhaustion (e.g. 10 racing admits at `max_active_tasks=5` => exactly 5 held, 5x 409), multi-user/multi-CLI same org isolation (different principal scopes don't collide; cross-tenant 404 on tasks/cursors/outbox), changed-payload-same-key 409, stale/revoked/expired snapshot denial, downgrade-during-flight (new denies, in-flight settles, cancel always works), audit-rollback on injected D1 failure, crash-between-batch-and-ack (retry returns same task, no double reservation, outbox still `queued`), TTL-expiry-with-uncertain-execution (reservation stays `held`, stop-duty queued, no silent release), supervisor claim/ack idempotency (duplicate ack same result, wrong lease 403), metered headroom (allowance-exhausted 403, unit mismatch 400, untrusted worker usage never increases allowance), `last_seen_at`-style metadata never used for auth (negative control).

## 8. Trade-offs and challenged assumptions

- Lead assumes D1 batch "serializes" concurrency away: true for write serialization, but correctness still depends on **conditional** SQL (guards inside the batch), not evaluate-then-insert. Any app-side count followed by insert reintroduces the race. This design puts every ceiling check in `WHERE` subselects.
- Lead implies TTL/lease can bound cost: TTL bounds *duty to stop*, not proof of stop. Local evidence (`coordinator quiesce` + verified systemd stop) shows uncertain stops retain/pause. Releasing metered/count capacity on TTL alone would under-bill and over-admit. Require authoritative terminal evidence.
- Lead lists `max_concurrent_workers`/`max_active_tasks` as sufficient: without `max_task_runtime_seconds` (lease/deadline ceiling) and `maximum_resource_reservations` (total held intents per org, distinct from active tasks), a tenant can hold unbounded queued intent. Add both, server-clamped by `timeout_seconds<=max_task_runtime_seconds`.
- Lead may treat `evaluate` as pre-check: document it as advisory only; admission re-evaluates. Otherwise TOCTOU between evaluate and create.
- "Unlimited" must be explicit `null` per known field; missing/stale snapshot denies. Do not invent default grants/prices.
- Free-tier fit is not established for admission polling: keep supervisor polling bounded (not per-worker 60s edge heartbeats at scale), aggregate via supervisor, measure CPU/rows-read before pilot.

## 9. Sources

Product source read at baseline: `docs/architecture/{phase-1-summary,phase-2a-summary,phase-2b1-summary,entitlements,cloud-api-contracts,identity-and-trust,implementation-plan}.md`, `phase-2b1-api.md`, `deployment.md`, `docs/cloud/{DEPLOYMENT,IDENTITY}.md`, `apps/cloud/migrations/000{1,2}_*.sql`, `apps/cloud/src/{common,index,links,machines,enrollment,abuse,crypto,schemas}.ts`, `cloudflare.config.ts`, `src/{store,domain,coordinator}.ts`, `src/providers/freestyle.ts`, `src/settings/load.ts`. No product code modified.

## 10. Unanswered / owner decisions needed

Units/rate schedule for `compute_seconds_by_class` weighting; `max_task_runtime_seconds` default ceiling; `maximum_resource_reservations` per-org default; allowance period/reset/carryover/overage-vs-hard-cap; grace/downgrade handling of held work; audit/usage retention (90d technical suggestion, no policy); supervisor polling interval vs Free quotas; preview D1 + abuse-budget validation; BYOK secret custody; repository broker choice; managed inference proxy design. None are invented here.

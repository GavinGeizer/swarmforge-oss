# Architecture: durable Cloudflare → existing Bun supervisor lease & recovery protocol
Phase 2B.2 engineering investigation — READ ONLY, no code changed

- Repo: GavinGeizer/swarmforge-oss
- Baseline: `fec66971536cb117b36c85faabd98883d6491cb2` ("docs: clarify distributed orchestration and verify developer onboarding")
- Branch (attached, not detached, no master merge): `swarmforge/phase2b2-hosted-20261009/architecture-leases-recovery/w-4e10d527-68dd-453b-9cac-6138049a538c`
- HEAD verified: `git reset --hard fec6697...` → `git rev-parse HEAD` = `fec6697...`, `git rev-parse --abbrev-ref HEAD` = assigned branch, `git status` clean.
- Docs read: `docs/architecture/{phase-1-summary,phase-2a-summary,phase-2b1-summary,entitlements,cloud-api-contracts,identity-and-trust,implementation-plan}.md` + `phase-2b1-api.md`; source read: `src/coordinator.ts`, `src/store.ts`, `src/domain.ts`, `src/providers/freestyle.ts` (stop hook), `apps/cloud/src/{index,common,machines,enrollment}.ts`, `apps/cloud/migrations/0002_machine_identity.sql`.
- No code implemented, no lockfiles touched, no deploys, no secrets accessed. No tests run (read-only investigation by design).
- Output location: `/workspace/.swarmforge/artifacts/report.md` (outside repo; repo kept clean). A copy is also placed at `/workspace/.swarmforge/artifacts/research.md` per task text.

## 1. Question restated

Design — independently, from source evidence — a durable protocol between Cloudflare edge (authority) and the **existing** Bun Coordinator acting as a *supervisor* (execution side), covering: distinct opaque hashed supervisor audience (must not widen `worker:identity`), admin-issued finite authorization, claim/ack/renew/cancel/complete/stop-reconcile lifecycle, fencing, crash-safe SQLite mapping to Coordinator records, confirmed-stop semantics from existing quiesce/cancel hooks, the critical rule that **lease expiry ≠ confirmed stop** (no redispatch until old runtime stop is trusted), a partition stop watchdog, idempotency/lost-ack handling, stale-supervisor cleanup-vs-execution authority split, flaws in naive outbox/claim designs, and a minimal adapter (no Coordinator rewrite, no new provisioning path).

## 2. Source evidence (what is true today)

### 2.1 Identity: there is NO supervisor audience; worker audience must not be reused
- `apps/cloud/src/machines.ts:14-18,49,104-120`: only two audiences exist — `cloud-cli` (`sfcli_…`, scopes `identity:read,devices:self`, 24 h) and `worker-identity` (`sfworker_…`, scopes `worker:identity,worker:rotate`, 1 h). `machineAuth()` rejects any other prefix/audience with 401 and never falls through to cookie/GitHub/instance bearer. `machineGuard()` rechecks credential expiry/revocation, resource status, epoch equality, org/active status, and — for workers — that the authorizing user is *still* owner/admin, on **every** request (no auth cache).
- `apps/cloud/migrations/0002_machine_identity.sql:43-52`: `CHECK(audience IN ('cloud-cli','worker-identity'))` plus mutual-exclusion check (installation XOR worker). A supervisor audience requires a migration; it cannot be smuggled into `worker-identity`.
- `docs/architecture/phase-2b1-api.md:37-51` + `identity-and-trust.md:46-54`: worker enrollment is **identity only** — "no heartbeat, task, usage, VM… Registration does not claim eligible compute or authorize a workload." Phase-1 `cloud-api-contracts.md:8,106-115` proposed `supervisor-ingress`/`supervisor:lease`-like separation and heartbeat-vs-delivery split, but it is explicitly **not implemented** ("Historical future contracts above remain proposals where the implementation document does not mark a route implemented").
- `src/http.ts:31-43`, `src/cloud-client.ts`, `src/cli/cloud.ts`: local instance bearer is global/per-instance; it is never accepted as cloud authority. Lead assumption "supervisor can reuse worker credential with an extra scope" is **rejected by source**: audience is bound at issuance, checked exactly, epoch-scoped, and worker credentials additionally depend on a single human authorizer's continued admin status — wrong trust root for a long-lived supervisor.

### 2.2 Confirmed-stop semantics already exist and are subtle — reuse them, do not redefine
- `src/domain.ts:280-283`: `stopWorkerRuntime?(w): Promise<void>` — "Resolve only after verifying that the guest runtime can no longer execute agent work. Aborting a session alone is insufficient; reject an uncertain stop."
- `src/providers/freestyle.ts:344-352`: the only verifying implementation — `systemctl stop swarmforge-opencode.service && ! systemctl is-active --quiet …`, throws unless exit 0.
- `src/coordinator.ts:856-895` `quiesce()` returns exactly three outcomes: `stopped` (hook resolved, or no VM), `paused` (hook/exec failed → VM pause succeeded, **or** ambiguous probe), `missing` (only when `getWorker()` returns `null`, i.e. provider-confirmed 404; a throwing probe stays `paused`). `vmMissing()` documents this explicitly (887-895).
- `applyControl` cancel path (`coordinator.ts:1176-1217`): abort preservation first, resume-if-paused (only `missing` settles here on resume failure), `quiesce()`, then `cancelDispatches` + `settle(cancelled)` — cancellation is durable **after** the stop attempt, and records `vm_missing` when confirmed gone.
- Destroy path (`coordinator.ts:1219-1328`): `paused` outcome → `recovery_required` ("VM paused because OpenCode could not be stopped"), never `destroyed`; `stopped` still requires verified Git handoff + `inspectPersistence` + settled preservation before `destroyWorker`; force-destroy abandons preservation explicitly. `fail()` (`908-956`) mirrors this: `missing` → failed+release; `paused` → `recovery_required` (capacity **retained**).
- Tests confirm: `tests/lifecycle.test.ts:525-614` (paused-VM cancel, missing-VM settle, "ambiguous live VM never treated as quiesced" → `recovery_required`); `tests/worker-runtime.test.ts:51` (uncertain stop → `paused`).
- **Invariant to preserve**: only `quiesce()==stopped` or `missing` (provider-confirmed absence) counts as "runtime cannot execute." `paused`, lease expiry, heartbeat loss, and `agent.abort()` success alone do **not**.

### 2.3 Local dispatch has no fencing and a known ambiguity window — the adapter must close it
- `src/store.ts:441-457` `claimDispatch()`: unconditional `pending→sending` + transition to `running`; no expected-state guard, no generation/fencing column.
- `src/coordinator.ts:626-632` `deliver()`: claim-then-`agent.submit()`; comment admits "Ambiguous submission after a crash is inspected, never blindly replayed."
- `monitor()` (`633-733`): `sending` + no message evidence + settled + past timeout → `recovery_required` ("Prompt delivery ambiguous"). This is the correct precedent: ambiguity → hold, not retry-blindly.
- Positive precedents to copy: `settle()`+`beginFinalization()` atomic (`461-472`); `finish()` idempotent per run (`575-600`, completed/cancelled runs ignored); `claimFinalization()` attempts-persisted-before-side-effect (`518-550`); `create()` fingerprint dedupe (`217-312`); `usage()` max-upsert (`616-631`).
- Capacity is in-memory per process (`coordinator.ts:368-391`); `entitlements.md:59-64` already requires **shared** reservations for multi-supervisor limits — a second supervisor without a shared reservation authority double-spends capacity.

### 2.4 Edge patterns to copy verbatim
- Atomic batches with authority rechecks inside the write transaction (`enrollment.ts:73-80`, `machines.ts:84-103` `browserGuard`); conflicting second consume → 409; same-key/same-context encrypted replay until expiry (`phase-2b1-api.md:20,47-49`).
- Invitation model: owner/admin-gated, 10-min, single-use (hashed secret), ≤25 active/tenant, ≤100 workers/installations per org; rotation bumps epoch, old token denied immediately, exact retry ≤10 min (`machines.ts:220-330`, `phase-2b1-api.md:31,45`).
- Rate/abuse budgets are D1-backed fixed windows + 5 s per-link poll budget; generic denials allocate no audit rows (`phase-2b1-api.md:59`).

## 3. Recommended design (minimal, adapter-shaped)

### 3.1 New supervisor audience + finite authorization (edge side, D1)
- New audience `supervisor-lease` (name bikeshed allowed; must be a **new** `CHECK` value, new `sfsuper_` prefix, new scopes e.g. `supervisor:claim,supervisor:renew,supervisor:report,supervisor:stop-ack` — never `worker:identity`). Credential: 256-bit opaque, SHA-256 hash at rest, 1 h token TTL, ≤30-day authorization window, epoch rotation identical to machine rotation semantics.
- New tables (additive migration `0003_supervisor_leases.sql`; no changes to `0001/0002` semantics):
  - `supervisor_enrollments` (mirrors `worker_enrollments`: org-bound, authorizing owner/admin + session, 10-min hashed `sfsupenroll_` secret, idempotency key+fingerprint+encrypted replay, consume/revoke/expiry).
  - `supervisors(supervisor_id PK, organization_id, authorizing_user_id, enrollment_id UNIQUE, name, status registered|revoked, epoch, created_at, authorization_expires_at, revoked_at)`.
  - Extend `machine_credentials` audience CHECK to include `supervisor-lease` with (supervisor_id NOT NULL, installation/worker NULL) XOR arm, or a parallel `supervisor_credentials` table — prefer parallel table to avoid widening the existing CHECK semantics in one step; either is acceptable if the XOR invariant is enforced in SQL.
  - `supervisor_tasks_outbox(task_id PK, organization_id, execution_class, body_hash, idempotency_key UNIQUE per org, state queued|claimed|leased|stopping|stopped|completed|failed|cancelled, lease_id NULL, supervisor_id NULL, fencing BIGINT NOT NULL DEFAULT 0, lease_expires_at NULL, stop_proof NULL, created_at, updated_at)` with tenant-scoped idempotency and state indexes.
  - `supervisor_leases(lease_id PK, task_id UNIQUE, supervisor_id, fencing, state claimed|active|renewing|stopping|stopped|done, expires_at, last_renew_at, idempotency_key, result_ciphertext NULL)`.
- Auth rule (copy `workerActive` pattern, adjusted): supervisor credential valid iff unrevoked + unexpired + epoch matches + org active + **authorizing owner/admin still active admin** OR — open decision, recommend — org-level service authorization independent of one human (see §6 unknowns). Until decided, copy the worker rule (stricter, known-safe).

### 3.2 Lifecycle + APIs (edge)
- `POST /v1/tenants/{t}/supervisor-enrollments` (owner/admin, Idempotency-Key) → `{enrollment_id, enrollment_secret, expires_at}`.
- `POST /v1/supervisors/register` (`Authorization: SupervisorEnroll <secret>`) → supervisor identity + `sfsuper_` credential (atomic consume, recheck admin/session/org, one logical identity, encrypted same-key replay).
- `POST /v1/tenants/{t}/tasks` (existing proposal, gated on atomic entitlement reservation + outbox insert in **one D1 batch**; duplicate idempotency key returns original task, no new reservation).
- `POST /v1/supervisors/claim` (supervisor audience, body `{task_filter?, idempotency_key}`) → assigns one `queued` task: `UPDATE … SET state='claimed', lease_id=?, supervisor_id=?, fencing=fencing+1, lease_expires_at=now+TTL WHERE state='queued'` — exactly one row; losers get 204/409. Reply includes `lease_id, fencing, lease_expires_at, task_body`.
- `POST /v1/supervisors/leases/{lease_id}/ack` (claim→leased/active; supervisor confirms durable local mapping — see §3.4; required before execution).
- `POST …/renew` (active→active, extend `lease_expires_at`; guard `WHERE lease_id=? AND supervisor_id=? AND fencing=? AND state='active'`; recheck entitlement headroom per `entitlements.md:62`).
- `POST …/complete` (guard same; requires result + stop-proof fields; terminal).
- `POST /v1/tenants/{t}/tasks/{id}/cancel` (account/CLI operator) → outbox `stopping` + durable stop intent (202, idempotent); **not** terminal.
- `POST …/leases/{lease_id}/stop-ack` (supervisor confirms `quiesce()` outcome: `stopped|missing` + how verified, or `paused→held`) → edge `stopped` (releasable) or stays `stopping/held`.
- Heartbeat/claim polling reuses per-supervisor 5 s atomic poll budget precedent; heartbeats carry `(lease_id, fencing, local_state)` and return `directive: continue|stop`.

### 3.3 The critical invariant (state machine)
- Edge task states: `queued → claimed → leased(active, renewals) → stopping → stopped → completed|failed|cancelled`, plus `held` (stop attempted but unconfirmed).
- **Lease expiry moves `leased → stopping`, never to a releasable state.** Redispatch (`stopping/held → queued` with new lease_id+fencing) is allowed **only** after `stop-ack ∈ {stopped, missing}` from the previously assigned supervisor (or provider-confirmed absence + operator escalation). Expiry only starts the stop watchdog and blocks renewal by a different supervisor.
- Fencing: every claim/redispatch increments `fencing`; all supervisor writes carry `(lease_id, fencing)`; mismatched fencing → 409 `stale_fencing`. A partitioned old supervisor that reconnects cannot renew/complete/ack-stop for a reassigned task.

### 3.4 Crash-safe local mapping (Bun/SQLite side, in the adapter — not in Coordinator core)
- New local table (same SQLite WAL DB, new table, no existing-table migration): `cloud_assignments(task_id PK, lease_id UNIQUE, fencing INT, worker_id UNIQUE, local_state mapped|running|stopping|stopped|done, updated_at)`.
- Adapter sequence, each step crash-atomic with the Coordinator call it mirrors:
  1. `claim` (edge) → `INSERT cloud_assignments(mapped)` + `store.create({team_id: tenant-derived, task_id: cloud-task, request_id: lease_id…})` in **one SQLite transaction** (copy `settle()` atomicity precedent). If crash before commit, edge claim has no local row → adapter must `stop-ack(held)` + release or re-ack on restart; never execute without the row.
  2. `ack` (edge) only after the local transaction commits.
  3. Execute via existing `Coordinator.spawn/message/step` paths unchanged; map completion via `store.finish/settle` + same-transaction `cloud_assignments→done/stopped` update.
  4. Cancel/stop: adapter calls existing `coordinator.control(worker_id,'cancel'|'destroy')`, reads resulting `quiesce()`-derived state (`cancelled` vs `recovery_required` vs `vm_missing`), and reports that — not its own opinion — as `stop-ack`.
- SQL guards (local): `UPDATE cloud_assignments SET … WHERE task_id=? AND fencing=? AND local_state IN (…)`; transitions condemned on 0 rows affected (another attempt already moved it).

### 3.5 Partition stop watchdog (both sides, required — this is the P0 safety net)
- Supervisor side: every `leased` assignment has a local timer (lease TTL + skew bound). On expiry / failed renew / edge unreachable: immediately `control(cancel)` (durable intent first, per existing `runControl`), keep VM (do **not** destroy on network failure — preservation/Git gates still apply), hold result, keep retrying `stop-ack`. Never continue agent execution past an unrenewed lease.
- Edge side: lease-expiry sweeper marks `leased(expired) → stopping`, revokes renew authority for that `(lease,fencing)`, pages/alerts, and **blocks** redispatch until `stop-ack(stopped|missing)`. Bounded cleanup cron (copy 10-min/500-row precedent) disposes only terminal+settled rows; it never force-completes `stopping`.

### 3.6 Stale-supervisor authority split
- **Cleanup authority** (edge/admin): revoke supervisor credential/epoch, expire its leases, move tasks to `stopping`, reassign **only after** stop proof. Revocation takes effect on subsequent checks (precedent: no in-flight kill).
- **Execution authority** (only the assigned, live, correctly-fenced supervisor via the adapter): quiesce/pause/destroy VMs, settle local workers. Edge never issues provider destroy; a second supervisor never touches the first's local workers. Compromised/partitioned supervisor damage is bounded by short leases + no GitHub/model-key custody in the lease protocol (keys stay in existing provider paths, never in task bodies — per `identity-and-trust.md:56-60`).

### 3.7 Lost-ack / idempotency rules
- All mutating supervisor calls require `Idempotency-Key`; scope `(tenant, supervisor credential, method, route, key)`; same-key+same-fingerprint → replay stored result (encrypted, bounded by lease/expiry); changed payload → 409. Claim retries after a lost reply reuse the same key and get the same `(lease_id, fencing)` rather than a second task.
- Local `deliver()` ambiguity precedent applies: after a crash between edge-claim and local-commit, the adapter inspects (`store.dispatch` state, `cloud_assignments` row) before resubmitting — never blind replay.

## 4. Why naive outbox/claim fails (flaws sought, with source grounding)
1. **Expiry-as-release double-executes**: without the stopping/held gate, two supervisors run the same task; local `claimDispatch` has no fencing so the second submit looks legitimate. Fix: fencing + stop-proof gate (§3.3).
2. **Heartbeat proves nothing about execution**: Phase-1 heartbeat proposal already warns "heartbeat is not billable compute proof" (`cloud-api-contracts.md:115`); `last_seen_at` is explicitly "never an authorization input" (`phase-2b1-api.md:61`). Liveness ≠ stop proof.
3. **Pause mistaken for stop**: local `paused` retains a live guest by design (`coordinator.ts:858,1235-1243`); any design that releases capacity on pause leaks VMs and billing.
4. **Claim without local atomicity orphans work**: edge `claimed` + crashed supervisor = stuck task; edge `leased` + crashed-before-commit = phantom execution. Fix: §3.4 transaction + ack-after-commit + sweeper that only moves to `stopping`.
5. **Reused `worker:identity` collapses trust roots**: worker creds depend on one human's admin status and 1 h TTL; supervisors need independent lifecycle. Reuse also violates the SQL audience CHECK and the "distinct consumers" rule (`phase-2b1-api.md:5`).
6. **Cloud-side force-stop is fiction**: edge cannot verify guest halt; only `stopWorkerRuntime` resolution or provider 404 can (`domain.ts:280-283`, `coordinator.ts:890-895`). Any "edge deletes VM" shortcut bypasses Git/preservation gates and must be rejected.
7. **Evaluate-then-insert races**: `entitlements.md:59` forbids it; task accept must be reservation+outbox in one batch, and renew must recheck headroom.

## 5. Minimal adapter shape (no Coordinator rewrite, no new provisioning)
- New module (e.g. `src/supervisor-lease-adapter.ts`, new code only): owns poll loop (`claim→map→ack→control→report→renew→stop-ack`), the `cloud_assignments` table, fencing checks, and both watchdogs. Calls only existing public surfaces: `store.create/get/transition/settle/finish/cancelDispatches`, `coordinator.control/tick/step` (via `operation`), and reads `quiesce`-derived worker states. No changes to `WorkerProvider`, `prepare`, `exec`, preservation, or Git handoff.
- Config: edge URL, `sfsuper_` credential file (reuse `cloud-credentials.ts` file discipline: 0600, no-follow, atomic rename), poll/lease/renew intervals, skew bound. Local mode untouched: adapter disabled by default; no hosted contact unless configured (Phase-1 boundary preserved).

## 6. Trade-offs & challenges to lead assumptions
- **Assume short leases (e.g. 60–120 s) with renew, not long claims**: bounds damage and matches 1 h worker-TTL precedent, but costs D1 writes per renew — validate against Free write limits (`deployment`/`IDENTITY.md` precedent) before pilot.
- **Assume at-most-one-executor, not at-least-once-delivery**: duplicates are the catastrophic case (cost + data), while delayed tasks are merely slow. The stopping gate trades availability for safety — document it.
- **Challenge "simple outbox + claim is enough"**: it is not, per §4. The stopping/held state, fencing column, and dual watchdogs are load-bearing, not gold-plating.
- **Challenge "we can generalize worker enrollment"**: worker enrollment binds a human authorizer's live admin status; supervisor authorization likely needs org-service semantics (survives one admin's departure). Do not ship supervisor auth on the worker rule without an explicit owner decision — flag as P0 policy gap.
- **Challenge "expiry implies idleness"**: a partitioned supervisor keeps executing locally by design (safety: it must quiesce, not vanish). Expiry implies *unknown*, and unknown implies *hold*.

## 7. Concrete interface recommendations (copy-ready)
- Edge D1 migration `0003_supervisor_leases.sql` with the four tables above; audience CHECK extended (or parallel credential table) with XOR invariant; indexes on `(state, lease_expires_at)`, `(supervisor_id, state)`, org idempotency uniques.
- Edge routes: enroll/register/claim/ack/renew/complete/cancel/stop-ack as in §3.2, all with strict Zod bodies, 128 KiB cap, `Cache-Control: no-store`, tenant-qualified IDs, opaque cursors, safe error codes (`stale_fencing, lease_expired, stop_unconfirmed, assignment_denied` mirroring existing `sequence_conflict/assignment_denied` style).
- Local: `cloud_assignments` table + `SupervisorLeaseAdapter` with methods `poll(), mapClaim(), ack(), renewLoop(), onCancel(), reportStop(), watchdog()`; transitions guarded by `(task_id, fencing, expected-local-state)`; stop reports derived exclusively from post-`control()` worker reads.
- D1 batch shapes: claim = single conditional UPDATE (one-row-won); renew/complete/stop-ack = conditional UPDATE with fencing+epoch+org rechecks + audit insert in the same batch (copy `browserGuard`/`machineGuard` composition).

## 8. Unanswered questions (need owner/Phase-2B decision, not invented here)
1. Lease TTL / renew interval / skew bound and D1 write budget at pilot scale.
2. Supervisor authorization root: live-admin-dependent (worker rule) vs org-service identity surviving authorizer churn; ownership transfer semantics.
3. Per-tenant supervisor caps, multi-supervisor scheduling, and shared reservation authority implementation (in-memory capacity today).
4. `stop-ack(missing)` acceptance threshold: provider-404 only, or operator-attested destroy after evidence? (Recommend provider-404 only for auto-redispatch; operator path explicit and audited.)
5. `held` (paused/unconfirmed) escalation: how long before human paging, and does billing accrue while held?
6. Entitlement/billing hooks at claim vs ack vs renew; `stopping` cost attribution.
7. Credential transport/persistence hardening for the supervisor host (vault vs file) and rotation UX.
8. Edge sweeper cadence/row bounds and alert channel; audit retention for lease events (90-day recommendation pending owner sign-off).

## 9. Sources (exact)
- Baseline/branch: `git rev-parse HEAD` → `fec6697…`; assigned branch above; `git status` clean; repo untouched.
- `docs/architecture/phase-1-summary.md:27-32,43-58` (stop hook, P0/P1 gates incl. "Tenant-qualified D1 metadata/outbox, deduplicated external supervisor protocol").
- `docs/architecture/phase-2a-summary.md:17-44` (D1 atomicity, tenant authority, no execution yet).
- `docs/architecture/phase-2b1-summary.md:17-51,70-78` (distinct audiences, identity-only enrollment, "do not broaden worker:identity").
- `docs/architecture/entitlements.md:56-70` (atomic reservation, finite leases, settle-only-on-trustworthy-evidence).
- `docs/architecture/cloud-api-contracts.md:8-10,91-115,130-133` (proposed supervisor ingress, heartbeat limits, reservation+outbox-before-accept — proposals, not implemented).
- `docs/architecture/identity-and-trust.md:19-54` (authority model, enrollment/assignment/lease shape).
- `docs/architecture/implementation-plan.md` (Phase-1 scope; stop-hook rationale).
- `docs/architecture/phase-2b1-api.md` (implemented linking/enrollment contracts; replay/rotation/rate precedents).
- `src/coordinator.ts:856-895,908-956,1176-1328` (quiesce/cancel/destroy confirmed-stop logic).
- `src/domain.ts:275-283` (provider hook contract).
- `src/providers/freestyle.ts:344-352` (verifying stop implementation).
- `src/store.ts:441-472,518-600` (claim/settle/finish idempotency precedents; `claimDispatch` unguarded).
- `apps/cloud/src/machines.ts:14-18,84-120,220-330` (audiences, guards, rotation replay).
- `apps/cloud/src/enrollment.ts:56-80` (atomic invitation insert with guard+caps).
- `apps/cloud/migrations/0002_machine_identity.sql` (audience CHECK, enrollment/worker/credential/rotation tables).
- `tests/lifecycle.test.ts:525-614`, `tests/worker-runtime.test.ts:51` (stop-ambiguity behavior).

## 10. Verification statement
HEAD verified as above. No implementation, migration, deployment, or secret access performed. No test suites run — read-only investigation; "actual tests only" = none to report. Working tree clean; all output written outside the repo.

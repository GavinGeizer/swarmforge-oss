# Security architectural opinion: atomic admission over `2d602ca` foundation + `b61` schema

READ-ONLY opinion (no product edits; no `hosted-admission.ts` authored here — the new coder owns it). Evaluated against real inspected foundation `2d602cac56595f20393b7646062ca83a8bc975d6` (scratch, detached, clean) and schema `b61f2444a6b28667c69893501d8f51013f3ce8af` lineage (migration `0003_hosted_execution.sql` + `hosted-types.ts`, independently approved). No helper-gate-only certification: every claim below cites concrete SQL/source or a real-D1 probe. Prior reports preserved unchanged.

## Proposed approach under review (as briefed)
Single conditional task INSERT verifying hostedPrincipal/sessionGuard + worker + newest pinned policy + active/quarantined quota counts + exact allowance old-quantities, then all dependent reservation/outbox/audit/operation/meter writes conditional on that new taskID. Meter BigInt runtime full-reserve, finite period including task deadline, no CAS partial-task. Cancellation: unleased queued-only release; assigned `stop_requested` + quarantine retains fence, no unsafe release.

## Verdict: approach is SOUND with four mandatory constraints (C1–C4). No superior design supported; alternatives considered and rejected below.

### Why the shape is right (evidence)
- D1 serializes batch writes; conditional-DML admission is the only correct mutual-exclusion primitive available (no stored procedures, no advisory locks). The foundation already proves the pattern (issuance ON CONFLICT + winner-read; `putPolicy` UNIQUE-version CAS + 409; pinned `activePolicyGuard` with newest-version + caps + window).
- `allowanceCasStatement` (`hosted-entitlements.ts:308-338`) demonstrates the exact-string conditional-write idiom (`reserved_quantity=? AND consumed_quantity=?` + live-policy EXISTS) the admission meter write must copy.
- Partial-unique worker exclusivity is DDL-enforced: probe inserting two `queued` tasks for one worker → `UNIQUE constraint failed: hosted_tasks.organization_id, hosted_tasks.w…` (real D1). The DB, not app code, owns exclusivity.
- Quarantine-retains-fence matches the schema contract: uncertain execution stays `active/quarantined` in counts; cancellation/expiry never removes it (migration header + `counts()` states). The proposal's cancel semantics (release only unleased-queued; quarantine otherwise) is the only reading consistent with that contract.

### C1 (MANDATORY): quota counts must be enforced inside the batch, never via app-side `counts()`
- `counts()` (`hosted-entitlements.ts:500-509`) is two non-atomic SELECTs. Probe: pre-admission `counts → {tasks:0,reservations:0}` — two racing admissions both read 0 and both proceed. If the coder gates on `counts()` output, `max_active_tasks:1` admits 2.
- Required: the task INSERT's WHERE clause must contain scalar-subquery ceilings, e.g. `(SELECT COUNT(*) FROM hosted_tasks WHERE organization_id=? AND state IN (…)) < ?` AND the same for reservations (active/quarantined), with `maximum_resource_reservations` likewise. NULL caps = explicit unlimited must short-circuit each predicate. Concurrent same-key issuance test in the foundation proves D1 serializes the race; the admission test matrix must include exact-ceiling concurrency (N+1 racers, exactly 1 winner, rest 409) — the bbad371 RED acceptance tests on the worker-client branch already demand this shape.

### C2 (MANDATORY): meter write must be full-reserve exact-CAS with finite period ⊇ task deadline
- Required single statement: `UPDATE hosted_allowances SET reserved_quantity=<old+runtime> WHERE … reserved_quantity=<old> AND consumed_quantity=<old> AND period_start<=created AND period_end>=deadline AND entitlement alive`, using canonical-string arithmetic computed client-side via `parseQuantity`/`addQuantities` (never Number/CAST). The `allowanceCasStatement` helper is the template; admission must not invent a second arithmetic path.
- Reject partial-task CAS (agreed): a meter CAS that succeeds while the task INSERT failed (or vice versa) strands capacity. Order: task INSERT first (conditional), then meter CAS conditional on the new taskID existing (`EXISTS(SELECT 1 FROM hosted_tasks WHERE task_id=?)`), then reservation/outbox/operation/audit conditional on both. Any statement failure → whole batch rolls back (D1 batch atomicity, already proven by the audit-rollback test).
- Period bound: probe shows allowance `period_start/end` = policy valid window (24h here). The meter predicate must require `period_end >= task.deadline_at` so a finite reserve cannot outlive its meter; otherwise a long-deadline task consumes quota that expires mid-execution with no re-authorization path.

### C3 (MANDATORY): principal binding must pin user+installation+grant, not just IDs
- The corrected `hostedPrincipalGuard` binds `grant_id + organization_id + user_id + installation_id` + live epoch/window/membership. Admission must compose this guard verbatim (not a reduced `grant_id`-only check) AND additionally require the task's `authorizing_user_id/installation_id/execution_grant_id` to equal the guard's bound values — otherwise a bearer for grant G in tenant T could admit a task attributing authorship to a different installation/user.
- Session-direct (`account` principal_kind) path must use `hostedSessionGuard` (browserGuard) inside the same batch, never a pre-read session check alone (TOCTOU between check and insert).

### C4 (MANDATORY): cancellation must be state-machine-conditional, fence-monotonic
- Release predicate: `UPDATE … SET state='released' WHERE task_id=? AND state='active' AND task_state='queued' AND lease_id IS NULL` — i.e., only unleased-queued releases. Assigned tasks transition to `stop_requested` + reservation to `quarantined`, preserving `fence`; never delete outbox rows or reset fence (fence must be monotonic for claim/ack/renew safety per protocol doc).
- Stale-fence settlement must be rejected: settle/renew statements must carry `fence=?` equality + `supervisor_id=?` equality, so a partitioned supervisor's late write cannot alter post-recovery state.

### Alternatives rejected (with reason)
- App-side reservation counters / process-local admission semaphore: invalid — D1 is the shared authority across supervisors; local counters diverge. (Schema header states this explicitly.)
- Two-phase reserve-then-insert: invalid — creates the stranded-capacity window C2 forbids; single batch is strictly superior on D1.
- Partial-meter CAS with compensating release: invalid — compensations fail under crash; atomic batch needs no compensation.

## Out-of-scope notes (recorded, not certified)
- Operator helper `7a` review deferred per dispatch ("later once durable"); the old-`2d` helper approval vs the actual UUID-driver trace contradiction is flagged for adjudication, not re-litigated here.
- No destroy/deploy performed. Own branch: unchanged baseline `fec` (clean, attached); remote assigned-branch HEAD is `32b230f`. Per dispatch, restore to `32b230f` ONLY if currently unchanged-baseline with no source changes — verified true (clean, HEAD==fec==base marker) — see change-summary below.


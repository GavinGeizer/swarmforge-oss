# Independent Review B (Interim, Provisional) — Phase 2B.2 Concurrency & Recovery

**Verdict: INCOMPLETE — interim review of `1830b06`; no approval. Findings below
are PROVISIONAL until the EXACT final commit (with the two forthcoming cloud
fixes) is inspected.**

No prior incomplete or filter-interrupted report is an approval. This report
does not certify the final candidate.

## Provenance (verified, read-only)

- Source bundle `/tmp/phase2b2-review-source.bundle`: SHA256
  `92df947d406f827e91782358836acc54b57fd0c219daec741ac668e45cf7dae0`,
  2736437 bytes — MATCHES dispatch.
- Isolated clone `/workspace/phase2b2-review`, detached at candidate
  `44156cc6ad7858059f0e45a659b63de81d258249`
  (tree `488901a0e0f4b89c56c8fe23fe0fd90c18c5a544`) — verified.
- Env bundle `/tmp/phase2b2-env-reviewed.bundle`: SHA256
  `a6461ca91ed6bbeb0a0321c92958e41fc8c74f2006efb9444d68ab7c620bf156`,
  1982 bytes — MATCHES dispatch; fetched into private ref
  `refs/private/env-reviewed` = `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc`.
- Review checkout: detached at `1830b06`, `git fsck --full` clean, worktree
  clean. `git diff 44156cc refs/private/env-reviewed` = test-only change to
  `tests/hosted-supervisor.test.ts` (raw watchdog deadline strings + captured
  boot authority assertions; production untouched).
- Original assigned branch `/workspace/repo` unchanged at `45c29d3`; no source
  modifications, no publication, no deployment. Toolchain: Bun 1.4.2 (pinned,
  frozen lockfiles); cloud integration via node `--experimental-strip-types`.
- Scope: Reviewer B — atomic admission, database witnesses, idempotency,
  leases/fencing, duplicate dispatch, crash/partition recovery, cancellation
  races, trusted OS stop and reservation settlement.

## Test evidence (executed, Bun 1.4.2 frozen deps)

Root suite (at `1830b06`):
- `tests/hosted-supervisor.test.ts`: **60 pass / 0 fail** (64.8s) — admission
  replay/conflict, held-capacity quarantine, start-right CAS, renew/stale-fence,
  partition watchdog, trusted stop/settlement, child env allowlist incl. the two
  watchdog boot-clock vars.
- `tests/hosted-child-lease.test.ts` + `tests/lifecycle.test.ts` +
  `tests/wait.test.ts`: **61 pass / 0 fail** — real child expiry, late renewal
  never reopens, cancel settle incl. vanished VM, abort listener release.
- `tests/cloud-worker-client.test.ts` + `tests/finalization*.test.ts` +
  `tests/serve.test.ts` + `tests/restart.test.ts`: **74 pass / 0 fail / 1 skip**.
- `tests/core/api/http/artifact-store/token-idle.test.ts`: **59 pass / 0 fail**.
- `tests/hosted-cli/cloud-phase2b1/cloud-worker-client/opencode-pagination/
  proof-runner/dashboard-protocol.test.ts`: **83 pass / 0 fail**.

Cloud suite (`apps/cloud`, miniflare-backed, real local D1):
- `bun run test:sql`: **87 pass / 0 fail**.
- `hosted-dispatch.integration.ts`: **14 pass / 0 fail** — claim election,
  duplicate-claim single winner, lost-ack same-lease replay, stale-fence/expired
  renew denial, settlement exactly-once + same-key idempotency, failed meter CAS
  without partial terminal state, cancel race, DB/audit rollback, expiry
  cleanup, task-authorizer guard, strict schemas.
- `hosted-supervisors/hosted-authority/hosted-entitlements/hosted-status/
  hosted-cleanup-compatibility/auth/abuse/additional-hostile/pairing-hostile/
  runtime/provider/linking/config/cli-runtime/preview-operations`: **all pass**.
- `hosted-admission.integration.ts`: **14 pass / 1 fail** (see F1 below).
- `enrollment.integration.ts`: **3 pass / 1 fail** (see F2 below).
- `worker-client.integration.ts`: 1 pass.

## Findings (ordered by severity; PROVISIONAL)

### F1 (High, provisional — known baseline, fix pending): exhausted-allowance production 409 contradicts docs 403
- Location: `apps/cloud/src/hosted-admission.ts:310-315` (production
  `allowance_exhausted` → 409) and `:629-639` (diagnostic `allowance_exhausted`
  → 409); contract docs `docs/architecture/cloud-api-contracts.md:130` and
  `docs/architecture/entitlements.md:60` specify 403 for exhausted allowances.
- Repro: `apps/cloud/test/hosted-admission.integration.ts:505-548` —
  allowance 60000, first task 10000 → 202, second task 55000 → actual **409**,
  expected **403** (`AssertionError: 409 !== 403`, line 544).
- Executed: `node --experimental-strip-types --test
  test/hosted-admission.integration.ts` → 14 pass / 1 fail (only this test).
- Impact: contract violation between advisory pre-check path and diagnostic
  path; clients keying on 403 for quota-exhausted vs 409 for conflict
  misclassify. Atomicity is NOT affected (no partial rows; the guard is inside
  the same conditional batch at `:317-337` and concurrency/idempotency/meter-
  rollback tests all pass). Per dispatch this is a known baseline item to be
  fixed by changing BOTH the advisory and the diagnostic to 403 while keeping
  other 409s; it does not authorize weakened assertions or quota changes.
- Invariant to hold after fix: exhausted allowance → 403 `allowance_exhausted`
  on both paths; quota races, idempotency conflicts, worker-busy, request-id
  reuse stay 409.

### F2 (Medium, provisional — known baseline, fix pending): stale enrollment placeholder returns 400, expected 404
- Location: enrollment route handling of a stale/placeholder enrollment id
  (see `apps/cloud/test/enrollment.integration.ts:36-47`).
- Repro: `POST /v1/tenants/:tenant/tasks` with a worker credential → actual
  **400**, test expects **404** (`AssertionError: 400 !== 404`, line 37).
- Executed: `node --experimental-strip-types --test test/enrollment.integration.ts`
  → 3 pass / 1 fail (only this test).
- Impact: wrong-envelope diagnostic for an unauthorized task-authority probe;
  no privilege granted (still denied), no side effects asserted. Per dispatch
  the fix must strengthen the test using a valid controlled payload +
  Idempotency-Key with a worker credential (expect 401 wrong-audience) plus a
  zero-side-effects assertion — not a weakened assertion, no production
  auth/quota change.

### No additional defects found (interim, at `1830b06`)
- Atomic admission: single conditional D1 batch per mutation with quotas,
  policy, worker liveness, allowance guard and idempotent operation row gated
  on the inserted task row (`hosted-admission.ts:341-455`); racing losers write
  nothing (concurrency tests: N racers at max_active_tasks=3 admit exactly 3;
  same-worker racers admit exactly 1; batch failure leaves no partial
  task/meter — all pass).
- Idempotency: fingerprint-bound `hosted_operations` replay with current-
  authority recheck (`hosted-admission.ts:209-239,478-493`); same-key race one
  row + identical replies, changed payload 409, request-id reuse 409 (pass);
  supervisor rotation durable pending key (`src/hosted-client.ts:412-485`);
  worker rotation `.rotate-pending` (`src/cloud-worker-client.ts:322-401`).
- Leases/fencing: monotonic `remainingAuthorityMs` with full RTT + margin
  (`src/hosted-client.ts:137-152`); ACK RTT measured after await
  (`src/hosted-supervisor.ts:186-236`); renew pins lease/fence/tenant/worker/
  supervisor/reservation and fixed authority
  (`src/hosted-supervisor.ts:514-551`); stale fence → stop intent, never widen.
- Duplicate dispatch: start-right-once CAS `mapped→acknowledged` single
  conditional UPDATE (`src/hosted-store.ts:360-392`); asserted no uncontrolled
  dispatch before start (`src/hosted-supervisor.ts:790-810`); dispatch intent
  durable before submit with ambiguous-submit inspect, never blind replay
  (`src/coordinator.ts:626-632`); result attribution per run
  (`src/finalization.ts:284-310`).
- Crash/partition/reconnect: `recover()` holds all non-settled rows, never
  blind re-exec (`src/hosted-supervisor.ts:900-918`); `reconcile()` retries
  verified stop + same-key settlement (`:925-975`); coordinator orphan adoption
  + ambiguous-submit inspect (`src/coordinator.ts:431-521`); renewal failure →
  durable stop intent (`src/hosted-supervisor.ts:502-509`).
- Cancellation races: teardown-held window with `cancelDispatches` before
  outcome (`src/coordinator.ts:898-907,1176-1217`); message refused while
  teardown/cancel/destroy pending (`:224-254`); finalizer abort on cancel
  (`:1181`); hosted child exit code 4 → cancelled only on requested stop
  (`src/hosted-supervisor.ts:392-404`); settlement intent frozen before HTTP
  with exact-key receipt requirement (`:812-890`).
- Trusted stop/settlement: OS-exit proof required, Coordinator labels never
  proof (`src/hosted-supervisor.ts:595-605,644-768`); pid/starttime/exe/boot-id
  identity before any signal (`src/hosted-runtime.ts:98-114,470-523`); foreign-
  clock measurement refused, conservative budget + unknown flag instead
  (`src/hosted-store.ts:526-636`); zero-use stop only for provably-never-
  started rows (`:589-612`); settlement receipt must bind frozen request
  (`src/hosted-supervisor.ts:860-872`).
- Expiry/rotation/revocation: expired credential refuses execution/renewal
  (`src/hosted-supervisor.ts:77-84`); 401/409 → durable stop intent; rotation
  key loss handling (`src/hosted-client.ts:477-484`,
  `src/cloud-worker-client.ts:389-399`); credential freshness bounds
  (`src/cloud-worker-client.ts:100-111`); child enforces lease/absolute boot-
  clock deadlines fail-closed incl. renewal pinning absolute
  (`src/hosted-child.ts:86-143`).
- Child env allowlist (the `1830b06` delta): exact 5-entry allowlist
  PATH/TZ/DURATION + the two watchdog boot-clock vars, raw `/^\d{1,16}$/`
  shape, numeric value, `lease > bootBeforeLaunch`, `lease <= absolute`, plus
  secret-absence assertion — passes (60/60 hosted-supervisor).

## Statement
No approval is given. Final verdict awaits the EXACT final commit including
the two forthcoming cloud fixes (F1: 403 `allowance_exhausted` on both paths;
F2: valid-payload + Idempotency-Key worker-credential probe with 401 and
zero-side-effects); the final `review.md` must state
APPROVED / CHANGES_REQUESTED / INCOMPLETE with the exact reviewed SHA.

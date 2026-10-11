# FINAL Independent Review B — Phase 2B.2 Concurrency & Recovery (controlled-local)

**Inspected HEAD:** `8abc7bdc58c2461bd067a5c860923b13f6e8b6cf`
**Inspected tree:** `f3e0f746f56bf6c9c0b6a36799f947921c77e18b`
**Complete bundle:** `/tmp/phase2b2-final-review-source.bundle`
SHA256 `fe1b0fae15fbd86c52bd962b2b46d87dd048bf842e422123dad7b6214eed5198`, 2902303 bytes — MATCHES dispatch.
**Worktree:** `/tmp/phase2b2-final-review-8abc7bd` (detached at exact `8abc7bd`, clean; `git fsck` clean). Base candidate `44156cc` is the merge-base. Original branch `/workspace/repo` unchanged at `45c29d3`.

## VERDICT

**APPROVED — controlled-local concurrency & recovery scope.** All prior
findings are closed and independently re-verified at the integrated head; no new
findings. This does **not** certify untrusted/pilot launch (see *Launch blockers*
below), and it is not overall A/B/C product acceptance.

## Scope reviewed

DB-enforced reservation atomicity/idempotency, outbox delivery, lease fencing,
cancellation races, crash/partition recovery, trusted stop/settlement, the
one-hour absolute boot-deadline bound, and complete real runtime integration.

## Production change under review (whole range)

`git diff 44156cc..HEAD` (non-docs) changes exactly 7 files; the **only**
production change is two status-code lines in
`apps/cloud/src/hosted-admission.ts`:
- `:310-315` advisory `allowance_exhausted` 409→**403**;
- `:635-639` post-batch diagnostic `anyCovered ? 403 : 409` with
  `allowance_exhausted`/`allowance_unavailable`.
Advisory `allowance_unavailable` (`:305-309`) stays 409; quota/reservation SQL
unchanged. All other diffs are tests (`abuse.integration.ts`,
`enrollment.integration.ts`, `hosted-admission-regressions.test.ts`,
`hosted-runtime.integration.ts`, `hosted-schema.integration.ts`,
`tests/hosted-supervisor.test.ts`) and `docs/.../recovery-20261011/**` evidence.

## Commands and counts (independently executed, frozen deps, Bun 1.4.2 / Node v24.21.0)

- Cloud full integration `node --experimental-strip-types --test test/*.integration.ts`
  **x3**: **130 pass / 0 fail** every run.
- Cloud SQL `bun run test:sql`: **90 pass / 0 fail** (351 expects).
- Runtime integration `node --experimental-strip-types --test test/hosted-runtime.integration.ts`:
  **5 pass / 0 fail** (real default workerd/D1 + real Bun supervisor/child).
- Root `bun test`: **788 pass / 2 skip / 0 fail / 4540 expect / 59 files / 257s**
  (2 pre-existing skips). Matches the committed `combined-final-root.log`.
- Statics: root `bun run check` (tsc + biome) clean **133 files**; cloud
  `tsc --noEmit` clean and biome clean **71 files**.
- Memory-capped `NODE_OPTIONS=--max-old-space-size=64` abuse suite: **3 pass / 0 fail**.
- Evidence log: `final-review-B-8abc7bd-suite.log`.

## Concurrency/recovery verification (source references)

- **Reservation atomicity/idempotency**: single conditional D1 batch with
  quotas/policy/worker/allowance/operation guards inside `INSERT…SELECT…WHERE`
  predicates (`apps/cloud/src/hosted-admission.ts:341-455`); fingerprint-bound
  replay with current-authority recheck (`:209-239,478-493`). Admission
  concurrency/idempotency/request-id/DB-rollback tests all pass in the 130.
- **Outbox delivery / leases / fencing**: claim election, ack, renew
  (stale-fence/expired denied), settlement exactly-once with same-key replay,
  failed meter CAS without partial terminal state, revoked-supervisor handling
  (`apps/cloud/src/hosted-dispatch.ts` — `hosted-dispatch.integration.ts` 14/14
  inside the 130). Local lease authority uses monotonic
  `remainingAuthorityMs` and post-await RTT (`src/hosted-client.ts:137-152`,
  `src/hosted-supervisor.ts:186-236`).
- **Cancellation races**: teardown-held window + `cancelDispatches` before
  outcome (`src/coordinator.ts:898-907,1176-1217`); runtime cancel case proves
  reservation released only on verified stop.
- **Crash/partition/recovery**: supervisor `recover()` holds all non-settled
  rows, `reconcile()` retries verified stop + same-key settlement
  (`src/hosted-supervisor.ts:900-975`); runtime driver-failure case proves
  production `supervisor.close()` stops a live child and the durable journal
  stays `stop_confirmed`.
- **Trusted stop/settlement**: OS-exit proof with pid/starttime/exe/boot-id
  identity before any signal (`src/hosted-runtime.ts:98-114,470-523`); foreign-
  clock measurement refused (`src/hosted-store.ts:526-636`); settlement receipt
  must bind the frozen request (`src/hosted-supervisor.ts:812-890`).
  Independent SIGKILL probe (prior `6ee…`/605 review) showed the real grandchild
  exits via stdin EOF (~51ms), and a SIGKILLed parent is correctly treated as
  *uncertain*, not as proof.
- **One-hour bound**: production refuses `absolute - boot > 3_600_000`
  (`src/hosted-runtime.ts:239`; child enforces the same at
  `src/hosted-child.ts:103`); the restored root assertion
  `expect(absoluteBootMs - bootBeforeLaunch).toBeLessThanOrEqual(3_600_000)`
  is present in `tests/hosted-supervisor.test.ts` and passes within the root run.
- **Complete real runtime integration**: `hosted-runtime.integration.ts` 5/5 at
  the integrated head, exercising the default production worker (Miniflare/
  workerd + real D1) over the Node loopback bridge with a real Bun
  supervisor/coordinator/provider child, renewals (31s under 30s lease),
  lost-ack recovery, cancel, held uncertainty, failure-path production cleanup,
  and unparsable/early-exit rejection.

## Prior findings — closure

- F1 (allowance_exhausted 409→403) — CLOSED at `1574331`, re-verified.
- F2 (enrollment wrong-audience 400→404 / 401 zero-mutation probe) — CLOSED at
  `1574331`; enrollment integration 4/4 in the 130.
- R1/R2 (runtime harness driver/child cleanup; parse/stdin rejection) — CLOSED
  at `a106`, re-verified at `605` and in the integrated 5/5.
- G1 (root "reversed launch order" wording) — CLOSED at `aa2`.
- Cloud window/body-lifetime robustness (`c1e696a`/`0b06aeb`) — verified; the
  deterministic fixed-clock saturation test and exact per-bucket invariants are
  in the passing 130.

## Findings (severity ordered)

None blocking. Two non-blocking observations carried forward:

- **B-OBS-1 (Low, test-robustness)**: the abuse HTTP test bounds windows at
  `1..4`, a tolerant heuristic not derived from the 20 attempts
  (`apps/cloud/test/abuse.integration.ts:73-77`). It does not weaken the exact
  cap proof (per-bucket `<=8`, `Σcount===audits`, plus the deterministic
  fixed-clock saturation test).
- **B-OBS-2 (Low, informational)**: SIGKILL-only parent death is (correctly)
  treated as uncertainty rather than proof; documented, no action required.

## Recovered/irretrievable verification gap — the earlier full-suite failure

Required action: recover the identity of the single earlier cloud full-suite
failure I recorded. Result: **irretrievable**.

- The original run's stored output (confirmed from preserved session records for
  session `ses_eda8ac004ffe69bmvCpZHdURPQ`) is exactly the summary I filtered to:
  `START 1791742605 / ℹ tests 125 / ℹ pass 124 / ℹ fail 1 / ℹ skipped 0 / END 1791742754`.
  No per-test name, message, or stack was ever written to any record — the
  command was piped through `grep -E "^ℹ (tests|pass|fail|skipped)"`, so the
  failing test's identity is not recoverable from session records. The committed
  `docs/.../recovery-20261011/*.log` files contain only the intentional RED
  diagnostics (`diagnostic-race-red.log`, `root-order-deterministic-red.log`)
  and clean runs; they do not contain this failure.
- Reproduction attempts: 3 fresh full cloud integration runs at the integrated
  head were **130/130** each (plus prior clean runs), so the failure did not
  recur.
- Honest characterization: I **cannot** classify it as a failed assertion or as
  an interrupted infrastructure/process failure — the evidence is absent. I
  therefore do **not** assert it was flaky as fact. It is recorded as an exact,
  unrecovered verification gap for one of the earlier (non-final) full-suite
  runs only; the final integrated head is fully green across all 3 full runs.

## Launch blockers (explicitly NOT certified here)

Per the committed evidence and this review's scope, the following remain
outside controlled-local acceptance and are untrusted/pilot gates: live edge
CPU/production qualification (`apps/cloud` ran in local workerd/D1 emulation
only, no live Cloudflare/customer endpoint); credential custody and edge
resource provisioning; and shared privileged cross-tenant runtime isolation (the
committed cross-tenant probe uses a SQLite D1 adapter + stub provider and does
not certify isolation). These are launch blockers independent of this code review.

## Statement

For the complete assigned controlled-local concurrency & recovery scope at HEAD
`8abc7bdc58c2461bd067a5c860923b13f6e8b6cf` (tree
`f3e0f746f56bf6c9c0b6a36799f947921c77e18b`): **APPROVED**. All prior findings
closed and re-verified; root 788/2skip/0fail, cloud 130/130 (x3), SQL 90/90,
runtime 5/5, statics clean. The only caveat is the unrecovered identity of one
earlier non-final full-suite failure, honestly reported as a verification gap
and not attributed to the final head. Untrusted/pilot launch blockers remain
separately uncertified.

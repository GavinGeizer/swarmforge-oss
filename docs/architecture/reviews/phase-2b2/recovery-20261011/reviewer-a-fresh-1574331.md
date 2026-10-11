# Independent final architecture review (fresh) — Phase 2B.2 recovery

- Worker: `w-cf8f53a8-390e-4f5b-90d9-4759b856a37f`
- Task: `final-architecture-review-fresh`
- Run: `dbbfc210-19ac-45db-bd26-36c5f5894a8f`
- Reviewed candidate: `/workspace/phase2b2-ready`
  - HEAD `157433166479c099a54cbee52ca9203dc722eb9f`
  - tree `bb2ff7fefd568ef07b93223fb42d375af1726b0c`
  - complete bundle SHA `424ca51ee631942cc25ad616eae0c939f4fbfb9659d35a9f88a66db08c7f93c0`
    (bootstrap-verified private source; fsck clean; Bun 1.4.2 / Node v24 installed)
- Baseline for compatibility diff: `fec66971536cb117b36c85faabd98883d6491cb2` (Phase 2B.1 branch point)
- Toolchain: Bun **1.4.2**, Node **v24.21.0**; frozen lockfile installs (root + `apps/cloud`)
- Method: read-only. No product/test/config/dependency edits, no push, no merge, no deploy,
  no VM delete. New artifacts are under `/workspace/.swarmforge/`. `/workspace/repo`
  (SwarmForge branch base `45c29d3`) was not treated as Phase 2B.2 source.

## Verdict

**APPROVED for the 1573 contribution** (`1574331`), bounded to the source and tests actually
executed here. No Critical/High/Medium source defect was reproduced in the reviewed change,
in the narrowly-approved 441 watchdog/SQL-clock corrections, or in the hosted modules,
root hosted runtime/storage/CLI, default-Worker routing/audiences, and additive migrations
that were inspected.

**Overall Phase 2B.2 acceptance remains INCOMPLETE.** The last integrated SHA (combined new
D1/Bun tests + tiny-test recovery + docs) was not provided at review time. This report is an
exact-SHA contribution review, not certification of the final integrated tree.

Git integrity: `git fsck --full` clean, `git status --porcelain` empty before and after
inspection; HEAD and tree unchanged.

## Findings (ordered by severity)

No Critical, High, or Medium findings were identified.

### L1 — Low: env-contract test dropped the absolute-deadline upper-bound assertion

- Location: `tests/hosted-supervisor.test.ts` (commit `1830b06`, the "runtime env and logs
  carry no bearer…" test). The previous assertion
  `expect(absoluteBootMs - hostedBootTimeMs()).toBeLessThanOrEqual(3_600_000)` and
  `expect(leaseBootMs).toBeGreaterThan(hostedBootTimeMs() - 60_000)` were replaced with
  `expect(leaseBootMs).toBeGreaterThan(bootBeforeLaunch)`.
- Impact: the replacement is *stronger* for the lease lower bound (captured-before-launch
  boot rather than a 60 s slack), but the ≤1 h production launch-authority cap enforced at
  `src/hosted-runtime.ts:239` (`absolute - boot > 3_600_000` throws) is no longer asserted
  at the environment-contract layer.
- Invariant affected: bounded initial authority (`absolute - observed <= 3_600_000`), also
  enforced in the child at `src/hosted-child.ts:103`.
- Minimal recommendation: re-add a bounded assertion, e.g.
  `expect(absoluteBootMs - bootBeforeLaunch).toBeLessThanOrEqual(3_600_000)`, or assert the
  `startControlled` rejection for an over-cap deadline. This is a test-coverage observation,
  not a production defect.

### L2 — Low: admission 401 zero-effect test comment no longer matches assertions

- Location: `apps/cloud/test/enrollment.integration.ts:39` (commit `1574331`). The comment was
  changed from “no task, reservation, outbox, operation, or meter rows” to “no task,
  reservation, outbox, or operation rows”. The assertions only cover `hosted_tasks`,
  `hosted_reservations`, `hosted_outbox`, `hosted_operations`; `hosted_allowances` is not
  asserted.
- Impact: none in production — the wrong-audience `sfworker_` request is rejected `401` inside
  `hostedAuth` (`apps/cloud/src/hosted-authority.ts:101`) before any statement executes, so
  the allowance is provably untouched. The comment-only edit removes a claim that was not
  asserted.
- Minimal recommendation: assert `hosted_allowances` (reserved/consumed) is unchanged, or
  keep the comment exactly matching the asserted tables. Not a defect.

## Verified change under review — 1573 (`7e0cf18` + `1574331`)

`git diff 44156cc..HEAD -- apps/cloud/src/hosted-admission.ts` is exactly two response-code
lines; all quota SQL is byte-identical:

- `apps/cloud/src/hosted-admission.ts:310-315` (advisory path): exhausted now `403`
  (`allowance_exhausted`); period-not-covering remains `409` (`allowance_unavailable`).
- `apps/cloud/src/hosted-admission.ts:635-639` (post-batch diagnostic path): now
  `anyCovered ? 403 : 409` with `anyCovered ? "allowance_exhausted" : "allowance_unavailable"`.

This makes the diagnostic path consistent with the documented contract
(`docs/architecture/reviews/phase-2b2/design-admission-original.md:147`: 403
`allowance_exhausted`) and with the advisory path: period covers window but capacity is
insufficient → `403 exhausted`; window not covered → `409 unavailable`.

The new batch-boundary regression in `apps/cloud/test/hosted-admission-regressions.test.ts`
(lines ~339-403) mutates the real ledger inside the SQLite adapter `beforeBatch` hook
(`apps/cloud/test/local-d1.ts:75`, committed outside the transaction) after the advisory read
and before the atomic batch, then asserts `403 exhausted`/`409 unavailable`, a single
election, and zero task/reservation/outbox/operation/audit rows with correct
reserved/consumed quantities. This is a genuine race at the batch boundary, not a
handler-shortcut test.

## Corrections carried into the candidate (inspected, narrow-approved)

- A-H1 child renewable lease (`7c0f147`): child now enforces `min(lease, absolute)` on the
  shared `/proc/uptime` boot clock and accepts validated renewal frames on private stdin;
  watchdog refuses to reopen after expiry (`src/hosted-child.ts:86-105,115-143`). Provider
  budgets and validates renewals (`src/hosted-runtime.ts:343-373`) and `renewOnce` re-checks
  local stop/authority after the write (`src/hosted-supervisor.ts:567-588`). Regression
  `tests/hosted-child-lease.test.ts:52` (blocked-parent expiry) and
  `tests/hosted-supervisor.test.ts:2839` pass in the full run.
- C1 rotation replay clock (`23535d2`): `rotationReplay` now compares both finite windows to
  `MAX(?, hostedSqlNow)` (`apps/cloud/src/hosted-supervisors.ts:470`); regression
  `apps/cloud/test/hosted-rotation-window.test.ts` passes.

I reproduced neither the A-H1 stall defect nor the C1 disclosure on this candidate: the
relevant guards and their regressions are present and green here.

## Other inspected surfaces

- Default Worker routing/order and CORS/CSRF/origin/error envelopes:
  `apps/cloud/src/index.ts:460-780`. Hosted handlers are wired before generic
  authentication; `/ready` gates on the additive hosted schema; error audit attribution is
  budget-bounded.
- Audiences: `hostedAuth` accepts only `sfexec_` and never falls through to cookie/GitHub/
  `sfcli_`/`sfworker_`/`sfsuper_` (`apps/cloud/src/hosted-authority.ts:98-125`); supervisor
  auth requires `sfsuper_` fixed scope/epoch/chain via SQL clock
  (`apps/cloud/src/hosted-supervisors.ts:148,210-213`).
- Admission/atomicity: advisory reads then one conditional batch, all dependent writes gated
  on the freshly elected task row (`apps/cloud/src/hosted-admission.ts:278-455`); diagnostic
  classification re-reads live state (`:509-658`).
- Dispatch operator recovery: browser owner/admin + CSRF + SQL-clock session check +
  independent OS-stop assertion (`apps/cloud/src/hosted-dispatch.ts:892-979`).
- Status pagination: the earlier disjoint-category cursor counterexample is fixed by a single
  ordered union page with one task cursor and a separate supervisor cursor
  (`apps/cloud/src/hosted-status.ts:312-349,427-438`).
- Private credential storage fails closed on ownership/mode/hardlink/symlink and uses
  O_NOFOLLOW + fsync + rename (`src/private-credential-file.ts`); hosted state applies the
  same POSIX discipline (`src/hosted-store.ts:88-143`).
- Compatibility: `git diff --name-status fec6697..HEAD` shows **no** edits to
  `src/coordinator.ts`, `src/store.ts`, `src/domain.ts`, `src/config.ts`, root
  `package.json`, or `bun.lock`. Root has no Cloudflare/workerd/wrangler/miniflare/Stripe
  dependency (grep + lockfile: 0 matches). Root additions are hosted/cloud modules and an
  explicit `hosted` CLI command that refuses raw credentials in argv
  (`src/cli/arguments.ts:560-680`).
- Migrations: `0001/0002` untouched; `0003_hosted_execution.sql` is additive with
  ownership-qualified FKs, quantity CHECKs, and no seeded customer policy.

## Verification performed (durable logs under `/workspace/.swarmforge/logs/`)

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test test/*.integration.ts` (apps/cloud) | **124 pass, 0 fail, 0 skip** |
| `bun --no-env-file --config=/dev/null test test/*.test.ts` (apps/cloud) | **90 pass, 0 fail, 0 skip** |
| `bun test` (root; includes `apps/cloud/test/hosted-dispatch.test.ts`) | **787 pass, 2 skip, 0 fail, 4533 assertions** (246 s) |
| `bun run check` (root: tsc + biome) | exit 0, 133 files |
| `bun run check` (apps/cloud: tsc + biome) | exit 0, 70 files |

No test, assertion, skip, timeout, concurrency, or ownership guard was weakened, removed, or
faked. The 2 root skips and `0 fail` match the recorded baseline. The D1/Miniflare
integration files ran under Node `--experimental-strip-types` (not Bun) as required; the
controlled-runtime integration files were not run under Bun.

## Remaining limits (why overall is INCOMPLETE)

- The last integrated SHA combining new D1/Bun tests, tiny-test recovery, and docs was not
  supplied; this review certifies only `1574331` / tree `bb2ff7f`.
- No live workerd/D1 clock/concurrency qualification, edge CPU / scanned-row measurement,
  secure supervisor deployment, repository broker/BYOK custody, hostile same-UID isolation,
  or untrusted customer-workload enablement was obtained. Controlled execution remains an
  inert bounded probe. These are preserved open release gates, not approvals.

## Explicit statement

No Critical, High, or Medium correctness or security finding was identified in the reviewed
change or the inspected surfaces. The two Low observations above are test-coverage/documentation
only and require no production source change.

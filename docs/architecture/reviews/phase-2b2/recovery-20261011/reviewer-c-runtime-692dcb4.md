# Contribution review — hosted runtime end-to-end qualification (1830..692dcb4)

**Reviewer:** independent-reviewer-c (read-only)
**Worker:** w-eb4ef77b-0a04-4d46-9bc5-934a1985eb3e
**Task:** final-security-review-fresh
**Run (authoritative dispatch):** d944343e-0f57-4365-9f47-146db4fb232e

## Contribution identity (verified)
- REQUIRES `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc`.
- `/tmp/phase2b2-runtime-5d.bundle` size 6429, SHA256
  `f05fd02f7a289316180dd6830d324c74874759c6cd4090cf71937ff4cc958470` — **verified**; holds
  HEAD `5dfe8d62ee56b7e1d89eb2b8e4898226d765adc1`.
- `/tmp/phase2b2-runtime-692.bundle` size 2405, SHA256
  `466def043a2f579abb95de6af0b40e1663c968e49cf3df40a3a8418dd7fdadf5` — **verified**; requires
  `5dfe8d62`, holds HEAD `692dcb4a882c4f2b7845d0e487b96c39c8ae7a4f`.
- Fetched sequentially into the private candidate clone (`refs/review/runtime-5dfe8d62`,
  `refs/review/runtime-692d`); isolated detached worktree `/tmp/phase2b2-runtime-692` at exact
  HEAD, tree `4811cf059caf35b35d8b224ce784968cfedbb272`, clean. Original assigned `45c` unchanged.
- Range `1830..692d` = `5dfe8d6` (real workerd/D1 + Bun lifecycle end to end) + `692dcb4`
  (hardened child-absence proof). Diff adds **only**
  `apps/cloud/test/hosted-runtime.integration.ts` (651 lines). No production source change.

## Verdict for THIS contribution: CHANGES_REQUESTED (test-hygiene only; no security/authority defect)

The qualification itself is real and its claims are accurate. The blocker is a concrete,
reproduced missing-teardown defect: the spawned Bun driver (and its real child) is never killed
on fixture/driver/assert failure, so a failing or timing-out test leaks a live process (and its
real inert child) past harness teardown. Fix is small and test-only. No overall phase approval.

## Findings

### F1 — LOW/MEDIUM (test hygiene, reproduced): driver/real-child not cleaned up on failure
- `runDriver` (`apps/cloud/test/hosted-runtime.integration.ts:238-280`) spawns the Bun driver and
  returns `{ child, result }`. The test body discards the handle (`void child;` at `:514`) and
  the cancel test never captures it (`const { result } = await runDriver(...)` at `:524`).
  `withHarness`'s `finally` (`:416-422`) closes the HTTP server, disposes Miniflare and removes
  the temp dir, but **never kills the driver child**.
- Consequence: any assertion failure after spawn, a `waitForTaskState` timeout
  (`:635-651`, 30s), or a rejected `result` leaves the Bun subprocess (and the inert
  `process.execPath` grandchild it spawned) running past teardown. In the happy path the driver
  is bounded and self-exits, so this is transient; but on a failing/timing-out test it leaks a
  live process and can leave the removed temp dir's SQLite files open.
- **Repro (executable, preserved):** `.swarmforge/artifacts/probes/runtime-driver-leak-repro.ts`
  spawns a bounded driver exactly like `runDriver`, performs the harness `finally` steps
  (`rm` temp dir) without killing the child, and observes
  `LEAK_REPRO: after harness-style teardown, driver pid=… alive=true exitCode=null`
  (`.swarmforge/logs/runtime-driver-leak-repro.log`). Confirms the child survives teardown
  because the suite never kills it.
- Suggested fix (test-only): keep spawned drivers in a registry on the harness context and kill
  them (`SIGKILL` after a short grace) in `withHarness`'s `finally` before `rm`; capture `child`
  in the cancel test too.

### F2 — LOW (test hygiene): lost-ack transport leaves a response body unconsumed
- `driverScript` lost-ack path (`:130-134`) awaits the real `baseFetch`, discards it with
  `void response`, then throws. `response.body?.cancel()` is never called, so the first ack's
  response body is left dangling (the production client cancels on `!ok`; the test transport does
  not). Bounded/short-lived, but a resource-hygiene defect worth cancelling.

### F3 — INFO: claims verified, not overstated; ESRCH-only hardening correct
- The header claims (`:12-27`) are accurate: `machine-helpers.fixture`
  (`test/machine-helpers.ts:12-54`) bundles and runs the **actual default Worker**
  (`../src/index.ts` `createWorker`, full route/middleware, not a hosted-only router) under real
  **Miniflare/workerd** with a real **D1** database and all three migrations; the driver
  (`:74-236`) runs the real Bun `HostedSupervisor` + `Coordinator` + `ControlledProcessProvider`
  + `HostedTaskClient`/`SupervisorClient` in an actual Bun subprocess with protected temp SQLite
  journals, reached over the Node loopback TCP bridge (`:380-410`). Synthetic GitHub identity;
  no live Cloudflare/customer endpoint.
- The observed run confirms the claims: test 1 completed in 34.5s with 31s controlled runtime
  and ≥2 real renewals and ≥2 ack attempts (lost-ack retried with the same durable key), exactly
  one spawned child, `task_state=completed`, journal `settled`/`stop_confirmed`, child proven
  dead only by **ESRCH** (`:198-204`), meter consumed once and reservation released; test 2
  cancels a running task (cancel 202, renew observed 409 on the stop path, settle 200) with
  verified stop and released reservation; test 3 ack-always holds, spawns nothing, keeps the
  reservation/meter reserved, and expired authority yields `claim_failed` with no spawn.
- ESRCH-only child-absence proof (`:194-205`) is a correct hardening (EPERM/unknown no longer
  counted as dead) — no authority weakening.

## Verifications run (this worktree, frozen deps, Bun 1.4.2)
| Command | Result |
| --- | --- |
| both bundles `git bundle verify` + sequential fetch + detached checkout | identity exact, clean |
| `node --experimental-strip-types --test test/hosted-runtime.integration.ts` | **3 pass / 0 fail**, 60.593s |
| `apps/cloud` `bun run test` (full integration) | **127 tests: 125 pass / 2 fail** — the two known old-1830 status/fixture failures, fixed separately by the 1574331 contribution |
| static checks | (unchanged test-only diff; cloud 70 / root 133 files pass earlier) |

Logs: `.swarmforge/logs/runtime-692-test.log`, `runtime-692-full-cloud.log`.

## Probe correction (companion) — fixed and rerun
- `.swarmforge/artifacts/probes/hosted-supervisor-cross-tenant-probe.ts`: the old `expectThrow`
  caught its own `assert.fail`, so a call that *resolved* could be reported as PASS. Replaced with
  `assert.rejects(fn, validator, msg)` and specific `/Unknown hosted task/` matchers; a resolved
  call now fails the probe. Rerun (against the reviewed 692d worktree):
  **15/15 checks pass** (`.swarmforge/logs/hosted-supervisor-cross-tenant-probe.log`).
- **Accurate limits (do not overstate):** `localFixture` uses the in-process REAL SQLite **D1
  adapter** (`LocalD1`), **not workerd**; the server guards exercised are the production handler
  predicates on that adapter. Part 2 seeds a **NEVER-STARTED** journal row (state `mapped`, stub
  provider, no OS child), so it proves (a) the server guards block cross-tenant authoritative
  ack/renew/status/settle (404) and (b) the local journal is the trusted admin plane — it does
  **not** prove anything about stopping a real foreign OS runtime (no cross-tenant OS stop was
  attempted or claimed). The private per-credential trusted-journal boundary means a public
  customer has no access to that journal; no claim is made that a shared privileged journal is
  automatically runtime-isolated. No production rewrite is warranted from this finding.

## Notes
- No implementation/source edited; probes and reports are preserved separately; original
  companion correction (`review-diagnostic-1574331.md`) preserved. No push, merge, deploy, or VM
  deletion. This is a contribution review only — **not overall phase acceptance**.

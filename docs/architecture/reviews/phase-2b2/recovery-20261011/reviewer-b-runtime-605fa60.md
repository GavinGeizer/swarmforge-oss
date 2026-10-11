# Reviewer B — Runtime-test Contribution Re-review: `1830b06..605fa6059d442a1c5ec40ffd4a36820efe173153`

**Verdict: APPROVED.** Prior findings R1 and R2 are closed; the two added
real failure cases are genuine; no configuration/timeout weakening and no
production edit. Not phase approval — the final integrated commit and overall
A/B/C acceptance remain pending.

Prior reports retained unchanged (`review.md`, `source-review-preflight.md`,
`review-contribution-1574331.md`, `review-runtime-692dcb4.md`,
`review-root-18ae36d.md`).

## Provenance (verified, read-only, no source edit/push/merge/deploy)

- `/tmp/phase2b2-runtime-final.bundle` SHA256
  `8ed197e51d6fc9beb1762b0f747037b8b09734eb5246cf0424c2e9a144917e47`, 13276B —
  MATCHES; fetched `refs/private/runtime-final` =
  `605fa6059d442a1c5ec40ffd4a36820efe173153` (tree
  `70a852cc7dd6c0df1193d32bd046f8078d890f9a`, requires `1830b06`). Includes
  `5d`→`692d`→`a106`→`605`. `git fsck` clean.
- `git diff 1830b06..605 --stat`: only
  `apps/cloud/test/hosted-runtime.integration.ts` (897 insertions). No
  production/config/deps change.
- Isolated detached worktree `/tmp/p2b2-rt605` at exact `605fa60`. Original
  branch `/workspace/repo` unchanged at `45c29d3`.

## Executed evidence

- All 5 Node cases at `605fa60`:
  `node --experimental-strip-types --test test/hosted-runtime.integration.ts`
  → **5 pass / 0 fail, 64.7s** (matches author 5/5). Cases: multi-renewal +
  lost-ack no-duplicate (33.8s); cancel release only on verified stop (16.9s);
  lost-ack held + expired authority (8.5s); **driver failure with live child →
  production cleanup + durable journal** (3.5s); **unparsable/early-exit driver
  rejected cleanly** (1.4s).
- Cloud suite on this tree (
  `hosted-admission.integration.ts` + `enrollment.integration.ts`): the **only**
  failures are the two known 1830 defects — admission metering (409 vs 403) and
  enrollment (400 vs 404). The new test file introduces no suite regression;
  consistent with the author's 127/129 (the two fixes live on the separate
  `1574331` branch, not on this runtime-only branch).
- Parent-SIGKILL probe (`probe-runtime-605-sigkill.log`): SIGKILLed parent →
  real grandchild absent in ~51ms via stdin EOF/close (production
  `src/hosted-child.ts` → `HOSTED_CHILD_EXIT_PARENT_DEAD`).

## Prior findings closure

### R1 (driver/real-child cleanup on failure) — CLOSED
- `runDriver` now takes the shared `drivers: Set<DriverHandle>` and registers
  each handle (`:333-360` region), removing it on exit.
- `withHarness` `finally` (`:550-595`) stops and **awaits every driver before**
  closing the bridge, disposing D1, or `rm`-ing the journals, via
  `stopDriver` (`:363-...`): SIGTERM → driver's `terminate` runs production
  `cleanup()` (`supervisor.close()` → verified child stop → `coordinator.stop()`
  → `store.close()`), bounded 15s; on timeout SIGKILL + 5s and records
  uncertainty.
- The driver's own `finally { await cleanup() }` (`:...`) also runs on in-process
  failure. Test 4 proves this end-to-end: crash while a real child is alive →
  `out.ok=false`, `child_pid>0`, `pid_dead=true`, `spawned>=1`,
  `reopened.stop_confirmed=true`, `cleanup_errors===undefined`. The journal
  `stop_confirmed` assertion is what proves the *production* stop ran, not mere
  process-exit stdin EOF.

### R2 (unhandled parse / stdin error) — CLOSED
- `exited` promise from `close`; `result = exited.then(...)` with explicit
  throws for stdin error, non-zero exit, and a try/catch around `JSON.parse`
  that rejects with "unparsable result" (`:335-360`). `child.stdin.on("error")`
  now records instead of a noop; `void result.catch(() => {})` prevents
  unobserved rejections. Test 5 (`exitEarly`) asserts the timeout-bounded
  rejection `/unparsable result|exited/` and passes.

## Teardown uncertainty / signal races / journal preservation

- **SIGKILL alone never proves grandchild absence**: as required, when graceful
  stop fails the harness records `cleanupUncertainty` and, at `605`, raises a
  combined error even when a primary failure is also present
  (`withHarness`, `:583-595`). A SIGKILLed parent yields no journal stop proof,
  so it correctly remains a failed qualification (the probe shows the child
  does exit, but absence is not *proven* without the production stop).
- **Graceful signal race**: `stopDriver` checks `exitCode`/`signalCode` first and
  awaits `exited`; the driver's `terminating` guard makes `terminate` idempotent;
  `cleanup()` is idempotent via `cleaned`. No double-stop or missed cleanup.
- **Journal preservation**: reopened on both success and failure paths
  (`:...`); test 4 asserts the reserved/stop-confirmed journal survives.
- No timeout/config weakening: test timeouts unchanged (120s/90s/30s); only the
  new `stopDriver` bounds (15s/5s) were added.

## Findings

None. No source changes requested for this contribution.

## Statement

Contribution `1830b06..605fa6059d442a1c5ec40ffd4a36820efe173153`: **APPROVED**
— R1/R2 closed, 5/5 Node cases pass independently, failure-path production
cleanup, graceful-signal and SIGKILL-uncertainty handling, and journal
preservation all verified; no weakened assertions/timeouts, no production edits.
Overall Phase 2B.2 A/B/C acceptance remains INCOMPLETE pending the final
integrated commit plus documents.

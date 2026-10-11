# Reviewer B — Contribution Review: `1830b06..692dcb4a882c4f2b7845d0e487b96c39c8ae7a4f`

**Verdict for THIS contribution: CHANGES_REQUESTED (minor, test-only cleanup
defect).** Production-quality and claim accuracy are otherwise VERIFIED. Overall
Phase 2B.2 remains INCOMPLETE — final combined source+docs follow; this is not
phase approval.

Original reports (`review.md`, `source-review-preflight.md`,
`review-contribution-1574331.md`) are preserved unchanged.

## Provenance (verified, read-only, no push/merge/deploy)

- `/tmp/phase2b2-runtime-5d.bundle` SHA256
  `f05fd02f7a289316180dd6830d324c74874759c6cd4090cf71937ff4cc958470`, 6429B —
  MATCHES; `refs/private/runtime-5d` = `5dfe8d62ee56b7e1d89eb2b8e4898226d765adc1`
  (requires `1830b06`).
- `/tmp/phase2b2-runtime-692.bundle` SHA256
  `466def043a2f579abb95de6af0b40e1663c968e49cf3df40a3a8418dd7fdadf5`, 2405B —
  MATCHES; `refs/private/runtime-692` =
  `692dcb4a882c4f2b7845d0e487b96c39c8ae7a4f` (tree
  `4811cf059caf35b35d8b224ce784968cfedbb272`, requires `5dfe8d6`). Fetched
  sequentially into the existing private clone `/workspace/phase2b2-review`.
- Isolated detached worktree `/tmp/p2b2-runtime` at exact `692d`, clean;
  `git fsck` clean. Original assigned branch `/workspace/repo` unchanged at
  `45c29d3`. Bun 1.4.2.
- Diff `1830b06..692d`: **only** `apps/cloud/test/hosted-runtime.integration.ts`
  added (651 insertions, 0 deletions, 1 file). No production file, no shared
  fixture, no test configuration, no authority/quota change.

## Executed evidence (Node, actual default worker)

`node --experimental-strip-types --test test/hosted-runtime.integration.ts`
→ **3 pass / 0 fail, duration 60.7s** (matches author 3/3):
- "hosted task completes across real workerd/D1 and a real Bun supervisor with
  multiple renewals and lost-ack recovery, no duplicate execution" (34.5s).
- "cloud cancellation stops the real child and releases the reservation only on
  verified stop" (17.0s).
- "network loss at ack holds uncertain durable state without execution and
  expired supervisor authority is rejected" (8.4s).

## Claim verification (not overstated)

- **Default production worker, not a hosted-only router**: the `5d..692` delta
  replaced `dispatchFixture`/`hosted-dispatch-helpers.ts` with
  `machine-helpers.ts` `fixture`, whose bundle entry point is
  `apps/cloud/test/machine-helpers.ts:13` → `../src/index.ts` (real default
  routes/middleware). Confirmed.
- **Only-ESRCH child-absence proof**: `if (error.code === "ESRCH") pid_dead =
  true; else throw` at `hosted-runtime.integration.ts:198-204`; any other/unknown
  error now fails the qualification. Confirmed.
- **Real end-to-end path**: Node TCP bridge over `h.request` (default D1/
  workerd), real Bun subprocess running production `Coordinator` +
  `ControlledProcessProvider` + `HostedTaskClient`/`SupervisorClient`, real inert
  child, protected temp SQLite journals (`0600` asserted at `:510-513`).
- **Renewal/lost-ack/no-duplicate**: 31s controlled duration under a 30s lease;
  `ack_calls >= 2` and `spawned.length === 1` (`:474-477`); mapping settled,
  `stop_confirmed`, measured `consumed_runtime_ms >= 31000`, `pid_dead`, reopened
  journal settled, D1 meter `consumed == consumed_runtime_ms` (`:485-507`).
  Directly asserted, not inferred.
- **Cancel only on verified stop** (`:539-566`): reservation `released` and
  meter returned only after `stop_confirmed` + `pid_dead`.
- **Held-on-uncertainty** (`:582-631`): lost-ack → `spawned` empty,
  `child_pid null`, reopened `held`/`stop_confirmed=false`, reservation not
  released, meter still `60000`; expired supervisor → `claim_failed:true`, zero
  spawn.
- **Bridge body/error handling**: full request body forwarded and full response
  body returned (`:388-397`); catch emits a 503 JSON envelope. Confirmed.

## Findings (ordered by severity)

### R1 (Medium, test-only cleanup defect, CHANGES_REQUESTED): spawned driver and its real child are not killed on assertion/timeout failure
- Location: `apps/cloud/test/hosted-runtime.integration.ts:238-280` (`runDriver`
  spawns the real Bun driver) and `:372-423` (`withHarness` finally). The
  `finally` at `:416-422` closes the HTTP server, disposes the Miniflare fixture
  and `rm`s the temp directory, but never kills or awaits the driver `child`.
  Tests 1 and 3 capture `child` and only `void child` (`:514`); test 2 destructures
  only `{ result }` (`:524`), discarding the handle. There is **no `child.kill()`
  anywhere** (verified by grep) and no exit await on failure paths.
- Repro: make any assertion fail after `runDriver` resolves, or let
  `waitForTaskState` hit its 30s deadline (`:639-648`) — the test throws, the
  `finally` closes the server and deletes `directory` while the Bun driver (and
  its real inert grandchild, up to ~31s) may still be running and holding the
  now-removed SQLite files open. `node:test`'s `{ timeout }` aborts the test but
  does not kill spawned subprocesses, so the driver/child can outlive the run on
  the failure path.
- Impact: test-hygiene/resource leak and potential failure-path flakiness in CI;
  not a production defect, and does not affect the green 3/3 result (on success
  the driver self-exits via `process.stdout.write` + drained event loop).
- Requested change: in `withHarness`'s `finally` (or a per-test `finally`), kill
  and await the driver child (e.g. `if (child.exitCode === null) child.kill();
  await once(child, "close")`), and pass the handle out so test 2 retains it too.

### R2 (Low, test-robustness): unhandled synchronous parse in the close handler
- Location: `:266-277`. On exit code 0 the `close` listener calls
  `JSON.parse(stdout.trim().split("\n").at(-1)!)`. Empty/garbled stdout makes
  `JSON.parse` throw inside the event handler — an uncaught exception, not a
  rejected `result` promise, so `await result` cannot surface it cleanly.
  Similarly `child.stdin!.write` (`:262`) has no `error` listener for EPIPE.
- Repro (hypothetical, bounded): force the driver to emit no stdout and exit 0 →
  uncaught `SyntaxError` from the listener instead of a clean test failure.
- Requested change: wrap the parse in try/catch and `reject` with the captured
  `stderr`; add `child.stdin!.on("error", () => {})`.

### No other defects found
- No test-configuration change, no authority/quota weakening, no shared-fixture
  or production edit. Staleness/cancel waiting is bounded (`:639-648`) and
  reports the observed state on timeout. Claims in the commit message and file
  header match the code.

## Statement

Contribution `1830b06..692dcb4a882c4f2b7845d0e487b96c39c8ae7a4f`:
**CHANGES_REQUESTED** for R1 (driver/real-child cleanup on failure) and R2
(harden the close-handler parse / stdin error). Everything else — the actual
default-worker qualification, only-ESRCH proof, real Miniflare/D1 bridge, real
Bun supervisor + child, renewals, lost-ack, cancel, held journal — is verified
by executed evidence and is not overstated. Final combined source+docs still
pending; no overall phase acceptance.

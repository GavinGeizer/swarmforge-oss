# Change summary: hosted-runtime.integration.ts (w-049b148a)

## Scope and workspace

- Authoritative private worktree: `/workspace/phase2b2-ready`
  - Base HEAD `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc`,
    base tree `7718e59f5c54750c6136bfd05a7c6cdf2c5e3264` (lead-verified EXACT).
  - Final follow-up HEAD `605fa6059d442a1c5ec40ffd4a36820efe173153`,
    tree `70a852cc7dd6c0df1193d32bd046f8078d890f9a`.
- Provenance: private source recovered via SDK stream at `5dfe8d62` / tree
  `4239c0fede255507b79dce638a510685a0697551`, recorded own sha
  `f05fd02f...958470`; `a106deb` recovered at sha `92f470...5bd17a`, five-case
  proof retained. Imported into lead Git; not published. Assigned clone
  `/workspace/repo` at older `45c29d3` remains **unchanged** (clean). No
  push/merge/deploy/VM deletion.
- Only NEW source file: `apps/cloud/test/hosted-runtime.integration.ts`
  (one file, 897 lines vs base). No other file, no prod/config/shared-fixture
  edit, no timeout/concurrency change to hide failures.
- Frozen deps installed locally (`bun install --frozen-lockfile`); no upgrades.
  `bun --version` = 1.4.2, `node --version` = v24.21.0.

## What the test covers (preserved)

Real default worker: `machine-helpers.ts` `fixture` bundles/runs the actual
default `src/index.ts` `createWorker` route/middleware under real local
Miniflare/workerd with real D1, reached over the Node loopback HTTP bridge used
by `worker-client.integration.ts`. Real Bun `HostedSupervisor` + `Coordinator`
+ `ControlledProcessProvider` + `HostedTaskClient` + `SupervisorClient` run in
an actual Bun subprocess with protected temporary SQLite journals and a real
inert child. Synthetic GitHub fixture only; no live contact.

Three original cases preserved with their assertions:

1. Completion with multiple real lease renewals (31s under 30s lease) and
   lost-ack idempotent recovery, single child spawn, meter settled once.
2. Cloud cancellation = verified runtime stop + reservation release.
3. Ack network loss held durable/uncertain without execution + expired
   supervisor authority rejected.

## ReviewerB corrections applied (follow-up commit a106deb)

R1 (harness/runtime leak + grandchild cleanup):

- Harness tracks every Bun driver (`Set<DriverHandle>`); `withHarness` finally
  stops each still-running driver with a bounded graceful `SIGTERM` and awaits
  its exit BEFORE closing the bridge server, disposing D1, or removing the temp
  dir. Only past the bound does it `SIGKILL` and record the teardown
  uncertainty (surfaced, not hidden). The cancel-case driver handle is retained
  (previously discarded), so a `waitForTaskState` failure can no longer leave a
  driver+child+journals outliving the test.
- Driver keeps all production objects in outer bindings and a `try/finally`
  that always runs `supervisor.close()` (production verified child stop) then
  `coordinator.stop()` and `store.close()`. Parent `SIGTERM`/`SIGINT` run the
  same cleanup before exit. Fallback uncertainty is documented: if the parent
  is SIGKILLed, the grandchild exits on stdin EOF/close.
- Journal reopen and ESRCH child-absence proof now happen after production
  cleanup, so they certify the grandchild was actually stopped.

R2 (result parsing / stdin errors):

- `result` rejects on JSON parse failure and on stdin `error` (EPIPE) with
  bounded stdout/stderr diagnostics; the suggested noop stdin listener is
  deliberately NOT used (it would swallow failures).
- New focused real failure-path regressions:
  - `driver failure while the real child is alive…`: the driver starts the real
    child, then throws; asserts `ok=false`, real `child_pid>0`, `pid_dead=true`
    (ESRCH), spawn count >= 1, reopened journal `stop_confirmed=true`, no
    cleanup errors. This exercises the actual failure, not a source grep.
  - `unparsable or early-exiting driver…`: asserts clean result rejection.

## ReviewerC corrections applied (follow-up commit 605fa60)

Smallest follow-up in the owned NEW file only:

- Lost-ACK transport previously returned the first real ack reply from
  `baseFetch` but discarded it with `void response`, leaking an unconsumed
  response body. It now consumes the small real reply (`await
  response.arrayBuffer()`) before deliberately throwing the synthetic lost-ACK
  error; the discarded reply is never fed back to the client as a fake
  delivery. No retries/security/config change.
- Teardown uncertainty now always fails/reports the qualification, even
  alongside another failure. It is documented that SIGKILL of the driver parent
  is NOT proof about a foreign grandchild; the tested graceful production stop
  is the only accepted proof.

## Verification evidence

Commands run separately (from `/workspace/phase2b2-ready/apps/cloud`):

- `bun install --frozen-lockfile` (root and apps/cloud) -> ok
- `node --experimental-strip-types --test test/hosted-runtime.integration.ts`
  -> `tests 5 | pass 5 | fail 0` (~64s). Log:
  `/workspace/.swarmforge/logs/hosted-runtime.integration.log`
- Full default-cloud suite
  `node --experimental-strip-types --test test/*.integration.ts`
  -> `tests 129 | pass 127 | fail 2` (both known pre-existing). Log:
  `/workspace/.swarmforge/logs/cloud-integration-full.log`
- Static (separate): `tsc --noEmit` exit 0; `biome check
  test/hosted-runtime.integration.ts` clean. Log:
  `/workspace/.swarmforge/logs/hosted-runtime-static.log`

## Pre-existing failures (NOT caused by this change)

- `test/enrollment.integration.ts:37` expected 404, got 400.
- `test/hosted-admission.integration.ts:544` expected 403, got 409 (metering).

Candidate `1830b06` defects/expectation drift for the implementation owner (a
corrected cloud branch `1574331` may later join); none are in this new test.

## Private commits / bundles

- Branch: `qualify-real-d1-bun-runtime-fresh/w-049b148a`
- Base commit: `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc`
- `5dfe8d62` -> `692dcb4` -> `a106deb` -> `605fa60`
  (`605fa6059d442a1c5ec40ffd4a36820efe173153`, tree
  `70a852cc7dd6c0df1193d32bd046f8078d890f9a`)
- Diffstat: vs `1830b06` 1 file +897; vs `a106deb` +11/-1.
- Artifacts:
  - `.swarmforge/artifacts/w-049b148a-hosted-runtime.patch` (1830..HEAD)
  - `.swarmforge/artifacts/w-049b148a-hosted-runtime.bundle`
    (verified `requires 1830b06`)
  - `.swarmforge/artifacts/w-049b148a-hosted-runtime-followup.patch`
    (a106deb..HEAD)
  - `.swarmforge/artifacts/w-049b148a-hosted-runtime-followup.bundle`
    (verified `requires a106deb`)

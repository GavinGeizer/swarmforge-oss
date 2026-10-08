# SwarmForge review — serve / drain / shutdown scope

- **Target (exact)**: `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Branch**: `feature/binary-config-serve-20260930` (fetched from `https://github.com/GavinGeizer/swarmforge-oss.git`)
- **Disposable checkout**: `/tmp/rv-serve-drain` (created with `git archive` from the target SHA; not a git working tree)
- **Assigned workspace**: `/workspace/repo` — left on its assigned baseline, unchanged and clean
- **Scope**: SIGTERM/SIGINT and repeated `stop()`, outstanding coordinator operations, shutdown deadline, SQLite close races
- **Verdict**: FINDINGS (2 × LOW; no CRITICAL/HIGH/MEDIUM)

## Files reviewed

`src/serve-command.ts` (signal handlers, deadline, exit policy), `src/serve.ts`
(resource ordering, `release()`, abort listener, startup gate), `src/coordinator.ts`
(`stop()`, `track()`, `exclusive()`, `tearingDown`, `stopWaiters`),
`src/store.ts` (`close()`, `subscribe()`), `src/runtime.ts` (`acquireProcessLock`,
`eventLogger`), `src/http.ts`, `src/mcp.ts`, `src/files.ts`, `src/security.ts`,
`src/main.ts`, `docs/SERVE.md`, `tests/serve.test.ts`,
`tests/fixtures/serve-command-child.ts`.

## What the shutdown path actually does (verified by trace + probe)

`runServe` installs `SIGTERM`/`SIGINT` handlers *before* calling `startServer`, so a
signal during a blocked startup is still delivered. The first signal sets `requested`
and arms the deadline; a **repeated** signal returns immediately at
`src/serve-command.ts:112`. With a live handle the signal starts `handle.stop()`;
otherwise it aborts the startup signal, and the `if (requested)` re-check at
`src/serve-command.ts:144` covers the window where the abort happened after
`startServer` resolved but before the assignment. `startServer` also registers its own
`abort` listener (`src/serve.ts:205`) as a second net; that registration sits in a
synchronous block, so it cannot miss the `signal.aborted` window.

`release()` (`src/serve.ts:140`) is memoized by `releasing ??= release()`, so repeated
`stop()` returns the identical promise. Order is: clear log interval → close gate →
`api.stop(true)` → `metricsServer.stop(true)` → `coordinator.stop()` → `flush()` →
`store.close()` → `unlock()`. The DB is closed last, after the drain.

`Coordinator.stop()` (`src/coordinator.ts:292`) sets `stopped`, clears the poll timer,
wakes `stopWaiters`, then drains: `while (this.idle) await this.idle;` plus
`Promise.allSettled([...this.locks.values()])`. I traced the invariants:

- `track()` creates `idle` only on the `inFlight === 0` edge and clears
  `idle`/`wakeIdle` *before* waking, so the `while` loop cannot spin or hang.
- Every store **write** is either inside `track` (`recover`, `tick`, `control`) or fully
  synchronous (`spawn`, `message` call `db.transaction(... )()` with no `await` between
  read and write), so no write can straddle `store.close()`.
- After `stopped` is set, `tick()` and `startProvisioning()` return early and
  `control()` throws, so no new lock can be created after `stop()` snapshots
  `this.locks`.
- `Coordinator.stop()` cannot reject (`Promise.allSettled` never rejects, `idle` only
  resolves), so the trailing `flush`/`store.close`/`unlock` cannot be skipped by it.
- `serve.ts:148-156` puts `flush`/`close`/`unlock` in a `try/finally`, so a throwing
  flush still closes the DB and releases the lock.

Two microtask-ordering dependencies that I checked explicitly because they *look*
racy but are in fact safe (see "Verified non-findings").

## Findings

### F1 — LOW — In-flight read-only tool calls raise `RangeError: Cannot use a closed database` after the drain closes SQLite

- **File / line (exact target)**: `src/serve.ts:152` (`store?.close()`) is the trigger;
  the un-drained reads are at `src/files.ts:121` and `src/files.ts:142`
  (`get_worker_logs` re-reads the store after an `await` on the provider), at
  `src/files.ts` async artifact/log handlers generally, and at `src/security.ts:48`
  (`redactorFor` → `c.store.all()`, evaluated lazily on **every** string handed to
  `Redactor.text`/`value`, so it is hit by the MCP response path at `src/mcp.ts:40`
  and by the error path at `src/mcp.ts:60`).
- **Trigger**: a client has a read-only MCP request in flight (e.g.
  `get_worker_logs` parked on `provider.getWorker`, or any tool whose response
  redaction runs) when `handle.stop()` is called. The drain only waits for
  `Coordinator`-tracked operations; `WorkerFiles` handlers and the redactor are not
  tracked, so `store.close()` runs while they are parked on external I/O. When they
  resume, `bun:sqlite` throws `RangeError: Cannot use a closed database`.
- **Consequence**: the tool call fails with an internal error instead of the intended
  tool-level `isError` / clean refusal. Worse, the throw happens *inside* the catch
  block of `register` (`src/mcp.ts:59-64`), so the handler's own error path also throws
  and no `isError` result is produced. In practice the client has usually already lost
  the connection because `api.stop(true)` force-closes it, so this is mostly masked.
  No durable corruption, no unhandled rejection, no post-close writes.
- **Reproduction (reviewer probe, outside the source checkout)**:
  `/tmp/rv-probe/probe2.ts` — instruments `Store.prototype` so every method records
  whether it ran after `Store.close()`, seeds a `running` worker, starts the server,
  parks `provider.getWorker` behind a deferred, fires `get_worker_logs`, calls
  `handle.stop()`, then releases the deferred. Observed (Bun 1.4.2, exit 0):

  ```
  DRAIN: drained 20ms
  LOGS RESULT: rejected:TypeError: The socket connection was closed unexpectedly...
  POST-CLOSE THROWING CALLS: 2
    all  RangeError: Cannot use a closed database
         <- security.ts:48 <- text security.ts:7 <- security.ts:33 <- value security.ts:29
         <- mcp.ts:40 <- executeToolHandler (MCP SDK mcp.js:233)
    all  RangeError: Cannot use a closed database
         <- security.ts:48 <- text security.ts:7 <- mcp.ts:60 <- executeToolHandler
  POST-CLOSE WRITES: 0
  UNHANDLED: []
  ```

  `/tmp/rv-probe/probe-postclose.ts` independently observed 3 post-close calls
  (`get`, `events` from `files.logs`, `all` from the redactor) and 0 unhandled
  rejections.
- **Why existing guards/tests do not prevent it**: `docs/SERVE.md` states the drain
  "covers the writes the coordinator owns, and an in-flight read-only wait is woken
  rather than left polling a closing database". The wake (`stopWaiters` →
  `waitForStateChange`) does cover `wait_for_state_change`, and
  `tests/serve.test.ts:643` asserts that case, but nothing covers the *other*
  read-only handlers (`get_worker_logs`, `list_worker_artifacts`, `get_worker_artifact`,
  `swarmforge://` resource reads) or the redactor, which are neither tracked nor woken.
  The Limitations section does concede "a request doing unbounded external I/O of its
  own is closed with its connection", so the behaviour is partly anticipated — the
  actionable part is the *unguarded throw*, not the lost connection.
- **Recommended correction** (either is sufficient, both are cheap):
  1. Make `Store.close()` idempotent and *safe for readers*: set a `closed` flag and
     have read methods return a neutral result (`null` / `[]`) instead of throwing, so
     a late reader degrades instead of failing.
  2. Or track `WorkerFiles` handlers with the same `Coordinator.track()` accounting
     used for writes, and/or snapshot the redactor secret set once
     (`redactorFor(c)` → `new Redactor(() => snapshot)`) so redaction never needs a
     post-shutdown database read.
- **Confidence**: reproduced (2 independent probes, real SQLite, real HTTP + MCP
  transport) — high for the throw; medium for user-visible impact, since the
  force-closed socket usually masks it.

### F2 — LOW — A repeated SIGINT/SIGTERM cannot shorten a stuck drain; the operator must wait the full deadline

- **File / line (exact target)**: `src/serve-command.ts:112` (`if (requested) return;`)
  in `onSignal`, with the only escape at `src/serve-command.ts:120-130` (the
  `SWARMFORGE_SHUTDOWN_TIMEOUT_MS` deadline, default `60000` at
  `src/serve-command.ts:9`).
- **Trigger**: a drain that cannot finish — e.g. a `provider` promise that never
  settles, or a `pushBranch` bounded by `SWARMFORGE_GIT_PUSH_TIMEOUT_MS` (default
  120000, `src/config.ts:53`) which exceeds the 60 s shutdown deadline. The operator
  sends `SIGINT` repeatedly expecting an escalation to an immediate exit; every signal
  after the first is dropped on the floor.
- **Consequence**: the process stays alive for up to 60 s after the operator has
  decided to stop it, then exits `70` (`forcedShutdownExitCode`). Under systemd with
  `TimeoutStopSec` below 60 s the unit is SIGKILLed, producing exit `137` instead of
  the intended `70` and losing the "Shutdown deadline exceeded" diagnostic. This is
  deliberate and tested (`tests/serve.test.ts:835` asserts
  `stdout.split("Shutdown requested")` has length 2, i.e. the repeat is ignored), so
  the *severity* is low; it is reported because the behaviour is a deliberate choice
  that has an actionable alternative.
- **Reproduction / code trace**: `onSignal` returns before touching the deadline
  (`src/serve-command.ts:112`), and the deadline timer is created only inside the
  first-signal path (`src/serve-command.ts:120`). Nothing else observes signals. The
  existing child-process test `tests/serve.test.ts:892` demonstrates the only escape:
  a 400 ms deadline.
- **Why existing guards/tests do not prevent it**: the guard *is* the ignore; no test
  asserts a repeated signal can escalate, and none of the docs promise escalation.
- **Recommended correction**: treat a second signal while a drain is in progress as an
  escalation — e.g. shorten to a small grace deadline (or `process.exit(70)` directly)
  on the second signal, which is the conventional supervisor-friendly behaviour. Keep
  the first-signal drain intact.
- **Confidence**: code-evidenced (deterministic from `onSignal`); not separately
  reproduced in a child process, but the existing test at `tests/serve.test.ts:835`
  confirms the ignore.

## Verified non-findings (traced, deliberately not reported as defects)

- **`Coordinator.control()`'s trailing `return this.store.get(id)` (`src/coordinator.ts:814`) sits outside `track`.** Microtask order makes this safe: `track`'s `finally` resolves `idle` *before* `stop()`'s `while (this.idle)` continuation is queued, so `stop()` is queued first, sees `idle === undefined`, exits the loop, and then yields once more on `await Promise.allSettled(...)`; `control`'s continuation is queued in between and therefore runs *before* `store.close()`. Fragile but deterministic. Worth a comment, not a fix.
- **A signal arriving between `startServer`'s `if (signal?.aborted)` check (`src/serve.ts:199`) and `addEventListener` (`src/serve.ts:205`)** cannot miss the abort: the block is synchronous, so no signal callback can run inside it, and `runServe`'s `if (requested)` re-check covers the rest.
- **`release()`'s ordering (`coordinator.stop()` before `flush`/`close`/`unlock`)** is safe: `Coordinator.stop()` is structurally incapable of rejecting, so the trailing `try/finally` cannot be skipped.
- **Poll-tick starvation during shutdown**: the coordinator's `setInterval` keeps firing between `gate.close()` and `coordinator.stop()`, but `stop()` awaits the resulting tracked tick, so the DB is never closed under a running tick.
- **Post-close writes**: none reachable. `spawn`/`message` are synchronous end to end; every other write is inside `track`. Both probes recorded `POST-CLOSE WRITES: 0`.

## Tests / probes run

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` (Bun 1.4.2 at `/tmp/bun142/bun-linux-x64/bun`) | exit 0, 125 packages, lockfile untouched |
| `bun test tests/serve.test.ts` | exit 0 — **20 pass / 0 fail**, 111 assertions, 4.42 s |
| `bun run /tmp/rv-probe/probe-postclose.ts` | exit 0 — 3 post-close reads, 0 unhandled rejections |
| `bun run /tmp/rv-probe/probe2.ts` | exit 0 — 2 post-close throws, 0 post-close writes, 0 unhandled rejections |

The system `bun` is 1.3.14 and cannot read this `lockfileVersion: 2`; official Bun
1.4.2 was installed under `/tmp` and the lockfile was never rewritten. No whole-suite
run, no compile, no real cloud/provider/infrastructure call: all probes use the repo's
own `FakeProvider`/`FakeAgent` from `tests/helpers.ts` against a throwaway SQLite file
in `mkdtemp`, on loopback ports allocated by `Bun.serve({port: 0})`.

## Limitations

- Probes patched `Store.prototype` from a file **outside** the source checkout
  (`/tmp/rv-probe/`). No source file was modified; no probe was committed anywhere.
- Post-close behaviour for `get_worker_artifact` / `swarmforge://` resource reads was
  inferred from the same code path as `get_worker_logs` (identical
  `WorkerFiles` → `store` shape) rather than probed separately.
- F2 was not reproduced in a spawned child process; it is a deterministic read of
  `onSignal` and is corroborated by the existing repeat-signal test.
- Only `tests/serve.test.ts` was executed. `tests/lifecycle.test.ts`,
  `tests/wait.test.ts`, `tests/commands.test.ts` and the rest were read in part or not
  run — out of this reviewer's scope.
- No credentials, `.env` files, or secret stores were read. All example values in this
  report are repo-local placeholders.

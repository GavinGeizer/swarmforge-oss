# SwarmForge review — scope 17 (serve startup / lifecycle)

- **Target:** `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Branch reviewed:** `feature/binary-config-serve-20260930` ("Bound compiled fixture teardown independently of test assertions")
- **Baseline (assigned branch, not the target):** `5672ead2a526e07fea9ed11e58b3725e42013527`
- **Reviewer workspace:** read-only detached clone at `/tmp/rev-17/target` (`git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`).
  `/workspace/repo` was left on the assigned branch at `5672ead`, clean, unmodified.
- **Scope:** server resource acquisition, readiness/mutation gate, startup abort, and
  bind-failure reverse cleanup.
- **Files in scope at target:** `src/serve.ts`, `src/serve-command.ts`, `src/main.ts`,
  `src/cli.ts` (serve path), the parts of `src/coordinator.ts` that `startServer` calls
  (`recover`, `startProvisioning`, `stop`, `track`/`idle`), `src/runtime.ts`
  (`acquireProcessLock`, `eventLogger`), `src/http.ts`, `src/config.ts` port validation,
  `docs/SERVE.md`, `tests/serve.test.ts`, `tests/fixtures/serve-command-child.ts`.
- **Verdict: FINDINGS** (1 MEDIUM reproduced, 3 LOW code-evidenced).

## Verdict summary

The ordered acquisition/rollback design is sound and, importantly, correct on the paths it
advertises. I traced and probed every reverse-cleanup path (pre-abort, lock contention,
instance-owner mismatch, recovery failure, API bind failure, metrics bind failure, abort
during recovery, abort during the first provisioning pass, idempotent `stop()`), and I found
no leak of the process lock, the SQLite handle, or either listener in any of them. The
`while (this.idle) await this.idle` drain in `Coordinator.stop` plus `Promise.allSettled` over
`locks` does correctly keep the database open until tracked writers settle, and the
`abort`-after-`withAbort` window between `serve.ts:199` and `serve.ts:205` is *not* a race
because no `await` intervenes. Two gaps remain: the periodic event-log flush is the one
server-owned periodic task that is not error-guarded, and `/health` reports liveness while
the gate is still refusing all mutations.

## Findings

### F1 — MEDIUM — A throwing event-log flush escapes the 1 s interval and kills the process without the ordered release

- **File/line at target:** `src/serve.ts:193` (`logTimer = setInterval(flush, 1000);`), with
  the unguarded callback defined at `src/runtime.ts:176-212` (`eventLogger`) and the
  `try/finally` that protects only the *final* flush at `src/serve.ts:148-156`.
- **Concrete trigger:** any `fs` error while the periodic flush runs — `appendFileSync` /
  `renameSync` / `statSync` on `<DB_PATH>.log` failing with `EISDIR`, `EACCES`, `ENOSPC`,
  `EROFS`, quota exhaustion, the log file being replaced by a directory or a read-only mount,
  or `store.setting("logged_event", …)` failing. In practice: the disk or the volume backing
  the event log fills up, or the event-log path is remounted read-only while the server runs.
- **Consequence:** the exception propagates out of the `setInterval` callback, so it is never
  observed by `runServe`. The process dies from an uncaught exception with a raw Node-style
  message/stack on stderr — **not** through `release()` — so on that exit path the readiness
  gate is not closed, the API and metrics listeners are not stopped by SwarmForge, the SQLite
  handle is not closed, the event log is not given a final flush, the lock file is not
  unlinked, and the message is never passed through `commandRedactor`. The redactor guarantee
  in `docs/SERVE.md:59` ("Every line the command reports is redacted first") does not hold for
  this output. The OS does release the `flock` on exit, so the next start recovers (the stale
  file is claimed as an unowned lock, `src/runtime.ts:151-157`), which is why this is MEDIUM
  and not HIGH — but it converts an ordinary, recoverable I/O fault into an abrupt,
  unreported, out-of-band termination during which unflushed events and the log file are lost.
- **Reproduction (reproduced, exit code 42 from the probe's own `uncaughtException` hook):**
  probe `/tmp/rev-17/probes/logflush2.ts` — seeds one queued worker with the repo's own
  `FakeProvider`/`FakeAgent` test helpers, creates a **directory** at `<db>.log`, then calls
  `startServer` from a scratch clone. The first interval tick throws:

  ```
  started http://127.0.0.1:18897 health 200
  01:42:18  requested  w-b555aec9-…  team/task  vm=vm-w-b555aec9-…
  UNCAUGHT: Error EISDIR: illegal operation on a directory, open '/tmp/…/db.sqlite.log'
  EXIT=42
  ```

  Note the server was serving (`/health` → 200) immediately before the crash, and it never
  reached the ordered teardown. An earlier probe (`/tmp/rev-17/probes/logflush.ts`) that made
  the same target unwritable but had no pending events did **not** crash — the fault needs at
  least one unflushed event, which is the normal state of any busy server.
- **Why existing guards/tests do not prevent it:**
  1. `release()` guards only the *one-shot* final flush (`try { flush?.() } finally { … }`,
     `src/serve.ts:148-152`). The periodic callback registered at `src/serve.ts:193` is the
     bare `flush` with no wrapper and no `try/catch`.
  2. Neither `serve-command.ts` nor `main.ts` installs an `uncaughtException` or
     `process.on("error")` handler, and `runServe` only awaits `startServer` and `exited` —
     an interval callback throw is not part of either promise.
  3. `Coordinator.stop()`/`track`/`idle` correctly protect *coordinator-owned* writes
     (`src/coordinator.ts:255-275`, `292-300`), but `eventLogger`'s flush is not tracked at
     all: it calls `c.store.events(...)` and `c.store.setting(...)` directly, so it is not
     covered by the drain guarantee either.
  4. `tests/serve.test.ts` never exercises a failing flush, so the suite is green
     (20/20 pass at target) with this path unrepresented.
- **Recommended correction:** register a guarded callback instead of the raw function, and
  route failures through the same reporting path as the rest of the command, e.g.
  `logTimer = setInterval(() => { try { flush(); } catch (error) { /* report redacted; count it */ } }, 1000)`.
  If a persistent event-log fault should be fatal, it should go through one bounded ordered
  shutdown (`shutdown()` is already idempotent) rather than an uncaught throw, so the lock,
  listeners and database are still released in reverse order and the message is redacted.

### F2 — LOW — `/health` answers 200 for the whole first provisioning pass while every mutation is refused

- **File/line at target:** gate `src/serve.ts:33` (`readOnlyMethods`) and `src/serve.ts:55-59`;
  the window is created by binding the listeners at `src/serve.ts:170-191` and awaiting
  `startProvisioning()` at `src/serve.ts:194` before `gate.open()` at `src/serve.ts:203`.
  `/health` is served from the wrapped handler at `src/http.ts:33`.
- **Concrete trigger:** normal startup with at least one worker in `queued` state (the common
  case after a restart with a seeded queue, or any `spawn_worker` already persisted). The
  gate stays in `starting` for the entire duration of the first `tick()`.
- **Consequence:** during that window `GET /health` → `200 {"status":"ok"}` while `POST /mcp`
  → `503` for *every* tool, including `spawn_worker` and `get_worker`. A deployment that uses
  `/health` as its readiness probe (the only liveness endpoint the server publishes) marks
  the instance ready and routes traffic to a process that refuses all mutations. The window
  is not small: the first pass can provision up to `SWARMFORGE_MAX_PROVISIONING` (default 4)
  workers, each `provider.createWorker` call bounded by `SWARMFORGE_API_TIMEOUT_MS`
  (default 30 000 ms, `src/coordinator.ts:41-59`, `457`), so a slow Freestyle can hold the
  gate closed for ~2 minutes by default.
- **Reproduction / trace:** the existing test
  `tests/serve.test.ts:432` ("listeners are reserved before provisioning, refuse mutations
  until ready…") already asserts exactly `{ mutation: 503, health: 200 }`, so the behaviour is
  confirmed at target; I did not need a new probe. The arithmetic above is from
  `src/coordinator.ts:444-470`.
- **Why existing guards/tests do not prevent it:** the gate is intentionally a
  *mutation* gate (documented at `docs/SERVE.md:42`) and the assertion above pins the current
  behaviour as correct, so nothing flags it. There is no separate readiness signal for a
  supervisor to use.
- **Recommended correction (optional, design-level):** keep refusing mutations, but either
  report readiness distinctly — e.g. `503` with a `Retry-After` on `/health` while
  `gate.state === "starting"`, or a dedicated `/ready` that only answers `200` after
  `gate.open()` — or move the `gate.open()` call before `await startProvisioning()` so the
  window covers only the listener reservation, which is what the port-conflict guarantee in
  `docs/SERVE.md:36` actually needs.

### F3 — LOW — Shutdown order in the code is the reverse of the documented order

- **File/line at target:** `src/serve.ts:141-142`; contradicted by `docs/SERVE.md:48`
  ("Stop admission: the readiness gate closes, then the log interval is cleared").
- **Concrete trigger:** every `stop()` and every rollback path.
- **Consequence:** cosmetic only — `clearInterval` runs one statement before `gate.close()`,
  so an event produced by a request that the gate admits in that sliver is still flushed by
  the final `flush()` at `src/serve.ts:149`. No leak, no data loss; the risk is that a future
  change relies on the documented order ("stop admitting first, then stop logging") and
  inverts the real one.
- **Reproduction / trace:** `src/serve.ts:140-142` vs `docs/SERVE.md:48`. Nothing at target
  fails because of it.
- **Why existing guards/tests do not prevent it:** the suite asserts end states (lock gone,
  handles closed, log contains `worker.requested` — `tests/serve.test.ts:527-590`), never the
  relative order of the two statements.
- **Recommended correction:** swap the two statements in `release()` to match the documented
  order (or amend the doc). Swapping is the safer direction, since it makes the real code
  admit nothing before it stops logging.

### F4 — LOW — A second termination signal is swallowed; only the deadline can end a stuck drain

- **File/line at target:** `src/serve-command.ts:111-113` (`if (requested) return;`).
- **Concrete trigger:** a shutdown already in progress that is blocked draining (e.g. a
  Freestyle/OpenCode call that has not settled) and an operator pressing Ctrl-C again, or a
  supervisor escalating SIGINT → SIGKILL on its own schedule.
- **Consequence:** the process keeps running until `SWARMFORGE_SHUTDOWN_TIMEOUT_MS`
  elapses (default 60 000 ms, `src/serve-command.ts:9`) and then exits `70`. An operator has
  no in-process way to escalate, so the practical exit is a much longer wait than the operator
  expects or an external `SIGKILL`, which would truncate a write the deadline path
  deliberately avoids.
- **Reproduction (probed, behaviour confirmed correct-for-its-design):** probe
  `/tmp/rev-17/probes/signal-matrix.ts` spawns the repo's own
  `tests/fixtures/serve-command-child.ts` in `blocked` mode (a `createWorker` promise that
  never settles) with `SWARMFORGE_SHUTDOWN_TIMEOUT_MS=400`, then signals it three ways:

  ```
  [one SIGTERM, 400ms deadline]            exit=70 elapsed=650ms  stderr="Shutdown deadline exceeded…"
  [SIGTERM x2, 400ms deadline]             exit=70 elapsed=747ms  stderr="Shutdown deadline exceeded…"
  [SIGTERM + SIGINT, 400ms deadline]       exit=70 elapsed=744ms  stderr="Shutdown deadline exceeded…"
  ```

  All three behave identically and correctly: the second signal changes nothing and the
  deadline forces `70` with durable state intact. I am reporting this as an operational sharp
  edge, not a correctness bug — the documented contract (`docs/SERVE.md:57`, `65`) is met.
- **Why existing guards/tests do not prevent it:** `tests/serve.test.ts:892` only signals
  once, so the "second signal" case is untested and unreported by design.
- **Recommended correction (optional):** accept a second signal of the *other* kind, or a
  third signal, as an immediate `process.exit(forcedShutdownExitCode)` — the deadline path
  already exits with the database open, so honouring an explicit second request adds no new
  truncation risk and matches operator expectation.

## Checks that came back clean (no finding raised)

- **Reverse cleanup on every bind/recovery failure.** Traced and covered by passing tests:
  pre-aborted signal (`src/serve.ts:120`), lock contention (`:161`), instance-owner mismatch
  (`:163-166`), recovery failure (`:168`), API bind failure (`:170`), metrics bind failure
  (`:179`), event-logger construction failure (`:192`). In all cases the catch at
  `src/serve.ts:195-198` runs the memoised `release()` and both listeners are freed, the lock
  file is unlinked and no SQLite descriptor survives.
- **Metrics port collision with the API port** is rejected at configuration time
  (`src/config.ts` `superRefine`), so the two-listener rollback is only reachable for a
  genuinely occupied foreign port.
- **Abort after the last `withAbort` but before `gate.open()`** (`src/serve.ts:199-205`) is
  *not* a lost-abort race: no `await` occurs between the `signal.aborted` check and
  `addEventListener`, so an abort cannot slip through, and the later listener plus
  `runServe`'s `if (requested)` branch cover the post-return case.
- **`withAbort` does not leak an unhandled rejection** — `src/serve.ts:92-95` attaches both
  fulfilment and rejection handlers, and the discarded branch of the race can never reject.
- **The idle-drain loop cannot spin or hang on a settled `idle`** — `while (this.idle) await
  this.idle` (`src/coordinator.ts:296`) re-reads the field, and `track` only installs a fresh
  promise when `inFlight` was 0.
- **Double release is impossible** — `shutdown()` memoises the promise
  (`src/serve.ts:158`) and `stop()` returns that same promise, so `handle.stop()` in a
  `finally` after an aborted startup cannot release twice.
- **HTTP-only mutations are covered by the gate** — the MCP surface is `POST` only
  (`src/http.ts:54-62`), `GET`/`DELETE` on `/mcp` are 405, and `/health` and `/events` are
  read-only, so treating `GET`/`HEAD`/`OPTIONS` as safe while `starting` does not admit a
  mutation.
- **Config supersedes the serve entry points:** `src/main.ts` and `src/cli.ts:191-205` both
  only `await import("./serve-command")` after the settings resolve, so a rejected
  configuration acquires no lock, opens no database and binds no listener.

## Tests and probes actually run

Toolchain: the snapshot `bun` is 1.3.14 and cannot read this `lockfileVersion: 2` lockfile, so
official Bun 1.4.2 was unpacked to `/tmp/bun142/bun-linux-x64/bun` (outside the checkout). The
lockfile was not rewritten; `bun install --frozen-lockfile` was run only in the `/tmp` clone.

| Command (in `/tmp/rev-17/target`) | Exit | Result |
| --- | --- | --- |
| `/tmp/bun142/bun-linux-x64/bun install --frozen-lockfile` | 0 | 125 packages installed |
| `/tmp/bun142/bun-linux-x64/bun test tests/serve.test.ts` | 0 | **20 pass, 0 fail**, 111 expect() calls, 4.38 s |
| `/tmp/bun142/bun-linux-x64/bun run tsc --noEmit` | 0 | no type errors |
| `/tmp/bun142/bun-linux-x64/bun run /tmp/rev-17/probes/logflush2.ts` | 42 | **F1 reproduced** (uncaught `EISDIR` from the flush interval) |
| `/tmp/bun142/bun-linux-x64/bun run /tmp/rev-17/probes/logflush.ts` | 0 | control: no pending events ⇒ no crash |
| `/tmp/bun142/bun-linux-x64/bun run /tmp/rev-17/probes/signal-matrix.ts` | 0 | F4 confirmed: exit 70 in all three signal patterns |

Log: `/workspace/.swarmforge/logs/rev17-serve-test.log`, `/workspace/.swarmforge/logs/rev17-tsc.log`.

Reviewer probes live only in `/tmp/rev-17/probes/` (outside the source checkout), use the
repo's own `FakeProvider`/`FakeAgent` helpers and throwaway SQLite files under
`/tmp/sf-*`, and never contact a real provider, model endpoint, or infrastructure. No real
credentials appear in this report; the config objects used the placeholder strings from the
repository's own test fixtures.

## Limitations of this review

- Only `tests/serve.test.ts` was executed, plus `tsc --noEmit`. The full `bun test` suite was
  not run (out of scope for a single reviewer) and `biome check` was not run.
- Findings were sought only in the assigned scope; `src/cli/*`, `src/settings/*`,
  `scripts/*`, the packaging/release workflow, git handoff, safety and redaction internals
  were read only where they intersect startup (`resolveServerSettings`, the serve command
  wiring) and were not audited.
- F1 was reproduced with a deliberately corrupted log target. I did not attempt to
  reproduce the equivalent via a full disk or a read-only remount, so the ENOSPC/EACCES
  variants remain code-evidenced rather than reproduced.
- F4's 30 s first probe reported a misleading exit code from my own harness; I re-ran it as
  the controlled three-scenario matrix quoted above, which is the result I trust.
- Startup-abort timing was assessed by code trace plus the repository's own blocking-provider
  tests rather than by fuzzing the signal window; the `serve.ts:199-205` window is provably
  not yieldable in a single-threaded runtime.
- `git.status` of `/workspace/repo` was checked before and after and remained clean at the
  assigned baseline `5672ead`; no source file was modified anywhere.

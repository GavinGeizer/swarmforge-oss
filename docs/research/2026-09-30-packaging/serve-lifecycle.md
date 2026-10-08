# SwarmForge `serve` command and runtime lifecycle architecture (research)

- Date 2026-09-30. Repo `/workspace/repo`, commit `5672ead2a526e07fea9ed11e58b3725e42013527`, branch `swarmforge/packaging-research-20260930/serve-lifecycle/w-f6f7cc4e-8010-437b-b64e-dcbf1a1495f6`. `git status` clean before and after; no commits, no repo files changed.
- Experiment host: Ubuntu 24.04.5, Linux 6.1.102 x86_64, systemd 255 (255.4-1ubuntu8.17), Bun 1.3.14.
- No credentials here. No services installed, no releases, no live infrastructure touched.

## 1. Decision

**One unified `swarmforge` CLI; its new `serve` subcommand runs the server in the FOREGROUND under external supervision (systemd). No builtin daemon, no pidfile, no detach.**

Three linked choices:

1. **Module boundary.** Move the imperative body of `src/main.ts` into a new side-effect-free `src/serve.ts` exporting `startServer(overrides?) → ServerHandle` (`{ coordinator, store, api, metrics, stop() }`). `src/main.ts` becomes an `import.meta.main` wrapper. `src/cli.ts` (already `package.json:6` `bin.swarmforge`) dispatches `serve` to the same function, keeping `runCli(args)` and `status` behavior unchanged.
2. **Command UX.** `swarmforge serve` (foreground) plus `swarmforge serve --check-config`. No `--daemon` in v1. Future and non-installing: `swarmforge unit` prints a unit to stdout; the admin installs it.
3. **Backward compatibility.** `bun run dev`, `bun run start` (`bun src/main.ts`, package.json:10), `bun run status` keep working because `main.ts` remains a thin wrapper and `scripts` are untouched.

Why foreground wins:

- The code already *is* a foreground service: signal handlers (`src/main.ts:87-88`), idempotent shutdown (`src/main.ts:74-86`), and one JSON log line when stdout is not a TTY (`src/runtime.ts:41-49`) — the journal-native shape.
- Single-owner safety already comes from an advisory `flock` on `<db>.lock` (`src/runtime.ts:145-171`), which the kernel releases on any process death. E1/E2/E5 show the lock *file* survives SIGTERM/SIGKILL/port-conflict death and the successor still acquires it (E3; `tests/process-lock.test.ts:118-139`). The crash-consistency problem a daemon would solve is already solved; a pidfile adds a weaker mechanism beside a correct one.
- systemd supplies restart policy, `TimeoutStartSec=`/`TimeoutStopSec=`, ordering, cgroups, and journal capture. A builtin daemon would re-implement all of it (spawn + detach + pidfile + log redirection + stop/status/restart + orphan reaping) on top of a process whose only durable state is a SQLite file a second supervisor could corrupt.

## 2. Alternatives and tradeoffs

| Option | Upside | Why not now |
|---|---|---|
| **A. Foreground `serve` + systemd (recommended)** | Smallest new code; reuses proven signal/rollback paths; no PID-reuse hazard; inspectable unit text | Needs systemd (or Docker/K8s); SwarmForge does not install it |
| B. Builtin daemon (`serve --daemon`, pidfile in `StateDirectory`, `serve stop/restart/status`) | Works on laptops/macOS with no init system | pidfile-vs-PID-reuse race (stop-by-PID can hit the wrong process); two supervisors racing `Restart=`; stdout/stderr redirection must be rebuilt and loses journal metadata; orphan reparenting; much harder to test; zero crash-safety gain over `flock`. Revisit only for a real "no init system" need — reusing the same `startServer()` |
| C. Separate `swarmforge-server` entrypoint beside the client CLI | Smaller client binary; clean type graph | Two binaries, two dispatch paths, confusing `which swarmforge`. Justified only if compiled CLI size/startup is measured to matter; still extract `src/serve.ts` |
| D. `Type=notify` + `sd_notify` readiness | Manager knows exactly when startup finished; `EXTEND_TIMEOUT_USEC=` | Needs libc FFI (feasible via `bun:ffi`, `src/runtime.ts:1`) plus real readiness semantics. `Type=simple` + `/ready` in `ExecStartPost=` suffices |

(Hot reload is already `scripts.dev` (package.json:9) and must never apply to `serve`.)

## 3. Current-code evidence (file:line at `5672ead`)

`src/main.ts` (88 lines, entirely top-level):

- `:10-12` `loadConfig()` at import; `:memory:` DB rejected by throwing at import.
- `:13` `acquireProcessLock(`${db}.lock`)` at import — **importing this module takes a global side-effect lock**.
- `:14-18` `Store` opened at import; `instance_id` mismatch throws at import.
- `:19-24` providers constructed at import, pulling Freestyle/OpenCode SDKs into any importer's graph.
- `:25-38` the **only** rollback: `coordinator.start()` failure closes the store, releases the lock, prints one JSON `level:"error"` line, `process.exit(1)`.
- `:39-45` API `Bun.serve` at import, outside any try/catch — port conflict throws unhandled (E1).
- `:46-60` metrics `Bun.serve` starts *after* the API listener is live; a metrics-port conflict also throws unhandled, while already serving.
- `:61-62` `setInterval(flush, 1000)` event-log timer. `:63-73` single startup log line (JSON when not a TTY, `src/runtime.ts:32-57`).
- `:74-86` `shutdown()`: `closing` flag for idempotency, `app.stop(true)`/`metricsServer?.stop(true)` force-close, then `coordinator.stop()`, `flush()`, `store.close()`, `unlock()`, `process.exit(0)`. **No deadline** around `coordinator.stop()`.
- `:87-88` signal handlers installed **last**; anything hanging before line 87 is unreachable by shutdown (E2).

`src/runtime.ts`:

- `:106-135` `flock` via `bun:ffi` `dlopen`, resolved **lazily on first lock attempt**; throws `"Advisory file locking is unavailable on this platform"` if nothing loads.
- `:109-116` candidate libraries are x86_64/glibc/musl/darwin only — no `/lib/aarch64-linux-gnu/libc.so.6`, no `libc.musl-aarch64.so.1`.
- `:145-171` `acquireProcessLock`: `O_RDWR|O_CREAT|O_NOFOLLOW`, `LOCK_EX|LOCK_NB`, then an inode-identity re-check (`:136-144`) with up to 8 retries against file-replacement; writes its pid (`:160`) **as a diagnostic only**; release idempotent (`:162-170`). The pid is never read for liveness, so a stale file cannot wedge startup.
- `:172-213` `eventLogger` rotates the `.log` at 1 MiB, writes `0600`, uses `console.log` for human lines and a file for JSON lines.

`src/coordinator.ts`: `:243-250` `start()` = `await recover()`, arm poll timer, one `tick()`; `:37-55` `bounded()` caps external calls at `SWARMFORGE_API_TIMEOUT_MS` (default 30000, `.env.example`); `:251-255` `stop()` = `stopped = true`, `clearInterval`, `await Promise.allSettled([...this.locks.values()])` — shutdown duration is unbounded from a supervisor's view.

`src/http.ts` / `src/metrics.ts`: `:33` `GET /health` returns `{"status":"ok"}` unconditionally once the listener exists — it ignores reconciliation state and the metrics listener; `:9-19` host allowlist and `:20-32` bearer/origin checks precede it, so local probing is safe. `src/metrics.ts:5-132` renders a fresh `Registry` per scrape from SQLite, so there is no metrics background poller in the shutdown path.

Packaging surface: `package.json:6` `bin.swarmforge → ./src/cli.ts` (one binary today, the *client*); `package.json:9-11` `dev`/`start`/`status`; `src/cli.ts:19-42` hand-rolled parser that shifts a leading `status` and rejects anything unknown (dispatch `serve` **before** it, preserving unknown-argument errors); `src/cli.ts:80` already uses `import.meta.main`. `docs/` has no daemon/serve/packaging content; the only systemd material is the guest-side worker unit written into each VM (`src/providers/freestyle.ts:172-178`).

## 4. Official sources (dated / versioned)

- Bun single-file executables, <https://bun.com/docs/bundler/executables> (fetched 2026-09-30): `bun build --compile --outfile`; targets `bun-linux-x64`, `bun-linux-arm64`, `bun-linux-x64-musl`, `bun-linux-arm64-musl`; `Bun.isStandaloneExecutable`; `.env`/`bunfig.toml` autoload enabled by default while `package.json`/`tsconfig.json` autoload are disabled; `BUN_OPTIONS` honored at runtime. Implication: a compiled binary cannot rely on `package.json`/`tsconfig.json` at runtime, and the FFI `dlopen` path (`src/runtime.ts:118-135`) stays lazy, so it is not resolved at build time.
- systemd: canonical pages <https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html> and `.../systemd.exec.html` returned HTTP 418 to this sandbox, so facts come from the **authoritative local man pages for systemd 255** (`/usr/share/man/man5/systemd.service.5.gz`, `.TH "SYSTEMD.SERVICE" "5" "" "systemd 255"`):
  - `Type=notify` — "it is expected that the service sends a `READY=1` notification message via `sd_notify(3)` … systemd will proceed with starting follow-up units after this notification message has been sent." `NotifyAccess=` — "If `NotifyAccess=` is missing or set to `none`, it will be forcibly set to `main`."
  - `TimeoutStopSec=` — "If no `ExecStop=` commands are specified, the service gets the `SIGTERM` immediately. This default behavior can be changed by `TimeoutStopFailureMode=` … Second, it configures the time to wait for the service itself to stop. If it doesn't terminate in the specified time, it will be forcibly terminated by `SIGKILL` … Defaults to `DefaultTimeoutStopSec=` … Pass `infinity` to disable the timeout logic." systemd 255 also documents `EXTEND_TIMEOUT_USEC=` for `Type=notify`/`notifyreload`.
  - `Restart=`/`RestartSec=`/`RestartSteps=`/`RestartPreventExitStatus=` live in the same page: restart policy is a unit-file concern, not an application one.

## 5. Prioritized gaps

**P0 — before any `serve` command ships**

- **G1. Import side effects.** `src/main.ts` is unimportable by tests: importing it loads config, takes the process lock, opens SQLite, binds ports, arms timers. Extract to `src/serve.ts` with `startServer()`; `main.ts` keeps an `import.meta.main` wrapper. Until this lands nothing below is unit-testable.
- **G2. No rollback on listener bind failure.** `src/main.ts:39-45`, `:47-60` throw outside any try/catch. E1: exit 1, raw stack, lock file and store left, no JSON error (contrast the deliberate JSON error at `:30-36`). Fix with one try/catch plus a LIFO teardown registry so `store.close()`+`unlock()` run on every path.
- **G3. Signals registered too late.** `src/main.ts:87-88`. E2: SIGTERM during `coordinator.start()` exits 143 with no cleanup. `start()` awaits `recover()` plus a `tick()` of bounded provider calls, so the window is seconds. Install handlers first, with a phase flag (`starting` vs `serving`).
- **G4. Metrics bind failure is partial serving.** `:47-60`: the API listener already accepts traffic when the metrics bind can throw. Share G2's rollback; bind both before anything is announced ready.

**P1 — required for correct supervised operation**

- **G5. Shutdown has no deadline.** `:81` awaits `coordinator.stop()` → `coordinator.ts:251-255` awaits every in-flight worker lock, bounded only by `SWARMFORGE_API_TIMEOUT_MS`. E5b: still alive 8s after SIGTERM; systemd would `SIGKILL` at `TimeoutStopSec=`, skipping `flush()`/`store.close()`/`unlock()`. Fix: `Promise.race` with `SWARMFORGE_STOP_DEADLINE_MS` (default 20000) then `process.exit(3)`; ship `TimeoutStopSec=` above it.
- **G6. Silent early exit mid-shutdown.** E5: when the pending shutdown promise has no live handle the process exits **before** `store.close()`/`unlock()`, leaving the lock file, while looking successful. Teardown must be re-entrant and independent of event-loop liveness; unlock last, do synchronous final steps after the awaits.
- **G7. Health is not readiness.** `src/http.ts:33` returns ok during reconciliation and with metrics down. Add `/ready` (503 until recovery completes and both listeners are bound), keep `/health` liveness-only, gate `ExecStartPost=` (or a future `Type=notify`) on `/ready`.
- **G8. `flock` FFI portability.** `src/runtime.ts:109-116` lacks aarch64 names while Bun ships arm64 and arm64-musl targets. E0: bare `"libc.so.6"` resolves via the loader on this glibc host and every musl/darwin candidate fails as expected — the list works for glibc x86_64 but would throw on Alpine/aarch64. Add aarch64 candidates plus a documented target matrix, or a non-FFI fallback (`O_CREAT|O_EXCL` takeover) so an arm64/musl artifact cannot fail to boot.

**P2 — hygiene, not blocking**

- **G9. Keep the pid write diagnostic-only** (`src/runtime.ts:160`). `tests/process-lock.test.ts:118-139` proves why: a leftover file with garbage, a dead pid, or this process's own pid number must all still acquire.
- **G10. DB ownership is per-process-per-file**, enforced only by `flock` + `instance_id` (`:15-18`). Document "one unit per `SWARMFORGE_DB_PATH`"; use systemd `StateDirectory=`/`RuntimeDirectory=` so lock, `.log`, and SQLite live under `/var/lib/swarmforge`.
- **G11. Service installation is future scope.** When it lands: `swarmforge unit` printing to stdout, never writing `/etc/systemd/system`, plus documented hardening (`User=`, `NoNewPrivileges=`, `ProtectSystem=strict`, `ReadWritePaths=`, `Restart=on-failure`, `RestartSec=5`, `TimeoutStopSec=` ≥ G5 deadline, `KillSignal=SIGTERM`, `Type=simple`, `EnvironmentFile=`).

## 6. Implementation sequence

1. `src/serve.ts`, no import-time effects: `ServerHandle`, `startServer()`, `stopServer(handle, deadlineMs)`. Order: config → lock → store → `instance_id` → coordinator → bind API → bind metrics → arm logger → register signals → return handle.
2. Teardown registry: push `unlock()`, `store.close()`, `app.stop(true)`, `metricsServer?.stop(true)` as each is created; unwind in reverse on throw and emit the JSON error shape of `src/main.ts:30-36`. Bind both listeners before announcing readiness (fixes G2, G4).
3. Signals first, guarded by a single `closing` promise so repeated/mixed signals run teardown exactly once (fixes G3, preserves `:74-77`).
4. `src/main.ts` → `import { startServer } from "./serve"; if (import.meta.main) await startServer();` (keeps `bun src/main.ts`, `start`, `dev`).
5. `/ready` in `src/http.ts`; `/health` unchanged.
6. `src/cli.ts`: dispatch `serve` before `argumentsFor`; add `--check-config`; keep `status`, `--help`, `--json`, `--no-interactive` and exit codes 0/1 exactly as `:44-78`.
7. Stop deadline + `SWARMFORGE_STOP_DEADLINE_MS` in `config.ts` and `.env.example` (G5/G6).
8. FFI target matrix for aarch64 (G8).
9. Docs: `docs/OPERATIONS.md` with the unit as text and the one-unit-per-database rule; ENVIRONMENT.md stop-deadline note. The product installs nothing.

## 7. Acceptance tests (only possible after step 1)

New `tests/serve.test.ts`:

1. **No import side effects:** `await import("../src/serve")` creates no lock file, binds no port, leaves `SWARMFORGE_DB_PATH` untouched. (Fails today: importing `src/main.ts` takes the lock and binds.)
2. **API port conflict rolls back:** hold the port with a throwaway `Bun.serve`, call `startServer()` → typed startup error; assert lock file **absent**, store closed, no metrics listener bound, one JSON error line rather than a stack.
3. **Metrics port conflict rolls back:** free API port, hold metrics port → same assertions, and the API port must be free afterwards (today's partial-serving bug).
4. **SIGTERM before ready:** inject a `recover()` that never settles, `SIGTERM` the child → exits with the documented code within ~1s, lock released, no listener left (reproduces E2).
5. **Idempotent shutdown:** concurrent `SIGTERM`+`SIGINT` plus two direct `stopServer()` calls → teardown counter exactly 1.
6. **Stop deadline:** `coordinator.stop()` never resolves → exit with the documented code within `deadline + 1s` (reproduces E5b).
7. **Readiness:** `/health` 200 while serving; `/ready` 503 until recovery completes and both listeners bind, 200 after (deferred-promise fake).
8. **Signal lock handover:** `SIGKILL` a lock-holding child, then `startServer()` in the successor must acquire and start — the signal-based sibling of `tests/process-lock.test.ts:118`. Keep `:77`, `:118`, `:141` green.
9. **Backward compatibility:** `bun src/main.ts` logs the same startup line; `bun src/cli.ts status --help` prints the same usage text; `status --json` exit codes 0/1 unchanged (`src/cli.ts:71-77`).
10. **Gates:** `bun test` and `bun run check` (`tsc --noEmit && biome check src tests scripts`, package.json:13) stay green.

## 8. Experiments (all in `/tmp/sf-exp`, outside the repo)

Method: the checkout has **no `node_modules`** and `src/runtime.ts` transitively imports `zod` (`./security` → `./domain`), so it cannot be imported directly. I copied `src/runtime.ts` to `/tmp/sf-exp/sf/runtime.ts`, patched **only the two `import type` lines** (`./coordinator`, `./domain` → a local `coordtype.ts`) and stubbed `security.ts` (`redactorFor` is unused by the lock path). `flock` FFI, `acquireProcessLock`, and the `main.ts:10-88` ordering are verbatim; `lifecycle.ts` mirrors that ordering. `bun build --compile` against the real entrypoints was **not** run (needs dependencies in the checkout).

| ID | Command | Result |
|---|---|---|
| E0 | `bun run /tmp/sf-exp/dlopen-probe.ts` (dlopens each `src/runtime.ts:109-116` candidate) | bun 1.3.14 linux x64. `libc.so.6`, `/lib/x86_64-linux-gnu/libc.so.6`, `/usr/lib/x86_64-linux-gnu/libc.so.6` → OK; `libc.musl-x86_64.so.1`, `/lib/ld-musl-x86_64.so.1`, `libSystem.B.dylib` → FAIL. Bare names go through the dynamic loader; aarch64 names are absent from the list (G8) |
| E0b | `bun -e 'import { acquireProcessLock } from "/tmp/sf-exp/sf/runtime.ts"; ...'` | acquired; second acquire → `refused: Another SwarmForge process owns this database`; lock file gone after release — the real lock code works standalone |
| E1 | blocker `bun -e 'Bun.serve({hostname:"127.0.0.1",port:18790,...})'`, then `timeout -s KILL 15 bun run lifecycle.ts e2e /tmp/sf-exp/e1/lock 18790` | **exit=1**; raw JS stack on stderr, **not** JSON; lock file still present with stale pid `5535`; `unlock()`/`store.close()` never ran → G2 |
| E2 | `timeout -s KILL 20 bun run lifecycle.ts slow-start /tmp/sf-exp/e2/lock 18791 &`, `sleep 1.0`, `kill -TERM $P` | **exit 143** (128+SIGTERM, default disposition); lock file left with stale pid `5556` → SIGTERM in the pre-handler startup window kills without cleanup → G3 |
| E3 | `bun run lifecycle.ts e2e /tmp/sf-exp/e3/lock 18792`, `curl http://127.0.0.1:18792/`, `kill -TERM` | `GET / -> 200`; **exit=0**; lock file absent → the graceful path works and already unlinks the lock |
| E4 | as E3 then `kill -TERM; kill -TERM; kill -INT` back-to-back | **exit=0**; lock absent; stderr empty → the `closing` guard is idempotent under repeated/mixed signals today |
| E5 | `bun run lifecycle.ts hang-stop /tmp/sf-exp/e5/lock 18794`, `kill -TERM`, observe 6s | Process **exited silently before completing cleanup**; lock file remained → a shutdown stalled on a handle-less promise ends the process with `store.close()`/`unlock()` unrun, and looks successful → G6 |
| E5b | `bun run lifecycle.ts busy-stop /tmp/sf-exp/e5b/lock 18795` (stop awaits 30s of real work), `kill -TERM`, observe 8s | **still alive 8s after SIGTERM** (needed SIGKILL) → with in-flight work the process lingers up to the API timeout; under systemd `TimeoutStopSec=` that becomes SIGKILL mid-cleanup → G5 |

Not run: the metrics-port-conflict end-to-end attempt (E6 reused a free API port, measured the wrong thing, discarded); `bun build --compile` of `src/main.ts`/`src/cli.ts` (no `node_modules`); `dlopen` inside a compiled binary; real `sd_notify` over `bun:ffi`; any systemd unit (installation out of scope).

## 9. Residual uncertainty

- Compile-path behavior (`--compile`, arm64/musl targets, `.env` autoload, `Bun.isStandaloneExecutable`) comes from the cited Bun docs, not a real SwarmForge binary; missing `node_modules` blocked that under research-only constraints. Bundled-SDK size is unverified.
- `bun:ffi` `dlopen` inside a `bun build --compile` binary was not exercised (E0 used the interpreter); the call is lazy so it should be unaffected, but that is inference.
- arm64/musl `flock` failure is inferred from the candidate list plus E0's loader behavior on one glibc x86_64 host; not reproduced on Alpine.
- Shutdown timing under real load was simulated with a 30s synthetic await, so the recommended `TimeoutStopSec=` needs one measurement against the true `coordinator.stop()` path.
- `docs/OBSERVABILITY.md` and `docs/ARCHITECTURE.md` were skimmed for systemd/daemon references only.
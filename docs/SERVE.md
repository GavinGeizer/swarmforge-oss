# Server lifecycle

`serve.ts` owns one SwarmForge server: it acquires resources, reserves listeners, reconciles durable state and releases everything in reverse order. `serve-command.ts` owns process concerns — signals, logging and exit policy. `main.ts` is a guarded wrapper that loads the environment and returns the command's exit code.

## Interfaces

```ts
interface ServerHandle {
  url: string; // bound origin, for example http://127.0.0.1:8787
  stop(): Promise<void>; // idempotent; every call returns the same shutdown promise
}
startServer(config: Config, options?: {
  signal?: AbortSignal;
  provider?: WorkerProvider;
  agent?: CodingAgent;
}): Promise<ServerHandle>;
runServe(config: Config, options?: {
  provider?: WorkerProvider;
  agent?: CodingAgent;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}): Promise<number>;
```

`url` addresses the whole surface: `${url}/mcp` for the MCP endpoint, `${url}/health` for liveness, `${url}/events` for the SSE replay. The injected `provider` and `agent` exist so tests can run the real lifecycle deterministically; production passes none and gets the Freestyle and OpenCode adapters. `env`, `log` and `logError` are test seams for the command layer.

Importing either module starts nothing: no listener, no process lock, no timer, no signal handler, no `process.exit`. The command installs `SIGTERM`/`SIGINT` handlers before it calls `startServer`, so a signal that arrives during a long startup is still delivered.

## Startup order

1. Validate the database path. A signal that is already aborted acquires nothing at all.
2. Acquire the process lock on `<DB_PATH>.lock`.
3. Open SQLite and check the persisted `instance_id`. A different owner is refused and nothing is overwritten.
4. Build the coordinator and run recovery, so late-created and orphaned VMs are reconciled before any request is served.
5. Bind the API listener, then the metrics listener. Both ports are reserved before any periodic provisioning runs, so a port conflict is reported before a VM is requested.
6. Attach the event logger and its one-second flush interval.
7. Start periodic provisioning and wait for the first pass.

Any failure releases what was acquired, in reverse order: flush and stop the periodic logger, stop the metrics listener, stop the API listener, stop the coordinator (which drains), close SQLite, release the lock. The database is closed last, so a rollback never closes it while a recovery, tick or worker operation can still write. Recovery state that was already committed stays durable: an aborted startup does not undo an adopted orphan.

Until startup finishes, the wrapped HTTP handler answers liveness reads and refuses every mutating request with `503` and a `Retry-After` header. Mutation cannot race a coordinator that is still reconciling. After the first provisioning pass the gate opens and normal admission applies.

## Shutdown order

`handle.stop()` is a single shared promise:

1. Stop admission: the readiness gate closes, then the log interval is cleared.
2. Stop the API and metrics listeners, which ends new requests and closes SSE streams.
3. Stop the coordinator: the poll timer is cleared, in-flight `wait_for_state_change` waits are woken, and every tracked operation — recovery, tick, worker control — is drained to completion.
4. Flush the event log one last time, close SQLite, release the lock once.

Repeated `stop()` calls, and a stop after an aborted startup, all return the same promise and never release twice. Requests already inside a handler are not cancelled; the drain covers the writes the coordinator owns, and an in-flight read-only wait is woken rather than left polling a closing database.

## Command policy and exit codes

`SWARMFORGE_SHUTDOWN_TIMEOUT_MS` (positive integer, default `60000`) is a command concern and is not part of `Config`; an invalid value fails startup with exit code `1`. The first signal arms the deadline, including a signal that arrives while startup is blocked.

| Exit code | Meaning |
| --- | --- |
| `0` | Clean shutdown: drain finished, event log flushed, database closed, lock released. |
| `1` | Startup failed, or the shutdown timeout value is invalid. No listener is running. |
| `70` | The shutdown deadline elapsed. |

A deadline does not cancel a provider promise that cannot be cancelled. Instead the command reports the deadline and exits `70` with the database still open, so no write is truncated; durable intent stays in SQLite and the operating system releases the lock on exit. The lock file may remain with a stale PID, which the next startup handles as an unowned lock. `startServer` itself always drains; it never hard-exits. Only the command applies a deadline, because only the command can end a process that a caller still holds.

## Limitations

- The deadline bounds the process, not any individual provider call; a blocked Freestyle or OpenCode call simply outlives this process.
- In-flight HTTP requests are drained only to the extent the coordinator tracks them. A request doing unbounded external I/O of its own is closed with its connection.
- The shutdown sequence is not transactional. A process killed between the log flush and the lock release leaves a stale lock file, recovered on the next start.
- `SWARMFORGE_SHUTDOWN_TIMEOUT_MS` only affects the command. Embedded users of `startServer` choose their own deadline.
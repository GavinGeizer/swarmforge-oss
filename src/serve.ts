import type { Config } from "./config";
import { Coordinator } from "./coordinator";
import type { CodingAgent, WorkerProvider } from "./domain";
import { createHttpHandler } from "./http";
import { createMetricsHandler } from "./metrics";
import { FreestyleProvider } from "./providers/freestyle";
import { OpenCodeAgent } from "./providers/opencode";
import { acquireProcessLock, eventLogger } from "./runtime";
import { Store } from "./store";

// Importing this module must never start a server: no listener, no process lock, no timer,
// no signal handler and no process.exit. The serve command owns signals and exit policy.
export interface ServerHandle {
  // The bound origin, for example http://127.0.0.1:8787. MCP is served at `${url}/mcp`,
  // liveness at `${url}/health` and the SSE replay at `${url}/events`.
  url: string;
  // Idempotent: every call returns the same shutdown promise and nothing is released twice.
  stop(): Promise<void>;
}

export interface ServeOptions {
  signal?: AbortSignal;
  provider?: WorkerProvider;
  agent?: CodingAgent;
}

export interface StartupGate {
  fetch(request: Request): Promise<Response>;
  open(): void;
  close(): void;
}

const readOnlyMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function refusal(message: string) {
  return Response.json(
    { error: message },
    { status: 503, headers: { "retry-after": "5" } },
  );
}

// Wraps the existing HTTP handler instead of replacing it: before recovery has finished
// startup only answers liveness, and every mutating request is refused rather than racing a
// coordinator that is still reconciling durable state.
export function startupGate(
  handler: (request: Request) => Promise<Response>,
): StartupGate {
  let state: "starting" | "ready" | "closed" = "starting";
  return {
    async fetch(request) {
      if (state === "closed")
        return refusal(
          "SwarmForge is shutting down; retry against the next process",
        );
      if (
        state === "starting" &&
        !readOnlyMethods.has(request.method.toUpperCase())
      )
        return refusal("SwarmForge is starting; retry once recovery completes");
      return handler(request);
    },
    open() {
      state = "ready";
    },
    close() {
      state = "closed";
    },
  };
}

export function abortError(): Error {
  return Object.assign(new Error("Server startup aborted"), {
    name: "AbortError",
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// Startup observes the signal without pretending a noncancelable provider promise can be
// stopped: the rejected race releases what has already been acquired, and the caller decides
// how long the abandoned operation may keep running.
async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  let onAbort: (() => void) | undefined;
  try {
    const outcome = await Promise.race([
      operation.then(
        (value) => ({ aborted: false, value }) as const,
        (error: unknown) => ({ aborted: false, error }) as const,
      ),
      new Promise<{ aborted: true }>((resolve) => {
        onAbort = () => resolve({ aborted: true });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (outcome.aborted) throw abortError();
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function origin(host: string, port: number) {
  const name = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${name}:${port}`;
}

export async function startServer(
  config: Config,
  options: ServeOptions = {},
): Promise<ServerHandle> {
  const signal = options.signal;
  if (signal?.aborted) throw abortError();
  if (config.SWARMFORGE_DB_PATH === ":memory:")
    throw new Error("Use a persistent database path to start the server");

  const provider = options.provider ?? new FreestyleProvider(config);
  const agent = options.agent ?? new OpenCodeAgent(config);
  const lockPath = `${config.SWARMFORGE_DB_PATH}.lock`;
  let unlock: (() => void) | undefined;
  let store: Store | undefined;
  let coordinator: Coordinator | undefined;
  let gate: StartupGate | undefined;
  let api: ReturnType<typeof Bun.serve> | undefined;
  let metricsServer: ReturnType<typeof Bun.serve> | undefined;
  let flush: (() => void) | undefined;
  let logTimer: ReturnType<typeof setInterval> | undefined;
  let releasing: Promise<void> | undefined;

  // Resources are acquired in a fixed order and released in exactly the reverse one: lock,
  // SQLite, instance owner, recovery, listeners, event log. A later failure can never leave
  // an earlier resource held, and the database is closed only once every writer has settled.
  const release = async () => {
    if (logTimer) clearInterval(logTimer);
    gate?.close();
    await api?.stop(true);
    api = undefined;
    await metricsServer?.stop(true);
    metricsServer = undefined;
    await coordinator?.stop();
    try {
      flush?.();
    } finally {
      flush = undefined;
      store?.close();
      store = undefined;
      unlock?.();
      unlock = undefined;
    }
  };
  const shutdown = () => (releasing ??= release());

  try {
    unlock = acquireProcessLock(lockPath);
    store = new Store(config.SWARMFORGE_DB_PATH);
    const owner = store.setting("instance_id");
    if (owner && owner !== config.SWARMFORGE_INSTANCE_ID)
      throw new Error("Instance ID differs from persisted database owner");
    store.setting("instance_id", config.SWARMFORGE_INSTANCE_ID);
    coordinator = new Coordinator(config, store, provider, agent);
    await withAbort(coordinator.recover(), signal);
    gate = startupGate(createHttpHandler(coordinator));
    api = Bun.serve({
      hostname: config.SWARMFORGE_HOST,
      port: config.SWARMFORGE_PORT,
      maxRequestBodySize: 131072,
      fetch: gate.fetch,
      idleTimeout: 60,
    });
    if (config.SWARMFORGE_METRICS_ENABLED) {
      metricsServer = Bun.serve({
        hostname: "127.0.0.1",
        port: config.SWARMFORGE_METRICS_PORT,
        fetch: createMetricsHandler(coordinator),
      });
    }
    flush = eventLogger(coordinator, `${config.SWARMFORGE_DB_PATH}.log`);
    logTimer = setInterval(flush, 1000);
    await withAbort(coordinator.startProvisioning(), signal);
  } catch (error) {
    await shutdown();
    throw error;
  }
  if (signal?.aborted) {
    await shutdown();
    throw abortError();
  }
  gate.open();
  const onAbort = () => void shutdown();
  signal?.addEventListener("abort", onAbort, { once: true });
  const server = api;
  return {
    url: origin(config.SWARMFORGE_HOST, server?.port ?? config.SWARMFORGE_PORT),
    stop: shutdown,
  };
}

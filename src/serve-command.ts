import type { Config } from "./config";
import type { CodingAgent, WorkerProvider } from "./domain";
import { renderStartup } from "./runtime";
import { Redactor } from "./security";
import { isAbortError, type ServerHandle, startServer } from "./serve";

// Shutdown deadline for the command only. It bounds how long the process may stay alive
// after a signal; it is deliberately not part of the validated configuration.
export const defaultShutdownTimeoutMs = 60000;
// Exit code used when the deadline is reached. The database is deliberately left open, so
// the operating system, not this process, releases the process lock.
export const forcedShutdownExitCode = 70;

export interface ServeCommandOptions {
  provider?: WorkerProvider;
  agent?: CodingAgent;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

export function shutdownTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SWARMFORGE_SHUTDOWN_TIMEOUT_MS?.trim();
  if (!raw) return defaultShutdownTimeoutMs;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      "SWARMFORGE_SHUTDOWN_TIMEOUT_MS must be a positive integer of milliseconds",
    );
  return value;
}

// The command has a resolved configuration but no coordinator, so the deployment's own
// credentials are the secret set. Redactor.text also strips credentials embedded in any
// URL, so a provider or SDK error that echoes a request target cannot leak through it.
export function commandRedactor(config: Config) {
  // Reported lines are JSON, so a secret containing a character JSON escapes is also
  // redacted in its escaped form.
  const escaped = (secret: string) => {
    const json = JSON.stringify(secret);
    return json.startsWith('"') ? json.slice(1, -1) : secret;
  };
  return new Redactor(() =>
    [
      config.FREESTYLE_API_TOKEN,
      config.SWARMFORGE_MODEL_API_KEY,
      config.SWARMFORGE_API_TOKEN ?? "",
      config.SWARMFORGE_GIT_PUSH_URL ?? "",
    ].flatMap((secret) => [secret, escaped(secret)]),
  );
}

// Owns signals, logging and exit policy. Startup and shutdown order belong to startServer;
// this layer only decides when the process ends and what it reports.
export async function runServe(
  config: Config,
  options: ServeCommandOptions = {},
): Promise<number> {
  const redactor = commandRedactor(config);
  const sink = options.log ?? ((line: string) => console.log(line));
  const errorSink = options.logError ?? ((line: string) => console.error(line));
  // Every reported payload is redacted before it is serialized: a startup or shutdown error
  // from a provider, adapter or environment value may echo a live credential. Redacting the
  // values rather than the finished line also keeps the reported JSON well formed.
  const report = (payload: Record<string, unknown>) =>
    JSON.stringify(redactor.value(payload));
  const log = (payload: Record<string, unknown>) => sink(report(payload));
  const logError = (payload: Record<string, unknown>) =>
    errorSink(report(payload));
  let limit: number;
  try {
    limit = shutdownTimeoutMs(options.env);
  } catch (error) {
    logError({ level: "error", message: (error as Error).message });
    return 1;
  }
  const controller = new AbortController();
  let handle: ServerHandle | undefined;
  let requested: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const disarm = () => {
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
  };
  const stopAndExit = async () => {
    try {
      await handle?.stop();
      disarm();
      log({ level: "info", message: "Shutdown complete" });
      resolveExit?.(0);
    } catch (error) {
      disarm();
      logError({
        level: "error",
        message: "Shutdown failed while releasing server resources",
        error: (error as Error).message,
      });
      resolveExit?.(1);
    }
  };
  // The deadline is armed on the first signal, including one that arrives while startup is
  // still blocked: cancellation cannot bound a noncancelable provider promise, so the
  // process itself has to.
  const onSignal = (name: string) => {
    if (requested) return;
    requested = name;
    log({
      level: "info",
      message: "Shutdown requested",
      signal: name,
      timeout_ms: limit,
    });
    deadline = setTimeout(() => {
      // Durable intent and the lock file stay on disk: no database close, no partial write.
      logError({
        level: "error",
        message:
          "Shutdown deadline exceeded; exiting with durable state intact",
        signal: name,
        timeout_ms: limit,
      });
      process.exit(forcedShutdownExitCode);
    }, limit);
    if (handle) void stopAndExit();
    else controller.abort();
  };
  const onTerm = () => onSignal("SIGTERM");
  const onInterrupt = () => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInterrupt);
  try {
    handle = await startServer(config, {
      signal: controller.signal,
      provider: options.provider,
      agent: options.agent,
    });
    if (requested) {
      void stopAndExit();
      return await exited;
    }
    const bound = new URL(handle.url);
    // The banner is rendered text rather than a payload, so it is scrubbed as a string.
    sink(
      redactor.text(
        renderStartup(
          {
            host: config.SWARMFORGE_HOST,
            port: Number(bound.port || config.SWARMFORGE_PORT),
            metricsEnabled: config.SWARMFORGE_METRICS_ENABLED,
            metricsPort: config.SWARMFORGE_METRICS_PORT,
          },
          Boolean(process.stdout.isTTY),
        ),
      ),
    );
    return await exited;
  } catch (error) {
    disarm();
    if (isAbortError(error)) {
      // The signal cancelled startup; its rollback already released everything acquired.
      log({
        level: "info",
        message: "Startup cancelled; no SwarmForge listener is running",
        signal: requested,
      });
      return 0;
    }
    logError({
      level: "error",
      message: "Startup failed; no SwarmForge listener is running",
      error: (error as Error).message,
    });
    return 1;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
    disarm();
  }
}

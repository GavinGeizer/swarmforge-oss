// Embedded fixed inert controlled child runtime for hosted execution.
//
// Compiled-binary safe: this module is imported (not spawned as a file) by
// src/hosted-runtime.ts, so the code is embedded in the compiled binary and
// runs via `process.execPath` self-spawn with the SWARMFORGE_HOSTED_CHILD=1
// marker. No external Bun, no repo files, no $bunfs path dependency.
//
// src/cli.ts dynamically loads this hook before normal command parsing when
// the isolated provider child marker is present.
//
// Entry contract: env SWARMFORGE_HOSTED_CHILD=1 +
// SWARMFORGE_HOSTED_DURATION=<bounded ms>. Only input is the bounded
// duration; no secrets, shell, repo/model/env.
export const HOSTED_CHILD_ENV = "SWARMFORGE_HOSTED_CHILD";
export const HOSTED_CHILD_DURATION_ENV = "SWARMFORGE_HOSTED_DURATION";
export const HOSTED_CHILD_EXIT_PARENT_DEAD = 3;

export function isHostedChildRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[HOSTED_CHILD_ENV] === "1";
}

export function hostedChildDuration(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const durationMs = Number(env[HOSTED_CHILD_DURATION_ENV]);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > 3_600_000
  )
    throw new Error("controlled runtime requires a bounded duration_ms");
  return durationMs;
}

/** Runs the fixed inert workload; resolves the process exit code. Never returns. */
export async function runHostedChildRuntime(
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadableStream = process.stdin as NodeJS.ReadableStream,
): Promise<never> {
  let durationMs: number;
  try {
    durationMs = hostedChildDuration(env);
  } catch {
    console.error("controlled runtime requires a bounded duration_ms");
    process.exit(2);
  }
  let done = false;
  const finish = (code: number): never => {
    if (done) process.exit(code);
    done = true;
    clearTimeout(timer);
    process.exit(code);
  };
  // Parent-death watchdog: the supervisor spawns with piped stdin and holds
  // its end open. EOF/close means the parent is gone: fail closed.
  stdin.on("end", () => finish(HOSTED_CHILD_EXIT_PARENT_DEAD));
  stdin.on("close", () => finish(HOSTED_CHILD_EXIT_PARENT_DEAD));
  (stdin as NodeJS.ReadStream).resume?.();
  // A stdio-inherited launch gives no pipe to observe: refuse to run without
  // the parent-death watchdog.
  if ((stdin as NodeJS.ReadStream).isTTY === true) {
    console.error(
      "controlled runtime requires piped stdin for parent-death watchdog",
    );
    process.exit(2);
  }
  process.on("SIGTERM", () => finish(0));
  process.on("SIGINT", () => finish(0));
  // Absolute duration deadline: the child stops itself even if renewal/parent IPC fails.
  const timer = setTimeout(() => {
    // Inert probe: bounded arithmetic only, no I/O, no network, no secrets.
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc = (acc + i) % 997;
    if (acc === -1) console.log("unreachable");
    finish(0);
  }, durationMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  // Hold the event loop for the bounded window without busy-waiting.
  await Bun.sleep(durationMs);
  finish(0);
  throw new Error("unreachable");
}

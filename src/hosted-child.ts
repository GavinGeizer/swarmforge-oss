import { readFileSync } from "node:fs";
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
// Entry contract: marker, bounded duration and numeric Linux boot-clock
// authority deadlines; private stdin carries validated renewal deadlines.
// No secrets, shell, repository or arbitrary workload.
export const HOSTED_CHILD_ENV = "SWARMFORGE_HOSTED_CHILD";
export const HOSTED_CHILD_DURATION_ENV = "SWARMFORGE_HOSTED_DURATION";
export const HOSTED_CHILD_LEASE_ENV = "SWARMFORGE_HOSTED_LEASE_BOOT_MS";
export const HOSTED_CHILD_ABSOLUTE_ENV = "SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS";
export const HOSTED_CHILD_EXIT_PARENT_DEAD = 3;
export const HOSTED_CHILD_EXIT_LEASE_EXPIRED = 4;

/** Linux host-wide boot-time clock; /proc/uptime has 10ms resolution.
 * Bun hrtime/performance clocks have process origins and cannot cross IPC.
 */
export function hostedBootTimeMs(): number {
  const raw = readFileSync("/proc/uptime", "utf8").split(" ")[0];
  if (!raw || !/^\d+\.\d{2}$/.test(raw))
    throw new Error("No shared boot clock");
  const value = Math.round(Number(raw) * 1000);
  if (!Number.isSafeInteger(value))
    throw new Error("Invalid shared boot clock");
  return value;
}

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
  let lease = Number(env[HOSTED_CHILD_LEASE_ENV]);
  const absolute = Number(env[HOSTED_CHILD_ABSOLUTE_ENV]);
  let pending = "";
  let workload: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout>;
  const finish = (code: number): never => {
    done = true;
    stdin.removeAllListeners();
    clearTimeout(watchdog);
    clearTimeout(workload);
    process.exit(code);
  };
  const now = () => {
    try {
      return hostedBootTimeMs() + 10;
    } catch {
      return finish(HOSTED_CHILD_EXIT_LEASE_EXPIRED);
    }
  };
  const check = () => {
    if (done) return;
    const remaining = Math.min(lease, absolute) - now();
    if (remaining <= 0) finish(HOSTED_CHILD_EXIT_LEASE_EXPIRED);
    watchdog = setTimeout(check, remaining);
  };
  // Bounded numeric initial authority is fixed BEFORE spawn. No work starts
  // with missing/stale authority; startup or pipe buffering cannot grant time.
  const observed = now();
  if (
    !/^\d{1,16}$/.test(env[HOSTED_CHILD_LEASE_ENV] ?? "") ||
    !/^\d{1,16}$/.test(env[HOSTED_CHILD_ABSOLUTE_ENV] ?? "") ||
    !Number.isSafeInteger(lease) ||
    !Number.isSafeInteger(absolute) ||
    lease <= observed ||
    absolute <= observed ||
    lease > absolute ||
    absolute - observed > 3_600_000
  )
    finish(HOSTED_CHILD_EXIT_LEASE_EXPIRED);
  check();
  workload = setTimeout(() => {
    if (Math.min(lease, absolute) <= now())
      finish(HOSTED_CHILD_EXIT_LEASE_EXPIRED);
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc = (acc + i) % 997;
    if (acc === -1) console.log("unreachable");
    finish(0);
  }, durationMs);
  stdin.on("data", (chunk: Buffer | string) => {
    if (done) return;
    if (Buffer.byteLength(chunk) > 256 || pending.length + chunk.length > 256)
      finish(HOSTED_CHILD_EXIT_LEASE_EXPIRED);
    pending += chunk.toString();
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const match = /^(\d{1,16}) (\d{1,16})$/.exec(line);
      if (!match) return finish(HOSTED_CHILD_EXIT_LEASE_EXPIRED);
      const next = Number(match[1]);
      const end = Number(match[2]);
      const observed = now();
      if (
        !Number.isSafeInteger(next) ||
        !Number.isSafeInteger(end) ||
        next <= observed ||
        end <= observed ||
        next > end ||
        end - observed > 3_600_000 ||
        lease <= observed ||
        absolute !== end
      )
        finish(HOSTED_CHILD_EXIT_LEASE_EXPIRED);
      lease = next;
      clearTimeout(watchdog);
      check();
    }
  });
  stdin.on("end", () => finish(HOSTED_CHILD_EXIT_PARENT_DEAD));
  stdin.on("close", () => finish(HOSTED_CHILD_EXIT_PARENT_DEAD));
  stdin.on("error", () => finish(HOSTED_CHILD_EXIT_PARENT_DEAD));
  if ((stdin as NodeJS.ReadStream).isTTY === true) finish(2);
  (stdin as NodeJS.ReadStream).resume?.();
  process.on("SIGTERM", () => finish(0));
  process.on("SIGINT", () => finish(0));
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}

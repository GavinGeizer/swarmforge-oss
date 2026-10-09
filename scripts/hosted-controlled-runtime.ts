// Fixed inert controlled workload for hosted execution.
// No argv secrets, no shell, no repo/model/env access: the only input is a
// bounded duration in milliseconds. Parent-death IPC closure (stdin EOF) stops
// the child independently even if the supervisor dies.
const raw = process.argv[2];
const durationMs = Number(raw);
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs <= 0 ||
  durationMs > 3_600_000
) {
  console.error("controlled runtime requires a bounded duration_ms argument");
  process.exit(2);
}
let done = false;
const finish = (code: number) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  process.exit(code);
};
// Parent-death watchdog: the supervisor spawns the child with a piped stdin
// and holds its end open. EOF/close means the parent is gone, so stop
// immediately (fail closed). stdio "pipe" (never "inherit") is essential:
// only a pipe lets the child observe the parent's death.
process.stdin.on("end", () => finish(3));
process.stdin.on("close", () => finish(3));
process.stdin.resume();
// A stdio-inherited launch gives the child no pipe to observe, so refuse to
// run rather than execute without the parent-death watchdog.
if (process.stdin.isTTY === true) {
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
timer.unref?.();
// Hold the event loop for the bounded window without busy-waiting.
await Bun.sleep(durationMs);
finish(0);

export {};

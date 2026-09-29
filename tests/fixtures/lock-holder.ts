import { acquireProcessLock } from "../../src/runtime";

const [lockPath, barrier] = process.argv.slice(2);
if (!lockPath) throw new Error("usage: lock-holder <lock-path> [barrier]");

if (barrier) {
  const deadline = Date.now() + 15000;
  while (!(await Bun.file(barrier).exists())) {
    if (Date.now() > deadline) {
      console.log(JSON.stringify({ outcome: "timeout" }));
      process.exit(0);
    }
    await Bun.sleep(1);
  }
}

const attempt = (() => {
  try {
    return { unlock: acquireProcessLock(lockPath) };
  } catch (error) {
    return { error: (error as Error).message };
  }
})();

if ("error" in attempt) {
  console.log(JSON.stringify({ outcome: "refused", error: attempt.error }));
  process.exit(0);
}

console.log(JSON.stringify({ outcome: "acquired", pid: process.pid }));
await new Promise<void>((resolve) => {
  const stop = () => {
    attempt.unlock();
    resolve();
    process.exit(0);
  };
  process.stdin.on("data", (chunk) => {
    if (String(chunk).includes("release")) stop();
  });
  process.stdin.on("end", stop);
  process.stdin.on("error", stop);
});

// TEMPORARY repro (outside source) for the missing driver/child teardown in
// apps/cloud/test/hosted-runtime.integration.ts@692dcb4.
// Mirrors runDriver/withHarness: spawn a bounded Bun driver, then run the
// harness `finally` teardown WITHOUT killing the child, and show the child
// process is still alive after teardown (i.e. no cleanup on assert failure).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.env.SWARMFORGE_TEST_BUN ?? "bun";
const directory = await mkdtemp(join(tmpdir(), "sf-driver-leak-"));
// Bounded driver: announces readiness quickly then lingers like the real one.
const child = spawn(
  BUN,
  ["--no-env-file", "--config=/dev/null", "-e", "setTimeout(()=>process.stdout.write('{}\\n'),6000)"],
  { cwd: directory, env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] },
);
child.stdin!.end();
await new Promise((r) => setTimeout(r, 400));
assert.equal(child.exitCode, null, "driver should be running before simulated failure");

// Simulate withHarness finally teardown exactly as the test does (server close
// + mf.dispose + rm). The test never touches `child`, so it is NOT killed.
await rm(directory, { recursive: true, force: true });

let alive: boolean;
try {
  process.kill(child.pid!, 0);
  alive = true;
} catch {
  alive = false;
}
console.log(
  `LEAK_REPRO: after harness-style teardown, driver pid=${child.pid} alive=${alive} exitCode=${child.exitCode}`,
);
assert.equal(alive, true, "repro expects the driver to leak");
console.log("LEAK_REPRO_CONFIRMED: driver survives teardown because withHarness/run never kills it");

// Cleanup for the probe itself.
try {
  child.kill("SIGKILL");
} catch {}

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

function launch(
  duration = 3000,
  entry = new URL("../src/hosted-child-script.ts", import.meta.url).pathname,
  leaseMs = duration + 1000,
  authority: Record<string, string> = {},
) {
  const end = bootMs() + duration + 1000;
  const child = spawn(
    process.execPath,
    ["--no-env-file", "--config=/dev/null", entry],
    {
      env: {
        PATH: "/usr/bin:/bin",
        SWARMFORGE_HOSTED_DURATION: String(duration),
        SWARMFORGE_HOSTED_LEASE_BOOT_MS: String(
          Math.min(end, bootMs() + leaseMs),
        ),
        SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS: String(end),
        ...authority,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  return { child, exited, end };
}
function bootMs() {
  return Math.floor(
    Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000,
  );
}
function frame(leaseMs: number, end: number) {
  return `${Math.min(bootMs() + leaseMs, end)} ${end}\n`;
}
function stopped(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")[1]
      ?.startsWith("Z ");
  } catch {
    return true;
  }
}

test("real child expires while its parent's event loop is blocked", async () => {
  const { child, exited } = launch(3000, undefined, 400);
  try {
    await Bun.sleep(80);
    expect(stopped(child.pid!)).toBe(false);
    await Bun.sleep(100);
    const until = performance.now() + 800;
    while (performance.now() < until) {}
    expect(stopped(child.pid!)).toBe(true);
    expect(await exited).toBe(4);
  } finally {
    child.kill("SIGKILL");
  }
});

test("timely renewals preserve the full 31 second task", async () => {
  const { child, exited, end } = launch(31000, undefined, 2000);
  const start = performance.now();
  const renew = setInterval(() => child.stdin.write(frame(2000, end)), 500);
  try {
    expect(await exited).toBe(0);
    expect(performance.now() - start).toBeGreaterThanOrEqual(31000);
  } finally {
    clearInterval(renew);
    child.kill("SIGKILL");
  }
}, 35000);

for (const input of ["garbage\n", "1 2\n", "x".repeat(257)]) {
  test(`malformed renewal IPC fails closed: ${input.slice(0, 12)}`, async () => {
    const { child, exited } = launch();
    try {
      child.stdin.write(input);
      expect(await exited).toBe(4);
    } finally {
      child.kill("SIGKILL");
    }
  });
}

test("buffered initial authority expires before delayed runtime startup", async () => {
  const entry = `import { runHostedChildRuntime } from ${JSON.stringify(new URL("../src/hosted-child.ts", import.meta.url).pathname)}; await Bun.sleep(700); await runHostedChildRuntime();`;
  const path = `/tmp/swarmforge-child-start-delay-${process.pid}.ts`;
  await Bun.write(path, entry);
  const { child, exited } = launch(3000, path, 300);
  try {
    expect(await exited).toBe(4);
  } finally {
    child.kill("SIGKILL");
  }
});

test("late renewal never reopens an expired child", async () => {
  const { child, exited, end } = launch(3000, undefined, 250);
  try {
    await Bun.sleep(600);
    child.stdin.write(frame(2000, end));
    expect(await exited).toBe(4);
  } finally {
    child.kill("SIGKILL");
  }
});

test("missing initial authority refuses work at startup", async () => {
  const { child, exited } = launch(3000, undefined, 3000, {
    SWARMFORGE_HOSTED_LEASE_BOOT_MS: "",
  });
  try {
    expect(await exited).toBe(4);
  } finally {
    child.kill("SIGKILL");
  }
});

test("parent EOF stops the leased real child", async () => {
  const { child, exited } = launch();
  try {
    await Bun.sleep(100);
    child.stdin.end();
    expect(await exited).toBe(3);
  } finally {
    child.kill("SIGKILL");
  }
});

test("buffered renewal cannot reopen a lease when child callbacks were delayed", async () => {
  const path = `/tmp/swarmforge-child-renew-delay-${process.pid}.ts`;
  await Bun.write(
    path,
    `import { runHostedChildRuntime } from ${JSON.stringify(new URL("../src/hosted-child.ts", import.meta.url).pathname)}; setTimeout(() => { const end = performance.now() + 700; while (performance.now() < end) {} }, 100); await runHostedChildRuntime();`,
  );
  const { child, exited, end } = launch(3000, path, 350);
  try {
    await Bun.sleep(450);
    child.stdin.write(frame(2000, end));
    expect(await exited).toBe(4);
  } finally {
    child.kill("SIGKILL");
  }
});

for (const lease of ["garbage", "1", "-1"]) {
  test(`invalid initial numeric authority refuses work: ${lease}`, async () => {
    const { child, exited } = launch(3000, undefined, 3000, {
      SWARMFORGE_HOSTED_LEASE_BOOT_MS: lease,
    });
    try {
      expect(await exited).toBe(4);
    } finally {
      child.kill("SIGKILL");
    }
  });
}

test("a real child completes its full duration under valid initial authority", async () => {
  const started = performance.now();
  const { child, exited } = launch(300);
  try {
    expect(await exited).toBe(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
  } finally {
    child.kill("SIGKILL");
  }
});

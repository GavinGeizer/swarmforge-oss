import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { acquireProcessLock } from "../src/runtime";

const fixture = join(import.meta.dir, "fixtures", "lock-holder.ts");
type Holder = {
  proc: Subprocess;
  report: Promise<{ outcome: string; pid?: number; error?: string }>;
  release: () => Promise<void>;
};

function newLock(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `sf-lock-${prefix}-`));
  return { dir, path: join(dir, "swarmforge.sqlite.lock") };
}

async function readLine(proc: Subprocess) {
  if (!(proc.stdout instanceof ReadableStream))
    throw new Error("holder stdout is not readable");
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.split("\n")[0] ?? "";
}

function startHolder(path: string, barrier?: string): Holder {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", fixture, path, barrier ?? ""],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const report = readLine(proc).then(async (line) => {
    try {
      return JSON.parse(line) as {
        outcome: string;
        pid?: number;
        error?: string;
      };
    } catch {
      const errors = await new Response(proc.stderr).text();
      throw new Error(`holder produced no report: ${line}${errors}`);
    }
  });
  return {
    proc,
    report,
    release: async () => {
      proc.stdin.write("release\n");
      await proc.stdin.flush();
      await proc.exited;
    },
  };
}

function deadPid() {
  const proc = Bun.spawnSync([process.execPath, "-e", "process.exit(0)"]);
  return proc.pid;
}

describe("single owner process lock", () => {
  test("simultaneous starts leave exactly one owner and a crash frees the lock", async () => {
    const { dir, path } = newLock("race");
    const barrier = join(dir, "go");
    writeFileSync(path, `${deadPid()}\n`);
    const holders = Array.from({ length: 5 }, () => startHolder(path, barrier));
    try {
      writeFileSync(barrier, "go");
      const reports = await Promise.all(holders.map((h) => h.report));
      const owners = reports.filter((r) => r.outcome === "acquired");
      expect(reports.map((r) => r.outcome).sort()).toEqual([
        "acquired",
        "refused",
        "refused",
        "refused",
        "refused",
      ]);
      expect(owners).toHaveLength(1);
      const owner = holders.findIndex(
        (_, i) => reports[i]?.outcome === "acquired",
      );
      expect(readFileSync(path, "utf8")).toContain(
        String(reports[owner]?.pid ?? ""),
      );
      expect(existsSync(path)).toBe(true);

      holders[owner]?.proc.kill(9);
      await holders[owner]?.proc.exited;
      const successor = startHolder(path);
      try {
        expect(await successor.report).toMatchObject({
          outcome: "acquired",
        });
      } finally {
        await successor.release();
      }
    } finally {
      for (const holder of holders) holder.proc.kill(9);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a lock file left behind by a dead or foreign owner never wedges startup", async () => {
    const { dir, path } = newLock("stale");
    try {
      for (const leftover of [
        "",
        "not-a-pid",
        `${deadPid()}\n`,
        `${process.pid}\n`,
      ]) {
        writeFileSync(path, leftover);
        acquireProcessLock(path)();
      }
      const unlock = acquireProcessLock(path);
      expect(() => acquireProcessLock(path)).toThrow();
      unlock();
      const reacquired = acquireProcessLock(path);
      expect(existsSync(path)).toBe(true);
      reacquired();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a released lock hands the database to the next process", async () => {
    const { dir, path } = newLock("release");
    const first = startHolder(path);
    try {
      expect(await first.report).toMatchObject({ outcome: "acquired" });
      const second = startHolder(path);
      expect(await second.report).toMatchObject({ outcome: "refused" });
      await second.proc.exited;
      await first.release();
      expect(existsSync(path)).toBe(false);
      const third = startHolder(path);
      try {
        expect(await third.report).toMatchObject({ outcome: "acquired" });
      } finally {
        await third.release();
      }
    } finally {
      first.proc.kill(9);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

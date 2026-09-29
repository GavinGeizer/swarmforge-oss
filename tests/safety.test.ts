import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker, WorkerResult } from "../src/domain";
import { branchFor } from "../src/git-handoff";
import { inspectPersistence } from "../src/safety";
import { config, FakeProvider, harness, runToRunning, task } from "./helpers";

function verifiedResult(w: Worker, commit: string): WorkerResult {
  return {
    status: "completed",
    summary: "done",
    files_changed: [],
    warnings: [],
    needs_followup: false,
    git: { persisted: true, branch: branchFor(w), commit },
  };
}

class LocalExec extends FakeProvider {
  override async exec(_id: string, command: string) {
    const p = Bun.spawn(["bash", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: await new Response(p.stdout).text(),
      stderr: await new Response(p.stderr).text(),
      code: await p.exited,
    };
  }
}
async function git(path: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-C", path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(p.stdout).text();
  if ((await p.exited) !== 0)
    throw new Error(await new Response(p.stderr).text());
  return output;
}
test("real git validation protects modified, untracked and locally committed source while allowing remote-persisted work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-safety-"));
  const h = harness();
  const w = h.coordinator.spawn(task);
  w.vm_id = "local";
  const c = { ...config, SWARMFORGE_WORKSPACE: dir };
  const provider = new LocalExec();
  try {
    await git(dir, "init");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.test");
    writeFileSync(join(dir, "code.txt"), "original");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "initial");
    const head = (await git(dir, "rev-parse", "HEAD")).trim();
    expect((await inspectPersistence(provider, c, w, null)).safe).toBe(false);
    // Only a control-plane verified push counts as durability.
    const verified = verifiedResult(w, head);
    expect((await inspectPersistence(provider, c, w, verified)).safe).toBe(
      true,
    );
    writeFileSync(join(dir, "code.txt"), "changed");
    expect((await inspectPersistence(provider, c, w, verified)).safe).toBe(
      false,
    );
    await git(dir, "checkout", "--", "code.txt");
    mkdirSync(join(dir, ".swarmforge"));
    writeFileSync(join(dir, ".swarmforge", "result.json"), "{}");
    expect((await inspectPersistence(provider, c, w, verified)).safe).toBe(
      true,
    );
    writeFileSync(join(dir, "untracked.txt"), "new");
    expect((await inspectPersistence(provider, c, w, verified)).safe).toBe(
      false,
    );
  } finally {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forged local remote refs are not proof that local commits are durable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-forged-"));
  const h = harness();
  const w = h.coordinator.spawn(task);
  w.vm_id = "local";
  const c = { ...config, SWARMFORGE_WORKSPACE: dir };
  const provider = new LocalExec();
  try {
    await git(dir, "init");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.test");
    writeFileSync(join(dir, "code.txt"), "original");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "initial");
    const head = (await git(dir, "rev-parse", "HEAD")).trim();
    // The worker can point guest-writable remote-tracking refs at its own commits.
    await git(dir, "update-ref", `refs/remotes/origin/${branchFor(w)}`, head);
    await git(dir, "update-ref", "refs/remotes/origin/HEAD", head);
    const forged = await inspectPersistence(provider, c, w, null);
    expect(forged.safe).toBe(false);
    expect(forged.reason).toContain("verified");
    expect(
      (await inspectPersistence(provider, c, w, verifiedResult(w, head))).safe,
    ).toBe(true);
  } finally {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work committed after the verified push is retained instead of destroyed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-retained-"));
  const h = harness();
  const w = h.coordinator.spawn(task);
  w.vm_id = "local";
  const c = { ...config, SWARMFORGE_WORKSPACE: dir };
  const provider = new LocalExec();
  try {
    await git(dir, "init");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.test");
    writeFileSync(join(dir, "code.txt"), "original");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "initial");
    const pushed = (await git(dir, "rev-parse", "HEAD")).trim();
    expect(
      (await inspectPersistence(provider, c, w, verifiedResult(w, pushed)))
        .safe,
    ).toBe(true);
    writeFileSync(join(dir, "code.txt"), "more");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "unpushed");
    const retained = await inspectPersistence(
      provider,
      c,
      w,
      verifiedResult(w, pushed),
    );
    expect(retained.safe).toBe(false);
    expect(retained.reason).toContain("verified");
  } finally {
    h.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker cannot certify its own commits as durable", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.agent.complete(h.store.get(w.worker_id), {
    status: "completed",
    summary: "done",
    git: { persisted: true, branch: branchFor(w), commit: "a".repeat(40) },
  });
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("completed");
  // Without a SwarmForge push there is no verified commit, whatever the worker claims.
  expect(h.store.result(w.worker_id)?.git?.persisted).toBe(false);
  h.store.close();
});
test("destroy quiesces the OpenCode service and its subprocesses before inspecting git", async () => {
  const h = harness();
  const order: string[] = [];
  const original = h.provider.exec.bind(h.provider);
  h.provider.exec = async (id, command) => {
    order.push(
      command.includes("systemctl stop")
        ? "stop"
        : command.includes("SWARMFORGE_GIT_CHECK")
          ? "inspect"
          : "other",
    );
    return original(id, command);
  };
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  await h.coordinator.control(w.worker_id, "destroy");
  expect(order.slice(0, 2)).toEqual(["stop", "inspect"]);
  h.store.close();
});

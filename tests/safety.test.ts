import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker, WorkerResult } from "../src/domain";
import { branchFor } from "../src/git-handoff";
import {
  inspectPersistence,
  inspectWorkspace,
  workspaceDigest,
} from "../src/safety";
import {
  FakeProvider,
  harness,
  loadTestConfig,
  runToRunning,
  task,
} from "./helpers";

class LocalWorkspace extends FakeProvider {
  override async listFiles(_id: string, path: string) {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : "file",
    }));
  }
  override async stat(_id: string, path: string) {
    const stat = statSync(path);
    return {
      size: stat.size,
      isFile: stat.isFile(),
      isSymlink: stat.isSymbolicLink(),
      modified: stat.mtime.toISOString(),
    };
  }
  // The host hashes workspace content to compare it with a published blob id.
  override async readFile(
    _id: string,
    path: string,
    offset = 0,
    length = 65536,
  ) {
    return new Uint8Array(readFileSync(path)).slice(offset, offset + length);
  }
  override async exec(): Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }> {
    // Durability is decided on the control plane; a guest command is never trusted.
    throw new Error("guest commands must not run during a safety check");
  }
}

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

// The remote lives outside the workspace: only the checkout is ever inspected.
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "sf-safety-"));
  const dir = join(base, "workspace");
  const remote = join(base, "remote.git");
  const repo = join(dir, "repo");
  mkdirSync(join(dir, ".swarmforge"), { recursive: true });
  await git("init", "--bare", remote);
  await git("init", repo);
  await git("-C", repo, "config", "user.name", "Test");
  await git("-C", repo, "config", "user.email", "test@example.test");
  writeFileSync(join(repo, "code.txt"), "original");
  await git("-C", repo, "add", ".");
  await git("-C", repo, "commit", "-m", "initial");
  const head = await git("-C", repo, "rev-parse", "HEAD");
  await git("-C", repo, "remote", "add", "origin", remote);
  await git("-C", repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  await git("--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { base, dir, remote, repo, head };
}

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

test("a pristine checkout stays safe while unpushed local commits are retained", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  };
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    expect(await inspectPersistence(provider, c, w, null)).toEqual({
      safe: true,
      reason: expect.stringContaining("recorded handoff base"),
    });
    // Local commits the control plane never published are unpersisted work.
    await git("-C", f.repo, "checkout", "-q", "-b", branchFor(w));
    writeFileSync(join(f.repo, "code.txt"), "changed but not pushed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "local only");
    const unpushed = await inspectPersistence(provider, c, w, null);
    expect(unpushed.safe).toBe(false);
    expect(unpushed.reason).toContain("recorded handoff base");
    // Guest-writable remote-tracking refs never stand in for a published commit.
    await git(
      "-C",
      f.repo,
      "update-ref",
      `refs/remotes/origin/${branchFor(w)}`,
      await git("-C", f.repo, "rev-parse", "HEAD"),
    );
    expect((await inspectPersistence(provider, c, w, null)).safe).toBe(false);
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a workspace unchanged since prepare is safe without any remote read", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: null,
    workspace_digest: null,
  };
  const provider = new LocalWorkspace();
  const c = loadTestConfig({
    workspace: f.dir,
    // An unreachable tree: the baseline alone has to answer the question.
    tree: join(f.dir, "not-a-repository"),
    push: f.remote,
  });
  try {
    const before = await inspectPersistence(provider, c, w, null);
    expect(before.safe).toBe(false);
    const digest = workspaceDigest(
      await inspectWorkspace(provider, "local", [f.dir]),
      [f.dir],
    );
    const prepared = { ...w, workspace_digest: digest };
    expect(await inspectPersistence(provider, c, prepared, null)).toEqual({
      safe: true,
      reason: "workspace unchanged since the worker was prepared",
    });
    writeFileSync(join(f.repo, "code.txt"), "edited");
    expect((await inspectPersistence(provider, c, prepared, null)).safe).toBe(
      false,
    );
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("the verified branch is safe to destroy and later work is retained", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  };
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branchFor(w));
    writeFileSync(join(f.repo, "code.txt"), "published change");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "published");
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    await git(
      "-C",
      f.repo,
      "push",
      "-q",
      "origin",
      `HEAD:refs/heads/${branchFor(w)}`,
    );
    expect(
      await inspectPersistence(provider, c, w, verifiedResult(w, commit)),
    ).toEqual({
      safe: true,
      reason: expect.stringContaining("verified remote branch"),
    });
    expect(provider.commands).toEqual([]);
    writeFileSync(join(f.repo, "code.txt"), "published change plus more");
    const retained = await inspectPersistence(
      provider,
      c,
      w,
      verifiedResult(w, commit),
    );
    expect(retained.safe).toBe(false);
    expect(retained.reason).toContain("modified code.txt");
    // A result the worker wrote for itself is not a verified push either.
    expect(
      (
        await inspectPersistence(provider, c, w, {
          ...verifiedResult(w, commit),
          git: { ...verifiedResult(w, commit).git, commit: f.head },
        })
      ).safe,
    ).toBe(false);
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a tracked link in the published tree does not block destruction", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  };
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    symlinkSync("code.txt", join(f.repo, "latest.txt"));
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "add a link");
    await git(
      "-C",
      f.repo,
      "push",
      "-q",
      "origin",
      `HEAD:refs/heads/${branchFor(w)}`,
    );
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    expect(
      await inspectPersistence(provider, c, w, verifiedResult(w, commit)),
    ).toMatchObject({ safe: true });
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("files outside a Git repository block destruction", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  };
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    writeFileSync(join(f.dir, "notes.txt"), "outside the repository");
    const stray = await inspectPersistence(provider, c, w, null);
    expect(stray.safe).toBe(false);
    expect(stray.reason).toContain("untracked notes.txt");
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a hostile git on the worker PATH cannot influence the verdict", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  };
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    // A shim early on PATH that reports a clean, fully pushed repository.
    const shim = join(f.base, "bin");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "git"),
      '#!/bin/sh\ncase "$1" in status) exit 0;; rev-list) echo 0;; esac\necho "clean"\n',
      { mode: 0o755 },
    );
    writeFileSync(join(f.repo, "code.txt"), "unpushed work");
    expect((await inspectPersistence(provider, c, w, null)).safe).toBe(false);
    expect(provider.commands).toEqual([]);
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("destroy quiesces the OpenCode service and its subprocesses before inspecting the workspace", async () => {
  const h = harness();
  const order: string[] = [];
  const original = h.provider.exec.bind(h.provider);
  h.provider.exec = async (id, command) => {
    order.push(command.includes("systemctl stop") ? "stop" : "other");
    return original(id, command);
  };
  h.provider.listFiles = async () => {
    order.push("inspect");
    return [];
  };
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  await h.coordinator.control(w.worker_id, "destroy");
  expect(order.slice(0, 2)).toEqual(["stop", "inspect"]);
  h.store.close();
});

test("the branch point and baseline recorded at prepare are the ones a later handoff uses", async () => {
  const f = await fixture();
  const h = harness();
  const w = h.coordinator.spawn(task);
  h.store.patch(w.worker_id, {
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  });
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    const recorded = h.store.get(w.worker_id);
    expect(recorded.git_base).toBe(f.head);
    expect(await inspectPersistence(provider, c, recorded, null)).toMatchObject(
      { safe: true },
    );
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a same-length uncommitted edit is not certified as published", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  };
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    expect((await inspectPersistence(provider, c, w, null)).safe).toBe(true);
    // "modified" is eight bytes, exactly like the published "original": only the content
    // differs, so a length comparison would certify this uncommitted work as safe.
    writeFileSync(join(f.repo, "code.txt"), "modified");
    const edited = await inspectPersistence(provider, c, w, null);
    expect(edited.safe).toBe(false);
    expect(edited.reason).toContain("modified code.txt");
    // Restoring the published content makes the same file safe again.
    writeFileSync(join(f.repo, "code.txt"), "original");
    expect((await inspectPersistence(provider, c, w, null)).safe).toBe(true);
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("an emptied workspace is not safe while published files are missing from it", async () => {
  const f = await fixture();
  const h = harness();
  const w = {
    ...h.coordinator.spawn(task),
    vm_id: "local",
    git_base: f.head,
    workspace_digest: null,
  };
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    // The tracked file is removed but the repository survives.
    rmSync(join(f.repo, "code.txt"));
    const emptied = await inspectPersistence(provider, c, w, null);
    expect(emptied.safe).toBe(false);
    expect(emptied.reason).toContain("deleted code.txt");
    // Removing the repository as well leaves the same empty snapshot, and the deletion of
    // every published file is still compared before the workspace is certified safe.
    rmSync(f.repo, { recursive: true, force: true });
    const gone = await inspectPersistence(provider, c, w, null);
    expect(gone.safe).toBe(false);
    expect(gone.reason).toContain("deleted code.txt");
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("an empty workspace is safe when the published tree expects no files", async () => {
  const f = await fixture();
  const h = harness();
  const c = loadTestConfig({
    workspace: f.dir,
    tree: f.remote,
    push: f.remote,
  });
  const provider = new LocalWorkspace();
  try {
    // The published branch point holds no files: the only tracked file was removed.
    rmSync(join(f.repo, "code.txt"));
    await git("-C", f.repo, "add", "-A");
    await git("-C", f.repo, "commit", "-q", "-m", "remove the file");
    const head = await git("-C", f.repo, "rev-parse", "HEAD");
    await git("-C", f.repo, "push", "-q", "origin", "HEAD:refs/heads/main");
    const w = {
      ...h.coordinator.spawn(task),
      vm_id: "local",
      git_base: head,
      workspace_digest: null,
    };
    rmSync(f.repo, { recursive: true, force: true });
    // Nothing was ever published, so an empty workspace holds no lost work.
    expect(await inspectPersistence(provider, c, w, null)).toMatchObject({
      safe: true,
    });
  } finally {
    h.store.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});

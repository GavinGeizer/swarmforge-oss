import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Freestyle } from "freestyle";
import type { Config } from "../src/config";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import {
  branchFor,
  githubInstallationToken,
  publishedTree,
  recordedTree,
} from "../src/git-handoff";
import { FreestyleProvider } from "../src/providers/freestyle";
import { bootstrap } from "../src/providers/opencode";
import { Store } from "../src/store";
import { config, FakeAgent, FakeProvider, runToRunning, task } from "./helpers";

test("branch names are unique, valid and tied to the worker", () => {
  const name = branchFor({ ...task, worker_id: "w_abc123" });
  expect(name).toBe("swarmforge/team/task/w_abc123");
  expect(branchFor({ ...task, worker_id: "w_other" })).not.toBe(name);
});

test("GitHub App requests a repository-scoped Contents token with a signed JWT", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const dir = mkdtempSync(join(tmpdir(), "sf-app-"));
  const path = join(dir, "app.pem");
  writeFileSync(path, privateKey.export({ type: "pkcs1", format: "pem" }));
  let called = false;
  try {
    const token = await githubInstallationToken(
      {
        ...config,
        SWARMFORGE_GIT_PUSH_MODE: "github-app",
        SWARMFORGE_GITHUB_APP_ID: "123",
        SWARMFORGE_GITHUB_INSTALLATION_ID: "456",
        SWARMFORGE_GITHUB_PRIVATE_KEY_PATH: path,
        SWARMFORGE_GITHUB_REPOSITORY: "owner/repo",
      },
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        called = true;
        expect(String(input)).toBe(
          "https://api.github.com/app/installations/456/access_tokens",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ["repo"],
          permissions: { contents: "write" },
        });
        const jwt = String(
          (init?.headers as Record<string, string>)?.Authorization,
        ).slice(7);
        const [header, payload, signature] = jwt.split(".");
        expect(
          JSON.parse(Buffer.from(header!, "base64url").toString()),
        ).toEqual({ alg: "RS256", typ: "JWT" });
        expect(
          JSON.parse(Buffer.from(payload!, "base64url").toString()).iss,
        ).toBe("123");
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${payload}`),
            publicKey,
            Buffer.from(signature!, "base64url"),
          ),
        ).toBe(true);
        return Response.json({ token: "installation-token" });
      }) as typeof fetch,
    );
    expect(called).toBe(true);
    expect(token).toBe("installation-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read-scoped installation token is available for the guest clone", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "sf-app-read-"));
  const path = join(dir, "app.pem");
  writeFileSync(path, privateKey.export({ type: "pkcs1", format: "pem" }));
  try {
    const token = await githubInstallationToken(
      {
        ...config,
        SWARMFORGE_GITHUB_APP_ID: "123",
        SWARMFORGE_GITHUB_INSTALLATION_ID: "456",
        SWARMFORGE_GITHUB_PRIVATE_KEY_PATH: path,
        SWARMFORGE_GITHUB_REPOSITORY: "owner/repo",
      },
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).permissions).toEqual({
          contents: "read",
        });
        return Response.json({ token: "read-token" });
      }) as typeof fetch,
      "read",
    );
    expect(token).toBe("read-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push mode requires a cloned tree and complete credentials", () => {
  const base = {
    FREESTYLE_API_TOKEN: "secret",
    FREESTYLE_SNAPSHOT_ID: "snap",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "key",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "https://github.com/owner/repo.git",
  };
  expect(() =>
    loadConfig({ ...base, SWARMFORGE_GIT_PUSH_MODE: "github-app" }),
  ).toThrow();
  expect(() =>
    loadConfig({ ...base, SWARMFORGE_GIT_PUSH_MODE: "ssh" }),
  ).toThrow();
  expect(() =>
    loadConfig({
      ...base,
      SWARMFORGE_GIT_PUSH_MODE: "ssh",
      SWARMFORGE_GIT_PUSH_URL: "git@example:repo.git",
      SWARMFORGE_GIT_SSH_KEY_PATH: "/key",
      SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: "/hosts",
      SWARMFORGE_GIT_TREE: "none",
    }),
  ).toThrow();
});

test("coordinator verifies push before completing and returns canonical branch metadata", async () => {
  const store = new Store(":memory:");
  const provider = new FakeProvider();
  const agent = new FakeAgent();
  const c = {
    ...config,
    SWARMFORGE_GIT_PUSH_MODE: "ssh" as const,
    SWARMFORGE_GIT_PUSH_URL: "git@example:repo.git",
    SWARMFORGE_GIT_SSH_KEY_PATH: "/key",
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: "/hosts",
  };
  const coordinator = new Coordinator(c, store, provider, agent);
  const w = coordinator.spawn(task);
  await runToRunning({ store, provider, agent, coordinator }, w.worker_id);
  agent.complete(store.get(w.worker_id), {
    status: "completed",
    summary: "done",
    git: { persisted: true, branch: "made-up" },
  });
  provider.pushFailure = true;
  await coordinator.tick();
  expect(store.get(w.worker_id).state).not.toBe("completed");
  expect(store.get(w.worker_id).error).toContain("Git branch push");
  expect(store.result(w.worker_id)).toBeNull();
  provider.pushFailure = false;
  await coordinator.tick();
  expect(store.get(w.worker_id).state).toBe("completed");
  expect(store.result(w.worker_id)?.git).toMatchObject({
    persisted: true,
    branch: branchFor(w),
    commit: "a".repeat(40),
    base_commit: "b".repeat(40),
  });
  store.close();
});

test("automatic handoff refuses normal VM destruction until a branch is verified", async () => {
  const store = new Store(":memory:");
  const provider = new FakeProvider();
  const agent = new FakeAgent();
  const c = { ...config, SWARMFORGE_GIT_PUSH_MODE: "ssh" as const };
  const coordinator = new Coordinator(c, store, provider, agent);
  const w = coordinator.spawn(task);
  await runToRunning({ store, provider, agent, coordinator }, w.worker_id);
  await coordinator.control(w.worker_id, "destroy");
  expect(store.get(w.worker_id).state).toBe("recovery_required");
  expect(store.get(w.worker_id).error).toContain("verified branch");
  expect(provider.vms.size).toBe(1);
  store.close();
});

test("worker instructions require a commit on its assigned branch while SwarmForge handles the push", () => {
  const store = new Store(":memory:");
  const w = store.create({ ...task, timeout_seconds: 60 });
  const d = store.dispatch(w.worker_id)!;
  const instructions = bootstrap(
    { ...config, SWARMFORGE_GIT_PUSH_MODE: "ssh" },
    w,
    d,
  );
  expect(instructions).toContain(branchFor(w));
  expect(instructions).toContain("commit");
  expect(instructions).toContain("SwarmForge will push");
  store.close();
});

test("worker checkout gets a task branch and local Git author identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-prepare-"));
  const key = join(dir, "key");
  const hosts = join(dir, "hosts");
  const readKey = join(dir, "read-key");
  const readHosts = join(dir, "read-hosts");
  writeFileSync(key, "PRIVATE WRITE KEY");
  writeFileSync(hosts, "unused");
  writeFileSync(readKey, "PRIVATE READ KEY");
  writeFileSync(readHosts, "unused");
  const commands: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const vm = {
    fs: {
      writeTextFile: async (path: string, content: string) => {
        writes.push({ path, content });
      },
      readDir: async (path: string) => localEntries(path),
      stat: async (path: string) => localStat(path),
    },
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      return {
        statusCode: 0,
        stdout: command.includes("git-base") ? `${"b".repeat(40)}\n` : "",
        stderr: "",
      };
    },
  };
  const c = loadConfig({
    FREESTYLE_API_TOKEN: "secret",
    FREESTYLE_SNAPSHOT_ID: "snap",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "key",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "git@git.example:repo.git",
    SWARMFORGE_GIT_PUSH_MODE: "ssh",
    SWARMFORGE_GIT_PUSH_URL: "git@git.example:repo.git",
    SWARMFORGE_GIT_SSH_KEY_PATH: key,
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: hosts,
    SWARMFORGE_GIT_SSH_CLONE_KEY_PATH: readKey,
    SWARMFORGE_GIT_SSH_CLONE_KNOWN_HOSTS_PATH: readHosts,
  });
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
  };
  try {
    const prepared = await new FreestyleProvider(c, {
      vms: { ref: () => vm },
    } as unknown as Freestyle).prepare(w);
    // The branch point and the workspace baseline are recorded for the control plane.
    expect(prepared.git_base).toBe("b".repeat(40));
    expect(prepared.workspace_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      commands.some(
        (x) => x.includes("git checkout -b") && x.includes(branchFor(w)),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (x) =>
          x.includes("git config user.name") &&
          x.includes("git config user.email"),
      ),
    ).toBe(true);
    // The clone stages the read-only key; the write key stays on the host.
    expect(writes).toEqual([
      { path: "/opt/swarmforge/git-secret", content: "PRIVATE READ KEY" },
      { path: "/opt/swarmforge/git-auth", content: "unused" },
      { path: "/opt/swarmforge/opencode.json", content: expect.any(String) },
      { path: "/opt/swarmforge/start.sh", content: expect.any(String) },
      {
        path: "/etc/systemd/system/swarmforge-opencode.service",
        content: expect.any(String),
      },
    ]);
    expect(commands.join(" ")).not.toContain("PRIVATE WRITE KEY");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a handoff without a recorded branch point is refused", async () => {
  const f = await workspace();
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
  };
  const guest = localVm();
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branchFor(w));
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    await expect(
      new FreestyleProvider(sshConfig(f.dir, f.repo, f.remote), {
        vms: { ref: () => guest.vm },
      } as unknown as Freestyle).pushBranch(w),
    ).rejects.toThrow("base was not recorded");
    expect(guest.commands).toEqual([]);
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("an SSH clone without a read-only key is refused before any worker exists", () => {
  const base = {
    FREESTYLE_API_TOKEN: "secret",
    FREESTYLE_SNAPSHOT_ID: "snap",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "key",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_PUSH_MODE: "ssh",
    SWARMFORGE_GIT_PUSH_URL: "git@example:repo.git",
    SWARMFORGE_GIT_SSH_KEY_PATH: "/key",
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: "/hosts",
  };
  // The write key alone is not a clone credential: the configuration refuses to start.
  expect(() =>
    loadConfig({ ...base, SWARMFORGE_GIT_TREE: "git@example:repo.git" }),
  ).toThrow();
  expect(() =>
    loadConfig({
      ...base,
      SWARMFORGE_GIT_TREE: "git@example:repo.git",
      SWARMFORGE_GIT_SSH_CLONE_KEY_PATH: "/read",
    }),
  ).toThrow();
  // A tree that clones over HTTPS needs no key at all.
  expect(
    loadConfig({
      ...base,
      SWARMFORGE_GIT_TREE: "https://git.example/owner/repo.git",
    }).SWARMFORGE_GIT_SSH_CLONE_KEY_PATH,
  ).toBeUndefined();
  expect(
    loadConfig({
      ...base,
      SWARMFORGE_GIT_TREE: "git@example:repo.git",
      SWARMFORGE_GIT_SSH_CLONE_KEY_PATH: "/read",
      SWARMFORGE_GIT_SSH_CLONE_KNOWN_HOSTS_PATH: "/read-hosts",
    }).SWARMFORGE_GIT_SSH_CLONE_KEY_PATH,
  ).toBe("/read");
});

test("a failed clone removes the staged guest credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-clone-"));
  const readKey = join(dir, "read-key");
  const readHosts = join(dir, "read-hosts");
  writeFileSync(readKey, "PRIVATE READ KEY");
  writeFileSync(readHosts, "unused");
  const commands: string[] = [];
  const writes: { path: string; content: string; mode?: number }[] = [];
  const vm = {
    fs: {
      writeTextFile: async (
        path: string,
        content: string,
        options?: { mode?: number },
      ) => {
        writes.push({ path, content, mode: options?.mode });
      },
    },
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      return {
        statusCode: command.includes("git clone") ? 1 : 0,
        stdout: "",
        stderr: "denied",
      };
    },
  };
  const c = loadConfig({
    FREESTYLE_API_TOKEN: "secret",
    FREESTYLE_SNAPSHOT_ID: "snap",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "key",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "git@git.example:repo.git",
    SWARMFORGE_GIT_PUSH_MODE: "ssh",
    SWARMFORGE_GIT_PUSH_URL: "git@git.example:repo.git",
    SWARMFORGE_GIT_SSH_KEY_PATH: join(dir, "key"),
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: join(dir, "hosts"),
    SWARMFORGE_GIT_SSH_CLONE_KEY_PATH: readKey,
    SWARMFORGE_GIT_SSH_CLONE_KNOWN_HOSTS_PATH: readHosts,
  });
  writeFileSync(join(dir, "key"), "PRIVATE WRITE KEY");
  writeFileSync(join(dir, "hosts"), "git.example ssh-ed25519 AAAA");
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
  };
  try {
    await expect(
      new FreestyleProvider(c, {
        vms: { ref: () => vm },
      } as unknown as Freestyle).prepare(w),
    ).rejects.toThrow("Failed to clone");
    expect(writes.map((x) => x.path)).toEqual([
      "/opt/swarmforge/git-secret",
      "/opt/swarmforge/git-auth",
    ]);
    expect(commands.at(-1)).toBe(
      "rm -f '/opt/swarmforge/git-auth' '/opt/swarmforge/git-secret'",
    );
    expect(commands.join(" ")).not.toContain("PRIVATE TEST KEY");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

async function branchOrNull(remote: string, branch: string) {
  const p = Bun.spawn(
    ["git", "--git-dir", remote, "rev-parse", "--verify", "--quiet", branch],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(p.stdout).text();
  return (await p.exited) === 0 ? stdout.trim() : null;
}

// A worker checkout, a bare remote and the workspace bookkeeping the handoff relies on.
async function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "sf-handoff-"));
  const remote = join(dir, "remote.git");
  const repo = join(dir, "repo");
  mkdirSync(join(dir, ".swarmforge"));
  await git("init", "--bare", remote);
  await git("init", repo);
  await git("-C", repo, "config", "user.name", "Test");
  await git("-C", repo, "config", "user.email", "test@example.test");
  writeFileSync(join(repo, "code.txt"), "base");
  await git("-C", repo, "add", ".");
  await git("-C", repo, "commit", "-m", "base");
  const base = await git("-C", repo, "rev-parse", "HEAD");
  await git("-C", repo, "remote", "add", "origin", remote);
  await git("-C", repo, "push", "-q", "origin", "HEAD:refs/heads/main");
  writeFileSync(join(dir, ".swarmforge", "git-base"), `${base}\n`);
  return { dir, remote, repo, base };
}

function localEntries(path: string) {
  return readdirSync(path, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory()
      ? "directory"
      : entry.isSymbolicLink()
        ? "symlink"
        : "file",
  }));
}

function localStat(path: string) {
  const stat = statSync(path);
  return {
    size: stat.size,
    isFile: stat.isFile(),
    isSymlink: stat.isSymbolicLink(),
    modified: stat.mtime.toISOString(),
  };
}

// A VM whose filesystem and shell are this machine, so the real Git plumbing is exercised.
function localVm() {
  const commands: string[] = [];
  const writes: { path: string; content: string; mode?: number }[] = [];
  const vm = {
    fs: {
      writeTextFile: async (
        path: string,
        content: string,
        options?: { mode?: number },
      ) => {
        writes.push({ path, content, mode: options?.mode });
        writeFileSync(path, content);
      },
      stat: async (path: string) => localStat(path),
      readFile: async (path: string) =>
        new Uint8Array(await Bun.file(path).arrayBuffer()),
      readDir: async (path: string) => localEntries(path),
    },
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      const p = Bun.spawn(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { statusCode: code, stdout, stderr };
    },
  };
  return { vm, commands, writes };
}

function sshConfig(dir: string, tree: string, push: string): Config {
  const key = join(dir, "key");
  const hosts = join(dir, "hosts");
  writeFileSync(key, "PRIVATE TEST KEY");
  writeFileSync(hosts, "git.example ssh-ed25519 AAAA");
  return loadConfig({
    FREESTYLE_API_TOKEN: "secret",
    FREESTYLE_SNAPSHOT_ID: "snap",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "key",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: tree,
    SWARMFORGE_GIT_PUSH_MODE: "ssh",
    SWARMFORGE_GIT_PUSH_URL: push,
    SWARMFORGE_GIT_SSH_KEY_PATH: key,
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: hosts,
    SWARMFORGE_WORKSPACE: dir,
  });
}

const handoffDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith("swarmforge-handoff-"));

test("push hands a bundle to the host, which publishes and verifies the remote SHA", async () => {
  const f = await workspace();
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
    git_base: f.base,
  };
  const branch = branchFor(w);
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branch);
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    const guest = localVm();
    const provider = new FreestyleProvider(sshConfig(f.dir, f.repo, f.remote), {
      vms: { ref: () => guest.vm },
    } as unknown as Freestyle);
    const before = handoffDirs();
    expect(await provider.pushBranch(w)).toEqual({
      branch,
      base_commit: f.base,
      commit,
    });
    expect(
      await git("--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`),
    ).toBe(commit);
    // The worker only ever produced a bundle: no credential, no push, no leftover file.
    expect(guest.writes).toEqual([]);
    expect(guest.commands.join("\n")).not.toContain("git push");
    expect(guest.commands.join("\n")).not.toContain("PRIVATE TEST KEY");
    expect(guest.commands.join("\n")).toContain("bundle create");
    expect(
      existsSync(join(f.dir, ".swarmforge", `handoff-${w.worker_id}.bundle`)),
    ).toBe(false);
    expect(handoffDirs()).toEqual(before);
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a malicious pre-push hook never runs and never observes a credential", async () => {
  const f = await workspace();
  const marker = join(f.dir, "hook-ran");
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
    git_base: f.base,
  };
  const branch = branchFor(w);
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branch);
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    const hooks = join(f.repo, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-push"),
      `#!/bin/sh\nenv >> ${JSON.stringify(`${f.dir}/hook-env`)}\ncat /opt/swarmforge/git-secret >> ${JSON.stringify(`${f.dir}/hook-key`)} 2>/dev/null\nexit 0\n`,
      { mode: 0o755 },
    );
    const guest = localVm();
    const provider = new FreestyleProvider(sshConfig(f.dir, f.repo, f.remote), {
      vms: { ref: () => guest.vm },
    } as unknown as Freestyle);
    await provider.pushBranch(w);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(f.dir, "hook-env"))).toBe(false);
    expect(existsSync(join(f.dir, "hook-key"))).toBe(false);
    expect(
      await git("--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`),
    ).toBe(commit);
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a rejected push reports failure and leaves no bundle or host state behind", async () => {
  const f = await workspace();
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
    git_base: f.base,
  };
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branchFor(w));
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    writeFileSync(
      join(f.remote, "hooks", "pre-receive"),
      "#!/bin/sh\necho rejected >&2\nexit 1\n",
      { mode: 0o755 },
    );
    const guest = localVm();
    const provider = new FreestyleProvider(sshConfig(f.dir, f.repo, f.remote), {
      vms: { ref: () => guest.vm },
    } as unknown as Freestyle);
    const before = handoffDirs();
    await expect(provider.pushBranch(w)).rejects.toThrow("Host Git push");
    expect(guest.writes).toEqual([]);
    expect(guest.commands.join("\n")).not.toContain("PRIVATE TEST KEY");
    expect(
      existsSync(join(f.dir, ".swarmforge", `handoff-${w.worker_id}.bundle`)),
    ).toBe(false);
    expect(handoffDirs()).toEqual(before);
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the GitHub App installation token stays on the host and never enters the worker", async () => {
  const f = await workspace();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPath = join(f.dir, "app.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs1", format: "pem" }));
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
    git_base: f.base,
  };
  const branch = branchFor(w);
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branch);
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    const c = loadConfig({
      FREESTYLE_API_TOKEN: "secret",
      FREESTYLE_SNAPSHOT_ID: "snap",
      SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
      SWARMFORGE_MODEL_API_KEY: "key",
      SWARMFORGE_MODEL_NAME: "qwen",
      SWARMFORGE_GIT_TREE: "https://github.com/owner/repo.git",
      SWARMFORGE_GIT_PUSH_MODE: "github-app",
      SWARMFORGE_GITHUB_APP_ID: "123",
      SWARMFORGE_GITHUB_INSTALLATION_ID: "456",
      SWARMFORGE_GITHUB_PRIVATE_KEY_PATH: keyPath,
      SWARMFORGE_GITHUB_REPOSITORY: "owner/repo",
      SWARMFORGE_WORKSPACE: f.dir,
    });
    // The target is redirected to the local bare remote so the handoff runs offline.
    const scopes: unknown[] = [];
    const guest = localVm();
    const provider = new FreestyleProvider(
      { ...c, SWARMFORGE_GIT_TREE: f.remote },
      { vms: { ref: () => guest.vm } } as unknown as Freestyle,
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        scopes.push(
          (JSON.parse(String(init?.body)) as { permissions: unknown })
            .permissions,
        );
        return Response.json({ token: "host-installation-token" });
      }) as typeof fetch,
    );
    const pushed = await provider.pushBranch(w);
    expect(pushed.commit).toBe(commit);
    expect(pushed.review_url).toBe(
      `https://github.com/owner/repo/compare/${pushed.base_commit}...${encodeURIComponent(branch)}`,
    );
    expect(scopes).toEqual([{ contents: "write" }]);
    expect(guest.writes).toEqual([]);
    expect(guest.commands.join("\n")).not.toContain("host-installation-token");
    expect(
      await git("--git-dir", f.remote, "rev-parse", `refs/heads/${branch}`),
    ).toBe(commit);
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a remote without the handoff base still receives the branch as a full bundle", async () => {
  const f = await workspace();
  const elsewhere = join(f.dir, "elsewhere.git");
  await git("init", "--bare", elsewhere);
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
    git_base: f.base,
  };
  const branch = branchFor(w);
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branch);
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    const guest = localVm();
    const provider = new FreestyleProvider(
      sshConfig(f.dir, f.repo, elsewhere),
      { vms: { ref: () => guest.vm } } as unknown as Freestyle,
    );
    const pushed = await provider.pushBranch(w);
    expect(pushed).toEqual({
      branch,
      base_commit: f.base,
      commit,
    });
    // The first, smaller bundle is replaced by a self-contained one after the seed fails.
    const bundles = guest.commands.filter((x) => x.includes("bundle create"));
    expect(bundles.length).toBe(2);
    const spec = (x: string) =>
      x.slice(x.indexOf("bundle create"), x.indexOf("; printf"));
    expect(spec(bundles[0]!)).toContain('"$base"');
    expect(spec(bundles[1]!)).not.toContain('"$base"');
    expect(
      await git("--git-dir", elsewhere, "rev-parse", `refs/heads/${branch}`),
    ).toBe(commit);
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a bundle that does not match the reported commit is refused", async () => {
  const f = await workspace();
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
    git_base: f.base,
  };
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branchFor(w));
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    const guest = localVm();
    const run = guest.vm.exec;
    guest.vm.exec = async (input: { command: string }) => {
      const r = await run(input);
      if (r.statusCode === 0 && r.stdout.includes("\n"))
        r.stdout = `${f.base}\n${"c".repeat(40)}\n`;
      return r;
    };
    const provider = new FreestyleProvider(sshConfig(f.dir, f.repo, f.remote), {
      vms: { ref: () => guest.vm },
    } as unknown as Freestyle);
    await expect(provider.pushBranch(w)).rejects.toThrow(
      "does not match the reported commit",
    );
    expect(await branchOrNull(f.remote, `refs/heads/${branchFor(w)}`)).toBe(
      null,
    );
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a rewritten handoff base cannot replace the one recorded at prepare", async () => {
  const f = await workspace();
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
    git_base: f.base,
  };
  try {
    await git("-C", f.repo, "checkout", "-q", "-b", branchFor(w));
    writeFileSync(join(f.repo, "code.txt"), "changed");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "change");
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    const guest = localVm();
    const run = guest.vm.exec;
    guest.vm.exec = async (input: { command: string }) => {
      const r = await run(input);
      if (r.statusCode === 0 && r.stdout.includes("\n"))
        r.stdout = `${"d".repeat(40)}\n${commit}\n`;
      return r;
    };
    const provider = new FreestyleProvider(sshConfig(f.dir, f.repo, f.remote), {
      vms: { ref: () => guest.vm },
    } as unknown as Freestyle);
    await expect(provider.pushBranch(w)).rejects.toThrow(
      "does not match the base recorded at prepare",
    );
    expect(await branchOrNull(f.remote, `refs/heads/${branchFor(w)}`)).toBe(
      null,
    );
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a re-prepare keeps the branch point the control plane recorded", async () => {
  const store = new Store(":memory:");
  const provider = new FakeProvider();
  // A deployment that hands off, so a branch point is recorded at prepare.
  provider.handoff = true;
  provider.gitBase = "a".repeat(40);
  const agent = new FakeAgent();
  const c = {
    ...config,
    SWARMFORGE_GIT_PUSH_MODE: "ssh" as const,
    SWARMFORGE_GIT_PUSH_URL: "git@example:repo.git",
    SWARMFORGE_GIT_SSH_KEY_PATH: "/key",
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: "/hosts",
  };
  const coordinator = new Coordinator(c, store, provider, agent);
  const h = { store, provider, agent, coordinator };
  try {
    const w = coordinator.spawn(task);
    await runToRunning(h, w.worker_id);
    expect(store.get(w.worker_id).git_base).toBe("a".repeat(40));
    // Messaging a failed worker boots it again, which prepares the workspace a second
    // time. By now the guest owns the base file the provider reports.
    store.transition(w.worker_id, "failed", { error: "task failed" });
    provider.gitBase = "d".repeat(40);
    await coordinator.message(w.worker_id, "try again");
    expect(store.get(w.worker_id).state).toBe("booting");
    await coordinator.tick();
    // The guest-reported branch point is discarded; the recorded one still stands.
    expect(store.get(w.worker_id).git_base).toBe("a".repeat(40));
    expect(store.get(w.worker_id).state).toBe("ready");
  } finally {
    store.close();
  }
});

test("the published tree carries a blob id, not just a length", async () => {
  const f = await workspace();
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
  };
  try {
    const c = sshConfig(f.dir, f.repo, f.remote);
    // The recorded base reports "code.txt" with the object id the repository stores.
    expect(await recordedTree(c, f.repo, f.base)).toEqual(
      new Map([
        [
          "code.txt",
          {
            size: 4,
            oid: await git("-C", f.repo, "rev-parse", "HEAD:code.txt"),
          },
        ],
      ]),
    );
    // A published branch reports the ids of its own blobs, so a same-length edit is
    // detectable by comparing content rather than length.
    await git("-C", f.repo, "checkout", "-q", "-b", branchFor(w));
    writeFileSync(join(f.repo, "code.txt"), "later");
    await git("-C", f.repo, "add", ".");
    await git("-C", f.repo, "commit", "-m", "later");
    const commit = await git("-C", f.repo, "rev-parse", "HEAD");
    await git(
      "-C",
      f.repo,
      "push",
      "-q",
      "origin",
      `HEAD:refs/heads/${branchFor(w)}`,
    );
    const published = await publishedTree(c, f.remote, branchFor(w), commit);
    expect(published.get("code.txt")).toEqual({
      size: 5,
      oid: await git("-C", f.repo, "rev-parse", "HEAD:code.txt"),
    });
  } finally {
    store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

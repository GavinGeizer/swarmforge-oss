import { expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Freestyle } from "freestyle";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import { branchFor, githubInstallationToken } from "../src/git-handoff";
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

test("SSH handoff keeps the key out of Git commands and removes it after push failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-ssh-"));
  const key = join(dir, "key");
  const hosts = join(dir, "known_hosts");
  writeFileSync(key, "PRIVATE TEST KEY");
  writeFileSync(hosts, "git.example ssh-ed25519 AAAA");
  const commands: string[] = [];
  const writes: { path: string; content: string; mode?: number }[] = [];
  const fakeClient = {
    vms: {
      ref: () => ({
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
            statusCode: command.includes("git push") ? 1 : 0,
            stdout: "",
            stderr: "",
          };
        },
      }),
    },
  } as unknown as Freestyle;
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
  });
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
  };
  try {
    await expect(
      new FreestyleProvider(c, fakeClient).pushBranch(w),
    ).rejects.toThrow("Git push or remote commit verification failed");
    expect(writes).toEqual([
      {
        path: "/opt/swarmforge/git-secret",
        content: "PRIVATE TEST KEY",
        mode: 0o600,
      },
      {
        path: "/opt/swarmforge/git-auth",
        content: "git.example ssh-ed25519 AAAA",
        mode: 0o600,
      },
    ]);
    expect(
      commands.some(
        (x) =>
          x.includes("git push") &&
          x.includes(branchFor(w)) &&
          x.includes("git ls-remote"),
      ),
    ).toBe(true);
    expect(commands.at(-1)).toContain("rm -f");
    expect(commands.join(" ")).not.toContain("PRIVATE TEST KEY");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker checkout gets a task branch and local Git author identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-prepare-"));
  const key = join(dir, "key");
  const hosts = join(dir, "hosts");
  writeFileSync(key, "unused");
  writeFileSync(hosts, "unused");
  const commands: string[] = [];
  const vm = {
    fs: { writeTextFile: async () => undefined },
    exec: async ({ command }: { command: string }) => {
      commands.push(command);
      return { statusCode: 0, stdout: "", stderr: "" };
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
  });
  const store = new Store(":memory:");
  const w = {
    ...store.create({ ...task, timeout_seconds: 60 }),
    vm_id: "vm-1",
  };
  try {
    await new FreestyleProvider(c, {
      vms: { ref: () => vm },
    } as unknown as Freestyle).prepare(w);
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
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push command publishes a real commit to a branch and verifies its remote SHA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-push-"));
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  const control = join(dir, ".swarmforge");
  const run = async (...args: string[]) => {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(p.stdout).text();
    const error = await new Response(p.stderr).text();
    if ((await p.exited) !== 0) throw new Error(error);
    return output.trim();
  };
  try {
    mkdirSync(control);
    await run("git", "init", "--bare", remote);
    await run("git", "init", repo);
    await run("git", "-C", repo, "config", "user.name", "Test");
    await run("git", "-C", repo, "config", "user.email", "test@example.test");
    writeFileSync(join(repo, "code.txt"), "base");
    await run("git", "-C", repo, "add", ".");
    await run("git", "-C", repo, "commit", "-m", "base");
    const base = await run("git", "-C", repo, "rev-parse", "HEAD");
    writeFileSync(join(control, "git-base"), `${base}\n`);
    const store = new Store(":memory:");
    const w = {
      ...store.create({ ...task, timeout_seconds: 60 }),
      vm_id: "vm-1",
    };
    await run("git", "-C", repo, "checkout", "-b", branchFor(w));
    writeFileSync(join(repo, "code.txt"), "changed");
    await run("git", "-C", repo, "add", ".");
    await run("git", "-C", repo, "commit", "-m", "change");
    const key = join(dir, "key");
    const hosts = join(dir, "hosts");
    writeFileSync(key, "unused");
    writeFileSync(hosts, "unused");
    const vm = {
      fs: { writeTextFile: async () => undefined },
      exec: async ({ command }: { command: string }) => {
        if (command.startsWith("rm -f"))
          return { statusCode: 0, stdout: "", stderr: "" };
        const p = Bun.spawn(["bash", "-c", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(p.stdout).text();
        const stderr = await new Response(p.stderr).text();
        return { statusCode: await p.exited, stdout, stderr };
      },
    };
    const c = loadConfig({
      FREESTYLE_API_TOKEN: "secret",
      FREESTYLE_SNAPSHOT_ID: "snap",
      SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
      SWARMFORGE_MODEL_API_KEY: "key",
      SWARMFORGE_MODEL_NAME: "qwen",
      SWARMFORGE_GIT_TREE: repo,
      SWARMFORGE_GIT_PUSH_MODE: "ssh",
      SWARMFORGE_GIT_PUSH_URL: remote,
      SWARMFORGE_GIT_SSH_KEY_PATH: key,
      SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: hosts,
      SWARMFORGE_WORKSPACE: dir,
    });
    const provider = new FreestyleProvider(c, {
      vms: { ref: () => vm },
    } as unknown as Freestyle);
    const pushed = await provider.pushBranch(w);
    expect(pushed).toEqual({
      branch: branchFor(w),
      base_commit: base,
      commit: await run("git", "-C", repo, "rev-parse", "HEAD"),
    });
    expect(
      await run(
        "git",
        "--git-dir",
        remote,
        "rev-parse",
        `refs/heads/${branchFor(w)}`,
      ),
    ).toBe(pushed.commit);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

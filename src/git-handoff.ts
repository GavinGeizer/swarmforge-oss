import { createSign } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";

export class GitHandoffError extends Error {}
// A thin bundle needs its base commit from the remote; the caller retries with a full one.
export class BundlePrerequisiteError extends GitHandoffError {}
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export const maxBundleBytes = 64 * 1024 * 1024;

export function branchFor(w: {
  team_id: string;
  task_id: string;
  worker_id: string;
}) {
  const part = (value: string) =>
    value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "id";
  return `swarmforge/${part(w.team_id)}/${part(w.task_id)}/${part(w.worker_id)}`;
}

export async function githubInstallationToken(
  c: Config,
  fetcher: typeof fetch = fetch,
  permission: "read" | "write" = "write",
): Promise<string> {
  if (
    !c.SWARMFORGE_GITHUB_APP_ID ||
    !c.SWARMFORGE_GITHUB_INSTALLATION_ID ||
    !c.SWARMFORGE_GITHUB_PRIVATE_KEY_PATH ||
    !c.SWARMFORGE_GITHUB_REPOSITORY
  )
    throw new Error("GitHub App configuration is incomplete");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: c.SWARMFORGE_GITHUB_APP_ID,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer
    .sign(readFileSync(c.SWARMFORGE_GITHUB_PRIVATE_KEY_PATH))
    .toString("base64url");
  const response = await fetcher(
    `https://api.github.com/app/installations/${c.SWARMFORGE_GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${data}.${signature}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [c.SWARMFORGE_GITHUB_REPOSITORY.split("/")[1]],
        permissions: { contents: permission },
      }),
      signal: AbortSignal.timeout(c.SWARMFORGE_API_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new Error(`GitHub App token request failed (${response.status})`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("token" in body) ||
    typeof body.token !== "string" ||
    !body.token
  )
    throw new Error("GitHub App token response is invalid");
  return body.token;
}

export interface BundleSpec {
  repo: string;
  branch: string;
  base_file: string;
  out: string;
  self_contained?: boolean;
}
// Runs inside the worker, which the coding agent fully controls: no credential is placed
// there, repository hooks and system configuration are disabled, and the host verifies
// every claim the bundle makes before anything is published.
export function bundleCommand(s: BundleSpec) {
  return `set -eu; cd ${quote(s.repo)}; test "$(git branch --show-current)" = ${quote(s.branch)}; test -z "$(git status --porcelain --untracked-files=all)"; base=$(cat ${quote(s.base_file)}); commit=$(git rev-parse HEAD); env GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null merge-base --is-ancestor "$base" "$commit"; rm -f ${quote(s.out)}; env GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null bundle create ${quote(s.out)} ${quote(`refs/heads/${s.branch}`)}${s.self_contained ? "" : ' "$base"'}; printf '%s\n%s\n' "$base" "$commit"`;
}

// Host Git never inherits ambient Git configuration: only the handoff environment below.
const hostEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
);

async function git(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    env: { ...hostEnv, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

export interface Handoff {
  target: string;
  branch: string;
  base: string;
  commit: string;
  bundle: Uint8Array;
  self_contained: boolean;
}

// The only place a write credential is used: this process, on the control-plane host.
// `read` never reaches for it when a read-only key or token is available.
async function hostCredentials(
  c: Config,
  dir: string,
  purpose: "push" | "read",
  fetcher: typeof fetch,
): Promise<Record<string, string>> {
  const ssh = (key?: string, hosts?: string): Record<string, string> => {
    if (!key || !hosts) return {};
    return {
      GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${hosts}`,
    };
  };
  if (c.SWARMFORGE_GIT_PUSH_MODE === "github-app") {
    const token = await githubInstallationToken(
      c,
      fetcher,
      purpose === "push" ? "write" : "read",
    );
    const secret = join(dir, "token");
    const askpass = join(dir, "askpass");
    writeFileSync(secret, token, { mode: 0o600 });
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf x-access-token;; *) cat "$SF_GIT_TOKEN_FILE";; esac\n',
      { mode: 0o700 },
    );
    return { GIT_ASKPASS: askpass, SF_GIT_TOKEN_FILE: secret };
  }
  if (c.SWARMFORGE_GIT_PUSH_MODE === "ssh") {
    const push = ssh(
      c.SWARMFORGE_GIT_SSH_KEY_PATH,
      c.SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH,
    );
    if (purpose === "push") return push;
    // A read-only key is preferred; the write key is a host-side fallback only.
    return {
      ...push,
      ...ssh(
        c.SWARMFORGE_GIT_SSH_CLONE_KEY_PATH,
        c.SWARMFORGE_GIT_SSH_CLONE_KNOWN_HOSTS_PATH,
      ),
    };
  }
  throw new GitHandoffError("Git access is not configured");
}

export async function publishBundle(
  c: Config,
  handoff: Handoff,
  fetcher: typeof fetch = fetch,
): Promise<{ branch: string; base_commit: string; commit: string }> {
  const { target, branch, base, commit, bundle } = handoff;
  if (handoff.bundle.length > maxBundleBytes)
    throw new GitHandoffError("Git handoff bundle is too large to publish");
  const dir = mkdtempSync(join(tmpdir(), "swarmforge-handoff-"));
  chmodSync(dir, 0o700);
  try {
    const hooks = join(dir, "hooks");
    mkdirSync(hooks);
    const bundlePath = join(dir, "handoff.bundle");
    writeFileSync(bundlePath, bundle, { mode: 0o600 });
    const repo = join(dir, "handoff.git");
    // Host Git ignores guest-reachable configuration: a fresh repository, no system or
    // global config, no hooks, and object checks while the untrusted bundle is read.
    const guard = [
      "-c",
      `core.hooksPath=${hooks}`,
      "-c",
      "transfer.fsckObjects=true",
    ];
    const env = {
      ...(await hostCredentials(c, dir, "push", fetcher)),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    };
    if ((await git([...guard, "init", "--bare", "--quiet", repo], env)).code)
      throw new GitHandoffError("Host Git repository setup failed");
    if (!handoff.self_contained) {
      const seed = await git(
        [
          ...guard,
          "-C",
          repo,
          "fetch",
          "--no-tags",
          "--quiet",
          "--",
          target,
          base,
        ],
        env,
      );
      if (seed.code)
        throw new BundlePrerequisiteError(
          "Remote cannot provide the handoff base commit",
        );
    }
    const loaded = await git(
      [
        ...guard,
        "-C",
        repo,
        "fetch",
        "--no-tags",
        "--quiet",
        "--",
        bundlePath,
        `+refs/heads/${branch}:refs/heads/${branch}`,
      ],
      env,
    );
    if (loaded.code)
      throw new GitHandoffError("Git handoff bundle could not be read");
    const head = await git(
      [
        "-C",
        repo,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}^{commit}`,
      ],
      env,
    );
    if (head.code || head.stdout.trim() !== commit)
      throw new GitHandoffError(
        "Git handoff bundle does not match the reported commit",
      );
    const ancestry = await git(
      [...guard, "-C", repo, "merge-base", "--is-ancestor", base, commit],
      env,
    );
    if (ancestry.code)
      throw new GitHandoffError(
        "Git handoff base is not an ancestor of the reported commit",
      );
    const pushed = await git(
      [
        ...guard,
        "-C",
        repo,
        "push",
        "--quiet",
        "--",
        target,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ],
      env,
    );
    if (pushed.code)
      throw new GitHandoffError(
        `Host Git push failed: ${pushed.stderr.trim().slice(0, 200)}`,
      );
    const remote = await git(
      ["ls-remote", "--", target, `refs/heads/${branch}`],
      env,
    );
    const remoteSha = remote.stdout.split(/\s+/)[0] ?? "";
    if (remote.code || remoteSha !== commit)
      throw new GitHandoffError(
        "Remote branch does not hold the pushed commit",
      );
    return { branch, base_commit: base, commit };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hardenedEnv = (extra: Record<string, string>) => ({
  ...extra,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
});

// The published tree of a branch SwarmForge pushed, read from the remote on the host.
export async function publishedTree(
  c: Config,
  target: string,
  branch: string,
  commit: string,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, number>> {
  return treeAt(c, target, `refs/heads/${branch}`, commit, fetcher);
}

// The recorded branch point is only meaningful while the remote still serves it, so the
// remote default branch is fetched and the commit is proven to be an ancestor of it.
export async function recordedTree(
  c: Config,
  target: string,
  commit: string,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, number>> {
  return treeAt(c, target, "HEAD", commit, fetcher);
}

async function treeAt(
  c: Config,
  target: string,
  ref: string,
  commit: string,
  fetcher: typeof fetch,
): Promise<Map<string, number>> {
  const dir = mkdtempSync(join(tmpdir(), "swarmforge-handoff-"));
  chmodSync(dir, 0o700);
  try {
    const repo = join(dir, "read.git");
    const env = hardenedEnv(await hostCredentials(c, dir, "read", fetcher));
    if ((await git(["init", "--bare", "--quiet", repo], env)).code)
      throw new GitHandoffError("Host Git repository setup failed");
    const fetched = await git(
      ["-C", repo, "fetch", "--no-tags", "--quiet", "--", target, ref],
      env,
    );
    if (fetched.code)
      throw new GitHandoffError("Host could not read the configured tree");
    const reachable = await git(
      ["-C", repo, "merge-base", "--is-ancestor", commit, "FETCH_HEAD"],
      env,
    );
    if (reachable.code)
      throw new GitHandoffError("The recorded commit is no longer published");
    const tree = await git(
      ["-C", repo, "ls-tree", "-r", "-l", "-z", commit],
      env,
    );
    if (tree.code)
      throw new GitHandoffError("Host could not read the published tree");
    const files = new Map<string, number>();
    for (const entry of tree.stdout.split("\0")) {
      // "<mode> <type> <object> <size>\t<path>"; submodules carry no local content.
      const [meta, path] = entry.split("\t");
      const parts = meta?.trim().split(/\s+/) ?? [];
      if (!path || parts[1] !== "blob") continue;
      const size = Number(parts[3]);
      files.set(path, Number.isSafeInteger(size) ? size : -1);
    }
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

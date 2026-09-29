import { createHash } from "node:crypto";
import type { Config } from "./config";
import type { FileInfo, Worker, WorkerProvider, WorkerResult } from "./domain";
import {
  branchFor,
  type PublishedFile,
  publishedTree,
  recordedTree,
} from "./git-handoff";

export interface WorkspaceEntry {
  size: number;
  modified: string;
  // A link is matched by presence; the file API cannot report a stable target length.
  link?: boolean;
}
export interface WorkspaceFs {
  listFiles(id: string, path: string): Promise<FileInfo[]>;
  stat(
    id: string,
    path: string,
  ): Promise<{
    size: number;
    isFile: boolean;
    isSymlink: boolean;
    modified: string;
  }>;
  // Content is read through the same control-plane API, so a host-side hash can be
  // compared with a published blob id without the guest resolving anything.
  readFile(
    id: string,
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
}
export interface WorkspaceRoot {
  root: string;
  files: Map<string, WorkspaceEntry>;
  // Repository directories below this root, as paths relative to it; "" is the root.
  gitRoots: Set<string>;
}
export interface WorkspaceSnapshot {
  roots: WorkspaceRoot[];
  files: number;
}
const skipped = new Set([".git", ".swarmforge", "node_modules", ".cache"]);
const walkLimits = { files: 5000, directories: 1000 };

// Read through the control-plane file API only. Nothing in the guest resolves a command,
// so PATH shadowing, a replaced `git` or a forged report cannot change the outcome.
export async function inspectWorkspace(
  fs: WorkspaceFs,
  id: string,
  roots: string[],
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = { roots: [], files: 0 };
  for (const root of [...new Set(roots)].sort()) {
    const files = new Map<string, WorkspaceEntry>();
    const gitRoots = new Set<string>();
    snapshot.roots.push({ root, files, gitRoots });
    const queue: { path: string; relative: string }[] = [
      { path: root, relative: "" },
    ];
    let directories = 0;
    while (queue.length) {
      if (++directories > walkLimits.directories)
        throw new Error("more than 1000 directories");
      const current = queue.shift()!;
      for (const entry of await fs.listFiles(id, current.path)) {
        if (
          !entry?.name ||
          entry.name === "." ||
          entry.name === ".." ||
          entry.name.includes("/") ||
          entry.name.includes("\\") ||
          entry.name.includes("\0")
        )
          throw new Error("unusable directory entry");
        const path = `${current.path}/${entry.name}`;
        const relative = current.relative
          ? `${current.relative}/${entry.name}`
          : entry.name;
        const kind = entry.kind === "directory" ? "directory" : "unknown";
        if (kind === "unknown") {
          const stat = await fs.stat(id, path);
          if (stat.isSymlink || stat.isFile) {
            files.set(relative, {
              size: stat.size,
              modified: stat.modified,
              // A listing reports a link as one, and `stat` follows it to its target, so
              // both are consulted before a file is read as ordinary content.
              ...(stat.isSymlink || entry.kind === "symlink"
                ? { link: true }
                : {}),
            });
            if (++snapshot.files > walkLimits.files)
              throw new Error("more than 5000 files");
            continue;
          }
        }
        if (entry.name === ".git") {
          gitRoots.add(current.relative);
          continue;
        }
        if (skipped.has(entry.name)) continue;
        queue.push({ path, relative });
      }
    }
  }
  return snapshot;
}

export function workspaceDigest(snapshot: WorkspaceSnapshot, roots?: string[]) {
  const wanted = roots ? new Set(roots) : null;
  const lines: string[] = [];
  for (const { root, files } of snapshot.roots) {
    if (wanted && !wanted.has(root)) continue;
    for (const [path, entry] of files)
      lines.push(
        `${root}\0${path}\0${entry.size}\0${entry.modified.replace(/\0/g, "")}`,
      );
  }
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// Only a push the control plane made and verified counts: local branches, remote-tracking
// refs and reflogs are all guest-writable, so the guest never decides its own durability.
function verifiedCommit(w: Worker, result: WorkerResult | null) {
  const git = result?.git;
  if (!git?.persisted || git.branch !== branchFor(w)) return null;
  return /^[0-9a-f]{40,64}$/.test(git.commit ?? "") ? git.commit! : null;
}

const readChunk = 1024 * 1024;
function blobAlgorithm(oid: string): "sha1" | "sha256" | null {
  if (/^[0-9a-f]{40}$/.test(oid)) return "sha1";
  if (/^[0-9a-f]{64}$/.test(oid)) return "sha256";
  return null;
}

// A published file is only published if the workspace still holds its content. A file
// length is not an identity: a same-length uncommitted edit keeps it, so the host hashes
// what it reads through the file API and compares that with the published blob id.
async function matchesPublished(
  fs: WorkspaceFs,
  id: string,
  path: string,
  size: number,
  file: PublishedFile,
) {
  const algorithm = blobAlgorithm(file.oid);
  if (!algorithm) return false;
  if (file.size >= 0 && file.size !== size) return false;
  const hash = createHash(algorithm);
  hash.update(`blob ${size}\0`);
  let read = 0;
  try {
    while (read < size) {
      const chunk = await fs.readFile(
        id,
        path,
        read,
        Math.min(readChunk, size - read),
      );
      // Short or failed reads prove nothing, so the file is reported, never certified.
      if (!chunk.length) return false;
      hash.update(chunk);
      read += chunk.length;
    }
  } catch {
    return false;
  }
  return hash.digest("hex") === file.oid;
}

async function differs(
  fs: WorkspaceFs,
  id: string,
  snapshot: WorkspaceSnapshot,
  expected: Map<string, PublishedFile>,
) {
  const issues: string[] = [];
  for (const { root, files, gitRoots } of snapshot.roots) {
    // A repository at the root subsumes any nested one; never compare a path twice.
    const prefixes = gitRoots.has("") ? [""] : [...gitRoots].sort();
    for (const path of files.keys())
      if (!prefixes.some((p) => path.startsWith(p ? `${p}/` : "")))
        issues.push(`untracked ${path}`);
    for (const prefix of prefixes) {
      const start = prefix ? `${prefix}/` : "";
      const inRepo = new Map<string, { entry: WorkspaceEntry; path: string }>();
      for (const [path, entry] of files)
        if (path.startsWith(start))
          inRepo.set(path.slice(start.length), {
            entry,
            path: `${root}/${path}`,
          });
      for (const [published, { entry, path }] of inRepo) {
        const file = expected.get(published);
        if (file === undefined) issues.push(`untracked ${published}`);
        // A link is matched by presence; the file API cannot report a stable target.
        else if (
          !entry.link &&
          !(await matchesPublished(fs, id, path, entry.size, file))
        )
          issues.push(`modified ${published}`);
      }
      // Deletions are compared for an empty checkout too: a guest that removed every
      // published file must not be certified by the emptiness it caused. Skipped
      // directories are never walked, so their published files are not "deleted".
      for (const path of expected.keys())
        if (!inRepo.has(path) && !skipped.has(path.split("/")[0] ?? ""))
          issues.push(`deleted ${path}`);
    }
  }
  return issues;
}

// Published files an empty workspace no longer holds. Skipped directories are never
// walked, so their published files are not "deleted".
function absentFrom(expected: Map<string, PublishedFile>) {
  return [...expected.keys()].filter(
    (path) => !skipped.has(path.split("/")[0] ?? ""),
  );
}

export async function inspectPersistence(
  provider: WorkerProvider,
  c: Config,
  w: Worker,
  result: WorkerResult | null,
) {
  if (!w.vm_id) return { safe: true, reason: "no VM" };
  // The tree is read on the host, so only VM locations can hold unpersisted work.
  const reported = result?.git?.workspace;
  const candidates = [
    ...new Set([c.SWARMFORGE_WORKSPACE, ...(reported ? [reported] : [])]),
  ];
  // A reported directory inside the workspace is already covered by its parent.
  const roots = candidates.filter(
    (root) =>
      !candidates.some(
        (other) => other !== root && root.startsWith(`${other}/`),
      ),
  );
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = await inspectWorkspace(provider, w.vm_id, roots);
  } catch (error) {
    return {
      safe: false,
      reason: `Unable to inspect the workspace: ${String(
        (error as Error).message,
      ).slice(0, 200)}`,
    };
  }
  // The baseline is a control-plane observation of the workspace before the worker ran.
  if (
    w.workspace_digest &&
    workspaceDigest(snapshot, [c.SWARMFORGE_WORKSPACE]) === w.workspace_digest
  )
    return {
      safe: true,
      reason: "workspace unchanged since the worker was prepared",
    };
  // Files that no repository claims can never be covered by a handoff. An empty workspace
  // has none, so emptiness alone is not a verdict and the published tree decides below.
  if (snapshot.files && !snapshot.roots.some((r) => r.gitRoots.size))
    return { safe: false, reason: "files outside a Git repository" };
  const verified = verifiedCommit(w, result);
  const subject = verified
    ? "the verified remote branch"
    : "the recorded handoff base";
  let expected: Map<string, PublishedFile> | null = null;
  try {
    if (verified)
      expected = await publishedTree(
        c,
        c.SWARMFORGE_GIT_PUSH_MODE === "github-app"
          ? c.SWARMFORGE_GIT_TREE
          : c.SWARMFORGE_GIT_PUSH_URL!,
        branchFor(w),
        verified,
      );
    else if (w.git_base)
      expected = await recordedTree(c, c.SWARMFORGE_GIT_TREE, w.git_base);
  } catch (error) {
    return {
      safe: false,
      reason: `Unable to read ${subject}: ${String(
        (error as Error).message,
      ).slice(0, 200)}`,
    };
  }
  // Without a published tree no work was ever claimed, so an empty workspace is empty
  // of anything to lose; files on disk are still unpersisted.
  if (!expected)
    return snapshot.files
      ? {
          safe: false,
          reason: "local files are not covered by a verified handoff",
        }
      : { safe: true, reason: "no files to persist" };
  // An empty workspace is not evidence that nothing was lost: a guest that removed every
  // published file leaves exactly this snapshot. Deletions are compared against the
  // published tree before the workspace is ever certified safe.
  const issues = snapshot.files
    ? await differs(provider, w.vm_id, snapshot, expected)
    : absentFrom(expected).map((path) => `deleted ${path}`);
  if (issues.length)
    return {
      safe: false,
      reason:
        `${issues.length} workspace file(s) differ from ${subject}: ${issues
          .slice(0, 5)
          .join(", ")}`.slice(0, 1000),
    };
  return snapshot.files
    ? { safe: true, reason: `workspace matches ${subject}` }
    : {
        safe: true,
        reason: `workspace is empty and ${subject} holds no files`,
      };
}

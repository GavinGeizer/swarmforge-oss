import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type {
  ArtifactEntry,
  ArtifactListing,
  ArtifactTransfer,
  WorkerArtifactTransport,
} from "../src/artifact-types";

// Intentional unit seam, not a stand-in for the production helper.
//
// The package 1 local transport fixture (tests/local-artifact-provider.ts) is the production
// capture path and must replace this file for the artifact capture tests. Until it exists, this
// double exists only so the manager API, download and metrics tests can run against real bytes,
// sizes, checksums and a real gzip archive without a VM; it deliberately does NOT emulate the
// guest helper's security properties (descriptor-relative O_NOFOLLOW opens, staging, symlink
// races), which are package 1's tests to prove. Layout mirrors the plan's workspace-relative
// contract: <root>/<vm_id><workspace>/<path>.
export function guestRoot() {
  return mkdtempSync(join(tmpdir(), "swarmforge-guest-"));
}
export function guestDir(root: string, vmId: string, workspace: string) {
  return join(root, vmId, workspace.replace(/^\/+/, ""));
}
export function guestFile(
  root: string,
  vmId: string,
  workspace: string,
  path: string,
) {
  const base = resolve(guestDir(root, vmId, workspace));
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(base + sep))
    throw new Error("path escapes the guest workspace");
  return target;
}
export function writeGuestFile(
  root: string,
  vmId: string,
  workspace: string,
  path: string,
  content: string | Uint8Array,
) {
  const target = guestFile(root, vmId, workspace, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  return target;
}
export function linkGuestFile(
  root: string,
  vmId: string,
  workspace: string,
  path: string,
  target: string,
) {
  const link = guestFile(root, vmId, workspace, path);
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(target, link);
}
export function destroyGuestWorkspace(root: string, vmId: string) {
  rmSync(join(root, vmId), { recursive: true, force: true });
}
function hasControl(value: string) {
  for (const code of value) if (code < " " || code === "\x7f") return true;
  return false;
}
export function relative(value: string) {
  if (
    !value ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    hasControl(value) ||
    value.split("/").length > 32 ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("invalid workspace-relative path");
  return value;
}
// The digest is computed with a fixed-size buffer, so no read is buffered whole, and the
// transfer is then a second real read of the same bytes.
function transferOf(target: string, filename: string): ArtifactTransfer {
  const size = lstatSync(target).size;
  const buffer = new Uint8Array(65536);
  const hash = createHash("sha256");
  const handle = openSync(target, "r");
  try {
    while (true) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  const node = Readable.toWeb(
    createReadStream(target, { highWaterMark: 65536 }),
  ) as unknown as ReadableStream<Uint8Array>;
  return {
    stream: node,
    size,
    sha256: hash.digest("hex"),
    filename,
    cleanup: async () => {},
  };
}
export function guestTransport(root: string): WorkerArtifactTransport {
  const base = (vmId: string, workspace: string) =>
    guestDir(root, vmId, workspace);
  const regular = (target: string) => {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("artifact is not a regular file");
    return info.size;
  };
  return {
    list: async (
      vmId: string,
      workspace: string,
      path: string,
      options: {
        offset?: number;
        limit?: number;
        signal?: AbortSignal;
        maxEntries?: number;
        maxDepth?: number;
      } = {},
    ): Promise<ArtifactListing> => {
      if (options.signal?.aborted) throw new Error("transfer aborted");
      const directory = path
        ? join(base(vmId, workspace), relative(path))
        : base(vmId, workspace);
      if (!existsSync(directory)) throw new Error("no such worker directory");
      const names = readdirSync(directory);
      if (
        names.some((name) => lstatSync(join(directory, name)).isSymbolicLink())
      )
        throw new Error("symlink entries are refused");
      const entries: ArtifactEntry[] = names
        .map((name) => {
          const info = lstatSync(join(directory, name));
          return {
            name,
            kind: info.isDirectory()
              ? "directory"
              : info.isFile()
                ? "file"
                : "other",
            ...(info.isFile() ? { size: info.size } : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const max = options.maxEntries ?? 1000;
      if (entries.length > max)
        throw new Error("directory exceeds the configured entry maximum");
      const offset = options.offset ?? 0;
      const limit = options.limit ?? entries.length;
      return {
        entries: entries.slice(offset, offset + limit),
        next_offset: offset + limit < entries.length ? offset + limit : null,
      };
    },
    open: async (
      vmId: string,
      workspace: string,
      path: string,
      options: { maxBytes: number; signal?: AbortSignal },
    ): Promise<ArtifactTransfer> => {
      if (options.signal?.aborted) throw new Error("transfer aborted");
      const target = guestFile(root, vmId, workspace, relative(path));
      const size = regular(target);
      if (size > options.maxBytes)
        throw new Error("artifact exceeds the configured maximum size");
      return transferOf(target, path.split("/").pop()!);
    },
    snapshot: async (
      vmId: string,
      workspace: string,
      options: {
        paths?: string[];
        maxBytes: number;
        maxEntries: number;
        maxDepth: number;
        signal?: AbortSignal;
      },
    ): Promise<ArtifactTransfer> => {
      if (options.signal?.aborted) throw new Error("transfer aborted");
      const directory = base(vmId, workspace);
      const staging = mkdtempSync(join(tmpdir(), "swarmforge-archive-"));
      const archive = join(staging, "workspace.tar.gz");
      const proc = Bun.spawn(
        [
          "tar",
          "--create",
          "--gzip",
          "--file",
          archive,
          "--exclude=.git",
          "--exclude=node_modules",
          "--directory",
          directory,
          ...(options.paths ?? ["."]),
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if ((await proc.exited) !== 0)
        throw new Error("guest snapshot helper failed");
      const size = regular(archive);
      if (size > options.maxBytes)
        throw new Error("snapshot exceeds the configured maximum size");
      const result = transferOf(archive, "workspace.tar.gz");
      return {
        ...result,
        cleanup: async () => rmSync(staging, { recursive: true, force: true }),
      };
    },
    diagnostics: async () => [],
  };
}

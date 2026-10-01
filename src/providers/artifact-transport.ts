import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  type ArtifactDiagnostic,
  type ArtifactDiagnosticsOptions,
  type ArtifactListing,
  type ArtifactListingOptions,
  type ArtifactOpenOptions,
  type ArtifactSnapshotOptions,
  safeFilename,
  validateRelativePath,
  validateRoot,
  type WorkerArtifactTransport,
} from "../artifact-types";
import { artifactHelperSource } from "./artifact-helper";

export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Private staging root inside a guest: root-owned, 0700, never a workspace path. */
export const guestStagingRoot = "/opt/swarmforge/staging";
export const guestHelperPath = "/opt/swarmforge/artifact-helper.py";

export interface ArtifactExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * The two primitives a capture helper needs from a host: a small exec whose
 * response carries metadata only, and a raw byte stream for the staged file.
 * Keeping them separate is what stops any file content from crossing a command
 * response, and it is why the transport is provider-neutral.
 */
export interface ArtifactHost {
  exec(
    vmId: string,
    command: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ArtifactExecResult>;
  openRaw(
    vmId: string,
    path: string,
    options: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
  writeRaw?(
    vmId: string,
    path: string,
    bytes: Uint8Array,
    options: { mode: number },
  ): Promise<void>;
  /** Private staging directory for this VM, outside any workspace root. */
  stagingDir(vmId: string): string;
}

export interface HelperTransportOptions {
  helperPath?: string;
  python?: string;
  /** Wall-clock bound for one helper run and one capture. */
  timeoutMs?: number;
  installTimeoutMs?: number;
}

interface HelperMetadata {
  name: string;
  size: number;
  sha256: string;
  filename?: string;
  total_size?: number;
  truncated?: boolean;
  entries?: number;
  timed_out?: boolean;
  sources_failed?: number;
}

interface ListMetadata {
  entries: ArtifactListing["entries"];
  next_offset: number | null;
  truncated?: boolean;
  total?: number;
}

export class ArtifactTransportError extends Error {}

/**
 * Runs the trusted Python helper inside a guest and turns its small metadata
 * response plus a raw staged-file stream into an {@link ArtifactTransfer}.
 *
 * Nothing here reads a workspace path through the host filesystem API: the
 * helper opens each component descriptor-relatively with O_NOFOLLOW, stages a
 * bounded copy, and the bytes then travel over the ordinary binary filesystem
 * transport. There is no stat-then-read pair to race.
 */
export class HelperArtifactTransport implements WorkerArtifactTransport {
  readonly helperPath: string;
  readonly python: string;
  readonly timeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly installed = new Map<string, Promise<void>>();

  constructor(
    readonly host: ArtifactHost,
    options: HelperTransportOptions = {},
  ) {
    this.helperPath = options.helperPath ?? guestHelperPath;
    this.python = options.python ?? "python3";
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.installTimeoutMs = options.installTimeoutMs ?? 30000;
  }

  async list(
    vmId: string,
    root: string,
    path: string,
    options: ArtifactListingOptions = {},
  ): Promise<ArtifactListing> {
    await this.ensureHelper(vmId, options.signal);
    const meta = await this.run<ListMetadata>(
      vmId,
      {
        op: "list",
        root: validateRoot(root),
        path: path === "" ? "" : validateRelativePath(path),
        offset: options.offset ?? 0,
        limit: options.limit ?? 100,
        max_entries: options.maxEntries ?? 1000,
        max_depth: options.maxDepth ?? 32,
      },
      options.signal,
    );
    return {
      entries: meta.entries ?? [],
      next_offset: meta.next_offset ?? null,
      ...(meta.truncated === undefined ? {} : { truncated: meta.truncated }),
      ...(meta.total === undefined ? {} : { total: meta.total }),
    };
  }

  async open(
    vmId: string,
    root: string,
    path: string,
    options: ArtifactOpenOptions,
  ) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
      throw new Error("Artifact transfer requires a positive byte bound");
    const validated = validateRelativePath(path);
    const staging = await this.stage(vmId, options.signal);
    const name = `open-${randomUUID()}`;
    try {
      const meta = await this.run<HelperMetadata>(
        vmId,
        {
          op: "open",
          root: validateRoot(root),
          path: validated,
          staging,
          name,
          max_bytes: options.maxBytes,
          offset: options.offset ?? 0,
          ...(options.length === undefined ? {} : { length: options.length }),
        },
        options.signal,
      );
      return await this.transfer(
        vmId,
        staging,
        name,
        meta,
        meta.filename ?? validated.split("/").at(-1)!,
        options.signal,
      );
    } catch (error) {
      await this.discard(vmId, staging);
      throw error;
    }
  }

  async snapshot(vmId: string, root: string, options: ArtifactSnapshotOptions) {
    const paths = (options.paths ?? []).map((path) =>
      validateRelativePath(path),
    );
    const staging = await this.stage(vmId, options.signal);
    const name = `snapshot-${randomUUID()}`;
    try {
      const meta = await this.run<HelperMetadata>(
        vmId,
        {
          op: "snapshot",
          root: validateRoot(root),
          paths,
          staging,
          name,
          max_bytes: options.maxBytes,
          max_entries: options.maxEntries,
          max_depth: options.maxDepth,
        },
        options.signal,
      );
      const transfer = await this.transfer(
        vmId,
        staging,
        name,
        meta,
        `${safeFilename(paths[0]?.split("/").at(-1) ?? "workspace", "workspace")}-snapshot.tar.gz`,
        options.signal,
      );
      return {
        ...transfer,
        ...(meta.truncated === undefined ? {} : { truncated: meta.truncated }),
        ...(meta.entries === undefined ? {} : { entries: meta.entries }),
      };
    } catch (error) {
      await this.discard(vmId, staging);
      throw error;
    }
  }

  async diagnostics(
    vmId: string,
    root: string,
    options: ArtifactDiagnosticsOptions,
  ): Promise<ArtifactDiagnostic[]> {
    const validated = validateRoot(root);
    const staging = await this.stage(vmId, options.signal);
    try {
      // Journal and Git state are salvage evidence, not artifact content, so each
      // is staged as its own bounded file and never reaches a command response.
      const journal = await this.capture(vmId, staging, {
        key: "journal",
        path: "logs/opencode-journal.txt",
        sources: [
          {
            argv: [
              "journalctl",
              "-u",
              "swarmforge-opencode",
              "--no-pager",
              "-n",
              "2000",
              "-o",
              "cat",
            ],
          },
        ],
        root: validated,
        options,
      });
      const git = await this.capture(vmId, staging, {
        key: "git",
        path: "logs/git-report.txt",
        sources: [
          { argv: gitCommand(validated, ["status", "--porcelain=v1", "-b"]) },
          { argv: gitCommand(validated, ["log", "--oneline", "-n", "200"]) },
        ],
        root: validated,
        options,
      });
      return [
        { path: "logs/opencode-journal.txt", transfer: journal },
        { path: "logs/git-report.txt", transfer: git },
      ];
    } catch (error) {
      await this.discard(vmId, staging);
      throw error;
    }
  }

  /** Installs the helper and its private staging root once per VM. */
  async ensureHelper(vmId: string, signal?: AbortSignal): Promise<void> {
    const existing = this.installed.get(vmId);
    if (existing) return existing;
    const pending = (async () => {
      const staging = this.host.stagingDir(vmId);
      const helperDir = shellQuote(dirnameOf(this.helperPath));
      await this.host.exec(
        vmId,
        `mkdir -p -- ${helperDir} ${shellQuote(staging)} && chmod 700 -- ${shellQuote(staging)} && chmod 755 -- ${helperDir}`,
        { timeoutMs: this.installTimeoutMs, ...(signal ? { signal } : {}) },
      );
      if (!this.host.writeRaw)
        throw new Error("Artifact transport requires a raw file writer");
      await this.host.writeRaw(vmId, this.helperPath, artifactHelperSource(), {
        mode: 0o700,
      });
      const check = await this.host.exec(
        vmId,
        `${shellQuote(this.python)} -I -B -c 'import sys' && test -x ${shellQuote(this.helperPath)}`,
        { timeoutMs: this.installTimeoutMs, ...(signal ? { signal } : {}) },
      );
      if (check.code !== 0)
        throw new Error("Worker guest cannot run the artifact capture helper");
    })();
    this.installed.set(vmId, pending);
    try {
      await pending;
    } catch (error) {
      this.installed.delete(vmId);
      throw error;
    }
  }

  private async capture(
    vmId: string,
    staging: string,
    request: {
      key: string;
      path: string;
      sources: { argv: string[] }[];
      root: string;
      options: ArtifactDiagnosticsOptions;
    },
  ) {
    const { key, path, sources, root, options } = request;
    const name = `capture-${key}-${randomUUID()}`;
    const meta = await this.run<HelperMetadata>(
      vmId,
      {
        op: "capture",
        root,
        staging,
        name,
        max_bytes: options.maxBytes,
        timeout_ms: this.timeoutMs,
        sources,
      },
      options.signal,
    );
    return this.transfer(
      vmId,
      staging,
      name,
      meta,
      path.split("/").at(-1)!,
      options.signal,
    );
  }

  private async stage(vmId: string, signal?: AbortSignal): Promise<string> {
    await this.ensureHelper(vmId, signal);
    const staging = `${this.host.stagingDir(vmId)}/t-${randomUUID()}`;
    const created = await this.exec(
      vmId,
      `mkdir -m 700 -- ${shellQuote(staging)}`,
      signal,
    );
    if (created.code !== 0)
      throw new Error("Artifact staging directory could not be created");
    return staging;
  }

  private async transfer(
    vmId: string,
    staging: string,
    name: string,
    meta: HelperMetadata,
    filename: string,
    signal?: AbortSignal,
  ) {
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await this.discard(vmId, staging);
    };
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = asWebStream(
        await this.host.openRaw(vmId, `${staging}/${name}`, {
          ...(signal ? { signal } : {}),
        }),
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
    return {
      stream,
      size: meta.size,
      sha256: meta.sha256,
      filename: safeFilename(filename),
      cleanup,
    };
  }

  private async discard(vmId: string, staging: string) {
    try {
      await this.host.exec(vmId, `rm -rf -- ${shellQuote(staging)}`, {
        timeoutMs: this.installTimeoutMs,
      });
    } catch {
      // A guest that cannot remove its staging copy is reported by the next
      // capture attempt; nothing here may mask the original failure.
    }
  }

  private async run<T>(
    vmId: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const command = `${shellQuote(this.python)} -I -B ${shellQuote(this.helperPath)} ${shellQuote(JSON.stringify(request))}`;
    const result = await this.exec(vmId, command, signal);
    // Only the helper's own JSON is parsed. Its stdout is metadata by
    // construction and its stderr is never surfaced, so no file byte can be
    // quoted back into an error message.
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ArtifactTransportError(
        `Artifact capture returned no metadata (exit ${result.code ?? "none"})`,
      );
    }
    const payload = parsed as { ok?: unknown; error?: unknown };
    if (payload?.ok !== true)
      throw new ArtifactTransportError(
        typeof payload?.error === "string"
          ? payload.error.slice(0, 512)
          : "Artifact capture failed",
      );
    return parsed as T;
  }

  private async exec(
    vmId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<ArtifactExecResult> {
    if (signal?.aborted) throw new Error("Artifact transfer aborted");
    const timeoutMs = this.timeoutMs;
    const operation = this.host.exec(vmId, command, {
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (!signal) return operation;
    // The guest API has no abort channel for exec, so a local abort stops
    // waiting; the guest-side timeout still bounds the run itself.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Artifact transfer aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * A host may hand back either a web or a Node readable; callers always get a web
 * stream, so storage never has to know which transport produced it.
 */
function asWebStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (typeof (stream as { getReader?: unknown }).getReader === "function")
    return stream;
  return Readable.toWeb(
    stream as unknown as Readable,
  ) as unknown as ReadableStream<Uint8Array>;
}

function dirnameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

function gitCommand(root: string, arguments_: string[]): string[] {
  // The repository lives under the workspace, not at the workspace root.
  return ["git", "-c", "safe.directory=*", "-C", `${root}/repo`, ...arguments_];
}

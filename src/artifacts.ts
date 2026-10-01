import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  ArtifactRepository,
  type ArtifactStorage,
  LocalArtifactStorage,
} from "./artifact-store";
import {
  type ArtifactEntry,
  type ArtifactListing,
  type ArtifactListQuery,
  type ArtifactListResult,
  type ArtifactRecord,
  type ArtifactSnapshotRequest,
  type ArtifactTransfer,
  hasControlCharacter,
  isSha256,
  safeFilename,
  safeReadLimit,
  validateRelativePath,
  validateRoot,
  type WorkerArtifactTransport,
} from "./artifact-types";
import type { Config } from "./config";
import type { Coordinator } from "./coordinator";
import type { Worker, WorkerProvider } from "./domain";
import { redactorFor } from "./security";
import type { Store } from "./store";

/** Limits read from configuration, with the documented defaults applied. */
export interface ArtifactLimits {
  maxBytes: number;
  maxEntries: number;
  maxDepth: number;
  timeoutMs: number;
  concurrency: number;
}

const defaults: ArtifactLimits = {
  maxBytes: 1073741824,
  maxEntries: 10000,
  maxDepth: 32,
  timeoutMs: 120000,
  concurrency: 4,
};

function bound(
  config: Config,
  key: string,
  fallback: number,
  maximum: number,
): number {
  const raw = (config as unknown as Record<string, unknown>)[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

/**
 * Artifact limits as configured, or the documented defaults. Reading them this
 * way keeps the service usable against a configuration that has not yet grown
 * the artifact keys, and clamps them to safe integers either way.
 */
export function artifactLimits(config: Config): ArtifactLimits {
  return {
    maxBytes: bound(
      config,
      "SWARMFORGE_ARTIFACT_MAX_BYTES",
      defaults.maxBytes,
      2 ** 53,
    ),
    maxEntries: bound(
      config,
      "SWARMFORGE_ARTIFACT_MAX_ENTRIES",
      defaults.maxEntries,
      1_000_000,
    ),
    maxDepth: bound(
      config,
      "SWARMFORGE_ARTIFACT_MAX_DEPTH",
      defaults.maxDepth,
      32,
    ),
    timeoutMs: bound(
      config,
      "SWARMFORGE_ARTIFACT_TIMEOUT_MS",
      defaults.timeoutMs,
      900_000,
    ),
    concurrency: bound(
      config,
      "SWARMFORGE_ARTIFACT_CONCURRENCY",
      defaults.concurrency,
      64,
    ),
  };
}

export function artifactStorageDir(config: Config): string {
  const configured = (config as unknown as Record<string, unknown>)
    .SWARMFORGE_ARTIFACT_DIR;
  if (typeof configured === "string" && configured.trim()) {
    if (!isAbsolute(configured))
      throw new Error("SWARMFORGE_ARTIFACT_DIR must be an absolute path");
    return resolve(configured);
  }
  const database = (config as unknown as Record<string, unknown>)
    .SWARMFORGE_DB_PATH;
  if (
    typeof database === "string" &&
    database.trim() &&
    database !== ":memory:"
  )
    return resolve(database, "..", "artifacts");
  // An in-memory database has nowhere durable to sit, but the bytes still may
  // not land in a world-readable place.
  return mkdtempSync(resolve(tmpdir(), "swarmforge-artifacts-"));
}

export interface PreserveInput {
  signal?: AbortSignal;
  runId?: string | null;
  kind?: string;
}

/**
 * Preserves worker output into durable storage.
 *
 * Bytes leave a guest only as raw binary: the guest helper opens each path
 * descriptor-relatively, stages a bounded private copy and reports a small
 * metadata object, then the staged file is streamed in and verified against the
 * captured size and SHA-256. A failed or interrupted transfer leaves a durable
 * failed record and no stored bytes; a partial artifact is never visible.
 */
export class ArtifactService {
  readonly limits: ArtifactLimits;
  readonly storage: ArtifactStorage;
  readonly repository: ArtifactRepository;
  private readonly root: string;
  private readonly redactor: ReturnType<typeof redactorFor>;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly provider: WorkerProvider,
  ) {
    this.limits = artifactLimits(config);
    this.root = validateRoot(config.SWARMFORGE_WORKSPACE);
    this.storage = new LocalArtifactStorage(artifactStorageDir(config));
    this.repository = new ArtifactRepository(store.db);
    this.redactor = redactorFor({ config, store } as unknown as Coordinator);
    // A crash can leave a half-written temporary object; drop them once at
    // start rather than letting them accumulate on the coordinator host.
    void this.storage.sweepStale(this.limits.timeoutMs).catch(() => 0);
  }

  private transport(): WorkerArtifactTransport {
    const transport = (
      this.provider as { artifactTransport?: WorkerArtifactTransport }
    ).artifactTransport;
    if (!transport)
      throw new Error(
        "Worker provider does not support the artifact transport; refusing an unsafe stat/read capture",
      );
    return transport;
  }

  private guest(workerId: string): Worker {
    const worker = this.store.get(workerId);
    if (!worker.vm_id || worker.state === "destroyed" || worker.vm_missing)
      throw new Error("Worker has no VM to read artifacts from");
    return worker;
  }

  /** Bounds concurrent transfers so a burst cannot exhaust host or guest I/O. */
  private async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limits.concurrency) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolveWait, reject) => {
      const onAbort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== onAbort);
        reject(new Error("Artifact transfer aborted"));
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolveWait();
      };
      this.waiting.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.active++;
    return () => this.release();
  }
  private release() {
    this.active--;
    this.waiting.shift()?.();
  }

  /**
   * The durable record for one source: a preserved artifact keeps its identity
   * (so a retry is idempotent), while anything else starts a fresh attempt.
   */
  private record(
    worker: Worker,
    input: {
      existing: ArtifactRecord | null;
      runId: string | null;
      original_path: string;
      filename: string;
      kind: string;
    },
  ): { record: ArtifactRecord; rebegin: () => ArtifactRecord } {
    const begin = () =>
      this.repository.begin({
        worker_id: worker.worker_id,
        task_id: worker.task_id,
        run_id: input.runId,
        original_path: input.original_path,
        filename: input.filename,
        kind: input.kind,
      });
    // A preserved artifact keeps its identity while its bytes stay the same.
    return {
      record: input.existing?.state === "preserved" ? input.existing : begin(),
      rebegin: begin,
    };
  }

  /**
   * One preservation attempt. The record is durable before the transfer starts
   * and always ends in a terminal state: a failure raised before the transfer
   * (no transport, refused path, aborted signal) is recorded too, so no
   * `preserving` row is left claiming work that is no longer running.
   */
  private async attempt(
    record: ArtifactRecord,
    run: (
      transport: WorkerArtifactTransport,
      vmId: string,
      signal: AbortSignal,
    ) => Promise<ArtifactRecord | ArtifactRecord[]>,
    options: { signal?: AbortSignal },
  ): Promise<never> {
    try {
      return (await this.capture(
        record.worker_id,
        run as (
          transport: WorkerArtifactTransport,
          vmId: string,
          signal: AbortSignal,
        ) => Promise<ArtifactRecord>,
        options,
      )) as never;
    } catch (error) {
      if (this.repository.get(record.artifact_id).state === "preserving")
        throw this.fail(record, message(error));
      throw error instanceof Error ? error : new Error(message(error));
    }
  }

  private async capture<T>(
    workerId: string,
    run: (
      transport: WorkerArtifactTransport,
      vmId: string,
      signal: AbortSignal,
    ) => Promise<T>,
    options: { signal?: AbortSignal },
  ): Promise<T> {
    const worker = this.guest(workerId);
    const transport = this.transport();
    const signal = combine(options.signal, this.limits.timeoutMs);
    const release = await this.acquire(signal);
    try {
      return await run(transport, worker.vm_id!, signal);
    } finally {
      release();
    }
  }

  /** Preserves one workspace file or one bounded snapshot of a directory. */
  async preserve(
    workerId: string,
    path: string,
    options: PreserveInput = {},
  ): Promise<ArtifactRecord> {
    const requested = validateRelativePath(path);
    const kind = options.kind ?? "file";
    const runId = options.runId ?? null;
    const worker = this.guest(workerId);
    const existing = this.repository.find({
      worker_id: worker.worker_id,
      run_id: runId,
      original_path: requested,
      kind,
    });
    const { record, rebegin } = this.record(worker, {
      existing,
      runId,
      original_path: requested,
      filename: safeFilename(requested.split("/").at(-1)),
      kind,
    });
    return this.attempt(
      record,
      async (transport, vmId, signal) => {
        const transfer = await transport.open(vmId, this.root, requested, {
          maxBytes: this.limits.maxBytes,
          signal,
        });
        return this.ingest(record, existing, transfer, signal, rebegin);
      },
      options,
    );
  }

  /** Archives files and directories as one bounded, regular-files-only tar.gz. */
  async snapshot(
    workerId: string,
    options: ArtifactSnapshotRequest = {},
  ): Promise<ArtifactRecord> {
    const worker = this.guest(workerId);
    const paths = (options.paths ?? []).map((path) =>
      validateRelativePath(path),
    );
    const runId = options.runId ?? null;
    const original = `snapshot:${paths.length === 1 ? paths[0]! : paths.join(",")}`;
    const existing = this.repository.find({
      worker_id: worker.worker_id,
      run_id: runId,
      original_path: original,
      kind: "snapshot",
    });
    const { record, rebegin } = this.record(worker, {
      existing,
      runId,
      original_path: original,
      filename: `${safeFilename(paths[0]?.split("/").at(-1) ?? "workspace", "workspace")}-snapshot.tar.gz`,
      kind: "snapshot",
    });
    return this.attempt(
      record,
      async (transport, vmId, signal) => {
        const transfer = await transport.snapshot(vmId, this.root, {
          ...(paths.length ? { paths } : {}),
          maxBytes: this.limits.maxBytes,
          maxEntries: this.limits.maxEntries,
          maxDepth: this.limits.maxDepth,
          signal,
        });
        return this.ingest(record, existing, transfer, signal, rebegin);
      },
      options,
    );
  }

  /** Bounded journal and Git state, staged directly into private files. */
  async diagnostics(
    workerId: string,
    options: PreserveInput = {},
  ): Promise<ArtifactRecord[]> {
    const worker = this.guest(workerId);
    const runId = options.runId ?? null;
    const started: ArtifactRecord[] = [];
    try {
      return await this.capture(
        workerId,
        async (transport, vmId, signal) => {
          const captured = await transport.diagnostics(vmId, this.root, {
            maxBytes: this.limits.maxBytes,
            signal,
          });
          const records: ArtifactRecord[] = [];
          for (const item of captured) {
            const existing = this.repository.find({
              worker_id: worker.worker_id,
              run_id: runId,
              original_path: item.path,
              kind: "diagnostic",
            });
            const { record, rebegin } = this.record(worker, {
              existing,
              runId,
              original_path: item.path,
              filename: safeFilename(item.path.split("/").at(-1)),
              kind: "diagnostic",
            });
            started.push(record);
            records.push(
              await this.ingest(
                record,
                existing,
                item.transfer,
                signal,
                rebegin,
              ),
            );
          }
          return records;
        },
        options,
      );
    } catch (error) {
      // Any diagnostic still marked in flight failed with the collection.
      for (const record of started)
        if (this.repository.get(record.artifact_id).state === "preserving")
          this.repository.failed(record, message(error));
      throw error instanceof Error ? error : new Error(message(error));
    }
  }

  /** Every regular file in a live guest directory, with directories snapshotted. */
  async collectDirectory(
    workerId: string,
    path: string,
    options: PreserveInput = {},
  ): Promise<ArtifactRecord[]> {
    const directory = validateRelativePath(path);
    const listing = await this.listWorkerFiles(workerId, directory, {
      limit: this.limits.maxEntries,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const records: ArtifactRecord[] = [];
    for (const entry of listing.entries) {
      const child = `${directory}/${entry.name}`;
      if (entry.kind === "file")
        records.push(
          await this.preserve(workerId, child, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
          }),
        );
      // A nested directory is preserved as its own archive rather than being
      // dropped or flattened into the parent.
      else if (entry.kind === "directory")
        records.push(
          await this.snapshot(workerId, {
            paths: [child],
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
          }),
        );
    }
    return records;
  }

  /**
   * One bounded window of a live guest file, captured securely and returned as
   * a raw stream. This is the live-file counterpart of {@link read}: it never
   * touches durable storage, and the caller owns `cleanup`.
   *
   * Not part of the documented service contract, but the live `WorkerFiles`
   * surface needs exactly this and must not fall back to stat/read.
   */
  async openLive(
    workerId: string,
    path: string,
    options: { offset: number; length: number; signal?: AbortSignal },
  ): Promise<ArtifactTransfer> {
    const requested = validateRelativePath(path);
    return this.capture(
      workerId,
      async (transport, vmId, signal) =>
        transport.open(vmId, this.root, requested, {
          maxBytes: Math.max(1, options.length),
          offset: options.offset,
          length: options.length,
          signal,
        }),
      options,
    );
  }

  /** Bounded, credential-free listing of live guest files. */
  async listWorkerFiles(
    workerId: string,
    path = "",
    options: { offset?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ArtifactListing> {
    const worker = this.guest(workerId);
    const transport = this.transport();
    const relative = path === "" ? "" : validateRelativePath(path);
    const listing = await transport.list(worker.vm_id!, this.root, relative, {
      offset: options.offset ?? 0,
      limit: Math.min(options.limit ?? 100, this.limits.maxEntries),
      maxEntries: this.limits.maxEntries,
      maxDepth: this.limits.maxDepth,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      entries: listing.entries.filter((entry) => listable(entry)),
      next_offset: listing.next_offset,
      ...(listing.truncated === undefined
        ? {}
        : { truncated: listing.truncated }),
      ...(listing.total === undefined ? {} : { total: listing.total }),
    };
  }

  list(query: ArtifactListQuery = {}): ArtifactListResult {
    return this.repository.list(query);
  }

  metadata(artifactId: string): ArtifactRecord {
    return this.repository.get(artifactId);
  }

  /** Raw, faithful, bounded bytes. Never screened: this is the private path. */
  async read(artifactId: string, offset = 0, length = safeReadLimit) {
    const record = this.repository.get(artifactId);
    if (record.state !== "preserved" || !record.storage_key)
      throw new Error("Artifact has no stored bytes");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid artifact byte range");
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error("Invalid artifact byte range");
    return this.storage.read(record.storage_key, offset, length);
  }

  /** Whole-object raw stream for an authenticated download. */
  async download(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const record = this.repository.get(artifactId);
    if (record.state !== "preserved" || !record.storage_key)
      throw new Error("Artifact has no stored bytes");
    return this.storage.open(record.storage_key, signal ? { signal } : {});
  }

  /**
   * The model-facing read: bounded to 32 KiB and screened for credentials. The
   * overlap window around the requested range is inspected too, so a secret
   * split across a chunk boundary still blocks the read.
   */
  async safeRead(
    artifactId: string,
    offset = 0,
    length = safeReadLimit,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid artifact byte range");
    if (!Number.isSafeInteger(length) || length < 1 || length > safeReadLimit)
      throw new Error("Artifact read exceeds 32768 bytes");
    const record = this.repository.get(artifactId);
    if (record.state !== "preserved" || !record.storage_key)
      throw new Error("Artifact has no stored bytes");
    const pad = Math.max(
      4096,
      ...this.secrets().map((secret) => secret.length),
    );
    const start = Math.max(0, offset - pad);
    const window = await this.storage.read(
      record.storage_key,
      start,
      length + 2 * pad,
    );
    if (this.redactor.contains(window))
      throw new Error(
        "Artifact contains credentials; remove them inside the worker before retrieval",
      );
    return window.slice(offset - start, offset - start + length);
  }

  private secrets(): string[] {
    return [
      this.config.FREESTYLE_API_TOKEN,
      this.config.SWARMFORGE_MODEL_API_KEY,
      this.config.SWARMFORGE_API_TOKEN ?? "",
    ].filter((secret) => secret.length > 0);
  }

  /**
   * Streams a staged transfer into storage and only then marks the record
   * preserved. Storage re-hashes what reached the disk, so a transport that
   * lies about its own bytes cannot commit them.
   */
  private async ingest(
    record: ArtifactRecord,
    existing: ArtifactRecord | null | undefined,
    transfer: ArtifactTransfer,
    signal: AbortSignal,
    rebegin: () => ArtifactRecord,
  ): Promise<ArtifactRecord> {
    if (!Number.isSafeInteger(transfer.size) || transfer.size < 0)
      throw this.fail(record, "Artifact transfer reported an invalid size");
    if (!isSha256(transfer.sha256))
      throw this.fail(record, "Artifact transfer reported an invalid hash");
    // Re-capturing the same bytes for a source that is already durable changes
    // nothing: the stored object stays, the record is not rewritten, and the
    // staged copy is dropped. Changed content replaces it below.
    if (
      existing?.storage_key &&
      existing.state === "preserved" &&
      existing.sha256 === transfer.sha256 &&
      existing.size === transfer.size &&
      (await this.storage.stat(existing.storage_key))?.sha256 ===
        transfer.sha256
    ) {
      await transfer.cleanup().catch(() => {});
      return existing;
    }
    // Content that differs from what is stored is a new attempt on the same
    // source, so the record's history keeps both the attempt and its outcome.
    const target = existing?.state === "preserved" ? rebegin() : record;
    const key = `${target.artifact_id.slice(4, 6)}/${target.artifact_id}`;
    try {
      signal.throwIfAborted();
      await this.storage.put({
        key,
        stream: transfer.stream,
        size: transfer.size,
        sha256: transfer.sha256,
        signal,
      });
      return this.repository.preserved({
        artifact_id: target.artifact_id,
        storage_key: key,
        size: transfer.size,
        sha256: transfer.sha256,
      });
    } catch (error) {
      // Bytes that failed verification must not remain readable under the key.
      await this.storage.remove(key).catch(() => {});
      throw this.fail(target, message(error));
    } finally {
      await transfer.cleanup().catch(() => {});
    }
  }

  private fail(record: ArtifactRecord, error: string): Error {
    this.repository.failed(record, error);
    return new Error(error);
  }
}

function message(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 1000);
}

/**
 * Only plain regular files and directories are offered to callers. Symlinks and
 * special files are described by the transport but never listed here: they can
 * never be captured, so offering them would only invite a failed request.
 */
function listable(entry: ArtifactEntry): boolean {
  return (
    (entry.kind === "file" || entry.kind === "directory") &&
    !hasControlCharacter(entry.name) &&
    !entry.name.includes("/") &&
    !entry.name.includes("\\")
  );
}

/**
 * Combines a caller signal with a transfer timeout, so an unbounded guest
 * read can neither hang a request nor outlive its deadline silently.
 */
function combine(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

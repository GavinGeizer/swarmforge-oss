import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  type ArtifactEvent,
  ArtifactRepository,
  type ArtifactStorage,
  LocalArtifactStorage,
  storageKeyFor,
} from "./artifact-store";
import {
  ArtifactCaptureError,
  type ArtifactEntry,
  type ArtifactListing,
  type ArtifactListQuery,
  type ArtifactListResult,
  ArtifactPathError,
  type ArtifactRecord,
  type ArtifactSnapshotRequest,
  type ArtifactTransfer,
  artifactErrorCode,
  cancelTransfers,
  describeArtifactError,
  hasControlCharacter,
  isSha256,
  safeFilename,
  safeReadLimit,
  screeningWindow,
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
 * Request words that name how a source was asked for, not what it is.
 *
 * A worker's declared output and the same file reached through a default
 * collection are one file, so they must be one artifact: with two kinds the
 * repository would hold two records and two stored objects for the same bytes.
 * Mapping the request vocabulary onto the stored kind is what keeps a path
 * captured twice a single artifact. An unrecognised kind is left alone, so a
 * caller that uses its own label still sees it back.
 */
const artifactKindAliases: Record<string, string> = { declared: "file" };

/** The stored kind for one requested kind, bounded and never empty. */
function captureKind(requested: string | undefined): string {
  const kind = requested ?? "file";
  if (!kind || kind.length > 64)
    throw new ArtifactPathError("Artifact kind must be 1-64 characters");
  return artifactKindAliases[kind] ?? kind;
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
  private readonly roots = new Map<string, string>();
  private readonly redactor: ReturnType<typeof redactorFor>;
  private readonly shutdown = new AbortController();
  abort() {
    this.shutdown.abort(new Error("Artifact service stopped"));
  }
  private active = 0;
  private waiting: (() => void)[] = [];

  /**
   * `storage` is an injection point for a future object backend. The interface
   * has always been the whole contract, and an object store should not have to be
   * reached by editing this constructor: a caller that supplies one gets exactly
   * the same behaviour, and the coordinator needs no change to use it.
   */
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly provider: WorkerProvider,
    storage?: ArtifactStorage,
  ) {
    this.limits = artifactLimits(config);
    this.root();
    this.storage =
      storage ?? new LocalArtifactStorage(artifactStorageDir(config));
    this.repository = new ArtifactRepository(store.db);
    this.redactor = redactorFor({ config, store } as unknown as Coordinator);
    // A crash can leave a half-written temporary object; drop them once at
    // start rather than letting them accumulate on the coordinator host.
    void this.storage.sweepStale(this.limits.timeoutMs).catch(() => 0);
  }

  /**
   * Runs one transport operation and returns a refusal a caller can classify.
   *
   * Whatever transport is in use, an error leaves here as a code plus a message
   * that names the same class: an absent source reads as an absence, a permission
   * or symlink failure as an unsafe path, and neither is ever reported as the
   * other. An unrecognised failure stays a transport failure rather than being
   * guessed into a more specific class.
   */
  private async classify<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ArtifactCaptureError) throw error;
      const code = artifactErrorCode(error);
      // Whole, and unbounded on the way out: whatever reaches a record is
      // screened first and bounded once, in fail().
      throw new ArtifactCaptureError(
        `${describeArtifactError(code)}: ${message(error)}`,
        code,
      );
    }
  }

  /**
   * The absolute root a transport may open under, as configured right now.
   *
   * It is read from configuration per capture rather than frozen at
   * construction: the value is the boundary of every path this service opens, so
   * a coordinator that is pointed at a different workspace must not keep serving
   * the old one. Validation is pure, so the result is remembered per value.
   */
  private root(): string {
    const configured = this.config.SWARMFORGE_WORKSPACE;
    const known = this.roots.get(configured);
    if (known) return known;
    const validated = validateRoot(configured);
    this.roots.set(configured, validated);
    return validated;
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
    this.shutdown.signal.throwIfAborted();
    const worker = this.store.get(workerId);
    if (!worker.vm_id || worker.state === "destroyed" || worker.vm_missing)
      throw new Error("Worker has no VM to read artifacts from");
    return worker;
  }

  /**
   * Bounds concurrent transfers so a burst cannot exhaust host or guest I/O.
   *
   * A slot is handed straight from the releasing caller to the next waiter
   * rather than being freed and re-taken, so the limit cannot be exceeded by a
   * caller that arrives in between. An aborted waiter removes its own entry,
   * so it can never consume a released slot and strand the ones behind it.
   */
  private async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limits.concurrency) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolveWait, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolveWait();
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(wake);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new Error("Artifact transfer aborted"));
      };
      this.waiting.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The slot was reserved by the release that woke this waiter.
    return () => this.release();
  }
  private release() {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
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
  ): ArtifactRecord {
    // A source that already has a published copy keeps that record for this
    // attempt; anything else starts a new one, so two attempts on one source are
    // two records and never one record claiming two things at once.
    if (input.existing?.state === "preserved") return input.existing;
    return this.repository.begin({
      worker_id: worker.worker_id,
      task_id: worker.task_id,
      run_id: input.runId,
      original_path: input.original_path,
      filename: input.filename,
      kind: input.kind,
    });
  }

  /**
   * One preservation attempt. The record is durable before the transfer starts
   * and always ends in a terminal state: a failure raised before the transfer
   * (no transport, refused path, aborted signal) is recorded too, so no
   * `preserving` row is left claiming work that is no longer running.
   */
  private async attempt<T>(
    record: ArtifactRecord,
    run: (
      transport: WorkerArtifactTransport,
      vmId: string,
      signal: AbortSignal,
    ) => Promise<T>,
    options: { signal?: AbortSignal },
  ): Promise<T> {
    try {
      return await this.capture(record.worker_id, run, options);
    } catch (error) {
      if (this.repository.get(record.artifact_id).state === "preserving")
        throw this.fail(record, message(error));
      throw error instanceof Error ? error : new Error(this.screened(error));
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
    const signal = AbortSignal.any([
      combine(options.signal, this.limits.timeoutMs),
      this.shutdown.signal,
    ]);
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
    const kind = captureKind(options.kind);
    const runId = options.runId ?? null;
    const worker = this.guest(workerId);
    const existing = this.repository.find({
      worker_id: worker.worker_id,
      run_id: runId,
      original_path: requested,
      kind,
    });
    const record = this.record(worker, {
      existing,
      runId,
      original_path: requested,
      filename: safeFilename(requested.split("/").at(-1)),
      kind,
    });
    return this.attempt(
      record,
      async (transport, vmId, signal) => {
        const transfer = await this.classify(() =>
          transport.open(vmId, this.root(), requested, {
            maxBytes: this.limits.maxBytes,
            signal,
          }),
        );
        return this.ingest(record, existing, transfer, signal);
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
    const kind = captureKind("snapshot");
    const existing = this.repository.find({
      worker_id: worker.worker_id,
      run_id: runId,
      original_path: original,
      kind,
    });
    const record = this.record(worker, {
      existing,
      runId,
      original_path: original,
      filename: `${safeFilename(paths[0]?.split("/").at(-1) ?? "workspace", "workspace")}-snapshot.tar.gz`,
      kind,
    });
    return this.attempt(
      record,
      async (transport, vmId, signal) => {
        const transfer = await this.classify(() =>
          transport.snapshot(vmId, this.root(), {
            ...(paths.length ? { paths } : {}),
            maxBytes: this.limits.maxBytes,
            maxEntries: this.limits.maxEntries,
            maxDepth: this.limits.maxDepth,
            signal,
          }),
        );
        // An archive that stopped at the entry or depth cap is not the snapshot
        // that was asked for, and reporting it as preserved would let a caller
        // conclude that everything was salvaged.
        if (transfer.truncated) {
          await transfer.cleanup().catch(() => {});
          throw new Error(
            "Snapshot is incomplete: it reached the entry or depth limit",
          );
        }
        return this.ingest(record, existing, transfer, signal);
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
          const captured = await this.classify(() =>
            transport.diagnostics(vmId, this.root(), {
              maxBytes: this.limits.maxBytes,
              signal,
            }),
          );
          const records: ArtifactRecord[] = [];
          for (const [index, item] of captured.entries()) {
            const existing = this.repository.find({
              worker_id: worker.worker_id,
              run_id: runId,
              original_path: item.path,
              kind: captureKind("diagnostic"),
            });
            const record = this.record(worker, {
              existing,
              runId,
              original_path: item.path,
              filename: safeFilename(item.path.split("/").at(-1)),
              kind: captureKind("diagnostic"),
            });
            started.push(record);
            try {
              records.push(
                await this.ingest(record, existing, item.transfer, signal),
              );
            } catch (error) {
              // The remaining captures still hold open streams and private
              // staged copies; they are released here, not left behind.
              await cancelTransfers(captured.slice(index + 1));
              throw error;
            }
          }
          return records;
        },
        options,
      );
    } catch (error) {
      // Any diagnostic still marked in flight failed with the collection.
      for (const record of started)
        if (this.repository.get(record.artifact_id).state === "preserving")
          this.fail(record, message(error));
      throw error instanceof Error ? error : new Error(this.screened(error));
    }
  }

  /**
   * Every regular file in one live guest directory, with each nested directory
   * archived as its own snapshot.
   *
   * The whole level is paged in, not just the first page, and a listing that
   * reached a cap is refused rather than reported as a complete collection: the
   * caller keeps the source instead of concluding that everything was salvaged.
   * A nested directory is neither flattened into the parent nor dropped: it
   * becomes its own bounded archive, which is the only way a directory
   * collection can carry a tree without pretending it captured one.
   */
  async collectDirectory(
    workerId: string,
    path: string,
    options: PreserveInput = {},
  ): Promise<ArtifactRecord[]> {
    const directory = validateRelativePath(path);
    const entries = await this.everyEntry(workerId, directory, options);
    const records: ArtifactRecord[] = [];
    for (const entry of entries) {
      if (!listable(entry)) continue;
      const child = `${directory}/${entry.name}`;
      if (entry.kind === "file")
        records.push(
          await this.preserve(workerId, child, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
          }),
        );
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
   * Every entry of one live directory, paged to the end.
   *
   * A transport may answer with fewer entries than were asked for and still have
   * more to give, so the listing is followed to its end rather than trusted: a
   * collection that stopped at the transport's first page would report a
   * directory of two hundred files as complete when it holds a thousand. A
   * listing that reached the entry cap, or that stopped advancing, is refused
   * instead, because neither is a complete directory.
   */
  private async everyEntry(
    workerId: string,
    path: string,
    options: { signal?: AbortSignal },
  ): Promise<ArtifactEntry[]> {
    const budget = this.limits.maxEntries;
    const entries: ArtifactEntry[] = [];
    let offset = 0;
    while (true) {
      const listing = await this.listing(workerId, path, {
        offset,
        limit: budget,
        maxEntries: budget,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (listing.truncated)
        throw new Error(
          "Artifact collection is incomplete: the directory reached the entry limit",
        );
      entries.push(...listing.entries);
      if (listing.next_offset === null) return entries;
      if (listing.next_offset <= offset || entries.length > budget)
        throw new Error(
          "Artifact collection is incomplete: the directory listing did not advance",
        );
      offset = listing.next_offset;
    }
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
        this.classify(() =>
          transport.open(vmId, this.root(), requested, {
            maxBytes: Math.max(1, options.length),
            offset: options.offset,
            length: options.length,
            signal,
          }),
        ),
      options,
    );
  }

  /** The transport's own bounded listing, before any entry is filtered out. */
  private async listing(
    workerId: string,
    path: string,
    options: {
      offset?: number;
      limit?: number;
      maxEntries?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ArtifactListing> {
    const worker = this.guest(workerId);
    const transport = this.transport();
    const relative = path === "" ? "" : validateRelativePath(path);
    const maxEntries = Math.min(
      options.maxEntries ?? this.limits.maxEntries,
      this.limits.maxEntries,
    );
    return this.classify(() =>
      transport.list(worker.vm_id!, this.root(), relative, {
        offset: options.offset ?? 0,
        limit: Math.min(options.limit ?? 100, maxEntries),
        maxEntries,
        maxDepth: this.limits.maxDepth,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
  }

  /**
   * Bounded, credential-free listing of live guest files.
   *
   * The page is filled with entries a caller may actually use: filtering after
   * the transport has paged can hand back an empty page for a directory whose
   * first entries are symlinks, and a caller that reads an empty page as the end
   * of the directory would then conclude the worker has no artifacts at all. The
   * returned `next_offset` is the transport's own, so paging continues exactly
   * where the transport stopped and no entry is skipped or repeated.
   */
  async listWorkerFiles(
    workerId: string,
    path = "",
    options: { offset?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ArtifactListing> {
    const wanted = Math.max(1, Math.min(options.limit ?? 50, 1000));
    if (options.offset !== undefined && !Number.isSafeInteger(options.offset))
      throw new ArtifactPathError("Invalid artifact page offset");
    if (options.offset !== undefined && options.offset < 0)
      throw new ArtifactPathError("Invalid artifact page offset");
    if (options.limit !== undefined && !Number.isSafeInteger(options.limit))
      throw new ArtifactPathError("Invalid artifact page size");
    let offset = options.offset ?? 0;
    const entries: ArtifactEntry[] = [];
    let next: number | null = null;
    let truncated = false;
    let total: number | undefined;
    // Bounded by the entry budget rather than by wall time: a directory is
    // either fully described inside the budget or the scan is refused.
    const budget = this.limits.maxEntries;
    let seen = 0;
    while (true) {
      const listing = await this.listing(workerId, path, {
        offset,
        limit: wanted,
        maxEntries: budget,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (listing.truncated) truncated = true;
      if (listing.total !== undefined) total = listing.total;
      for (const entry of listing.entries) {
        seen++;
        if (listable(entry)) entries.push(entry);
        if (entries.length >= wanted) break;
      }
      if (entries.length >= wanted) {
        // Continue from the transport's own next offset so a page boundary never
        // re-reads or skips an entry.
        next = listing.next_offset ?? null;
        break;
      }
      if (listing.next_offset === null) {
        next = null;
        break;
      }
      if (listing.next_offset <= offset || seen >= budget) {
        next = listing.next_offset;
        break;
      }
      offset = listing.next_offset;
    }
    return {
      entries: entries.slice(0, wanted),
      next_offset: next,
      ...(truncated ? { truncated: true } : {}),
      ...(total === undefined ? {} : { total }),
    };
  }

  list(query: ArtifactListQuery = {}): ArtifactListResult {
    return this.repository.list(query);
  }

  metadata(artifactId: string): ArtifactRecord {
    return this.repository.get(artifactId);
  }

  /**
   * Raw, faithful, bounded bytes. Never screened: this is the private path.
   *
   * The cap is explicit, so a caller cannot turn a metadata read into an
   * arbitrary whole-object transfer through a range; anything larger is served by
   * {@link download}, which streams from the pinned descriptor instead of
   * allocating the object.
   */
  async read(artifactId: string, offset = 0, length = safeReadLimit) {
    const record = this.repository.get(artifactId);
    if (record.state !== "preserved" || !record.storage_key)
      throw new Error("Artifact has no stored bytes");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid artifact byte range");
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error("Invalid artifact byte range");
    if (length > safeReadLimit)
      throw new Error("Artifact read exceeds 32768 bytes; stream it instead");
    return this.storage.read(record.storage_key, offset, length);
  }

  /**
   * Whole-object raw stream for an authenticated download, straight from the
   * verified descriptor: no byte range is assembled in memory and cancelling the
   * response stops the reads.
   */
  async download(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const record = this.repository.get(artifactId);
    if (record.state !== "preserved" || !record.storage_key)
      throw new Error("Artifact has no stored bytes");
    return this.storage.open(record.storage_key, signal ? { signal } : {});
  }

  /** Bounded, content-free attempt history for one artifact. */
  events(artifactId: string, limit = 20): ArtifactEvent[] {
    this.repository.get(artifactId);
    return this.repository.events(artifactId, limit);
  }

  /** Cumulative attempt, success and failure counts, optionally per worker. */
  counters(filter: { worker_id?: string } = {}) {
    return this.repository.counters(filter);
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
    // The overlap comes from the very set this redactor screens, measured in
    // bytes and across encoded variants, so a secret split across the requested
    // window is still caught however long or however multi-byte it is.
    const pad = screeningWindow(this.redactor.secrets());
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

  /**
   * Streams a staged transfer into storage and only then marks it published.
   *
   * Storage re-hashes what reached the disk, so a transport that lies about its
   * own bytes cannot commit them. What is published is always a key of this
   * attempt's own: a first capture stores under the record's key, and a recapture
   * of changed content stores under a new key held by a new attempt record. The
   * previous verified copy keeps its record, its key and its bytes for as long as
   * the replacement has not been stored, so a transfer that is interrupted,
   * corrupted or refused leaves the earlier copy exactly as it was, readable
   * under the record that still points at it, and its failure puts that copy back
   * in charge. Only a verified replacement supersedes it, and even then the
   * superseded object is retained: an artifact id that was ever handed out stays
   * readable for exactly the bytes it described.
   */
  private async ingest(
    record: ArtifactRecord,
    existing: ArtifactRecord | null | undefined,
    transfer: ArtifactTransfer,
    signal: AbortSignal,
  ): Promise<ArtifactRecord> {
    if (!Number.isSafeInteger(transfer.size) || transfer.size < 0)
      throw this.fail(record, "Artifact transfer reported an invalid size");
    if (!isSha256(transfer.sha256))
      throw this.fail(record, "Artifact transfer reported an invalid hash");
    // Re-capturing the same bytes for a source that is already durable rewrites
    // nothing: the verified object stays as it is and the staged copy is dropped.
    // This attempt becomes the current record for the source, so a listing never
    // shows two current copies of one artifact and nothing is stored twice.
    if (
      existing?.storage_key &&
      existing.state === "preserved" &&
      existing.sha256 === transfer.sha256 &&
      existing.size === transfer.size &&
      (await this.storage.stat(existing.storage_key))?.sha256 ===
        transfer.sha256
    ) {
      const unchanged =
        record.artifact_id === existing.artifact_id
          ? existing
          : this.repository.preserved({
              artifact_id: record.artifact_id,
              storage_key: existing.storage_key,
              size: transfer.size,
              sha256: transfer.sha256,
              incomplete: transfer.incomplete ?? null,
            });
      await transfer.cleanup().catch(() => {});
      return unchanged;
    }
    // Changed content is a new attempt with its own key, so the replacement and
    // the copy it replaces never share a name on disk.
    const replacement =
      existing?.state === "preserved" && existing.storage_key
        ? this.repository.beginAttempt({
            record: existing,
            size: transfer.size,
            sha256: transfer.sha256,
          })
        : record;
    const key =
      replacement.storage_key ?? storageKeyFor(replacement.artifact_id);
    try {
      signal.throwIfAborted();
      await this.storage.put({
        key,
        stream: transfer.stream,
        size: transfer.size,
        sha256: transfer.sha256,
        signal,
      });
      const published = this.repository.preserved({
        artifact_id: replacement.artifact_id,
        storage_key: key,
        size: transfer.size,
        sha256: transfer.sha256,
        incomplete: transfer.incomplete ?? null,
      });
      // The replaced copy is kept. Its record stays readable and its bytes stay
      // verifiable under its own artifact id, so a consumer that captured an
      // artifact id before a recapture can still read exactly those bytes; a
      // stored object is never deleted on the strength of a recapture.
      return published;
    } catch (error) {
      // Only this attempt's own key is cleaned up, and only if it was ever
      // published: the previous copy keeps its bytes and its record.
      if (await this.storage.stat(key))
        await this.storage.remove(key).catch(() => {});
      throw this.fail(replacement, message(error));
    } finally {
      await transfer.cleanup().catch(() => {});
    }
  }

  /**
   * Records a failure, with the error text screened before it is stored.
   *
   * Order matters: a record's error is a durable, client-visible string, so it is
   * redacted first and bounded second. Bounding first would keep the first
   * thousand characters of a message that happens to carry a credential past the
   * cut, and the artifact bytes themselves are never touched by this.
   */
  private fail(record: ArtifactRecord, error: string): Error {
    const screened = this.screened(error);
    this.repository.failed(record, screened);
    return new Error(screened);
  }

  /**
   * The only place an error is bounded, and only after the whole message has
   * been screened. Screening first is the point: a credential that starts just
   * before a cut and runs past it is only recognisable while it is whole.
   */
  private screened(error: unknown): string {
    return this.redactor.text(message(error)).slice(0, 1000);
  }
}

/**
 * The raw text of an error, whole.
 *
 * Nothing is cut before the redactor has seen it. A bound applied here would
 * keep a prefix of a message whose credential starts before the cut and runs past
 * it, and the redactor matches on whole strings: the surviving prefix would then
 * be persisted. The only bound is applied once, after screening.
 */
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

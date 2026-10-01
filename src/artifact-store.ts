import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ArtifactListQuery,
  ArtifactListResult,
  ArtifactRecord,
} from "./artifact-types";
import { hasControlCharacter } from "./artifact-types";

/**
 * Object storage for preserved artifacts. A future object backend implements the
 * same interface, so the service never learns where bytes actually live.
 */
export interface ArtifactStorage {
  put(input: {
    key: string;
    stream: ReadableStream<Uint8Array>;
    size: number;
    sha256: string;
    signal?: AbortSignal;
  }): Promise<void>;
  open(
    key: string,
    options?: { offset?: number; length?: number; signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
  read(
    key: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  stat(key: string): Promise<{ size: number; sha256: string } | null>;
  remove(key: string): Promise<void>;
  /** Temporary copies older than `maxAgeMs` are dropped; returns how many. */
  sweepStale(maxAgeMs: number): Promise<number>;
}

const directories = 0o700;
const files = 0o600;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;
// Read-write so the object can be hashed from the descriptor that wrote it,
// without a second path resolution between the write and its verification.
const CREATE_NEW =
  fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW;
// O_NONBLOCK keeps a FIFO from parking a read even if one is planted between the
// resolution and the open; the descriptor is only ever read after S_ISREG.
const READ_ONLY =
  fsConstants.O_RDONLY | NO_FOLLOW | (fsConstants.O_NONBLOCK ?? 0);
const streamChunk = 64 * 1024;

/**
 * Private local storage: 0700 directories, 0600 objects, atomic publication by
 * rename, and a streamed hash check so a corrupted transfer is refused instead
 * of stored.
 *
 * Every open is `O_NOFOLLOW` and every object is created `O_EXCL`, so a symlink
 * planted where a key belongs can never be written through or read from; the
 * rename that publishes an object replaces a directory entry rather than
 * dereferencing one. The root itself is coordinator-private (0700, resolved
 * once through any real symlink), so nothing outside this process can plant
 * those entries in the first place. Worker-owned paths are the case that needs
 * descriptor-relative opening, and the guest helper does that.
 */
export class LocalArtifactStorage implements ArtifactStorage {
  readonly root: string;
  readonly incomingDir: string;
  constructor(root: string) {
    if (typeof root !== "string" || !root.startsWith("/") || root === "/")
      throw new Error("Artifact storage root must be an absolute path");
    // Resolving the root once pins a symlinked configuration path, so later
    // components are always resolved against a real private directory.
    mkdirSync(root, { recursive: true, mode: directories });
    this.root = realpathSync(root);
    this.incomingDir = join(this.root, ".incoming");
    mkdirSync(this.incomingDir, { recursive: true, mode: directories });
    for (const directory of [this.root, this.incomingDir]) {
      if (statSync(directory).isSymbolicLink())
        throw new Error("Artifact storage root must not be a symlink");
      chmodSync(directory, directories);
    }
  }
  /** Absolute path of a key, or null when the object is absent. */
  pathFor(key: string, missing = false): string | null {
    let path: string;
    try {
      path = this.resolve(key, false);
    } catch (error) {
      if (missing && error instanceof ArtifactNotStoredError) return null;
      throw error;
    }
    if (!missing) return path;
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }
  private parts(key: string): string[] {
    if (typeof key !== "string" || !key || key.length > 256)
      throw new Error("Invalid artifact storage key");
    const parts = key.split("/");
    if (
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.includes("\\") ||
          hasControlCharacter(part),
      )
    )
      throw new Error("Invalid artifact storage key");
    return parts;
  }
  /**
   * Walks a key to an absolute path, refusing any component that is a symlink
   * and optionally creating the missing parent directories privately.
   */
  private resolve(key: string, createParents: boolean): string {
    const parts = this.parts(key);
    let at = this.root;
    for (const [index, part] of parts.entries()) {
      at = join(at, part);
      const leaf = index === parts.length - 1;
      let info: Stats | null = null;
      try {
        info = lstatSync(at);
      } catch (error) {
        if (!isMissing(error)) throw new ArtifactNotStoredError();
      }
      if (!info) {
        // A read must find the object; a put creates its leaf by atomic rename.
        if (!createParents || leaf) {
          if (!createParents) throw new ArtifactNotStoredError();
          return at;
        }
        try {
          mkdirSync(at, { mode: directories });
        } catch (error) {
          if (!isBusy(error)) throw error;
        }
        info = lstatSync(at);
      }
      if (info.isSymbolicLink())
        throw new Error("Artifact storage path must not be a symlink");
      if (!leaf && !info.isDirectory())
        throw new Error("Artifact storage path is not a directory");
    }
    return at;
  }
  async put(input: {
    key: string;
    stream: ReadableStream<Uint8Array>;
    size: number;
    sha256: string;
    signal?: AbortSignal;
  }) {
    if (!Number.isSafeInteger(input.size) || input.size < 0)
      throw new Error("Invalid artifact size");
    if (!/^[0-9a-f]{64}$/.test(input.sha256))
      throw new Error("Invalid artifact hash");
    // Re-storing identical content is a no-op rather than a rewrite, so a retry
    // after an ambiguous failure cannot churn a durable artifact.
    const existing = await this.stat(input.key);
    if (
      existing &&
      existing.size === input.size &&
      existing.sha256 === input.sha256
    )
      return;
    const final = this.resolve(input.key, true);
    const temporary = join(this.incomingDir, `t-${randomUUID()}`);
    let handle: number | undefined;
    const cleanup = () => {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {}
        handle = undefined;
      }
      try {
        unlinkSync(temporary);
      } catch {}
    };
    try {
      handle = openSync(temporary, CREATE_NEW, files);
      const written = await this.copy(input, handle);
      if (written !== input.size)
        throw new Error(
          `Artifact size mismatch: expected ${input.size} bytes, received ${written}`,
        );
      const digest = await this.digest(handle);
      if (digest !== input.sha256)
        throw new Error(
          "Artifact hash mismatch: the transferred bytes do not match the captured hash",
        );
      input.signal?.throwIfAborted();
      // Durability before publication. The verified bytes reach the medium before
      // any name points at them, and the destination directory entry is on the
      // medium before this call returns, so a caller that records the artifact as
      // preserved afterwards cannot be ahead of the disk.
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      fsyncDirectory(dirname(final));
      // One directory tree, so the rename is the atomic step that publishes the
      // object: no reader ever sees a partial artifact under its final key.
      renameSync(temporary, final);
      fsyncDirectory(dirname(final));
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  /**
   * Streams a transfer into the descriptor, refusing to write a byte past the
   * declared size.
   *
   * The bound is checked against the running total, not once at the end, so a
   * source that keeps producing is stopped instead of filling the disk; and the
   * pending read is raced against the caller's signal, so an abort while the
   * source is blocked is honoured immediately rather than after the source
   * eventually produces something.
   */
  private async copy(
    input: {
      stream: ReadableStream<Uint8Array>;
      size: number;
      signal?: AbortSignal;
    },
    handle: number,
  ): Promise<number> {
    const reader = input.stream.getReader();
    let written = 0;
    try {
      while (true) {
        input.signal?.throwIfAborted();
        const { done, value } = await raced(
          reader.read(),
          input.signal,
          "Artifact transfer aborted",
        );
        if (done) break;
        if (!value?.length) continue;
        if (written + value.byteLength > input.size)
          throw new Error(
            `Artifact transfer exceeded its declared size of ${input.size} bytes`,
          );
        written += writeAll(handle, value);
      }
    } finally {
      // The source stops being read whatever happened: a transfer that overran
      // its bound must not keep pumping bytes at a handle nobody is draining.
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {}
    }
    return written;
  }
  /** Hash the bytes as they reached the disk, not as they arrived in memory. */
  private digest(handle: number): string {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let at = 0;
    while (true) {
      const read = readSync(handle, buffer, 0, buffer.length, at);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      at += read;
    }
    return hash.digest("hex");
  }
  async read(
    key: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      throw new Error("Invalid artifact byte range");
    if (length === 0) return new Uint8Array();
    const handle = this.handleFor(key);
    try {
      const info = fstatSync(handle);
      if (!info.isFile()) throw new ArtifactNotStoredError();
      const size = info.size;
      const start = Math.min(offset, size);
      const wanted = Math.min(length, size - start);
      if (wanted <= 0) return new Uint8Array();
      const buffer = Buffer.alloc(wanted);
      const read = readSync(handle, buffer, 0, wanted, start) ?? 0;
      if (read < wanted && signal?.aborted)
        throw new Error("Artifact transfer aborted");
      return new Uint8Array(buffer.subarray(0, read));
    } finally {
      closeSync(handle);
    }
  }
  /**
   * A real web stream over the verified descriptor, not a path reopened per
   * chunk: the object cannot be replaced between the size check and the bytes,
   * cancelling stops the reads and closes the descriptor, and the service never
   * has to learn whether a backend produces web or Node streams.
   */
  async open(
    key: string,
    options: { offset?: number; length?: number; signal?: AbortSignal } = {},
  ) {
    options.signal?.throwIfAborted();
    const handle = this.handleFor(key);
    let size: number;
    try {
      const info = fstatSync(handle);
      if (!info.isFile()) throw new ArtifactNotStoredError();
      size = info.size;
    } catch (error) {
      closeSync(handle);
      throw error;
    }
    const offset = Math.max(0, Math.min(options.offset ?? 0, size));
    const length = Math.max(
      0,
      Math.min(options.length ?? size - offset, size - offset),
    );
    if (length === 0) {
      closeSync(handle);
      return emptyStream();
    }
    return objectStream(handle, offset, length, options.signal);
  }
  async stat(key: string): Promise<{ size: number; sha256: string } | null> {
    let handle: number;
    try {
      handle = this.handleFor(key);
    } catch {
      return null;
    }
    try {
      const info = fstatSync(handle);
      if (!info.isFile()) return null;
      return { size: info.size, sha256: this.digest(handle) };
    } finally {
      closeSync(handle);
    }
  }
  async remove(key: string) {
    const path = this.pathFor(key, true);
    if (path) rmSync(path, { force: true });
  }
  /**
   * An fd on the object itself: one resolution, then no further path use. A
   * descriptor that is not a regular file is closed and refused, so a device,
   * socket or FIFO planted under a key can never be read.
   */
  private handleFor(key: string): number {
    const handle = openSync(this.resolve(key, false), READ_ONLY);
    try {
      if (!fstatSync(handle).isFile()) throw new ArtifactNotStoredError();
    } catch (error) {
      closeSync(handle);
      throw error;
    }
    return handle;
  }
  async sweepStale(maxAgeMs: number) {
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    let removed = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(this.incomingDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const path = join(this.incomingDir, entry);
      try {
        if (statSync(path).mtimeMs >= cutoff) continue;
        unlinkSync(path);
        removed++;
      } catch {
        // A temporary file that vanished on its own needs no attention.
      }
    }
    return removed;
  }
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * A bounded web stream over one pinned descriptor. Nothing here resolves a path
 * again, so there is no window between the verified object and the bytes served;
 * cancelling or erroring closes the descriptor, and an abort stops the reads.
 */
function objectStream(
  handle: number,
  offset: number,
  length: number,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let at = offset;
  let remaining = length;
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    try {
      closeSync(handle);
    } catch {}
  };
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (closed) return;
        if (signal?.aborted) {
          release();
          controller.error(new Error("Artifact transfer aborted"));
          return;
        }
        if (remaining <= 0) {
          release();
          controller.close();
          return;
        }
        // A fresh buffer per chunk: a reused one would still be overwritten by
        // the next pull while a consumer is holding the chunk it was handed.
        const wanted = Math.min(streamChunk, remaining);
        const buffer = Buffer.allocUnsafe(wanted);
        const read = readSync(handle, buffer, 0, wanted, at);
        if (read <= 0) {
          // The object ended inside the range it promised: a truncated download
          // is a failure, not a short body.
          release();
          controller.error(
            new Error("Stored artifact ended before its length"),
          );
          return;
        }
        at += read;
        remaining -= read;
        controller.enqueue(new Uint8Array(buffer.buffer, 0, read));
      },
      cancel() {
        release();
      },
    },
    { highWaterMark: 0 },
  );
}

/** Directory entries are durable only once the directory itself is synced. */
function fsyncDirectory(path: string) {
  let handle: number | undefined;
  try {
    handle = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(handle);
  } catch {
    // A directory that cannot be synced is a platform limitation, not a reason
    // to withhold bytes that are already verified and published.
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {}
    }
  }
}

/**
 * Races a pending read against an abort. A source that never produces would
 * otherwise keep the caller waiting past its own deadline.
 */
async function raced<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  reason: string,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new Error(reason);
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, stopped]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** The key resolves to nothing, which a listing may absorb and a read may not. */
export class ArtifactNotStoredError extends Error {
  constructor() {
    super("Artifact is not stored");
    this.name = "ArtifactNotStoredError";
  }
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Another writer created the directory first, which is a success for us. */
function isBusy(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function writeAll(handle: number, bytes: Uint8Array) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let written = 0;
  while (written < buffer.length) {
    const count = writeSync(handle, buffer, written, buffer.length - written);
    if (!count) break;
    written += count;
  }
  return written;
}

export interface ArtifactBeginInput {
  worker_id: string;
  task_id: string;
  run_id?: string | null;
  original_path: string;
  filename: string;
  kind: string;
}

/**
 * A durable, content-free record of one preservation attempt. Cumulative
 * attempt, success and failure counts come from these rather than from the live
 * artifact rows, because a row that is replaced on every recapture cannot
 * report how many times anything was tried.
 */
export interface ArtifactEvent {
  event_id: number;
  kind: "artifact.attempted" | "artifact.preserved" | "artifact.failed";
  artifact_id: string;
  worker_id: string;
  task_id: string;
  run_id: string | null;
  attempt: number;
  artifact_kind: string;
  outcome: "preserved" | "failed" | null;
  size: number | null;
  sha256: string | null;
  error: string | null;
  at: number;
}

/** Event names, so a consumer matches on a constant rather than a literal. */
export const artifactEventNames = {
  attempted: "artifact.attempted",
  preserved: "artifact.preserved",
  failed: "artifact.failed",
} as const;

/** Most terminal events one artifact may keep; bounds a source that churns. */
export const maxArtifactEvents = 20;

/**
 * Where an object lives: two characters of shard, then its own artifact id. A
 * recapture that changes the content gets a different id and therefore a
 * different key, which is what lets the previous copy survive a failed one.
 */
export function storageKeyFor(artifactId: string): string {
  return `${artifactId.slice(4, 6)}/${artifactId}`;
}

/**
 * Durable artifact metadata, created from the coordinator's own database. A
 * record is written before any transfer starts and only becomes `preserved`
 * once the bytes are stored, so an interrupted run leaves an inspectable
 * `preserving` row instead of a half-truth.
 */
export class ArtifactRepository {
  constructor(private readonly db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifacts(
      artifact_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT,
      original_path TEXT NOT NULL,
      storage_key TEXT,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      retrieved_at INTEGER,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS artifacts_worker ON artifacts(worker_id,created_at);
    CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id,created_at);
    CREATE INDEX IF NOT EXISTS artifacts_state ON artifacts(state);

    CREATE TABLE IF NOT EXISTS artifact_events(
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT,
      attempt INTEGER NOT NULL,
      artifact_kind TEXT NOT NULL,
      outcome TEXT,
      size INTEGER,
      sha256 TEXT,
      error TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS artifact_events_worker ON artifact_events(worker_id,at);
    CREATE INDEX IF NOT EXISTS artifact_events_kind ON artifact_events(kind);
    CREATE INDEX IF NOT EXISTS artifact_events_artifact ON artifact_events(artifact_id);
    `);
    // A database written before this column existed keeps working: the field is
    // only ever read where it is present, and it has to exist before the partial
    // index below can be built.
    const columns = this.db.query("PRAGMA table_info(artifacts)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "superseded_by"))
      this.db.exec("ALTER TABLE artifacts ADD COLUMN superseded_by TEXT");
    // At most one current published copy per worker, run, path and kind. The
    // index is partial over exactly that predicate, so every attempt, every
    // failure and every replaced copy can keep its own row without any of them
    // being able to block the next attempt. Rebuilt once, because the previous
    // definition covered every row.
    this.db.exec(`DROP INDEX IF EXISTS artifacts_source;
      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_source ON artifacts(worker_id,ifnull(run_id,''),original_path,kind)
        WHERE state='preserved' AND superseded_by IS NULL;`);
  }
  /**
   * A new attempt at one source, as a new record.
   *
   * Attempts never share a row: a record that is already published describes
   * bytes that are on disk, and an attempt that fails must not be able to change
   * what that record says. The attempt number is still cumulative for the source,
   * so a client can see how many times a source has been tried.
   */
  begin(input: ArtifactBeginInput): ArtifactRecord {
    return this.insert({
      ...input,
      run_id: input.run_id ?? null,
      now: Date.now(),
    });
  }
  /**
   * A recapture of an already preserved source, as its own attempt record.
   *
   * The replacement gets its own identity and its own content key from the moment
   * it starts, and only becomes the published copy once its bytes are stored.
   * The previous verified copy keeps its record, its key and its readability, so
   * an interrupted, corrupted or refused recapture can only mark its own attempt
   * failed: it can never remove the copy that was already there.
   */
  beginAttempt(input: {
    record: ArtifactRecord;
    size: number;
    sha256: string;
  }): ArtifactRecord {
    return this.db.transaction(() => {
      const current = this.get(input.record.artifact_id);
      // The attempt this record is being replaced by is named straight away, so
      // exactly one record is ever the current one for a source. It is cleared
      // again if the attempt fails, which is what puts the previous copy back in
      // charge with its bytes untouched.
      const artifact_id = `art-${randomUUID()}`;
      this.db
        .query("UPDATE artifacts SET superseded_by=? WHERE artifact_id=?")
        .run(artifact_id, current.artifact_id);
      const attempt = this.insert({
        worker_id: current.worker_id,
        task_id: current.task_id,
        run_id: current.run_id,
        original_path: current.original_path,
        filename: current.filename,
        kind: current.kind,
        now: Date.now(),
        artifact_id,
      });
      // The key is this attempt's own, and the captured identity is recorded
      // before the transfer starts, so an interrupted attempt is still
      // attributable to the bytes it was going to store.
      this.db
        .query(
          "UPDATE artifacts SET storage_key=?,size=?,sha256=? WHERE artifact_id=?",
        )
        .run(
          storageKeyFor(attempt.artifact_id),
          input.size,
          input.sha256,
          attempt.artifact_id,
        );
      return this.get(attempt.artifact_id);
    })();
  }
  private insert(input: {
    worker_id: string;
    task_id: string;
    run_id: string | null;
    original_path: string;
    filename: string;
    kind: string;
    now: number;
    artifact_id?: string;
  }): ArtifactRecord {
    const attempts = (
      this.db
        .query(
          `SELECT count(*) total FROM artifacts WHERE worker_id=? AND ifnull(run_id,'')=?
           AND original_path=? AND kind=?`,
        )
        .get(
          input.worker_id,
          input.run_id ?? "",
          input.original_path,
          input.kind,
        ) as { total: number }
    ).total;
    const record: ArtifactRecord = {
      artifact_id: input.artifact_id ?? `art-${randomUUID()}`,
      task_id: input.task_id,
      worker_id: input.worker_id,
      run_id: input.run_id,
      original_path: input.original_path,
      storage_key: null,
      filename: input.filename,
      size: 0,
      sha256: null,
      kind: input.kind,
      state: "preserving",
      attempts: attempts + 1,
      error: null,
      created_at: input.now,
      retrieved_at: null,
      superseded_by: null,
    };
    this.db
      .query(
        `INSERT INTO artifacts(artifact_id,worker_id,task_id,run_id,original_path,storage_key,filename,size,sha256,kind,state,attempts,error,created_at,retrieved_at,superseded_by)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.artifact_id,
        record.worker_id,
        record.task_id,
        record.run_id,
        record.original_path,
        null,
        record.filename,
        0,
        null,
        record.kind,
        record.state,
        record.attempts,
        null,
        input.now,
        null,
        null,
      );
    this.event(artifactEventNames.attempted, record, record.attempts);
    return record;
  }
  /**
   * A stored object. The record it replaces is marked, not deleted, so the
   * history keeps both the copy that was there and the copy that replaced it.
   */
  preserved(input: {
    artifact_id: string;
    storage_key: string;
    size: number;
    sha256: string;
    filename?: string;
  }): ArtifactRecord {
    return this.db.transaction(() => {
      this.db
        .query(
          "UPDATE artifacts SET state='preserved',storage_key=?,size=?,sha256=?,error=NULL,retrieved_at=? WHERE artifact_id=?",
        )
        .run(
          input.storage_key,
          input.size,
          input.sha256,
          Date.now(),
          input.artifact_id,
        );
      // Last publisher wins for a source: any other current copy, whether it is
      // the one this attempt was told to replace or a concurrent attempt that
      // finished first, becomes history. The transaction is what keeps exactly
      // one current row per source while both are being written.
      const source = this.get(input.artifact_id);
      this.db
        .query(
          `UPDATE artifacts SET superseded_by=? WHERE worker_id=? AND ifnull(run_id,'')=?
           AND original_path=? AND kind=? AND artifact_id<>? AND state='preserved' AND superseded_by IS NULL`,
        )
        .run(
          input.artifact_id,
          source.worker_id,
          source.run_id,
          source.original_path,
          source.kind,
          input.artifact_id,
        );
      const settled = this.get(input.artifact_id);
      this.event(artifactEventNames.preserved, settled, settled.attempts, {
        size: input.size,
        sha256: input.sha256,
      });
      return settled;
    })();
  }

  failed(record: { artifact_id: string }, error: string): ArtifactRecord {
    const message = String(error).slice(0, 1000);
    this.db
      .query(
        "UPDATE artifacts SET state='failed',error=?,retrieved_at=coalesce(retrieved_at,?) WHERE artifact_id=?",
      )
      .run(message, Date.now(), record.artifact_id);
    // A failed attempt replaces nothing, so whatever it was superseding is the
    // current copy again. Its bytes were never touched.
    this.db
      .query("UPDATE artifacts SET superseded_by=NULL WHERE superseded_by=?")
      .run(record.artifact_id);
    const settled = this.get(record.artifact_id);
    this.event(artifactEventNames.failed, settled, settled.attempts, {
      error: message,
    });
    return settled;
  }
  /**
   * One content-free event row: a name, an attempt number, a bounded error and
   * a verified size. No artifact contents are ever recorded, and the number of
   * terminal events per artifact is bounded so a source that keeps changing
   * cannot grow the table without limit.
   */
  private event(
    kind: ArtifactEvent["kind"],
    record: ArtifactRecord,
    attempt: number,
    extra: {
      size?: number | null;
      sha256?: string | null;
      error?: string | null;
    } = {},
  ) {
    if (kind !== artifactEventNames.attempted) {
      const terminal = (
        this.db
          .query(
            "SELECT count(*) total FROM artifact_events WHERE artifact_id=? AND kind<>'artifact.attempted'",
          )
          .get(record.artifact_id) as { total: number }
      ).total;
      if (terminal >= maxArtifactEvents) return;
    }
    this.db
      .query(
        `INSERT INTO artifact_events(kind,artifact_id,worker_id,task_id,run_id,attempt,artifact_kind,outcome,size,sha256,error,at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        kind,
        record.artifact_id,
        record.worker_id,
        record.task_id,
        record.run_id,
        Math.max(1, attempt),
        record.kind,
        kind === artifactEventNames.preserved
          ? "preserved"
          : kind === artifactEventNames.failed
            ? "failed"
            : null,
        extra.size ?? null,
        extra.sha256 ?? null,
        extra.error ?? null,
        Date.now(),
      );
  }
  /** Bounded, oldest-last history for one artifact. Never its contents. */
  events(artifactId: string, limit = 20): ArtifactEvent[] {
    const bounded = Math.min(200, Math.max(1, Math.floor(limit) || 1));
    return this.db
      .query(
        "SELECT * FROM artifact_events WHERE artifact_id=? ORDER BY event_id DESC LIMIT ?",
      )
      .all(artifactId, bounded)
      .reverse() as ArtifactEvent[];
  }
  /** Cumulative attempt, success and failure counts from durable events. */
  counters(filter: { worker_id?: string } = {}): {
    attempts: number;
    preserved: number;
    failed: number;
  } {
    const where = filter.worker_id ? "AND worker_id=?" : "";
    const argument = filter.worker_id ? [filter.worker_id] : [];
    const row = this.db
      .query(
        `SELECT
           count(*) total,
           sum(CASE WHEN kind='artifact.preserved' THEN 1 ELSE 0 END) preserved,
           sum(CASE WHEN kind='artifact.failed' THEN 1 ELSE 0 END) failed
         FROM artifact_events WHERE kind<>'artifact.attempted' ${where}`,
      )
      .get(...argument) as {
      total: number;
      preserved: number;
      failed: number;
    };
    return {
      attempts: Number(row?.total ?? 0),
      preserved: Number(row?.preserved ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }
  get(artifactId: string): ArtifactRecord {
    const row = this.db
      .query("SELECT * FROM artifacts WHERE artifact_id=?")
      .get(artifactId) as ArtifactRecord | null;
    if (!row) throw new Error("Artifact not found");
    return row;
  }
  /**
   * The current published copy for one source, if there is one. A failed or
   * still-running attempt is not a copy anybody can read, so it is deliberately
   * not returned: the next attempt for that source starts a new record rather
   * than reviving one that has a failure attached to it.
   */
  find(filter: {
    worker_id?: string;
    run_id?: string | null;
    original_path?: string;
    kind?: string;
  }): ArtifactRecord | null {
    if (!filter.worker_id || filter.original_path === undefined) return null;
    const row = this.db
      .query(
        `SELECT * FROM artifacts WHERE worker_id=? AND ifnull(run_id,'')=? AND original_path=?
         AND state='preserved' AND (superseded_by IS NULL)
         ${filter.kind === undefined ? "" : "AND kind=?"}
         ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(
        filter.worker_id,
        filter.run_id ?? "",
        filter.original_path,
        ...(filter.kind === undefined ? [] : [filter.kind]),
      ) as ArtifactRecord | null;
    return row;
  }
  /**
   * The current artifacts, newest last. A record a later attempt replaced is
   * left out: it is history, not the copy a client should read, and it is still
   * reachable by its own id. Counting it would inflate both a listing and any
   * metric derived from one.
   */
  list(query: ArtifactListQuery = {}): ArtifactListResult {
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const where = `(? IS NULL OR worker_id=?) AND (? IS NULL OR task_id=?)
      AND (superseded_by IS NULL)`;
    const rows = this.db
      .query(
        `SELECT * FROM artifacts WHERE ${where} ORDER BY created_at,rowid LIMIT ? OFFSET ?`,
      )
      .all(
        query.worker_id ?? null,
        query.worker_id ?? null,
        query.task_id ?? null,
        query.task_id ?? null,
        limit,
        offset,
      ) as ArtifactRecord[];
    const total = (
      this.db
        .query(`SELECT count(*) total FROM artifacts WHERE ${where}`)
        .get(
          query.worker_id ?? null,
          query.worker_id ?? null,
          query.task_id ?? null,
          query.task_id ?? null,
        ) as { total: number }
    ).total;
    const next = offset + rows.length;
    return { artifacts: rows, next_offset: next < total ? next : null };
  }
  /** Records a restart found mid-transfer; lifecycle decides what to do with them. */
  pending(): ArtifactRecord[] {
    return this.db
      .query(
        "SELECT * FROM artifacts WHERE state='preserving' ORDER BY created_at",
      )
      .all() as ArtifactRecord[];
  }
  count(state?: ArtifactRecord["state"]): number {
    if (!state) return 0;
    return (
      this.db
        .query(
          "SELECT count(*) total FROM artifacts WHERE state=? AND (superseded_by IS NULL)",
        )
        .get(state) as { total: number }
    ).total;
  }
  async openStored(
    storage: ArtifactStorage,
    record: ArtifactRecord,
    options: { offset?: number; length?: number } = {},
  ) {
    if (!record.storage_key) throw new Error("Artifact has no stored bytes");
    return storage.open(record.storage_key, options);
  }
}

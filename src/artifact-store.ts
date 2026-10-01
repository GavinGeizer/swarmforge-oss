import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  constants as fsConstants,
  fstatSync,
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
import { join } from "node:path";
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
const READ_ONLY = fsConstants.O_RDONLY | NO_FOLLOW;

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
      closeSync(handle);
      handle = undefined;
      // One directory tree, so the rename is the atomic step that publishes the
      // object: no reader ever sees a partial artifact under its final key.
      renameSync(temporary, final);
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  private async copy(
    input: { stream: ReadableStream<Uint8Array>; signal?: AbortSignal },
    handle: number,
  ): Promise<number> {
    const reader = input.stream.getReader();
    let written = 0;
    try {
      while (true) {
        input.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        written += writeAll(handle, value);
      }
    } finally {
      await reader.cancel().catch(() => {});
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
      const size = fstatSync(handle).size;
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
  async open(
    key: string,
    options: { offset?: number; length?: number; signal?: AbortSignal } = {},
  ) {
    options.signal?.throwIfAborted();
    const handle = this.handleFor(key);
    let size: number;
    try {
      size = fstatSync(handle).size;
    } finally {
      closeSync(handle);
    }
    const offset = Math.max(0, Math.min(options.offset ?? 0, size));
    const length = Math.max(
      0,
      Math.min(options.length ?? size - offset, size - offset),
    );
    if (length === 0) return emptyStream();
    const path = this.resolve(key, false);
    return createReadStream(path, {
      start: offset,
      end: offset + length - 1,
    }) as unknown as ReadableStream<Uint8Array>;
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
  /** An fd on the object itself: one resolution, then no further path use. */
  private handleFor(key: string): number {
    return openSync(this.resolve(key, false), READ_ONLY);
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
      retrieved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS artifacts_worker ON artifacts(worker_id,created_at);
    CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id,created_at);
    CREATE INDEX IF NOT EXISTS artifacts_state ON artifacts(state);
    CREATE UNIQUE INDEX IF NOT EXISTS artifacts_source ON artifacts(worker_id,ifnull(run_id,''),original_path,kind);
    `);
  }
  /** One record per worker, run, path and kind; a retry reuses the record. */
  begin(input: ArtifactBeginInput): ArtifactRecord {
    return this.db.transaction(() => {
      const existing = this.find(input);
      const now = Date.now();
      if (existing) {
        this.db
          .query(
            "UPDATE artifacts SET state='preserving',attempts=attempts+1,error=NULL WHERE artifact_id=?",
          )
          .run(existing.artifact_id);
        return this.get(existing.artifact_id);
      }
      const record: ArtifactRecord = {
        artifact_id: `art-${randomUUID()}`,
        worker_id: input.worker_id,
        task_id: input.task_id,
        run_id: input.run_id ?? null,
        original_path: input.original_path,
        storage_key: null,
        filename: input.filename,
        size: 0,
        sha256: null,
        kind: input.kind,
        state: "preserving",
        attempts: 1,
        error: null,
        created_at: now,
        retrieved_at: null,
      };
      this.db
        .query(
          `INSERT INTO artifacts(artifact_id,worker_id,task_id,run_id,original_path,storage_key,filename,size,sha256,kind,state,attempts,error,created_at,retrieved_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          now,
          null,
        );
      return record;
    })();
  }
  preserved(input: {
    artifact_id: string;
    storage_key: string;
    size: number;
    sha256: string;
    filename?: string;
  }): ArtifactRecord {
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
    return this.get(input.artifact_id);
  }
  failed(record: { artifact_id: string }, error: string): ArtifactRecord {
    const message = String(error).slice(0, 1000);
    this.db
      .query(
        "UPDATE artifacts SET state='failed',error=?,retrieved_at=coalesce(retrieved_at,?) WHERE artifact_id=?",
      )
      .run(message, Date.now(), record.artifact_id);
    return this.get(record.artifact_id);
  }
  get(artifactId: string): ArtifactRecord {
    const row = this.db
      .query("SELECT * FROM artifacts WHERE artifact_id=?")
      .get(artifactId) as ArtifactRecord | null;
    if (!row) throw new Error("Artifact not found");
    return row;
  }
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
         ${filter.kind === undefined ? "" : "AND kind=?"}`,
      )
      .get(
        filter.worker_id,
        filter.run_id ?? "",
        filter.original_path,
        ...(filter.kind === undefined ? [] : [filter.kind]),
      ) as ArtifactRecord | null;
    return row;
  }
  list(query: ArtifactListQuery = {}): ArtifactListResult {
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const where = `(? IS NULL OR worker_id=?) AND (? IS NULL OR task_id=?)`;
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
        .query("SELECT count(*) total FROM artifacts WHERE state=?")
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

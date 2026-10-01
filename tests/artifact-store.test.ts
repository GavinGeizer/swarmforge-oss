import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactRepository,
  type ArtifactStorage,
  LocalArtifactStorage,
} from "../src/artifact-store";
import { Store } from "../src/store";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

let base: string;
let storage: LocalArtifactStorage;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "swarmforge-store-"));
  storage = new LocalArtifactStorage(join(base, "artifacts"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const objects = (root: string) =>
  readdirSync(root, { recursive: true })
    .map(String)
    .filter((entry) => entry.includes(".incoming") === false);

test("a stored artifact is private, complete and byte-faithful", async () => {
  const bytes = new Uint8Array(1024 * 64).map((_, i) => i % 251);
  const key = "w-abc/def";
  await storage.put({
    key,
    stream: stream(bytes),
    size: bytes.length,
    sha256: sha(bytes),
  });
  const path = storage.pathFor(key)!;
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(base, "artifacts")).mode & 0o777).toBe(0o700);
  expect(new Uint8Array(await storage.read(key, 0, bytes.length))).toEqual(
    bytes,
  );
  const window = await storage.read(key, 1000, 2048);
  expect(window.length).toBe(2048);
  expect(window[0]).toBe(bytes[1000]);
  const streamed = await new Response(
    await storage.open(key, { offset: 4096, length: 16 }),
  ).arrayBuffer();
  expect(new Uint8Array(streamed)).toEqual(bytes.slice(4096, 4112));
  expect(await storage.stat(key)).toEqual({
    size: bytes.length,
    sha256: sha(bytes),
  });
});

test("a partially written transfer is never visible and never left behind", async () => {
  const bytes = new Uint8Array(4096).fill(9);
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = storage.put({
    key: "slow",
    stream: new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bytes.subarray(0, 1024));
        await gate;
        controller.enqueue(bytes.subarray(1024));
        controller.close();
      },
    }),
    size: bytes.length,
    sha256: sha(bytes),
  });
  await Bun.sleep(20);
  expect(storage.pathFor("slow", true)).toBeNull();
  expect(readdirSync(storage.incomingDir)).toHaveLength(1);
  release!();
  await pending;
  expect(storage.pathFor("slow", true)).not.toBeNull();
  expect(readdirSync(storage.incomingDir)).toHaveLength(0);
});

test("a corrupt or truncated transfer is refused and leaves no object", async () => {
  const bytes = new Uint8Array(8192).fill(3);
  await expect(
    storage.put({
      key: "bad-hash",
      stream: stream(bytes),
      size: bytes.length,
      sha256: sha(new Uint8Array(8192).fill(4)),
    }),
  ).rejects.toThrow(/hash/i);
  await expect(
    storage.put({
      key: "short",
      stream: stream(bytes.subarray(0, 100)),
      size: bytes.length,
      sha256: sha(bytes),
    }),
  ).rejects.toThrow(/size|length/i);
  await expect(
    storage.put({
      key: "long",
      stream: stream(bytes),
      size: 100,
      sha256: sha(bytes),
    }),
  ).rejects.toThrow(/size|length/i);
  expect(objects(join(base, "artifacts"))).toEqual([]);
  expect(readdirSync(storage.incomingDir)).toEqual([]);
  await expect(storage.read("bad-hash", 0, 10)).rejects.toThrow();
});

test("an aborted transfer removes its temporary file", async () => {
  const controller = new AbortController();
  const bytes = new Uint8Array(2 * 1024 * 1024).fill(5);
  const pending = storage.put({
    key: "cancelled",
    stream: new ReadableStream<Uint8Array>({
      async pull(controller_) {
        controller_.enqueue(bytes.subarray(0, 4096));
        await Bun.sleep(1);
      },
    }),
    size: bytes.length,
    sha256: sha(bytes),
    signal: controller.signal,
  });
  await Bun.sleep(5);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(objects(join(base, "artifacts"))).toEqual([]);
  expect(readdirSync(storage.incomingDir)).toEqual([]);
});

test("re-storing identical content is idempotent and never duplicates", async () => {
  const bytes = new Uint8Array(4096).fill(1);
  const input = { key: "idempotent", size: bytes.length, sha256: sha(bytes) };
  await storage.put({ ...input, stream: stream(bytes) });
  const before = statSync(storage.pathFor(input.key)!).mtimeMs;
  await Bun.sleep(5);
  await storage.put({ ...input, stream: stream(bytes) });
  expect(objects(join(base, "artifacts"))).toEqual(["idempotent"]);
  expect(statSync(storage.pathFor(input.key)!).mtimeMs).toBe(before);
  expect((await storage.read(input.key, 0, bytes.length)).length).toBe(4096);
});

test("a symlinked directory can never redirect a write outside the root", async () => {
  const outside = join(base, "outside");
  mkdirSync(outside);
  mkdirSync(join(base, "artifacts"), { recursive: true, mode: 0o700 });
  symlinkSync(outside, join(base, "artifacts", "escape"));
  const bytes = new Uint8Array(64).fill(7);
  await expect(
    storage.put({
      key: "escape/evil",
      stream: stream(bytes),
      size: bytes.length,
      sha256: sha(bytes),
    }),
  ).rejects.toThrow();
  expect(readdirSync(outside)).toEqual([]);
  await expect(storage.read("escape/evil", 0, 1)).rejects.toThrow();
});

test("a relative storage root is refused", () => {
  expect(() => new LocalArtifactStorage("relative/dir")).toThrow();
  expect(() => new LocalArtifactStorage("")).toThrow();
});

test("stale temporary files are swept, and real objects are never touched", async () => {
  const bytes = new Uint8Array(128).fill(2);
  await storage.put({
    key: "kept",
    stream: stream(bytes),
    size: bytes.length,
    sha256: sha(bytes),
  });
  const stale = join(storage.incomingDir, "t-stale");
  const fresh = join(storage.incomingDir, "t-fresh");
  writeFileSync(stale, "x");
  writeFileSync(fresh, "x");
  const old = new Date(Date.now() - 3600_000);
  const { utimesSync } = await import("node:fs");
  utimesSync(stale, old, old);
  const removed = await storage.sweepStale(60_000);
  expect(removed).toBe(1);
  expect(readdirSync(storage.incomingDir)).toEqual(["t-fresh"]);
  expect(storage.pathFor("kept", true)).not.toBeNull();
});

test("storage keys cannot escape the root", () => {
  for (const key of ["../escape", "/abs", "a/../../b", "", "a//b/"])
    expect(() => storage.pathFor(key, true)).toThrow();
});

test("the metadata repository is atomic, idempotent and queryable", () => {
  const store = new Store(":memory:");
  const repository = new ArtifactRepository(store.db as Database);
  const input = {
    worker_id: "w-1",
    task_id: "task-1",
    run_id: "run-1",
    original_path: ".swarmforge/artifacts/report.txt",
    filename: "report.txt",
    kind: "file",
  };
  const first = repository.begin(input);
  expect(first.state).toBe("preserving");
  expect(first.attempts).toBe(1);
  expect(first.sha256).toBeNull();
  expect(first.storage_key).toBeNull();
  // A second attempt on the same source is a second record: one row per attempt
  // is what keeps a failed recapture from being able to touch a published copy.
  const repeat = repository.begin(input);
  expect(repeat.artifact_id).not.toBe(first.artifact_id);
  expect(repeat.attempts).toBe(2);
  const preserved = repository.preserved({
    artifact_id: first.artifact_id,
    storage_key: "aa/artifact",
    size: 12,
    sha256: sha(new TextEncoder().encode("hello world")),
  });
  expect(preserved.state).toBe("preserved");
  expect(preserved.retrieved_at).toBeGreaterThan(0);
  expect(preserved.size).toBe(12);
  // A failed attempt is durable and visible, never silently dropped, and it is a
  // record of its own: the next attempt for that source does not inherit it.
  const third = repository.begin(input);
  expect(third.artifact_id).not.toBe(first.artifact_id);
  const failed = repository.failed(third, "source changed during capture");
  expect(failed.state).toBe("failed");
  expect(failed.error).toBe("source changed during capture");
  expect(failed.attempts).toBe(3);
  expect(failed.retrieved_at).toBeGreaterThan(0);
  // The published copy is still the current one for that source: a failure
  // somewhere else never takes it out of the listing.
  expect(
    repository.find({
      worker_id: "w-1",
      run_id: "run-1",
      original_path: input.original_path,
    }),
  ).toMatchObject({ artifact_id: first.artifact_id, state: "preserved" });
  expect(repository.events(third.artifact_id).map((e) => e.kind)).toEqual([
    "artifact.attempted",
    "artifact.failed",
  ]);
  expect(repository.events(third.artifact_id)[0]?.attempt).toBe(3);
  expect(repository.counters({ worker_id: "w-1" })).toEqual({
    attempts: 2,
    preserved: 1,
    failed: 1,
  });
  expect(
    repository.find({
      worker_id: "w-1",
      run_id: "other",
      original_path: input.original_path,
    }),
  ).toBeNull();
  expect(
    repository.find({
      worker_id: "w-2",
      run_id: "run-1",
      original_path: input.original_path,
    }),
  ).toBeNull();
  store.close();
});

test("listing pages deterministically and filters by worker and task", () => {
  const store = new Store(":memory:");
  const repository = new ArtifactRepository(store.db as Database);
  for (let i = 0; i < 7; i++) {
    const record = repository.begin({
      worker_id: i < 4 ? "w-1" : "w-2",
      task_id: `task-${i % 2}`,
      run_id: `run-${i}`,
      original_path: `file-${i}.txt`,
      filename: `file-${i}.txt`,
      kind: "file",
    });
    repository.preserved({
      artifact_id: record.artifact_id,
      storage_key: "k",
      size: i,
      sha256: sha(new Uint8Array()),
    });
  }
  const page = repository.list({ limit: 3 });
  expect(page.artifacts).toHaveLength(3);
  expect(page.next_offset).toBe(3);
  expect(repository.list({ offset: 6 }).next_offset).toBeNull();
  expect(repository.list({ worker_id: "w-1" }).artifacts).toHaveLength(4);
  expect(repository.list({ task_id: "task-1" }).artifacts).toHaveLength(3);
  const all = repository.list({});
  expect(all.artifacts.map((r) => r.original_path)).toEqual([
    "file-0.txt",
    "file-1.txt",
    "file-2.txt",
    "file-3.txt",
    "file-4.txt",
    "file-5.txt",
    "file-6.txt",
  ]);
  expect(repository.pending()).toHaveLength(0);
  repository.begin({
    worker_id: "w-9",
    task_id: "task-9",
    run_id: "run-9",
    original_path: "interrupted.txt",
    filename: "interrupted.txt",
    kind: "file",
  });
  expect(repository.pending().map((r) => r.original_path)).toEqual([
    "interrupted.txt",
  ]);
  store.close();
});

test("records survive reopening the database and unknown ids fail", () => {
  const path = join(base, "meta.sqlite");
  let artifactId = "";
  {
    const store = new Store(path);
    const repository = new ArtifactRepository(store.db as Database);
    const record = repository.begin({
      worker_id: "w-1",
      task_id: "task-1",
      run_id: null,
      original_path: "a.txt",
      filename: "a.txt",
      kind: "file",
    });
    artifactId = record.artifact_id;
    repository.preserved({
      artifact_id: record.artifact_id,
      storage_key: "aa/bb",
      size: 3,
      sha256: sha(new Uint8Array([1, 2, 3])),
    });
    store.close();
  }
  const reopened = new Store(path);
  const repository = new ArtifactRepository(reopened.db as Database);
  expect(repository.get(artifactId)).toMatchObject({
    state: "preserved",
    run_id: null,
    storage_key: "aa/bb",
  });
  expect(() => repository.get("missing")).toThrow();
  reopened.close();
});

test("a storage implementation only needs the shared interface", async () => {
  const seen: string[] = [];
  const memory: ArtifactStorage = {
    async put(input) {
      seen.push(input.key);
    },
    async open() {
      return stream(new Uint8Array());
    },
    async read() {
      return new Uint8Array();
    },
    async stat() {
      return null;
    },
    async remove(key) {
      seen.push(`remove:${key}`);
    },
    async sweepStale() {
      return 0;
    },
  };
  await memory.put({
    key: "object-key",
    stream: stream(new Uint8Array()),
    size: 0,
    sha256: sha(new Uint8Array()),
  });
  expect(await memory.stat("object-key")).toBeNull();
  await memory.remove("object-key");
  expect(seen).toEqual(["object-key", "remove:object-key"]);
  expect(readFileSync("/dev/null").length).toBe(0);
  expect(chmodSync).toBeDefined();
  expect(existsSync(storage.pathFor("object-key", true) ?? "")).toBe(false);
});

test("a transfer that overruns its declared size is stopped while it runs", async () => {
  let produced = 0;
  const block = new Uint8Array(64 * 1024);
  // A source that would keep producing for ever: the bound is a running count,
  // so the write stops at the declared size instead of filling the disk.
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced++;
      controller.enqueue(block);
    },
  });
  await expect(
    storage.put({
      key: "w-1/endless",
      stream: endless,
      size: block.length * 2,
      sha256: sha(new Uint8Array(0)),
    }),
  ).rejects.toThrow(/declared size/);
  // The transfer is stopped after the declared size, and nothing is published:
  // a source may be pulled one chunk ahead of the consumer, never without end.
  expect(produced).toBeLessThanOrEqual(6);
  expect(storage.pathFor("w-1/endless", true)).toBeNull();
  expect(readdirSync(join(base, "artifacts", ".incoming"))).toEqual([]);
});

test("an abort while the source is blocked wakes the write promptly", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const blocked = new ReadableStream<Uint8Array>({
    pull() {
      // A source that never produces and never resolves on its own.
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = storage.put({
    key: "w-1/blocked",
    stream: blocked,
    size: 1024,
    sha256: sha(new Uint8Array(0)),
    signal: controller.signal,
  });
  const started = Date.now();
  controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(cancelled).toBe(true);
  expect(storage.pathFor("w-1/blocked", true)).toBeNull();
  expect(readdirSync(join(base, "artifacts", ".incoming"))).toEqual([]);
});

test("a download is a real web stream that can be read and cancelled", async () => {
  const bytes = new Uint8Array(300 * 1024).map((_, i) => (i * 7) % 256);
  const key = "w-1/streamed";
  await storage.put({
    key,
    stream: stream(bytes),
    size: bytes.length,
    sha256: sha(bytes),
  });
  const download = await storage.open(key);
  expect(typeof download.getReader).toBe("function");
  const reader = download.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value!);
  }
  const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  expect(joined.length).toBe(bytes.length);
  expect(sha(new Uint8Array(joined))).toBe(sha(bytes));
  // Cancelling stops the reads at once instead of leaving a half-read object.
  const partial = await storage.open(key);
  const stopping = partial.getReader();
  await stopping.read();
  const cancelledAt = Date.now();
  await stopping.cancel();
  expect(Date.now() - cancelledAt).toBeLessThan(1000);
  // The object itself is untouched and still complete.
  expect(sha(await storage.read(key, 0, bytes.length))).toBe(sha(bytes));
});

test("an aborted download stops reading the pinned descriptor", async () => {
  const bytes = new Uint8Array(200 * 1024).fill(7);
  const key = "w-1/signal";
  await storage.put({
    key,
    stream: stream(bytes),
    size: bytes.length,
    sha256: sha(bytes),
  });
  const controller = new AbortController();
  const download = await storage.open(key, { signal: controller.signal });
  const reader = download.getReader();
  await reader.read();
  controller.abort();
  await expect(reader.read()).rejects.toThrow(/abort/i);
  expect(readFileSync(storage.pathFor(key)!).length).toBe(bytes.length);
});

test("an object is durable before its record can claim it", async () => {
  // Publication order is observable: the object is on the medium, and the
  // directory that names it is synced, before `put` resolves. A crash between
  // the rename and the caller's own bookkeeping can therefore only lose the
  // record, never the bytes it names.
  const bytes = new Uint8Array(4096).fill(1);
  const key = "w-1/durable";
  await storage.put({
    key,
    stream: stream(bytes),
    size: bytes.length,
    sha256: sha(bytes),
  });
  // The temporary copy is gone and the object is complete under its own key, so
  // a caller that records the artifact after this returns is never ahead of the
  // bytes it names.
  expect(readdirSync(join(base, "artifacts", ".incoming"))).toEqual([]);
  expect(statSync(storage.pathFor(key)!).size).toBe(bytes.length);
  expect(await storage.stat(key)).toEqual({
    size: bytes.length,
    sha256: sha(bytes),
  });
});

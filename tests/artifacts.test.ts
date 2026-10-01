import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { artifactErrorCode, screeningWindow } from "../src/artifact-types";
import { WorkerFiles } from "../src/files";
import { redactorFor } from "../src/security";
import { type LocalHarness, localHarness } from "./local-artifact-provider";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);
const collect = async (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

/** The window a read would get from character counts and a fixed baseline. */
const baselineWindow = 4096;

/**
 * A read offset that exact-substring screening only catches when the overlap is
 * sized from byte lengths across encoded variants. Placing the read between the
 * baseline window and the correct byte window means an under-sized window
 * starts after the secret, so the secret would leak.
 */
function discriminatingOffset(pad: number): number {
  if (pad <= baselineWindow) throw new Error("window is not discriminating");
  const offset = 1000 + Math.floor((baselineWindow + pad) / 2);
  expect(offset - pad).toBeLessThanOrEqual(1000);
  expect(offset - baselineWindow).toBeGreaterThan(1000);
  return offset;
}

let h: LocalHarness;
let worker: string;
let vm: string;

const artifacts = () => join(h.workspace.root, ".swarmforge", "artifacts");
const write = (name: string, body: string | Uint8Array) => {
  mkdirSync(artifacts(), { recursive: true, mode: 0o700 });
  writeFileSync(join(artifacts(), name), body as string);
};
/** The objects a storage root holds, relative and without its temporary dir. */
const storedFilesOf = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".incoming") continue;
      if (entry.isDirectory())
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  walk(root);
  return out.sort();
};

const storedFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory())
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  walk(h.storageDir);
  return out.filter((entry) => !entry.startsWith(".incoming")).sort();
};

beforeEach(async () => {
  h = await localHarness();
  const created = h.spawn();
  await h.provider.createWorker(created);
  worker = created.worker_id;
  vm = created.vm_id!;
});
afterEach(async () => {
  await h.cleanup();
});

test("a preserved artifact is stored, durable, verifiable and byte-faithful", async () => {
  const body = "report contents\nline two\n";
  write("report.txt", body);
  const record = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/report.txt",
    {
      runId: "run-1",
    },
  );
  expect(record).toMatchObject({
    task_id: "task",
    worker_id: worker,
    run_id: "run-1",
    original_path: ".swarmforge/artifacts/report.txt",
    filename: "report.txt",
    size: body.length,
    sha256: sha(text(body)),
    state: "preserved",
    attempts: 1,
    error: null,
    kind: "file",
  });
  expect(record.retrieved_at).toBeGreaterThan(0);
  expect(record.storage_key).toBeTruthy();
  expect(storedFiles()).toEqual([`${record.storage_key}`]);
  expect(h.artifacts.metadata(record.artifact_id)).toMatchObject({
    artifact_id: record.artifact_id,
  });
  expect(await h.artifacts.read(record.artifact_id, 0, body.length)).toEqual(
    text(body),
  );
  expect(await h.artifacts.read(record.artifact_id, 7, 8)).toEqual(
    text("contents"),
  );
  expect(await collect(await h.artifacts.download(record.artifact_id))).toEqual(
    text(body),
  );
});

test("binary and large artifacts survive the round trip untouched", async () => {
  const binary = new Uint8Array(200_000).map((_, i) => (i * 37) % 256);
  write("blob.bin", binary);
  const small = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/blob.bin",
  );
  // A raw range read is explicitly capped: a large object is streamed, never
  // assembled in memory by a metadata call.
  await expect(
    h.artifacts.read(small.artifact_id, 0, binary.length),
  ).rejects.toThrow();
  expect(await h.artifacts.read(small.artifact_id, 0, 32768)).toEqual(
    binary.subarray(0, 32768),
  );
  expect(await collect(await h.artifacts.download(small.artifact_id))).toEqual(
    binary,
  );
  // 12 MiB through the real stream: no truncation, no buffering, hash matched.
  const size = 12 * 1024 * 1024;
  const big = Buffer.alloc(size);
  const digest = createHash("sha256");
  for (let at = 0; at < size; at += 65536) {
    const block = Buffer.alloc(Math.min(65536, size - at), at % 251);
    big.set(block, at);
    digest.update(block);
  }
  write("big.bin", big);
  const record = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/big.bin",
  );
  expect(record.size).toBe(size);
  expect(record.sha256).toBe(digest.digest("hex"));
  const streamed = await collect(
    await h.artifacts.download(record.artifact_id),
  );
  expect(streamed.length).toBe(size);
  expect(sha(streamed)).toBe(record.sha256!);
});

test("preserving the same source twice is idempotent, and a retry re-attempts", async () => {
  const body = "stable output";
  write("stable.txt", body);
  const first = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/stable.txt",
    {
      runId: "run-1",
    },
  );
  const again = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/stable.txt",
    {
      runId: "run-1",
    },
  );
  // Identical bytes: one current record, one stored object, nothing rewritten.
  expect(storedFiles()).toEqual([`${first.storage_key}`]);
  expect(h.artifacts.list({ worker_id: worker }).artifacts).toHaveLength(1);
  expect(h.artifacts.metadata(again.artifact_id).storage_key).toBe(
    first.storage_key,
  );
  // Changed content is a new attempt with its own key and its own record, so the
  // copy that was already verified is still there, still readable and marked as
  // the one this attempt replaced.
  write("stable.txt", "different output entirely");
  const changed = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/stable.txt",
    { runId: "run-1" },
  );
  expect(changed.artifact_id).not.toBe(first.artifact_id);
  expect(changed.sha256).toBe(sha(text("different output entirely")));
  expect(changed.storage_key).not.toBe(first.storage_key);
  expect(changed.superseded_by).toBeNull();
  // Only the current copy is kept once its replacement is verified.
  expect(storedFiles()).toEqual([`${changed.storage_key}`]);
  expect(
    Buffer.from(
      await h.artifacts.read(changed.artifact_id, 0, changed.size),
    ).toString(),
  ).toBe("different output entirely");
  const replaced = h.artifacts.metadata(first.artifact_id);
  expect(replaced.superseded_by).toBe(changed.artifact_id);
  // A verified replacement supersedes the old copy, so only one object is kept
  // and the replaced record is history rather than a second stored blob.
  expect(h.artifacts.metadata(first.artifact_id).storage_key).toBe(
    first.storage_key,
  );
  expect(storedFiles()).toEqual([`${changed.storage_key}`]);
  // Exactly one current record per source, so a listing cannot grow with retries.
  expect(
    h.artifacts
      .list({ worker_id: worker })
      .artifacts.map((record) => record.artifact_id),
  ).toEqual([changed.artifact_id]);
});

test("an oversized or missing source fails closed with a durable record", async () => {
  const limited = await localHarness({ SWARMFORGE_ARTIFACT_MAX_BYTES: "4096" });
  try {
    const created = limited.spawn();
    await limited.provider.createWorker(created);
    writeFileSync(
      join(limited.workspace.root, ".swarmforge", "big.bin"),
      Buffer.alloc(64 * 1024, 1),
    );
    await expect(
      limited.artifacts.preserve(created.worker_id, ".swarmforge/big.bin"),
    ).rejects.toThrow();
    const failed = limited.artifacts
      .list({ worker_id: created.worker_id })
      .artifacts.at(0)!;
    expect(failed.state).toBe("failed");
    expect(failed.storage_key).toBeNull();
    expect(failed.error).toMatch(/maximum size/i);
    expect(failed.sha256).toBeNull();
    const missing = await limited.artifacts
      .preserve(created.worker_id, ".swarmforge/absent.txt")
      .then(() => null)
      .catch((error: Error) => error);
    // The refusal names its own class, so a caller can tell an absent source
    // from a size limit without reading English.
    expect(String(missing)).toMatch(/no such file|not a regular file/i);
    expect(artifactErrorCode(missing)).toBe("not_found");
    expect(
      limited.artifacts.list({ worker_id: created.worker_id }).artifacts,
    ).toHaveLength(2);
    // A retry after a failure reuses the record and can still succeed.
    writeFileSync(
      join(limited.workspace.root, ".swarmforge", "big.bin"),
      "small now",
    );
    const retry = await limited.artifacts.preserve(
      created.worker_id,
      ".swarmforge/big.bin",
    );
    expect(retry.state).toBe("preserved");
    // The failed attempt stays as its own durable record; the retry is a new one,
    // and its attempt number continues the source's history.
    expect(retry.artifact_id).not.toBe(failed.artifact_id);
    expect(retry.attempts).toBeGreaterThan(failed.attempts);
    expect(limited.artifacts.metadata(failed.artifact_id).state).toBe("failed");
    expect(
      limited.artifacts.counters({ worker_id: created.worker_id }),
    ).toEqual({ attempts: 3, preserved: 1, failed: 2 });
  } finally {
    await limited.cleanup();
  }
});

test("a corrupt transfer is refused and leaves no stored bytes", async () => {
  write("corrupt.txt", "x".repeat(1024));
  const original = h.workspace.transport.open.bind(h.workspace.transport);
  h.workspace.transport.open = async (...args) => {
    const transfer = await original(...args);
    // A transport that lies about its bytes must not be able to store them.
    return { ...transfer, sha256: sha(text("something else")) };
  };
  await expect(
    h.artifacts.preserve(worker, ".swarmforge/artifacts/corrupt.txt"),
  ).rejects.toThrow(/hash/i);
  expect(storedFiles()).toEqual([]);
  expect(h.artifacts.list({ worker_id: worker }).artifacts[0]).toMatchObject({
    state: "failed",
    storage_key: null,
  });
});

test("an aborted preservation stores nothing and cleans its staging", async () => {
  const controller = new AbortController();
  write("aborted.bin", Buffer.alloc(3 * 1024 * 1024, 4));
  controller.abort();
  await expect(
    h.artifacts.preserve(worker, ".swarmforge/artifacts/aborted.bin", {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(storedFiles()).toEqual([]);
  expect(h.workspace.stagingEntries()).toEqual([]);
  const records = h.artifacts.list({ worker_id: worker }).artifacts;
  expect(records[0]?.state).toBe("failed");
  expect(records[0]?.error).toMatch(/abort/i);
});

test("a snapshot of the workspace is stored as one bounded archive", async () => {
  write("keep.txt", "keep");
  mkdirSync(join(h.workspace.root, "src"), { recursive: true });
  writeFileSync(join(h.workspace.root, "src", "one.txt"), "one");
  writeFileSync(
    join(h.workspace.root, "src", "two.bin"),
    Buffer.from([0, 255]),
  );
  const record = await h.artifacts.snapshot(worker, {
    paths: ["src"],
    runId: "run-1",
  });
  expect(record.kind).toBe("snapshot");
  expect(record.filename.endsWith(".tar.gz")).toBe(true);
  expect(record.state).toBe("preserved");
  const bytes = await h.artifacts.read(record.artifact_id, 0, record.size);
  expect(bytes[0]).toBe(0x1f);
  expect(bytes[1]).toBe(0x8b);
  expect(
    Bun.spawnSync(["tar", "-tzf", "-"], { stdin: bytes }).stdout.toString(),
  ).toContain("src/one.txt");
});

test("diagnostics are captured as separate bounded artifacts", async () => {
  const records = await h.artifacts.diagnostics(worker, { runId: "run-1" });
  expect(records.length).toBe(2);
  for (const record of records) {
    expect(record.kind).toBe("diagnostic");
    expect(record.state).toBe("preserved");
    expect(record.original_path.startsWith("logs/")).toBe(true);
    expect(
      sha(await h.artifacts.read(record.artifact_id, 0, record.size)),
    ).toBe(record.sha256!);
  }
  expect(h.workspace.stagingEntries()).toEqual([]);
});

test("collecting a directory stores each regular file and skips the rest", async () => {
  write("one.txt", "one");
  write("two.bin", Buffer.from([1, 2, 3]));
  mkdirSync(join(artifacts(), "nested"));
  writeFileSync(join(artifacts(), "nested", "three.txt"), "three");
  symlinkSync("/etc/passwd", join(artifacts(), "escape.txt"));
  const records = await h.artifacts.collectDirectory(
    worker,
    ".swarmforge/artifacts",
    { runId: "run-1" },
  );
  expect(records.map((r) => r.original_path).sort()).toEqual([
    ".swarmforge/artifacts/one.txt",
    ".swarmforge/artifacts/two.bin",
    "snapshot:.swarmforge/artifacts/nested",
  ]);
  // A nested directory becomes its own bounded archive rather than being
  // flattened into the parent or dropped, so a tree is not silently truncated.
  expect(records.find((r) => r.original_path.endsWith("nested"))?.kind).toBe(
    "snapshot",
  );
  for (const record of records) expect(record.state).toBe("preserved");
});

test("listWorkerFiles pages live guest files without leaking entries", async () => {
  write("a.txt", "a");
  write("b.txt", "bb");
  symlinkSync("/etc/passwd", join(artifacts(), "escape"));
  Bun.spawnSync(["mkfifo", join(artifacts(), "fifo")]);
  mkdirSync(join(artifacts(), "sub"));
  const listing = await h.artifacts.listWorkerFiles(
    worker,
    ".swarmforge/artifacts",
  );
  expect(listing.entries.map((e) => e.name).sort()).toEqual([
    "a.txt",
    "b.txt",
    "sub",
  ]);
  expect(listing.entries.find((e) => e.name === "a.txt")?.size).toBe(1);
  const page = await h.artifacts.listWorkerFiles(
    worker,
    ".swarmforge/artifacts",
    {
      limit: 2,
    },
  );
  expect(page.entries).toHaveLength(2);
  expect(page.next_offset).toBe(2);
  await expect(
    h.artifacts.listWorkerFiles(worker, "../../etc"),
  ).rejects.toThrow();
  await expect(h.artifacts.listWorkerFiles(worker, "/etc")).rejects.toThrow();
});

test("listing metadata pages, filters and reports unknown ids", async () => {
  write("x.txt", "x");
  await h.artifacts.preserve(worker, ".swarmforge/artifacts/x.txt", {
    runId: "run-1",
  });
  mkdirSync(join(h.workspace.root, "src"), { recursive: true });
  writeFileSync(join(h.workspace.root, "src", "one.txt"), "one");
  await h.artifacts.snapshot(worker, { paths: ["src"] });
  const all = h.artifacts.list({});
  expect(all.artifacts).toHaveLength(2);
  expect(all.next_offset).toBeNull();
  const page = h.artifacts.list({ limit: 1 });
  expect(page.next_offset).toBe(1);
  expect(h.artifacts.list({ worker_id: "w-other" }).artifacts).toHaveLength(0);
  expect(h.artifacts.list({ task_id: "task" }).artifacts).toHaveLength(2);
  expect(() => h.artifacts.metadata("art-missing")).toThrow();
  await expect(h.artifacts.read("art-missing", 0, 1)).rejects.toThrow();
  await expect(h.artifacts.download("art-missing")).rejects.toThrow();
});

test("safe reads screen credentials across boundaries and stay bounded", async () => {
  const key = h.config.SWARMFORGE_MODEL_API_KEY;
  // A secret just outside the requested window is still caught, because the
  // overlap inspected around it can hold the tail of a very long token.
  const head = "y".repeat(20000);
  write("split.txt", `${head}${key}${head}CLEAN-TAIL`);
  const split = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/split.txt",
  );
  expect(split.size).toBe(head.length * 2 + key.length + "CLEAN-TAIL".length);
  const near = head.length + key.length + 100;
  await expect(
    h.artifacts.safeRead(split.artifact_id, near, 8),
  ).rejects.toThrow(/credentials/i);
  expect(
    Buffer.from(
      await h.artifacts.safeRead(split.artifact_id, split.size - 8, 8),
    ).toString(),
  ).toBe("EAN-TAIL");

  // Every configured secret source and its encoded variants are screened.
  const secrets = [
    h.config.SWARMFORGE_MODEL_API_KEY,
    h.config.FREESTYLE_API_TOKEN,
    h.store.get(worker).server_password,
  ];
  for (const [index, secret] of secrets.entries()) {
    for (const variant of new Set([
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
    ])) {
      write(`secret-${index}-${variant.length}.txt`, `before${variant}after`);
      const record = await h.artifacts.preserve(
        worker,
        `.swarmforge/artifacts/secret-${index}-${variant.length}.txt`,
      );
      await expect(h.artifacts.safeRead(record.artifact_id)).rejects.toThrow(
        /credentials/i,
      );
      // Raw private reads stay faithful: storage keeps bytes as they were.
      expect(
        Buffer.from(
          await h.artifacts.read(record.artifact_id, 0, record.size),
        ).toString(),
      ).toBe(`before${variant}after`);
    }
  }
  write("clean.txt", "nothing sensitive here");
  const clean = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/clean.txt",
  );
  expect(
    Buffer.from(
      await h.artifacts.safeRead(clean.artifact_id, 0, 32),
    ).toString(),
  ).toBe("nothing sensitive here");
  expect((await h.artifacts.safeRead(clean.artifact_id, 0, 1)).length).toBe(1);
  await expect(
    h.artifacts.safeRead(clean.artifact_id, 0, 32769),
  ).rejects.toThrow();
  await expect(
    h.artifacts.safeRead(clean.artifact_id, -1, 10),
  ).rejects.toThrow();
  // A very long token still blocks a read that only overlaps it partly.
  const longHarness = await localHarness({
    SWARMFORGE_MODEL_API_KEY: "L".repeat(9000),
  });
  try {
    const created = longHarness.spawn();
    await longHarness.provider.createWorker(created);
    writeFileSync(
      join(longHarness.workspace.root, "long.txt"),
      `${"z".repeat(200)}${"L".repeat(9000)}`,
    );
    const record = await longHarness.artifacts.preserve(
      created.worker_id,
      "long.txt",
    );
    await expect(
      longHarness.artifacts.safeRead(record.artifact_id, 200, 64),
    ).rejects.toThrow(/credentials/i);
  } finally {
    await longHarness.cleanup();
  }
});

test("a provider without artifact transport fails clearly", async () => {
  const bare = await localHarness();
  try {
    (bare.provider as { artifactTransport?: unknown }).artifactTransport =
      undefined;
    const created = bare.spawn();
    writeFileSync(join(bare.workspace.root, "a.txt"), "a");
    await expect(
      bare.artifacts.preserve(created.worker_id, "a.txt"),
    ).rejects.toThrow(/transport/i);
  } finally {
    await bare.cleanup();
  }
});

test("a destroyed or vanished guest has nothing left to preserve", async () => {
  write("gone.txt", "gone");
  // The record is terminal: retention no longer has a source to read.
  h.store.transition(worker, "destroyed");
  await expect(
    h.artifacts.preserve(worker, ".swarmforge/artifacts/gone.txt"),
  ).rejects.toThrow(/no VM/i);
  await expect(h.artifacts.listWorkerFiles(worker)).rejects.toThrow(/no VM/i);
  // A live record whose guest disappeared fails in the transport instead.
  const other = h.spawn({ task_id: "task-2" });
  await h.provider.createWorker(other);
  await h.provider.destroyWorker(other.vm_id!);
  await expect(
    h.artifacts.preserve(other.worker_id, ".swarmforge/artifacts/gone.txt"),
  ).rejects.toThrow();
  expect(storedFiles()).toEqual([]);
});

test("a preserved artifact outlives the guest it came from", async () => {
  const body = "salvaged before the guest disappeared\n";
  write("salvage.txt", body);
  const record = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/salvage.txt",
    { runId: "run-1" },
  );
  // The whole point of preservation: the guest and its filesystem go away.
  await h.provider.destroyWorker(vm);
  expect(existsSync(join(h.workspace.root, ".swarmforge", "artifacts"))).toBe(
    false,
  );
  expect(
    Buffer.from(
      await h.artifacts.read(record.artifact_id, 0, record.size),
    ).toString(),
  ).toBe(body);
  expect(
    sha(await collect(await h.artifacts.download(record.artifact_id))),
  ).toBe(record.sha256!);
  expect(h.artifacts.metadata(record.artifact_id).state).toBe("preserved");
  expect(h.artifacts.list({ worker_id: worker }).artifacts).toHaveLength(1);
});

test("concurrent preservation is bounded and every transfer still lands", async () => {
  const limited = await localHarness({
    SWARMFORGE_ARTIFACT_CONCURRENCY: "2",
    SWARMFORGE_ARTIFACT_MAX_ENTRIES: "100",
  });
  try {
    const created = limited.spawn();
    await limited.provider.createWorker(created);
    const directory = join(limited.workspace.root, "many");
    mkdirSync(directory, { recursive: true });
    for (let i = 0; i < 6; i++)
      writeFileSync(join(directory, `f${i}.bin`), Buffer.alloc(2048, i));
    let active = 0;
    let peak = 0;
    const transport = limited.workspace.transport;
    const original = transport.open.bind(transport);
    transport.open = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await original(...args);
      } finally {
        active--;
      }
    };
    const records = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        limited.artifacts.preserve(created.worker_id, `many/f${i}.bin`),
      ),
    );
    expect(records).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(records.every((r) => r.state === "preserved")).toBe(true);
    expect(storedFilesIn(limited.storageDir)).toHaveLength(6);
    expect(existsSync(join(directory, "f0.bin"))).toBe(true);
    for (const record of records)
      expect(
        sha(await limited.artifacts.read(record.artifact_id, 0, record.size)),
      ).toBe(record.sha256!);
  } finally {
    await limited.cleanup();
  }
});

function storedFilesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory())
        walk(join(current, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  walk(dir);
  return out.filter((entry) => !entry.startsWith(".incoming"));
}

test("a queued transfer that aborts does not strand the queue", async () => {
  const limited = await localHarness({
    SWARMFORGE_ARTIFACT_CONCURRENCY: "1",
  });
  try {
    const created = limited.spawn();
    await limited.provider.createWorker(created);
    mkdirSync(join(limited.workspace.root, "q"), { recursive: true });
    for (const name of ["one.bin", "two.bin", "three.bin"])
      writeFileSync(
        join(limited.workspace.root, "q", name),
        Buffer.alloc(4096, 1),
      );
    // Hold the only slot so the next two callers have to queue behind it.
    let unblock: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started = 0;
    let peak = 0;
    const transport = limited.workspace.transport;
    const original = transport.open.bind(transport);
    transport.open = async (...args) => {
      started++;
      peak = Math.max(peak, started);
      if (started === 1) await held;
      started--;
      return original(...args);
    };
    const first = limited.artifacts.preserve(created.worker_id, "q/one.bin");
    for (let i = 0; i < 50 && started === 0; i++) await Bun.sleep(5);
    expect(started).toBe(1);
    const controller = new AbortController();
    const stranded = limited.artifacts.preserve(
      created.worker_id,
      "q/two.bin",
      {
        signal: controller.signal,
      },
    );
    await Bun.sleep(5);
    controller.abort();
    await expect(stranded).rejects.toThrow(/abort/i);
    const third = limited.artifacts.preserve(created.worker_id, "q/three.bin");
    unblock!();
    await first;
    // The aborted waiter must not consume the released slot and strand this one.
    await third;
    expect(peak).toBe(1);
    expect(
      limited.artifacts
        .list({ worker_id: created.worker_id })
        .artifacts.filter((r) => r.state === "preserved")
        .map((r) => r.original_path)
        .sort(),
    ).toEqual(["q/one.bin", "q/three.bin"]);
  } finally {
    await limited.cleanup();
  }
});

test("the configured limit holds under a burst that includes aborted waiters", async () => {
  const limited = await localHarness({
    SWARMFORGE_ARTIFACT_CONCURRENCY: "2",
  });
  try {
    const created = limited.spawn();
    await limited.provider.createWorker(created);
    mkdirSync(join(limited.workspace.root, "burst"), { recursive: true });
    for (let i = 0; i < 8; i++)
      writeFileSync(
        join(limited.workspace.root, "burst", `f${i}.bin`),
        Buffer.alloc(8192, i),
      );
    let active = 0;
    let peak = 0;
    const transport = limited.workspace.transport;
    const original = transport.open.bind(transport);
    transport.open = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await Bun.sleep(5);
        return await original(...args);
      } finally {
        active--;
      }
    };
    const controllers = [new AbortController(), new AbortController()];
    const jobs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      limited.artifacts.preserve(created.worker_id, `burst/f${i}.bin`, {
        ...(i === 3 ? { signal: controllers[0]!.signal } : {}),
        ...(i === 6 ? { signal: controllers[1]!.signal } : {}),
      }),
    );
    await Bun.sleep(10);
    controllers[0]!.abort();
    controllers[1]!.abort();
    const settled = await Promise.allSettled(jobs);
    expect(peak).toBeLessThanOrEqual(2);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(
      settled
        .filter((r) => r.status === "fulfilled")
        .map(
          (r) => (r as PromiseFulfilledResult<{ state: string }>).value.state,
        ),
    ).toEqual(Array(6).fill("preserved"));
  } finally {
    await limited.cleanup();
  }
});

test("screening covers long, encoded and per-worker secrets in byte terms", async () => {
  const longApiToken = `t${"π".repeat(5000)}`;
  const harness = await localHarness({
    SWARMFORGE_API_TOKEN: longApiToken,
    SWARMFORGE_MODEL_API_KEY: "model-secret",
  });
  try {
    const created = harness.spawn();
    await harness.provider.createWorker(created);
    // A long per-worker server password is part of the same secret set.
    const password = `pw${"日".repeat(3000)}`;
    harness.store.patch(created.worker_id, { server_password: password });
    const cases = [
      { name: "api-raw", secret: longApiToken },
      { name: "pw-raw", secret: password },
      { name: "model-raw", secret: harness.config.SWARMFORGE_MODEL_API_KEY },
      { name: "api-url", secret: encodeURIComponent(longApiToken) },
      { name: "pw-base64", secret: Buffer.from(password).toString("base64") },
    ];
    const pad = screeningWindow(redactorFor(harness.coordinator).secrets());
    for (const item of cases) {
      const bytes = Buffer.byteLength(item.secret);
      // A read that only a correctly sized window can still cover.
      const offset = discriminatingOffset(pad);
      expect(bytes).toBeGreaterThan(0);
      writeFileSync(
        join(harness.workspace.root, `${item.name}.txt`),
        Buffer.concat([
          Buffer.from("A".repeat(1000)),
          Buffer.from(item.secret),
          Buffer.from("B".repeat(bytes * 2)),
        ]),
      );
      const record = await harness.artifacts.preserve(
        created.worker_id,
        `${item.name}.txt`,
      );
      await expect(
        harness.artifacts.safeRead(record.artifact_id, offset, 16),
      ).rejects.toThrow(/credentials/i);
      // Raw private reads stay faithful.
      expect(
        (await harness.artifacts.read(record.artifact_id, 1000, bytes))
          .byteLength,
      ).toBe(bytes);
    }
  } finally {
    await harness.cleanup();
  }
});

test("a truncated listing or snapshot fails instead of reporting completeness", async () => {
  const limited = await localHarness({
    SWARMFORGE_ARTIFACT_MAX_ENTRIES: "3",
  });
  try {
    const created = limited.spawn();
    await limited.provider.createWorker(created);
    const directory = join(limited.workspace.root, "many");
    mkdirSync(directory, { recursive: true });
    for (let i = 0; i < 6; i++)
      writeFileSync(join(directory, `f${i}.txt`), `body ${i}`);
    // A directory with more entries than the cap is provably incomplete.
    await expect(
      limited.artifacts.collectDirectory(created.worker_id, "many"),
    ).rejects.toThrow(/limit|incomplete/i);
    const records = limited.artifacts.list({
      worker_id: created.worker_id,
    }).artifacts;
    expect(records).toHaveLength(0);
    // A snapshot that stopped at the entry or depth cap is not a faithful
    // archive either, so it must not be stored as if it were one.
    await expect(
      limited.artifacts.snapshot(created.worker_id, { paths: ["many"] }),
    ).rejects.toThrow(/limit|incomplete/i);
    const after = limited.artifacts.list({
      worker_id: created.worker_id,
    }).artifacts;
    expect(after.every((r) => r.state === "failed")).toBe(true);
    expect(after.every((r) => r.storage_key === null)).toBe(true);
    expect(storedFilesIn(limited.storageDir)).toEqual([]);
    // With the cap raised the same collection succeeds.
    const roomy = await localHarness({
      SWARMFORGE_ARTIFACT_MAX_ENTRIES: "100",
    });
    try {
      const okWorker = roomy.spawn();
      await roomy.provider.createWorker(okWorker);
      const roomyDirectory = join(roomy.workspace.root, "many");
      mkdirSync(roomyDirectory, { recursive: true });
      for (let i = 0; i < 6; i++)
        writeFileSync(join(roomyDirectory, `f${i}.txt`), `body ${i}`);
      const collected = await roomy.artifacts.collectDirectory(
        okWorker.worker_id,
        "many",
      );
      expect(collected).toHaveLength(6);
      expect(collected.every((r) => r.state === "preserved")).toBe(true);
    } finally {
      await roomy.cleanup();
    }
  } finally {
    await limited.cleanup();
  }
});

test("a secret too wide to screen in bounded memory is refused, not under-screened", async () => {
  // The URL-encoded form of this token is far wider than the bounded overlap.
  const huge = `h${"π".repeat(30000)}`;
  const harness = await localHarness({
    SWARMFORGE_MODEL_API_KEY: huge,
    SWARMFORGE_API_TOKEN: "small-token-value-1234567",
  });
  try {
    const created = harness.spawn();
    await harness.provider.createWorker(created);
    writeFileSync(
      join(harness.workspace.root, "wide.txt"),
      Buffer.concat([Buffer.from("A".repeat(100)), Buffer.from(huge)]),
    );
    const record = await harness.artifacts.preserve(
      created.worker_id,
      "wide.txt",
    );
    await expect(
      harness.artifacts.safeRead(record.artifact_id, 0, 16),
    ).rejects.toThrow(/screening window/i);
    // The refusal is about the screen, not about content: a clean range in the
    // same artifact is refused too rather than returned unscreened.
    expect(record.state).toBe("preserved");
  } finally {
    await harness.cleanup();
  }
});

test("a failed diagnostic releases every capture it opened", async () => {
  const storage = h.artifacts.storage;
  const original = storage.put.bind(storage);
  let attempts = 0;
  storage.put = async (input) => {
    attempts++;
    if (attempts === 1) throw new Error("storage unavailable");
    return original(input);
  };
  try {
    await expect(h.artifacts.diagnostics(worker, {})).rejects.toThrow(
      /storage unavailable/,
    );
    // The second capture was still open when the first failed: its stream and
    // its staged copy are both released rather than left behind.
    expect(h.workspace.stagingEntries()).toEqual([]);
    const records = h.artifacts.list({ worker_id: worker }).artifacts;
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("failed");
    expect(records[0]?.original_path).toBe("logs/opencode-journal.txt");
  } finally {
    storage.put = original;
  }
});

test("a failed recapture keeps the previous verified copy readable", async () => {
  write("keep.txt", "the good copy");
  const first = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/keep.txt",
    { runId: "run-1" },
  );
  // The source changed and the recapture is then interrupted: the replacement is
  // written to a key of its own, so the copy that was already verified is still
  // there, still current and still readable afterwards.
  write("keep.txt", "half a different copy");
  const controller = new AbortController();
  const transport = h.workspace.transport;
  const original = transport.open.bind(transport);
  transport.open = async (...args) => {
    const transfer = await original(...args);
    const stream = transfer.stream;
    return {
      ...transfer,
      stream: new ReadableStream<Uint8Array>({
        async start(read) {
          const reader = stream.getReader();
          const { value } = await reader.read();
          read.enqueue(value!);
          await reader.cancel();
          controller.abort();
        },
      }),
    };
  };
  try {
    await expect(
      h.artifacts.preserve(worker, ".swarmforge/artifacts/keep.txt", {
        runId: "run-1",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  } finally {
    transport.open = original;
  }
  const current = h.artifacts.metadata(first.artifact_id);
  expect(current.state).toBe("preserved");
  expect(current.superseded_by).toBeNull();
  expect(current.storage_key).toBe(first.storage_key);
  expect(
    Buffer.from(
      await h.artifacts.read(current.artifact_id, 0, current.size),
    ).toString(),
  ).toBe("the good copy");
  expect(storedFiles()).toEqual([`${first.storage_key}`]);
  // The failed attempt is recorded on its own, so the failure is visible without
  // the good copy losing its identity.
  const listed = h.artifacts.list({ worker_id: worker }).artifacts;
  expect(listed.map((record) => record.state).sort()).toEqual([
    "failed",
    "preserved",
  ]);
  const failedRecord = listed.find((record) => record.state === "failed")!;
  const failed = h.artifacts
    .events(failedRecord.artifact_id)
    .filter((event) => event.kind === "artifact.failed");
  expect(failed.length).toBeGreaterThan(0);
  expect(failed.at(-1)?.error).toMatch(/abort/i);
});

test("a failed recapture keeps the copy readable after the guest is destroyed", async () => {
  write("survivor.txt", "durable content");
  const first = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/survivor.txt",
    { runId: "run-1" },
  );
  // A recapture that fails its integrity check, not one that is interrupted.
  const transport = h.workspace.transport;
  const original = transport.open.bind(transport);
  transport.open = async (...args) => {
    const transfer = await original(...args);
    return { ...transfer, sha256: sha(text("a different hash entirely")) };
  };
  try {
    await expect(
      h.artifacts.preserve(worker, ".swarmforge/artifacts/survivor.txt", {
        runId: "run-1",
      }),
    ).rejects.toThrow(/hash/i);
  } finally {
    transport.open = original;
  }
  await h.provider.destroyWorker(vm);
  const current = h.artifacts.metadata(first.artifact_id);
  expect(current.state).toBe("preserved");
  expect(current.sha256).toBe(first.sha256);
  expect(
    Buffer.from(
      await h.artifacts.read(current.artifact_id, 0, current.size),
    ).toString(),
  ).toBe("durable content");
  expect(storedFiles()).toEqual([`${first.storage_key}`]);
  // The failed attempt and the success before it are both countable afterwards.
  expect(h.artifacts.counters({ worker_id: worker })).toEqual({
    attempts: 2,
    preserved: 1,
    failed: 1,
  });
});

test("a successful recapture supersedes the old record and drops its object", async () => {
  write("swap.txt", "first version");
  const first = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/swap.txt",
    { runId: "run-1" },
  );
  write("swap.txt", "second version");
  const second = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/swap.txt",
    { runId: "run-1" },
  );
  expect(second.storage_key).not.toBe(first.storage_key);
  expect(h.artifacts.metadata(first.artifact_id).superseded_by).toBe(
    second.artifact_id,
  );
  expect(storedFiles()).toEqual([`${second.storage_key}`]);
  expect(h.artifacts.list({ worker_id: worker }).artifacts).toHaveLength(1);
  expect(h.artifacts.counters({ worker_id: worker })).toMatchObject({
    preserved: 2,
    failed: 0,
  });
});

test("durable events count attempts, successes and failures without contents", async () => {
  write("evented.txt", "body");
  const record = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/evented.txt",
  );
  const events = h.artifacts.events(record.artifact_id);
  expect(events.map((event) => event.kind)).toEqual([
    "artifact.attempted",
    "artifact.preserved",
  ]);
  expect(events[1]).toMatchObject({
    worker_id: worker,
    artifact_kind: "file",
    outcome: "preserved",
    size: "body".length,
    attempt: 1,
  });
  // The event stream carries no artifact bytes, only the verified size and hash.
  expect(JSON.stringify(events)).not.toContain("body");
  expect(events.length).toBeLessThanOrEqual(21);
});

test("a diagnostic that hit a bound is preserved and labelled incomplete", async () => {
  // A bound this small cannot hold a whole journal or diff, so every capture is
  // a bounded prefix of what it was asked for.
  const limited = await localHarness({
    SWARMFORGE_ARTIFACT_MAX_BYTES: "64",
  });
  try {
    const created = limited.spawn();
    await limited.provider.createWorker(created);
    const records = await limited.artifacts.diagnostics(created.worker_id, {
      runId: "run-1",
    });
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.state).toBe("preserved");
      expect(record.size).toBeLessThanOrEqual(64);
      // The bytes are real and verified ...
      const bytes = await limited.artifacts.read(
        record.artifact_id,
        0,
        record.size,
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        record.sha256 ?? "",
      );
      // ... and they are not passed off as the whole report.
      expect(record.incomplete).toBeTruthy();
    }
  } finally {
    await limited.cleanup();
  }
});

test("a full diagnostic with no bound is not labelled incomplete", async () => {
  const records = await h.artifacts.diagnostics(worker, { runId: "run-1" });
  expect(records.length).toBe(2);
  for (const record of records) {
    expect(record.state).toBe("preserved");
    expect(record.incomplete).toBeNull();
  }
});

test("collecting a directory follows the listing to its end", async () => {
  const directory = join(h.workspace.root, "many");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const names: string[] = [];
  for (let index = 0; index < 12; index++) {
    const name = `file-${String(index).padStart(2, "0")}.txt`;
    names.push(name);
    writeFileSync(join(directory, name), `body ${index}`);
  }
  // The transport answers with a small page, exactly as a guest that caps one
  // response would. A collection that trusted the first page would report twelve
  // files as the whole directory.
  const transport = h.workspace.transport;
  const original = transport.list.bind(transport);
  const pages: number[] = [];
  transport.list = async (vmId, root, path, options = {}) => {
    const all = await original(vmId, root, path, {
      ...options,
      limit: 1000,
      offset: 0,
    });
    const start = options.offset ?? 0;
    const end = start + 5;
    pages.push(all.entries.slice(start, end).length);
    return {
      entries: all.entries.slice(start, end),
      next_offset: end < all.entries.length ? end : null,
    };
  };
  try {
    const records = await h.artifacts.collectDirectory(worker, "many", {
      runId: "run-1",
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(records.map((record) => record.original_path).sort()).toEqual(
      names.map((name) => `many/${name}`).sort(),
    );
    for (const record of records) expect(record.state).toBe("preserved");
  } finally {
    transport.list = original;
  }
});

test("a listing that stops advancing is refused as incomplete", async () => {
  write("stuck.txt", "one");
  const transport = h.workspace.transport;
  const original = transport.list.bind(transport);
  transport.list = async (_vmId, _root, _path, options = {}) => ({
    entries: [{ name: "stuck.txt", kind: "file", size: 3 }],
    next_offset: options.offset ?? 0,
  });
  try {
    await expect(
      h.artifacts.collectDirectory(worker, ".swarmforge/artifacts"),
    ).rejects.toThrow(/did not advance/);
  } finally {
    transport.list = original;
  }
});

test("a live listing is not cut short by entries a caller cannot use", async () => {
  // Symlinks sort before the files here, so filtering after the transport has
  // paged would hand back an empty first page and a caller would read that as an
  // empty directory.
  const listing = join(h.workspace.root, "mixed");
  mkdirSync(listing, { recursive: true, mode: 0o700 });
  for (const name of ["a-escape", "b-escape", "c-escape"])
    symlinkSync("/etc/passwd", join(listing, name));
  writeFileSync(join(listing, "d-file.txt"), "d");
  writeFileSync(join(listing, "e-file.txt"), "e");
  const first = await h.artifacts.listWorkerFiles(worker, "mixed", {
    limit: 1,
  });
  expect(first.entries.map((entry) => entry.name)).toEqual(["d-file.txt"]);
  // The next page continues from the transport's own offset, so nothing is
  // skipped and nothing is repeated.
  const second = await h.artifacts.listWorkerFiles(worker, "mixed", {
    limit: 5,
    offset: first.next_offset ?? 0,
  });
  expect(second.entries.map((entry) => entry.name)).toEqual(["e-file.txt"]);
  expect(second.next_offset).toBeNull();
  for (const bad of [1.5, -1, Number.NaN])
    await expect(
      h.artifacts.listWorkerFiles(worker, "mixed", { offset: bad }),
    ).rejects.toThrow();
  await expect(
    h.artifacts.listWorkerFiles(worker, "mixed", { limit: 2.5 }),
  ).rejects.toThrow();
});

test("a refused live read surfaces the refusal class to the caller", async () => {
  const files = new WorkerFiles(h.coordinator);
  write("secret-free.txt", "clean");
  mkdirSync(join(h.workspace.root, ".swarmforge", "artifacts", "dir"), {
    recursive: true,
  });
  const absent = await files
    .readArtifact(worker, "absent.txt")
    .then(() => null)
    .catch((error: unknown) => error);
  expect(artifactErrorCode(absent)).toBe("not_found");
  const notFile = await files
    .readArtifact(worker, "dir")
    .then(() => null)
    .catch((error: unknown) => error);
  expect(["not_directory", "unsafe_path"]).toContain(
    artifactErrorCode(notFile),
  );
  expect(await files.readArtifact(worker, "secret-free.txt")).toEqual(
    text("clean"),
  );
});

test("a recorded error is screened before it is bounded", async () => {
  const secret = "cred-that-must-never-be-recorded";
  const harness = await localHarness({ SWARMFORGE_MODEL_API_KEY: secret });
  try {
    const created = harness.spawn();
    await harness.provider.createWorker(created);
    const transport = harness.workspace.transport;
    const original = transport.open.bind(transport);
    const refuse = async (message: string, path: string) => {
      transport.open = async () => {
        throw new Error(message);
      };
      try {
        await expect(
          harness.artifacts.preserve(created.worker_id, path),
        ).rejects.toThrow();
      } finally {
        transport.open = original;
      }
    };
    // A credential inside the part of the message that survives the cut is
    // replaced, not merely dropped by the cut.
    await refuse(
      `capture refused for token=${secret}`,
      ".swarmforge/early.txt",
    );
    const early = harness.artifacts
      .list({ worker_id: created.worker_id })
      .artifacts.at(-1)!;
    expect(early.state).toBe("failed");
    expect(early.error).not.toContain(secret);
    expect(early.error).toContain("[REDACTED]");
    expect(early.error!.length).toBeLessThanOrEqual(1000);
    // One buried past the cut is gone as well, because screening happens first.
    await refuse(
      `${"x".repeat(4000)} token=${secret} ${"y".repeat(4000)}`,
      ".swarmforge/deep.txt",
    );
    const deep = harness.artifacts
      .list({ worker_id: created.worker_id })
      .artifacts.at(-1)!;
    expect(deep.error).not.toContain(secret);
    expect(deep.error!.length).toBeLessThanOrEqual(1000);
  } finally {
    await harness.cleanup();
  }
});

test("a hundred real captures stay inside the entry, listing and event bounds", async () => {
  // Scale through the production helper, not a double: the point is that the
  // helper, staging, verification and the repository all hold up together, and
  // that nothing about a large run grows without a bound.
  const many = await localHarness({ SWARMFORGE_ARTIFACT_MAX_ENTRIES: "500" });
  try {
    const created = many.spawn();
    await many.provider.createWorker(created);
    const directory = join(many.workspace.root, "bulk");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 100; index++)
      writeFileSync(
        join(directory, `item-${String(index).padStart(3, "0")}.txt`),
        `body ${index}\n`,
      );
    const records = await many.artifacts.collectDirectory(
      created.worker_id,
      "bulk",
      { runId: "run-1" },
    );
    expect(records).toHaveLength(100);
    for (const record of records) expect(record.state).toBe("preserved");
    // The listing pages deterministically and the current view is complete.
    const listed = many.artifacts.list({
      worker_id: created.worker_id,
      limit: 100,
    });
    expect(listed.artifacts).toHaveLength(100);
    expect(listed.next_offset).toBeNull();
    expect(many.artifacts.counters({ worker_id: created.worker_id })).toEqual({
      attempts: 100,
      preserved: 100,
      failed: 0,
    });
    // One current record and one stored object per source: no duplicate blobs.
    const stored = storedFilesOf(many.storageDir);
    expect(stored).toHaveLength(100);
    expect(new Set(stored).size).toBe(100);
  } finally {
    await many.cleanup();
  }
}, 120000);

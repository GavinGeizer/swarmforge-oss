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

let h: LocalHarness;
let worker: string;
let _vm: string;

const artifacts = () => join(h.workspace.root, ".swarmforge", "artifacts");
const write = (name: string, body: string | Uint8Array) => {
  mkdirSync(artifacts(), { recursive: true, mode: 0o700 });
  writeFileSync(join(artifacts(), name), body as string);
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
  _vm = created.vm_id!;
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
  expect(await h.artifacts.read(small.artifact_id, 0, binary.length)).toEqual(
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
  expect(sha(await h.artifacts.read(record.artifact_id, 0, size))).toBe(
    record.sha256!,
  );
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
  expect(again.artifact_id).toBe(first.artifact_id);
  expect(again.attempts).toBe(1);
  expect(storedFiles()).toEqual([`${first.storage_key}`]);
  // The same source is one artifact: new content replaces the stored bytes and
  // bumps the attempt count, rather than leaving a record describing content
  // that is no longer there.
  write("stable.txt", "different output entirely");
  const changed = await h.artifacts.preserve(
    worker,
    ".swarmforge/artifacts/stable.txt",
    { runId: "run-1" },
  );
  expect(changed.artifact_id).toBe(first.artifact_id);
  expect(changed.attempts).toBe(2);
  expect(changed.sha256).toBe(sha(text("different output entirely")));
  expect(changed.storage_key).toBe(first.storage_key);
  expect(storedFiles()).toEqual([`${first.storage_key}`]);
  expect(
    Buffer.from(
      await h.artifacts.read(changed.artifact_id, 0, changed.size),
    ).toString(),
  ).toBe("different output entirely");
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
    expect(String(missing)).toMatch(/regular file|missing/i);
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
    expect(retry.attempts).toBe(2);
    expect(retry.artifact_id).toBe(failed.artifact_id);
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
  // A directory becomes its own snapshot so nothing inside it is silently lost.
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

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  rmSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalArtifactStorage,
  type ArtifactStorage,
} from "/tmp/opencode/review-data/src/artifact-store";
import { ArtifactService } from "/tmp/opencode/review-data/src/artifacts";
import { screeningWindow } from "/tmp/opencode/review-data/src/artifact-types";
import { WorkerFiles } from "/tmp/opencode/review-data/src/files";
import {
  localHarness,
  type LocalHarness,
} from "/tmp/opencode/review-data/tests/local-artifact-provider";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const collect = async (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) out.set(chunk, at), (at += chunk.length);
  return out;
};

async function withHarness(
  env: Record<string, string>,
  body: (h: LocalHarness, worker: string) => Promise<void>,
) {
  const h = await localHarness(env);
  try {
    const worker = h.spawn().worker_id;
    await h.provider.createWorker({} as never);
    await body(h, worker);
  } finally {
    await h.cleanup();
  }
}

const guestFile = (h: LocalHarness, name: string) =>
  join(h.workspace.root, ".swarmforge", "artifacts", name);
const write = (h: LocalHarness, name: string, body: string) => {
  writeFileSync(guestFile(h, name), body);
  return `.swarmforge/artifacts/${name}`;
};

// 1. Historic superseded bytes stay faithful and every handed-out id stays
// readable for exactly the bytes it described.
test("probe: superseded bytes stay faithful and old ids stay readable", async () => {
  await withHarness({}, async (h, worker) => {
    const path = write(h, "faithful.txt", "generation-one");
    const first = await h.artifacts.preserve(worker, path, { runId: "r1" });
    write(h, "faithful.txt", "generation-two-is-longer");
    const second = await h.artifacts.preserve(worker, path, { runId: "r1" });

    expect(second.artifact_id).not.toBe(first.artifact_id);
    const old = h.artifacts.metadata(first.artifact_id);
    expect(old.state).toBe("preserved");
    expect(old.superseded_by).toBe(second.artifact_id);
    expect(old.sha256).toBe(sha(new TextEncoder().encode("generation-one")));
    const oldBytes = await h.artifacts.read(first.artifact_id, 0, old.size);
    expect(Buffer.from(oldBytes).toString()).toBe("generation-one");
    expect(sha(oldBytes)).toBe(old.sha256);
    // The stored object is still there under its own key and still verifies.
    expect((await h.artifacts.storage.stat(old.storage_key!))?.sha256).toBe(
      old.sha256,
    );
    // History is reachable by id, and a listing shows exactly one current copy.
    expect(
      h.artifacts.list({ worker_id: worker }).artifacts.map((r) => r.artifact_id),
    ).toEqual([second.artifact_id]);
    const rows = h.store.db
      .query("SELECT count(*) c FROM artifacts")
      .get() as { c: number };
    expect(rows.c).toBe(2);
  });
});

// 2. A recapture that fails leaves the previous copy in charge and readable.
test("probe: a failed recapture restores the previous copy as current", async () => {
  await withHarness({}, async (h, worker) => {
    const path = write(h, "restore.txt", "verified");
    const first = await h.artifacts.preserve(worker, path, { runId: "r1" });
    const key = first.storage_key!;
    // The source becomes something a capture must refuse, so the recapture of
    // changed content cannot succeed.
    const outside = mkdtempSync(join(tmpdir(), "sf-restore-"));
    writeFileSync(join(outside, "secret.txt"), "outside the workspace");
    rmSync(guestFile(h, "restore.txt"));
    symlinkSync(outside, guestFile(h, "restore.txt"));
    let failed = false;
    try {
      await h.artifacts.preserve(worker, path, { runId: "r1" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const after = h.artifacts.metadata(first.artifact_id);
    expect(after.state).toBe("preserved");
    expect(after.superseded_by ?? null).toBeNull();
    expect(after.storage_key).toBe(key);
    expect(
      Buffer.from(await h.artifacts.read(first.artifact_id, 0, after.size))
        .toString(),
    ).toBe("verified");
    // A source with one current copy, and no new object stored for the failure.
    const stored = readdirSync(h.storageDir).filter((n) => n !== ".incoming");
    expect(stored.length).toBe(1);
  });
});

// 3. Concurrent attempts on one source: no unique-index failure, one current row,
// every id readable, integrity intact.
test("probe: concurrent attempts settle without breaking the partial index", async () => {
  await withHarness({}, async (h, worker) => {
    const path = write(h, "race.txt", "same-bytes");
    await h.artifacts.preserve(worker, path, { runId: "r1" });
    const results = await Promise.all([
      h.artifacts.preserve(worker, path, { runId: "r1" }),
      h.artifacts.preserve(worker, path, { runId: "r1" }),
      h.artifacts.preserve(worker, path, { runId: "r1" }),
      h.artifacts.preserve(worker, path, { runId: "r1" }),
    ]);
    const current = h.artifacts
      .list({ worker_id: worker })
      .artifacts.filter((r) => r.original_path === path);
    expect(current).toHaveLength(1);
    for (const record of results)
      expect(sha(await h.artifacts.read(record.artifact_id, 0, record.size))).toBe(
        record.sha256 ?? "",
      );
    expect(
      (h.store.db.query("PRAGMA integrity_check").get() as Record<string, string>)
        .integrity_check,
    ).toBe("ok");
    const duplicates = h.store.db
      .query(
        `SELECT count(*) c FROM artifacts WHERE state='preserved' AND superseded_by IS NULL
         GROUP BY worker_id, ifnull(run_id,''), original_path, kind HAVING count(*) > 1`,
      )
      .all() as { c: number }[];
    expect(duplicates).toEqual([]);
  });
});

// 4. A long secret must be screened on both the storage and the live-file paths,
// with a window sized from byte lengths rather than a fixed baseline.
test("probe: a long secret is screened across both read paths", async () => {
  const longSecret = `L${"k".repeat(6000)}L`;
  await withHarness(
    { SWARMFORGE_MODEL_API_KEY: longSecret, FREESTYLE_API_TOKEN: longSecret },
    async (h, worker) => {
      const pad = screeningWindow([longSecret]);
      expect(pad).toBeGreaterThan(4096);
      // A secret that starts after where a 4096-byte baseline window would end.
      const start = 9000;
      const path = write(
        h,
        "longsecret.txt",
        `${".".repeat(start)}${longSecret}${".".repeat(200)}`,
      );
      const record = await h.artifacts.preserve(worker, path, { runId: "r1" });
      // The discriminating read: a fixed 4096-byte baseline window starts after
      // the secret, the byte-sized window still reaches back over it.
      const offset = start + Math.floor((4096 + pad) / 2);
      expect(offset - 4096).toBeGreaterThan(start);
      expect(offset - pad).toBeLessThanOrEqual(start);
      await expect(
        h.artifacts.safeRead(record.artifact_id, offset, 64),
      ).rejects.toThrow(/credentials/);
      // Raw private read stays faithful and never screened.
      const raw = await h.artifacts.read(record.artifact_id, start, 32);
      expect(Buffer.from(raw).toString()).toBe(longSecret.slice(0, 32));
      // The live guest path screens with the same window.
      const files = new WorkerFiles(h.coordinator);
      await expect(
        files.readArtifact(worker, "longsecret.txt", offset, 64),
      ).rejects.toThrow(/credentials/);
      // A secret too wide for any bounded window is refused, not under-screened.
      expect(() => screeningWindow(["x".repeat(70000)])).toThrow();
    },
  );
});

// 5. Screening happens before truncation: a secret crossing the 1000-character
// cut leaves no recognisable part of itself in a durable record.
test("probe: a record error is screened whole, then bounded", async () => {
  const secret = `S${"q".repeat(400)}`;
  await withHarness({ SWARMFORGE_MODEL_API_KEY: secret }, async (h, worker) => {
    const key = `art-${crypto.randomUUID()}`;
    const record = h.artifacts.repository.begin({
      worker_id: worker,
      task_id: "task",
      run_id: null,
      original_path: "screened-error",
      filename: "screened-error",
      kind: "file",
    });
    expect(record.artifact_id).toBeTruthy();
    const hostile = new Error(
      `${"e".repeat(900)}${secret}${"f".repeat(900)}`,
    );
    // Reach the private failure path the way a capture failure does.
    (h.artifacts as unknown as { fail(r: unknown, e: string): Error }).fail(
      record,
      hostile.message,
    );
    const stored = h.artifacts.metadata(record.artifact_id);
    expect(stored.state).toBe("failed");
    expect(stored.error!.length).toBeLessThanOrEqual(1000);
    expect(stored.error).not.toContain(secret);
    expect(stored.error).not.toContain("q".repeat(100));
    expect(stored.error).not.toContain("q".repeat(20));
    expect(stored.error).toContain("[REDACTED]");
  });
});

// 6. Storage hardening: a planted `.incoming` link or special file is refused
// before anything outside the root is touched, and a real I/O failure is fatal.
test("probe: incoming links and special files are refused without touching outside", () => {
  const outside = mkdtempSync(join(tmpdir(), "sf-outside-"));
  const sentinel = join(outside, "keep.txt");
  writeFileSync(sentinel, "untouched");
  chmodSync(outside, 0o755);
  const root = mkdtempSync(join(tmpdir(), "sf-store-"));
  const before = lstatSync(outside).mode & 0o7777;
  symlinkSync(outside, join(root, ".incoming"));
  let refused = "";
  try {
    new LocalArtifactStorage(root);
  } catch (error) {
    refused = String(error);
  }
  expect(refused).toMatch(/symlink/);
  expect((lstatSync(outside).mode & 0o7777)).toBe(before);
  expect(readdirSync(outside)).toEqual(["keep.txt"]);
  expect(readFileSync(sentinel, "utf8")).toBe("untouched");

  // A special file planted in a real `.incoming` is refused too.
  const root2 = mkdtempSync(join(tmpdir(), "sf-store2-"));
  const incoming = join(root2, ".incoming");
  mkdirSync(incoming, { mode: 0o700 });
  Bun.spawnSync(["mkfifo", join(incoming, "pipe")]);
  expect(lstatSync(join(incoming, "pipe")).isFIFO()).toBe(true);
  expect(() => new LocalArtifactStorage(root2)).toThrow(/special file/);
});

// 7. A failing directory sync is a real failure; only "cannot fsync a directory"
// is tolerated.
test("probe: a real directory fsync failure fails the put", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-sync-"));
  const storage = new LocalArtifactStorage(dir, {
    sync: () => {
      const error: NodeJS.ErrnoException = new Error("EIO");
      error.code = "EIO";
      throw error;
    },
  });
  const bytes = new TextEncoder().encode("payload");
  await expect(
    storage.put({
      key: "aa/obj",
      stream: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      size: bytes.length,
      sha256: sha(bytes),
    }),
  ).rejects.toThrow(/durable/);
  expect(storage.pathFor("aa/obj", true)).toBeNull();
  // EINVAL means the platform cannot fsync a directory: tolerated.
  const tolerant = new LocalArtifactStorage(mkdtempSync(join(tmpdir(), "sf-sync2-")), {
    sync: () => {
      const error: NodeJS.ErrnoException = new Error("EINVAL");
      error.code = "EINVAL";
      throw error;
    },
  });
  await tolerant.put({
    key: "bb/obj",
    stream: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    size: bytes.length,
    sha256: sha(bytes),
  });
  expect(await tolerant.stat("bb/obj")).toEqual({
    size: bytes.length,
    sha256: sha(bytes),
  });
  // Nothing half-written is left in the private incoming directory.
  expect(readdirSync(join(dir, ".incoming"))).toEqual([]);
});

// 8. A foreign object backend: the whole service works without the local one.
test("probe: an injected foreign storage backend serves every read path", async () => {
  await withHarness({}, async (h, worker) => {
    const objects = new Map<string, Uint8Array>();
    const foreign: ArtifactStorage = {
      async put({ key, stream, size, sha256 }) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
          chunks.push(chunk);
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const chunk of chunks) out.set(chunk, at), (at += chunk.length);
        if (out.length !== size || sha(out) !== sha256)
          throw new Error("foreign backend refused corrupt bytes");
        objects.set(key, out);
      },
      async open(key, options = {}) {
        const body = objects.get(key);
        if (!body) throw new Error("missing");
        const start = Math.max(0, options.offset ?? 0);
        const end = Math.min(
          body.length,
          start + (options.length ?? body.length - start),
        );
        const slice = body.subarray(start, Math.max(start, end));
        return new ReadableStream<Uint8Array>({
          start(c) {
            if (slice.length) c.enqueue(slice);
            c.close();
          },
        });
      },
      async read(key, offset, length) {
        const body = objects.get(key)!;
        return body.subarray(offset, offset + length);
      },
      async stat(key) {
        const body = objects.get(key);
        return body ? { size: body.length, sha256: sha(body) } : null;
      },
      async remove(key) {
        objects.delete(key);
      },
      async sweepStale() {
        return 0;
      },
    };
    const service = new ArtifactService(
      h.config,
      h.store,
      h.provider,
      foreign,
    );
    const path = write(h, "foreign.txt", "object-store-bytes");
    const record = await service.preserve(worker, path, { runId: "r1" });
    expect(objects.has(record.storage_key!)).toBe(true);
    expect(
      Buffer.from(await service.read(record.artifact_id, 0, record.size))
        .toString(),
    ).toBe("object-store-bytes");
    expect(
      Buffer.from(await collect(await service.download(record.artifact_id)))
        .toString(),
    ).toBe("object-store-bytes");
    expect(
      Buffer.from(await service.safeRead(record.artifact_id, 0, 32)).toString(),
    ).toBe("object-store-bytes");
    // The harness's own local backend exists but stored no object: the foreign
    // one really served every byte.
    expect(readdirSync(h.storageDir)).toEqual([".incoming"]);
    expect(readdirSync(join(h.storageDir, ".incoming"))).toEqual([]);
  });
});

// 9. No `preserving` row is left behind by a refusal, and a restart sees it if
// one really is interrupted.
test("probe: refusals leave no preserving row behind", async () => {
  await withHarness({}, async (h, worker) => {
    await expect(
      h.artifacts.preserve(worker, "../escape.txt"),
    ).rejects.toThrow();
    const outside = mkdtempSync(join(tmpdir(), "sf-escape-"));
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(h.workspace.root, "link"));
    await expect(h.artifacts.preserve(worker, "link/secret.txt")).rejects.toThrow(
      /symlink|not permitted/,
    );
    expect(h.artifacts.repository.pending()).toEqual([]);
    const states = h.artifacts
      .list({ worker_id: worker })
      .artifacts.map((r) => r.state);
    expect(states.every((state) => state === "failed")).toBe(true);
  });
});
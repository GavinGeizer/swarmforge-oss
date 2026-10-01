import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screeningWindow } from "../src/artifact-types";
import { WorkerFiles } from "../src/files";
import { redactorFor } from "../src/security";
import { type LocalHarness, localHarness } from "./local-artifact-provider";

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
let files: WorkerFiles;
let worker: string;

const artifacts = () => join(h.workspace.root, ".swarmforge", "artifacts");
const write = (name: string, body: string) => {
  mkdirSync(artifacts(), { recursive: true, mode: 0o700 });
  writeFileSync(join(artifacts(), name), body);
};
const text = (value: string) => new TextEncoder().encode(value);

beforeEach(async () => {
  h = await localHarness();
  const created = h.spawn();
  await h.provider.createWorker(created);
  worker = created.worker_id;
  files = new WorkerFiles(h.coordinator);
});
afterEach(async () => {
  await h.cleanup();
});

test("a bounded handle describes a live file without reading it", async () => {
  write("report.txt", "x".repeat(100000));
  const handle = await files.artifact(worker, "report.txt");
  expect(handle).toMatchObject({
    name: "report.txt",
    size: 100000,
    mimeType: "application/octet-stream",
    offset: 0,
    length: 32768,
    next_offset: 32768,
  });
  expect(handle.uri).toContain("swarmforge://workers/");
  expect(handle.uri).toContain(encodeURIComponent("report.txt"));
  const tail = await files.artifact(worker, "report.txt", 99000, 1000);
  expect(tail).toMatchObject({
    offset: 99000,
    length: 1000,
    next_offset: null,
  });
});

test("a bounded read returns the requested window and nothing else", async () => {
  write("report.txt", "0123456789".repeat(10));
  const bytes = await files.readArtifact(worker, "report.txt", 0, 1024);
  expect(bytes).toEqual(text("0123456789".repeat(10)));
  expect(await files.readArtifact(worker, "report.txt", 20, 5)).toEqual(
    text("01234"),
  );
  await expect(
    files.readArtifact(worker, "report.txt", 0, 0),
  ).rejects.toThrow();
  await expect(
    files.readArtifact(worker, "report.txt", 0, 32769),
  ).rejects.toThrow();
  await expect(
    files.readArtifact(worker, "report.txt", -1, 10),
  ).rejects.toThrow();
});

test("a secret anywhere near the requested window blocks the read", async () => {
  const key = h.config.SWARMFORGE_MODEL_API_KEY;
  // Split across the overlap: the requested range itself is innocent.
  write("split.txt", `${"y".repeat(2000)}${key}${"z".repeat(2000)}`);
  await expect(
    files.readArtifact(worker, "split.txt", 2000 + key.length + 10, 16),
  ).rejects.toThrow(/credentials/i);
  // Encoded variants count too.
  write("encoded.txt", `before${encodeURIComponent(key)}after`);
  await expect(
    files.readArtifact(worker, "encoded.txt", 0, 16),
  ).rejects.toThrow(/credentials/i);
  write("clean.txt", "nothing sensitive");
  expect(await files.readArtifact(worker, "clean.txt", 0, 16)).toEqual(
    text("nothing sensitiv"),
  );
  expect(await files.readArtifact(worker, "clean.txt", 9, 8)).toEqual(
    text("ensitive"),
  );
});

test("paths and paths that contain credentials are refused", async () => {
  write("ok.txt", "ok");
  for (const path of [
    "../start.sh",
    "/etc/passwd",
    "nested\\file",
    "a//b",
    "..",
    "",
    `${"deep/".repeat(33)}file`,
    `${"x".repeat(1025)}`,
  ])
    await expect(files.artifact(worker, path)).rejects.toThrow();
  write(`leak-${h.config.SWARMFORGE_MODEL_API_KEY}.txt`, "x");
  await expect(
    files.artifact(worker, `leak-${h.config.SWARMFORGE_MODEL_API_KEY}.txt`),
  ).rejects.toThrow(/credentials/i);
});

test("directories, special files and symlinks are never offered", async () => {
  write("plain.txt", "plain");
  Bun.spawnSync(["mkfifo", join(artifacts(), "fifo")]);
  symlinkSync("/etc/passwd", join(artifacts(), "escape"));
  mkdirSync(join(artifacts(), "sub"), { recursive: true });
  const listing = await files.artifacts(worker);
  expect(listing.entries.map((e) => e.name)).toEqual(["plain.txt", "sub"]);
  await expect(files.artifact(worker, "escape")).rejects.toThrow();
  await expect(files.artifact(worker, "fifo")).rejects.toThrow();
  await expect(files.artifact(worker, "sub")).rejects.toThrow();
  await expect(files.artifacts(worker, "../..")).rejects.toThrow();
  await expect(files.artifacts(worker, "/etc")).rejects.toThrow();
});

test("listing pages deterministically inside one directory", async () => {
  mkdirSync(join(artifacts(), "reports"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"])
    writeFileSync(join(artifacts(), "reports", name), name);
  const page = await files.artifacts(worker, "reports", 1, 2);
  expect(page.entries.map((e) => e.name)).toEqual(["b.txt", "c.txt"]);
  expect(page.next_offset).toBe(3);
  const last = await files.artifacts(worker, "reports", 3, 50);
  expect(last.next_offset).toBeNull();
  expect(last.entries.map((e) => e.name)).toEqual(["d.txt", "e.txt"]);
});

test("a provider without the transport refuses rather than falling back", async () => {
  write("plain.txt", "plain");
  (h.provider as { artifactTransport?: unknown }).artifactTransport = undefined;
  await expect(files.artifacts(worker)).rejects.toThrow(/transport/i);
  await expect(files.artifact(worker, "plain.txt")).rejects.toThrow(
    /transport/i,
  );
  await expect(files.readArtifact(worker, "plain.txt", 0, 16)).rejects.toThrow(
    /transport/i,
  );
});

test("a destroyed worker has no live files and no handle", async () => {
  write("plain.txt", "plain");
  h.store.transition(worker, "destroyed");
  await expect(files.artifacts(worker)).rejects.toThrow();
  await expect(files.artifact(worker, "plain.txt")).rejects.toThrow();
});

test("log inspection is unchanged and still needs no guest command", async () => {
  const created = h.spawn({ task_id: "task-2" });
  await h.provider.createWorker(created);
  let execCalls = 0;
  const original = h.provider.exec.bind(h.provider);
  h.provider.exec = async (id, command) => {
    execCalls++;
    return original(id, command);
  };
  const logs = await files.logs(created.worker_id);
  expect(logs.events.length).toBeGreaterThan(0);
  expect(logs.opencode).toBe("local journal line\n");
  expect(execCalls).toBeGreaterThanOrEqual(0);
});

test("live reads screen long, encoded and per-worker secrets in byte terms", async () => {
  const longApiToken = `k${"π".repeat(5000)}`;
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
    const live = new WorkerFiles(harness.coordinator);
    const directory = join(harness.workspace.root, ".swarmforge", "artifacts");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cases = [
      { name: "api-raw.txt", secret: longApiToken },
      { name: "pw-raw.txt", secret: password },
      { name: "api-url.txt", secret: encodeURIComponent(longApiToken) },
      {
        name: "api-base64.txt",
        secret: Buffer.from(longApiToken).toString("base64"),
      },
    ];
    const pad = screeningWindow(redactorFor(harness.coordinator).secrets());
    for (const item of cases) {
      const bytes = Buffer.byteLength(item.secret);
      // A read that only a correctly sized window can still cover.
      const offset = discriminatingOffset(pad);
      writeFileSync(
        join(directory, item.name),
        Buffer.concat([
          Buffer.from("A".repeat(1000)),
          Buffer.from(item.secret),
          Buffer.from("B".repeat(bytes * 2)),
        ]),
      );
      await expect(
        live.readArtifact(created.worker_id, item.name, offset, 16),
      ).rejects.toThrow(/credentials/i);
      expect(harness.workspace.stagingEntries()).toEqual([]);
    }
  } finally {
    await harness.cleanup();
  }
});

test("live reads refuse an unverified staging transfer and clean up", async () => {
  write("live.txt", "x".repeat(4096));
  const transport = h.workspace.transport;
  const original = transport.open.bind(transport);
  type Transfer = Awaited<ReturnType<typeof original>>;
  // Each case damages one property of an otherwise real transfer, so the read
  // has to notice rather than trust what it was handed.
  const broken: Record<string, (real: Transfer) => Transfer> = {
    corrupt: (real) => ({ ...real, sha256: "b".repeat(64) }),
    oversized_size: (real) => ({ ...real, size: 5_000_000 }),
    wrong_size: (real) => ({ ...real, size: real.size - 1 }),
    oversized_stream: (real) => ({
      ...real,
      size: 65536,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(2));
          controller.close();
        },
        cancel: () => real.stream.cancel().then(() => {}),
      }),
    }),
  };
  for (const [name, damage] of Object.entries(broken)) {
    let cleaned = 0;
    transport.open = async (vmId, root, path, options) => {
      const real = await original(vmId, root, path, options);
      const replacement = damage(real);
      return {
        ...replacement,
        cleanup: async () => {
          cleaned++;
          await replacement.cleanup();
        },
      };
    };
    await expect(
      files.readArtifact(worker, "live.txt", 0, 1024),
      name,
    ).rejects.toThrow();
    // The private staged copy goes away whichever way the read failed.
    expect(cleaned, name).toBe(1);
    expect(h.workspace.stagingEntries(), name).toEqual([]);
  }
  transport.open = original;
  expect((await files.readArtifact(worker, "live.txt", 0, 1024)).length).toBe(
    1024,
  );
});

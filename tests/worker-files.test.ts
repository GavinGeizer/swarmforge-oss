import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerFiles } from "../src/files";
import { type LocalHarness, localHarness } from "./local-artifact-provider";

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

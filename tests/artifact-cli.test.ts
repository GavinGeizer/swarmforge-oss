import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/cli/arguments";
import { downloadArtifact } from "../src/cli/artifact-download";
import { connectSwarmForge } from "../src/cli/client";
import { createHttpHandler } from "../src/http";
import { localHarness } from "./local-artifact-provider";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("artifact commands parse explicit output and pagination and reject invalid input", () => {
  expect(
    parseArguments([
      "artifacts",
      "list",
      "--worker",
      "w-1",
      "--offset",
      "20",
      "--limit",
      "10",
    ]),
  ).toMatchObject({
    kind: "artifacts",
    action: "list",
    workerId: "w-1",
    offset: 20,
    limit: 10,
  });
  expect(
    parseArguments([
      "artifacts",
      "download",
      "a-1",
      "--output",
      "output.bin",
      "--json",
    ]),
  ).toMatchObject({ artifactId: "a-1", output: "output.bin", json: true });
  for (const args of [
    ["artifacts"],
    ["artifacts", "download", "a-1"],
    ["artifacts", "list", "--limit", "101"],
    ["artifacts", "download", "../bad", "--output", "x"],
  ])
    expect(() => parseArguments(args)).toThrow();
});

for (const bytes of [
  new Uint8Array([0, 255, 128, 13, 10, 42]),
  new Uint8Array(),
])
  test(`download verifies exact binary bytes (${bytes.length}) and refuses overwrites`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-download-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return new Response(bytes);
      },
    });
    const metadata = {
      artifact_id: "a-test",
      state: "preserved",
      size: bytes.length,
      sha256: digest(bytes),
    };
    try {
      const output = join(dir, "result.bin");
      const saved = await downloadArtifact(
        `http://127.0.0.1:${server.port}/mcp`,
        "test-token",
        metadata,
        output,
      );
      expect(saved.sha256).toBe(metadata.sha256);
      expect(await readFile(output)).toEqual(Buffer.from(bytes));
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(
        downloadArtifact(
          `http://127.0.0.1:${server.port}/mcp`,
          "test-token",
          metadata,
          output,
        ),
      ).rejects.toThrow("already exists");
      expect(await readdir(dir)).toEqual(["result.bin"]);
    } finally {
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

test("corrupt, oversized, truncated and redirected downloads never publish or leave partial files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-download-errors-"));
  let response: () => Response = () => new Response("wrong");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => response(),
  });
  const metadata = {
    artifact_id: "a-test",
    state: "preserved",
    size: 5,
    sha256: digest(Buffer.from("right")),
  };
  const endpoint = `http://127.0.0.1:${server.port}/mcp`;
  try {
    for (const payload of ["wrong", "toolong", "shorter"]) {
      response = () => new Response(payload);
      await expect(
        downloadArtifact(endpoint, undefined, metadata, join(dir, "output")),
      ).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    }
    response = () => new Response("no");
    await expect(
      downloadArtifact(endpoint, undefined, metadata, join(dir, "output")),
    ).rejects.toThrow("verification failed");
    response = () => Response.redirect(`http://127.0.0.1:${server.port}/other`);
    await expect(
      downloadArtifact(endpoint, "credential", metadata, join(dir, "output")),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled transfer removes its temporary file without publishing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-download-abort-"));
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("partial"));
            ready();
          },
        }),
      ),
  });
  const abort = new AbortController();
  const pending = downloadArtifact(
    `http://127.0.0.1:${server.port}/mcp`,
    undefined,
    {
      artifact_id: "a-test",
      state: "preserved",
      size: 100,
      sha256: "f".repeat(64),
    },
    join(dir, "output"),
    abort.signal,
  );
  const result = pending.catch((error) => error);
  try {
    await started;
    abort.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("authenticated artifact CLI and client retrieve preserved files independently of the guest", async () => {
  const h = await localHarness();
  const w = h.spawn();
  await h.provider.createWorker(w);
  const dir = await mkdtemp(join(tmpdir(), "sf-artifact-cli-"));
  await writeFile(
    join(h.workspace.root, "result.bin"),
    Buffer.from([0, 255, 10, 128]),
  );
  const artifact = await h.coordinator.artifacts.preserve(
    w.worker_id,
    "result.bin",
  );
  await h.provider.destroyWorker(w.vm_id!);
  const token = "artifact-cli-token-with-enough-characters";
  h.config.SWARMFORGE_API_TOKEN = token;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const client = await connectSwarmForge(url, token);
  try {
    expect(
      (await client.listArtifacts({ workerId: w.worker_id, limit: 1 }))
        .artifacts[0]?.artifact_id,
    ).toBe(artifact.artifact_id);
    const proc = Bun.spawn(
      [
        "bun",
        "--no-env-file",
        "--config=/dev/null",
        "src/cli.ts",
        "artifacts",
        "download",
        artifact.artifact_id,
        "--output",
        join(dir, "saved.bin"),
        "--url",
        url,
        "--json",
      ],
      {
        env: { ...process.env, SWARMFORGE_API_TOKEN: token },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exit, err).toBe(0);
    expect(JSON.parse(out).sha256).toBe(artifact.sha256);
    expect(await readFile(join(dir, "saved.bin"))).toEqual(
      Buffer.from([0, 255, 10, 128]),
    );
  } finally {
    await client.close();
    await server.stop(true);
    await h.coordinator.stop();
    await h.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dashboard artifact browser saves a verified file to an explicitly edited path", async () => {
  const { EventEmitter } = await import("node:events");
  const { runDashboard } = await import("../src/cli/tui");
  const h = await localHarness();
  const w = h.spawn();
  await h.provider.createWorker(w);
  const bytes = Buffer.from([255, 0, 128, 10]);
  await writeFile(join(h.workspace.root, "deliverable.bin"), bytes);
  await h.coordinator.artifacts.preserve(w.worker_id, "deliverable.bin");
  const dir = await mkdtemp(join(tmpdir(), "sf-artifact-ui-"));
  const destination = join(dir, "saved.bin");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const client = await connectSwarmForge(`http://127.0.0.1:${server.port}/mcp`);
  const frames: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
  }) as unknown as typeof process.stdin;
  const output = Object.assign(new EventEmitter(), {
    columns: 150,
    rows: 50,
    write: (frame: string) => {
      frames.push(frame);
      return true;
    },
  }) as unknown as typeof process.stdout;
  const key = (name: string, text = "", ctrl = false) =>
    input.emit("keypress", text, { name, ctrl });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 300 && !predicate(); i++) await Bun.sleep(5);
    expect(predicate()).toBe(true);
  };
  const session = runDashboard(
    client,
    await client.overview(),
    input,
    output,
    60000,
  );
  try {
    key("return");
    await wait(() => !!frames.at(-1)?.includes("a artifacts"));
    key("a");
    await wait(() => !!frames.at(-1)?.includes("deliverable.bin"));
    key("return");
    expect(frames.at(-1)).toContain("Save to:");
    key("u", "", true);
    input.emit("keypress", destination, {});
    key("return");
    await wait(() => !!frames.at(-1)?.includes("SHA256 verified"));
    expect(await readFile(destination)).toEqual(bytes);
  } finally {
    key("q");
    await session;
    await client.close();
    await server.stop(true);
    await h.coordinator.stop();
    await h.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

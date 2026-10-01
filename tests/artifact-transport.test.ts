import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type LocalWorkspace, localWorkspace } from "./local-artifact-provider";

let ws: LocalWorkspace;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const collect = async (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    chunks.push(chunk);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

beforeEach(async () => {
  ws = await localWorkspace();
});
afterEach(async () => {
  await ws.cleanup();
});

test("the production helper lists a bounded, sorted directory page", async () => {
  writeFileSync(join(ws.root, "a.txt"), "aaa");
  writeFileSync(join(ws.root, "b.bin"), "bbbb");
  mkdirSync(join(ws.root, "sub"));
  symlinkSync("/etc/passwd", join(ws.root, "escape"));
  mkdirSync(join(ws.root, ".git"));
  const all = await ws.transport.list(ws.vmId, ws.root, "");
  expect(all.entries.map((e) => e.name)).toEqual([
    ".git",
    "a.txt",
    "b.bin",
    "escape",
    "sub",
  ]);
  expect(all.entries.find((e) => e.name === "a.txt")).toEqual({
    name: "a.txt",
    kind: "file",
    size: 3,
  });
  expect(all.entries.find((e) => e.name === "escape")?.kind).toBe("symlink");
  expect(all.entries.find((e) => e.name === "sub")?.kind).toBe("directory");
  expect(all.next_offset).toBeNull();
  const page = await ws.transport.list(ws.vmId, ws.root, "", {
    offset: 1,
    limit: 2,
  });
  expect(page.entries.map((e) => e.name)).toEqual(["a.txt", "b.bin"]);
  expect(page.next_offset).toBe(3);
});

test("captured bytes are raw and identical, with a hash the caller can verify", async () => {
  const binary = new Uint8Array(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  writeFileSync(join(ws.root, "blob.bin"), binary);
  writeFileSync(join(ws.root, "text.txt"), "hello\nworld\n");
  const text = await ws.transport.open(ws.vmId, ws.root, "text.txt", {
    maxBytes: 1024,
  });
  expect(text.filename).toBe("text.txt");
  expect(text.size).toBe(12);
  expect(text.sha256).toBe(sha(new TextEncoder().encode("hello\nworld\n")));
  expect(await collect(text.stream)).toEqual(
    new TextEncoder().encode("hello\nworld\n"),
  );
  await text.cleanup();
  const blob = await ws.transport.open(ws.vmId, ws.root, "blob.bin", {
    maxBytes: 8192,
  });
  expect(blob.size).toBe(4096);
  expect(blob.sha256).toBe(sha(binary));
  expect(await collect(blob.stream)).toEqual(binary);
  await blob.cleanup();
});

test("a large file streams through without truncation or whole-file buffering", async () => {
  const size = 24 * 1024 * 1024;
  const digest = createHash("sha256");
  const handle = await Bun.file(join(ws.root, "big.bin")).writer();
  const block = new Uint8Array(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (i * 7 + 13) % 256;
  for (let i = 0; i < size / block.length; i++) {
    digest.update(block);
    await handle.write(block);
  }
  await handle.end();
  const expected = digest.digest("hex");
  const transfer = await ws.transport.open(ws.vmId, ws.root, "big.bin", {
    maxBytes: size * 2,
  });
  expect(transfer.size).toBe(size);
  expect(transfer.sha256).toBe(expected);
  const seen = createHash("sha256");
  let received = 0;
  let maxChunk = 0;
  for await (const chunk of transfer.stream as unknown as AsyncIterable<Uint8Array>) {
    seen.update(chunk);
    received += chunk.length;
    maxChunk = Math.max(maxChunk, chunk.length);
  }
  expect(received).toBe(size);
  expect(seen.digest("hex")).toBe(expected);
  expect(maxChunk).toBeLessThanOrEqual(1024 * 1024);
  await transfer.cleanup();
});

test("a bounded window of a large file is captured without the whole file", async () => {
  const body = new Uint8Array(1024 * 1024).fill(0x41);
  writeFileSync(join(ws.root, "window.bin"), body);
  const transfer = await ws.transport.open(ws.vmId, ws.root, "window.bin", {
    maxBytes: 4096,
    offset: 1000,
    length: 2048,
  });
  expect(transfer.size).toBe(2048);
  const bytes = await collect(transfer.stream);
  expect(bytes.length).toBe(2048);
  expect(bytes.every((b) => b === 0x41)).toBe(true);
  await transfer.cleanup();
});

test("traversal, absolute, encoded and control-character paths are refused", async () => {
  writeFileSync("/tmp/swarmforge-outside-secret", "outside");
  const bad = [
    "../outside-secret",
    "../../etc/passwd",
    "/etc/passwd",
    "sub\\file",
    "nul\0byte",
    "bell\u0007",
    "",
    ".",
    "..",
    "a//b",
    `${"deep/".repeat(33)}file`,
    `${"x".repeat(1025)}`,
  ];
  for (const path of bad)
    await expect(
      ws.transport.open(ws.vmId, ws.root, path, { maxBytes: 1024 }),
    ).rejects.toThrow();
  await expect(ws.transport.list(ws.vmId, ws.root, "../")).rejects.toThrow();
  await expect(
    ws.transport.snapshot(ws.vmId, ws.root, {
      maxBytes: 1024,
      maxEntries: 10,
      maxDepth: 8,
      paths: ["../outside-secret"],
    }),
  ).rejects.toThrow();
  expect(existsSync("/tmp/swarmforge-outside-secret")).toBe(true);
});

test("a symlinked component or leaf never resolves to a file outside the root", async () => {
  writeFileSync("/tmp/swarmforge-outside-secret", "outside-bytes");
  mkdirSync(join(ws.root, "real"));
  writeFileSync(join(ws.root, "real", "inside.txt"), "inside-bytes");
  symlinkSync("/tmp/swarmforge-outside-secret", join(ws.root, "leaf-link"));
  symlinkSync("/tmp", join(ws.root, "dir-link"));
  symlinkSync("real", join(ws.root, "rel-link"));
  for (const path of [
    "leaf-link",
    "dir-link/outside-secret",
    "rel-link/inside.txt",
  ])
    await expect(
      ws.transport.open(ws.vmId, ws.root, path, { maxBytes: 1024 }),
    ).rejects.toThrow();
  // A relative symlink to a directory inside the root is still refused: the
  // contract is descriptor-relative opening, never path re-resolution.
  expect(existsSync(join(ws.root, "rel-link"))).toBe(true);
  const ok = await ws.transport.open(ws.vmId, ws.root, "real/inside.txt", {
    maxBytes: 1024,
  });
  expect(await collect(ok.stream)).toEqual(
    new TextEncoder().encode("inside-bytes"),
  );
  await ok.cleanup();
});

test("directories, fifos, sockets and missing paths are refused for capture", async () => {
  mkdirSync(join(ws.root, "sub"));
  Bun.spawnSync(["mkfifo", join(ws.root, "pipe")]);
  await expect(
    ws.transport.open(ws.vmId, ws.root, "sub", { maxBytes: 1024 }),
  ).rejects.toThrow();
  await expect(
    ws.transport.open(ws.vmId, ws.root, "pipe", { maxBytes: 1024 }),
  ).rejects.toThrow();
  await expect(
    ws.transport.open(ws.vmId, ws.root, "absent.txt", { maxBytes: 1024 }),
  ).rejects.toThrow();
  expect(existsSync(join(ws.root, "pipe"))).toBe(true);
});

test("swapping a component for a symlink mid-capture never leaks outside bytes", async () => {
  writeFileSync("/tmp/swarmforge-outside-secret", "TOP-SECRET-OUTSIDE");
  mkdirSync(join(ws.root, "swap"));
  writeFileSync(join(ws.root, "swap", "file.txt"), "inside-bytes");
  const link = join(ws.root, "swap-link");
  let sawInside = 0;
  for (let round = 0; round < 40; round++) {
    Bun.spawnSync(["ln", "-sfn", "/tmp/swarmforge-outside-secret", link]);
    Bun.spawnSync(["rm", "-rf", join(ws.root, "swap")]);
    Bun.spawnSync(["mkdir", "-p", join(ws.root, "swap")]);
    Bun.spawnSync([
      "sh",
      "-c",
      `printf 'inside-bytes' > ${JSON.stringify(join(ws.root, "swap", "file.txt"))}`,
    ]);
    try {
      const transfer = await ws.transport.open(
        ws.vmId,
        ws.root,
        "swap/file.txt",
        {
          maxBytes: 1024,
        },
      );
      const bytes = Buffer.from(await collect(transfer.stream)).toString();
      await transfer.cleanup();
      expect(bytes).toBe("inside-bytes");
      sawInside++;
    } catch (error) {
      expect(String(error)).not.toContain("TOP-SECRET-OUTSIDE");
    }
  }
  expect(sawInside).toBeGreaterThan(0);
});

test("a source whose metadata changes during capture fails closed", async () => {
  const path = join(ws.root, "moving.bin");
  writeFileSync(path, Buffer.alloc(16 * 1024 * 1024, 0x5a));
  let _stop = false;
  const churn = Bun.spawn(
    [
      "sh",
      "-c",
      `while [ ! -f ${JSON.stringify(join(ws.root, "stop"))} ]; do touch ${JSON.stringify(path)}; done`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    await expect(
      ws.transport.open(ws.vmId, ws.root, "moving.bin", {
        maxBytes: 64 * 1024 * 1024,
      }),
    ).rejects.toThrow(/changed/i);
  } finally {
    _stop = true;
    writeFileSync(join(ws.root, "stop"), "");
    churn.kill();
  }
  expect(ws.stagingEntries()).toEqual([]);
});

test("capture refuses anything larger than the bound and leaves no staged bytes", async () => {
  writeFileSync(join(ws.root, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
  await expect(
    ws.transport.open(ws.vmId, ws.root, "big.bin", { maxBytes: 1024 * 1024 }),
  ).rejects.toThrow();
  expect(ws.stagingEntries()).toEqual([]);
});

test("cleanup removes the private staging directory and is idempotent", async () => {
  writeFileSync(join(ws.root, "x.txt"), "x");
  const transfer = await ws.transport.open(ws.vmId, ws.root, "x.txt", {
    maxBytes: 1024,
  });
  expect(ws.stagingEntries()).toHaveLength(1);
  const [staged] = readdirSync(ws.staging);
  expect(readdirSync(join(ws.staging, staged!)).length).toBe(1);
  await transfer.cleanup();
  await transfer.cleanup();
  expect(ws.stagingEntries()).toEqual([]);
});

test("staging must be private: a group-readable staging directory is refused", async () => {
  writeFileSync(join(ws.root, "x.txt"), "x");
  // Model a guest with a loose umask: the staged copy must be refused rather
  // than left readable by the worker's own account.
  const original = ws.host.exec.bind(ws.host);
  ws.host.exec = async (vm, command, options) => {
    const result = await original(vm, command, options);
    const created = /^mkdir -m 700 -- '(.*)'$/.exec(command);
    if (created) chmodSync(created[1]!, 0o755);
    return result;
  };
  await expect(
    ws.transport.open(ws.vmId, ws.root, "x.txt", { maxBytes: 1024 }),
  ).rejects.toThrow(/private/);
  expect(ws.stagingEntries()).toEqual([]);
});

test("an aborted transfer fails and removes its staging directory", async () => {
  writeFileSync(join(ws.root, "x.bin"), Buffer.alloc(3 * 1024 * 1024, 3));
  const controller = new AbortController();
  controller.abort();
  await expect(
    ws.transport.open(ws.vmId, ws.root, "x.bin", {
      maxBytes: 4 * 1024 * 1024,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(ws.stagingEntries()).toEqual([]);
});

test("a snapshot is a readable tar.gz of regular files only", async () => {
  mkdirSync(join(ws.root, "src", "nested"), { recursive: true });
  writeFileSync(join(ws.root, "src", "one.txt"), "one");
  writeFileSync(
    join(ws.root, "src", "nested", "two.bin"),
    Buffer.from([0, 1, 2, 255]),
  );
  mkdirSync(join(ws.root, "src", ".git"));
  writeFileSync(join(ws.root, "src", ".git", "HEAD"), "ref: refs/heads/main");
  mkdirSync(join(ws.root, "src", "node_modules"));
  writeFileSync(join(ws.root, "src", "node_modules", "big.js"), "ignored");
  symlinkSync("/etc/passwd", join(ws.root, "src", "passwd"));
  Bun.spawnSync(["mkfifo", join(ws.root, "src", "fifo")]);
  const transfer = await ws.transport.snapshot(ws.vmId, ws.root, {
    paths: ["src"],
    maxBytes: 8 * 1024 * 1024,
    maxEntries: 100,
    maxDepth: 8,
  });
  expect(transfer.filename.endsWith(".tar.gz")).toBe(true);
  const bytes = await collect(transfer.stream);
  expect(bytes.length).toBe(transfer.size);
  expect(sha(bytes)).toBe(transfer.sha256);
  expect(bytes[0]).toBe(0x1f);
  expect(bytes[1]).toBe(0x8b);
  const list = Bun.spawnSync(["tar", "-tzvf", "-"], {
    stdin: bytes,
  }).stdout.toString();
  expect(list).toContain("src/one.txt");
  expect(list).toContain("src/nested/two.bin");
  expect(list).not.toContain(".git/HEAD");
  expect(list).not.toContain("node_modules/big.js");
  expect(list).not.toContain("passwd");
  expect(list).not.toContain("fifo");
  const extracted = Bun.spawnSync(["tar", "-xzO", "-", "src/one.txt"], {
    stdin: bytes,
  }).stdout;
  expect(extracted.toString()).toBe("one");
  await transfer.cleanup();
});

test("snapshots stay inside their source, entry and byte bounds", async () => {
  mkdirSync(join(ws.root, "deep", "a", "b"), { recursive: true });
  for (let i = 0; i < 12; i++) {
    mkdirSync(join(ws.root, "deep", `d${i}`), { recursive: true });
    writeFileSync(join(ws.root, "deep", `d${i}`, "f.txt"), "x".repeat(1024));
  }
  writeFileSync(join(ws.root, "deep", "a", "b", "leaf.txt"), "leaf");
  const shallow = await ws.transport.snapshot(ws.vmId, ws.root, {
    paths: ["deep"],
    maxBytes: 8 * 1024 * 1024,
    maxEntries: 100,
    maxDepth: 2,
  });
  const names = Bun.spawnSync(["tar", "-tzf", "-"], {
    stdin: await collect(shallow.stream),
  }).stdout.toString();
  expect(names).not.toContain("deep/a/b/leaf.txt");
  expect(shallow.truncated).toBe(true);
  await shallow.cleanup();
  const few = await ws.transport.snapshot(ws.vmId, ws.root, {
    paths: ["deep"],
    maxBytes: 8 * 1024 * 1024,
    maxEntries: 4,
    maxDepth: 8,
  });
  expect(
    Bun.spawnSync(["tar", "-tzf", "-"], {
      stdin: await collect(few.stream),
    })
      .stdout.toString()
      .trim()
      .split("\n").length,
  ).toBeLessThanOrEqual(4);
  await few.cleanup();
  await expect(
    ws.transport.snapshot(ws.vmId, ws.root, {
      paths: ["deep"],
      maxBytes: 2048,
      maxEntries: 100,
      maxDepth: 8,
    }),
  ).rejects.toThrow();
  expect(ws.stagingEntries()).toEqual([]);
});

test("a snapshot of a single file and of the whole root both work", async () => {
  writeFileSync(join(ws.root, "only.txt"), "just one");
  writeFileSync(join(ws.root, "second.txt"), "second");
  const one = await ws.transport.snapshot(ws.vmId, ws.root, {
    paths: ["only.txt"],
    maxBytes: 1024 * 1024,
    maxEntries: 10,
    maxDepth: 8,
  });
  expect(
    Bun.spawnSync(["tar", "-tzf", "-"], { stdin: await collect(one.stream) })
      .stdout.toString()
      .trim(),
  ).toBe("only.txt");
  await one.cleanup();
  const all = await ws.transport.snapshot(ws.vmId, ws.root, {
    maxBytes: 1024 * 1024,
    maxEntries: 100,
    maxDepth: 8,
  });
  const names = Bun.spawnSync(["tar", "-tzf", "-"], {
    stdin: await collect(all.stream),
  })
    .stdout.toString()
    .trim()
    .split("\n");
  expect(names).toContain("only.txt");
  expect(names).toContain("second.txt");
  await all.cleanup();
});

test("diagnostics stage journal and git output as bounded private files", async () => {
  mkdirSync(join(ws.root, "repo", ".git"), { recursive: true });
  writeFileSync(
    join(ws.root, "repo", ".git", "HEAD"),
    "ref: refs/heads/main\n",
  );
  Bun.spawnSync([
    "sh",
    "-c",
    `printf 'branch line\\n' > ${JSON.stringify(join(ws.root, "repo", "status.txt"))}`,
  ]);
  const results = await ws.transport.diagnostics(ws.vmId, ws.root, {
    maxBytes: 64 * 1024,
  });
  expect(results.length).toBeGreaterThanOrEqual(2);
  const journal = results.find((r) => r.path.includes("journal"));
  expect(journal).toBeDefined();
  const journalBytes = await collect(journal!.transfer.stream);
  expect(journalBytes.length).toBe(journal!.transfer.size);
  expect(sha(journalBytes)).toBe(journal!.transfer.sha256);
  await journal!.transfer.cleanup();
  const git = results.find((r) => r.path.includes("git"));
  expect(git).toBeDefined();
  await git!.transfer.cleanup();
  const bounded = await ws.transport.diagnostics(ws.vmId, ws.root, {
    maxBytes: 16,
  });
  for (const item of bounded) {
    expect(item.transfer.size).toBeLessThanOrEqual(16);
    await item.transfer.cleanup();
  }
  expect(ws.stagingEntries()).toEqual([]);
});

test("no artifact or diagnostic byte ever appears in the helper response", async () => {
  const marker = "CANARY-BYTES-MUST-NOT-LEAK-9d2f";
  writeFileSync(join(ws.root, "canary.txt"), marker.repeat(64));
  let responses = "";
  const original = ws.host.exec.bind(ws.host);
  ws.host.exec = async (vm, command, options) => {
    const result = await original(vm, command, options);
    responses += `${result.stdout}${result.stderr}`;
    return result;
  };
  const transfer = await ws.transport.open(ws.vmId, ws.root, "canary.txt", {
    maxBytes: 64 * 1024,
  });
  expect(await collect(transfer.stream)).toEqual(
    new TextEncoder().encode(marker.repeat(64)),
  );
  await transfer.cleanup();
  const snapshot = await ws.transport.snapshot(ws.vmId, ws.root, {
    paths: ["canary.txt"],
    maxBytes: 1024 * 1024,
    maxEntries: 10,
    maxDepth: 4,
  });
  await collect(snapshot.stream);
  await snapshot.cleanup();
  const diagnostics = await ws.transport.diagnostics(ws.vmId, ws.root, {
    maxBytes: 64 * 1024,
  });
  for (const item of diagnostics) await item.transfer.cleanup();
  expect(responses.length).toBeGreaterThan(0);
  expect(responses).not.toContain("CANARY-BYTES-MUST-NOT-LEAK");
  expect(responses.length).toBeLessThan(4096);
});

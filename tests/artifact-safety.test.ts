import { expect, test } from "bun:test";
import type { Freestyle } from "freestyle";
import { loadConfig } from "../src/config";
import { WorkerFiles } from "../src/files";
import { FreestyleProvider } from "../src/providers/freestyle";
import { excerptText, Redactor } from "../src/security";
import { baseEnv, harness, runToRunning, task } from "./helpers";

const root = "/workspace/.swarmforge/artifacts";

async function running(h: ReturnType<typeof harness>) {
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  return { id: w.worker_id, vm: h.store.get(w.worker_id).vm_id! };
}

test("a symlink swapped in after the path checks cannot leak outside-root content", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  const marker = "outside-root-marker";
  const files = new WorkerFiles(h.coordinator);
  await h.provider.writeFile(vm, `${root}/report.txt`, "safe artifact body\n");
  await h.provider.writeFile(
    vm,
    "/etc/shadow",
    `root:${marker}:19000:0:99999:7:::`,
  );
  const clean = await files.readArtifact(id, "report.txt", 0, 64);
  expect(new TextDecoder().decode(clean)).toContain("safe artifact body");
  // Every check has already run at this point. The name becomes a symlink before
  // the read resolves it a second time, which is the window a stat-then-read pair
  // leaves open: a by-name read returns outside-root bytes, a contained open refuses.
  h.provider.beforeRead = () => {
    h.provider.links.set(`${vm}:${root}/report.txt`, "/etc/shadow");
    h.provider.files.delete(`${vm}:${root}/report.txt`);
  };
  h.provider.reads = 0;
  h.provider.contained = 0;
  const outcome = await files.readArtifact(id, "report.txt", 0, 64).then(
    (bytes) => new TextDecoder().decode(bytes),
    (error) => `rejected: ${error.message}`,
  );
  expect(outcome).not.toContain(marker);
  expect(outcome.startsWith("rejected:")).toBe(true);
  expect(h.provider.contained).toBe(1);
  expect(h.provider.reads).toBe(0);
  h.store.close();
});

test("a symlinked trusted prefix cannot disclose outside-root names or sizes", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  const files = new WorkerFiles(h.coordinator);
  await h.provider.writeFile(
    vm,
    "/outside/artifacts/secret-name.txt",
    "outside content",
  );
  // The worker owns its workspace, so it can replace the .swarmforge directory
  // holding the artifacts root with a symlink of its own.
  h.provider.links.set(`${vm}:/workspace/.swarmforge`, "/outside");
  const rejected = "rejected: Symlink artifact paths are not allowed";
  const listing = await files.artifacts(id).then(
    (result) => result.entries.map((e) => e.name),
    () => rejected,
  );
  expect(listing).toBe(rejected);
  const handle = await files.artifact(id, "secret-name.txt").then(
    (result) => `size ${result.size}`,
    () => rejected,
  );
  expect(handle).toBe(rejected);
  // With the prefix intact the listing names only entries inside the root.
  h.provider.links.delete(`${vm}:/workspace/.swarmforge`);
  await h.provider.writeFile(vm, `${root}/real.txt`, "in root");
  expect((await files.artifacts(id)).entries.map((e) => e.name)).toEqual([
    "real.txt",
  ]);
  h.store.close();
});

test("artifact reads fail closed when the provider cannot guarantee containment", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  await h.provider.writeFile(vm, `${root}/report.txt`, "safe artifact body\n");
  (h.provider as { readFileContained?: unknown }).readFileContained = undefined;
  await expect(
    new WorkerFiles(h.coordinator).readArtifact(id, "report.txt", 0, 64),
  ).rejects.toThrow();
  expect(h.provider.reads).toBe(0);
  h.store.close();
});

test("invisible characters cannot reassemble a credential after sanitization", async () => {
  const r = new Redactor(() => ["model-secret", "infra-secret"]);
  // These hold only for text that a terminal, log or excerpt renderer folds first.
  expect(r.contains(new TextEncoder().encode("mod\u200bel-secret"))).toBe(true);
  expect(r.contains(new TextEncoder().encode("model\u200b-secret"))).toBe(true);
  expect(r.contains(new TextEncoder().encode("model-\u202esecret"))).toBe(true);
  expect(r.contains(new TextEncoder().encode("model-\u0007secret"))).toBe(true);
  expect(
    r.contains(new TextEncoder().encode("https://u:infr\u200ba-secret@x.test")),
  ).toBe(true);
  expect(excerptText("token mod\u200bel-secret tail", (v) => r.text(v))).toBe(
    "token [REDACTED] tail",
  );
  expect(r.contains(new TextEncoder().encode("nothing to see here"))).toBe(
    false,
  );
});

test("a usable piece of a credential is refused wherever it sits in a window", () => {
  const r = new Redactor(() => ["infra-secret"]);
  const pad = "P".repeat(4096);
  const bytes = (text: string) =>
    new TextEncoder().encode(`${pad}${text}${pad}`);
  // Eleven of the twelve characters, held away from every window edge by padding.
  expect(r.discloses(bytes(`i${pad}nfra-secret`))).toBe(true);
  // The same eleven spelled across invisible filler no renderer shows.
  expect(r.discloses(bytes(`i${pad}nfra\u200b-secret`))).toBe(true);
  // Every character of the credential, in order, split by the line wrap an
  // ordinary log would put between them.
  expect(r.discloses(bytes("infra\n  -secret"))).toBe(true);
  // Below the floor and short of the whole credential: still released.
  expect(r.discloses(bytes(`i${pad}nfra-se`))).toBe(false);
  // Padding, escapes and invisible filler alone are not credentials.
  expect(r.discloses(bytes(`build ok${"\u200b".repeat(64)}done`))).toBe(false);
  expect(r.discloses(bytes("\u001b[32mgreen\u001b[0m text"))).toBe(false);
});

test("an artifact that only spells a credential with invisible characters is blocked", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  await h.provider.writeFile(
    vm,
    `${root}/notes.txt`,
    "report body mod\u200bel-secret and infra\u0007-secret tail",
  );
  const files = new WorkerFiles(h.coordinator);
  await expect(files.readArtifact(id, "notes.txt", 0, 256)).rejects.toThrow();
  await h.provider.writeFile(
    vm,
    `${root}/clean.txt`,
    "report body with no keys",
  );
  const bytes = await files.readArtifact(id, "clean.txt", 0, 256);
  expect(new TextDecoder().decode(bytes)).toContain("no keys");
  h.store.close();
});

test("a credential longer than the read overlap is still caught at a chunk boundary", async () => {
  const token = `sf-live-${"Z".repeat(6000)}`;
  const h = harness({ ...baseEnv, SWARMFORGE_API_TOKEN: token });
  const { id, vm } = await running(h);
  // The token starts 904 bytes before the scanned window opens, so only its tail
  // is inside unless the overlap covers the whole credential.
  await h.provider.writeFile(
    vm,
    `${root}/long.txt`,
    `${"A".repeat(5000)}${token}${"B".repeat(40000)}`,
  );
  const files = new WorkerFiles(h.coordinator);
  await expect(
    files.readArtifact(id, "long.txt", 10000, 32768),
  ).rejects.toThrow();
  // Without the token the same chunk is returned unchanged.
  const plain = harness();
  const other = await running(plain);
  await plain.provider.writeFile(
    other.vm,
    `${root}/long.txt`,
    `${"A".repeat(5000)}${"Z".repeat(6000)}${"B".repeat(40000)}`,
  );
  const bytes = await new WorkerFiles(plain.coordinator).readArtifact(
    other.id,
    "long.txt",
    10000,
    32768,
  );
  expect(bytes.length).toBe(32768);
  plain.store.close();
  // A credential too long for any bounded overlap fails the read closed instead
  // of screening a window that could still miss part of it.
  const huge = harness({ SWARMFORGE_API_TOKEN: "K".repeat(25000) });
  const third = await running(huge);
  await huge.provider.writeFile(
    third.vm,
    `${root}/plain.txt`,
    "B".repeat(1000),
  );
  await expect(
    new WorkerFiles(huge.coordinator).readArtifact(
      third.id,
      "plain.txt",
      0,
      64,
    ),
  ).rejects.toThrow(/cannot cover the longest configured credential/);
  huge.store.close();
  h.store.close();
});

test("deep artifact paths are rejected before any provider call", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  const files = new WorkerFiles(h.coordinator);
  const deep = `${"nested/".repeat(24)}file.txt`;
  expect(deep.length).toBeLessThan(1024);
  h.provider.stats = 0;
  await expect(files.readArtifact(id, deep)).rejects.toThrow();
  await expect(files.artifacts(id, "nested/".repeat(24))).rejects.toThrow();
  expect(h.provider.stats).toBe(0);
  // A path at the depth limit still resolves, within a bounded stat budget.
  const allowed = `${"nested/".repeat(15)}file.txt`;
  await h.provider.writeFile(vm, `${root}/${allowed}`, "deep artifact body\n");
  h.provider.stats = 0;
  const bytes = await files.readArtifact(id, allowed, 0, 64);
  expect(new TextDecoder().decode(bytes)).toContain("deep artifact body");
  // Trusted workspace components, the root, and one stat per supplied segment.
  expect(h.provider.stats).toBeLessThanOrEqual(4 + 16);
  h.store.close();
});

test("a credential cut off by the window edge cannot be disclosed by invisible filler", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  // "model-secret" is written with zero-width characters between its halves, so
  // no screen can match it literally. The invisible run also crosses the byte
  // where the scanned window opens, so the chunk on offer would carry "el-secret",
  // the tail of a credential whose head is outside the window. Each filler
  // character is three bytes on disk, so the split lands on the 50001st byte.
  const filler = "\u200b".repeat(6666);
  await h.provider.writeFile(
    vm,
    `${root}/filler.txt`,
    `${"P".repeat(30000)}mod${filler}el-secret${"Q".repeat(70000)}`,
  );
  const files = new WorkerFiles(h.coordinator);
  await expect(
    files.readArtifact(id, "filler.txt", 50001, 32768),
  ).rejects.toThrow();
  // Shorter than the fragment floor, so the same shape is released: a piece this
  // small is not usable without the rest of the credential.
  await h.provider.writeFile(
    vm,
    `${root}/piece.txt`,
    `${"P".repeat(30000)}mod${filler}el-secr${"Q".repeat(70000)}`,
  );
  const bytes = await files.readArtifact(id, "piece.txt", 50001, 32768);
  expect(bytes.length).toBe(32768);
  // The same cut at the far end of the window: nothing of the credential is on
  // offer there, but the fragment is still screened rather than reasoned about.
  await h.provider.writeFile(
    vm,
    `${root}/tail.txt`,
    `${"X".repeat(20000)}model-sec${"\u200b".repeat(20000)}ret${"Y".repeat(70000)}`,
  );
  await expect(
    files.readArtifact(id, "tail.txt", 24096, 32768),
  ).rejects.toThrow();
  h.store.close();
});

test("filler cannot carry a credential fragment out of the screened window", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  const files = new WorkerFiles(h.coordinator);
  const token = "infra-secret";
  // Filler that renderers drop, between the halves of a credential, so no screen
  // can match it literally.
  const gap = "\u200b".repeat(3333);
  const shapes: [string, string][] = [
    // The first character sits behind the read and padding keeps the other
    // eleven away from any edge the screen measures, so one read would carry
    // eleven of twelve characters of FREESTYLE_API_TOKEN.
    [
      "gap.txt",
      `${"P".repeat(59000)}${token[0]}${"P".repeat(4999)}${gap}${token.slice(1)}${"Q".repeat(70000)}`,
    ],
    // The same split with filler a renderer keeps, so nothing about it is
    // invisible: only the position of the fragment is unusual.
    [
      "padding.txt",
      `${"P".repeat(59000)}${token[0]}${"P".repeat(5000)}${token.slice(1)}${"Q".repeat(70000)}`,
    ],
    // Every character, in order, with only the line wrap an ordinary log would
    // put between them.
    ["wrapped.txt", `${"P".repeat(70000)}infra\n  -secret${"Q".repeat(70000)}`],
  ];
  for (const [name, body] of shapes) {
    await h.provider.writeFile(vm, `${root}/${name}`, body);
    const outcome = await files.readArtifact(id, name, 60000, 32768).then(
      (bytes) => `released ${new TextDecoder().decode(bytes).slice(0, 32)}`,
      (error) => `rejected: ${error.message}`,
    );
    expect(outcome.startsWith("rejected:")).toBe(true);
  }
  // The same shape carrying ordinary output is released, invisible run and all:
  // what is measured is credential material, not how much filler surrounds it.
  await h.provider.writeFile(
    vm,
    `${root}/ordinary.txt`,
    `${"P".repeat(59000)}info\n  ready${gap}${"Q".repeat(70000)}`,
  );
  const bytes = await files.readArtifact(id, "ordinary.txt", 60000, 32768);
  expect(bytes.length).toBe(32768);
  h.store.close();
});

test("the Freestyle contained read opens without following links and always clears its staging copy", async () => {
  const execs: string[] = [];
  const reads: { path: string; offset: number; length: number }[] = [];
  const reply = (command: string) => ({
    statusCode: 0,
    stdout: `{"size": 19}`,
    stderr: "",
    stage: command.match(/'(\/run\/[^']+)'/)?.[1] ?? "",
  });
  const client = {
    vms: {
      ref: () => ({
        exec: async ({ command }: { command: string }) => {
          execs.push(command);
          return reply(command);
        },
        fs: {
          readFile: async (
            path: string,
            opts: { offset: number; length: number },
          ) => {
            reads.push({ path, ...opts });
            return new TextEncoder().encode("safe artifact body\n");
          },
        },
      }),
    },
  } as unknown as Freestyle;
  const provider = new FreestyleProvider(loadConfig(baseEnv), client);
  const out = await provider.readFileContained(
    "vm-1",
    `${root}/report.txt`,
    16,
    64,
  );
  expect(out.size).toBe(19);
  expect(new TextDecoder().decode(out.bytes)).toContain("safe artifact body");
  const stage = reply(execs[0]!).stage;
  const [open, ...rest] = execs;
  expect(open).toContain("O_NOFOLLOW");
  expect(open).toContain("dir_fd=");
  expect(open).toContain(`'${root}/report.txt'`);
  expect(open).toContain(" 16 64");
  expect(stage.startsWith("/run/swarmforge-read/")).toBe(true);
  // The staging directory is created fresh for this call, never reused.
  expect(open).not.toContain("exist_ok");
  // Only the staging directory this call chose is ever read or removed.
  expect(reads).toEqual([{ path: `${stage}/chunk`, offset: 0, length: 64 }]);
  expect(rest).toEqual([`rm -rf -- '${stage}'`]);

  // A guest that reports a different file is ignored: the copy this call made is
  // the only path it will read or delete.
  execs.length = 0;
  reads.length = 0;
  const lying = new FreestyleProvider(loadConfig(baseEnv), {
    vms: {
      ref: () => ({
        exec: async ({ command }: { command: string }) => {
          execs.push(command);
          return {
            ...reply(command),
            stdout: '{"size": 4, "path": "/etc/passwd"}',
          };
        },
        fs: {
          readFile: async (path: string) => {
            reads.push({ path, offset: 0, length: 64 });
            return new TextEncoder().encode("junk");
          },
        },
      }),
    },
  } as unknown as Freestyle);
  const lied = await lying.readFileContained(
    "vm-1",
    `${root}/report.txt`,
    0,
    64,
  );
  expect(lied.size).toBe(4);
  expect(reads.map((r) => r.path)).toEqual([`${reply(execs[0]!).stage}/chunk`]);
  expect(execs[1]).not.toContain("/etc/passwd");

  // A refusal inside the guest, and a response that cannot be trusted, both fail
  // the read and still remove whatever the guest may have staged.
  for (const failure of [
    { statusCode: 1, stdout: "" },
    { statusCode: 0, stdout: "not json" },
    { statusCode: 0, stdout: '{"size": -1}' },
    { statusCode: 0, stdout: '{"size": 1.5}' },
  ]) {
    execs.length = 0;
    reads.length = 0;
    const failing = new FreestyleProvider(loadConfig(baseEnv), {
      vms: {
        ref: () => ({
          exec: async ({ command }: { command: string }) => {
            execs.push(command);
            return { ...reply(command), ...failure };
          },
          fs: {
            readFile: async (path: string) => {
              reads.push({ path, offset: 0, length: 64 });
              return new Uint8Array();
            },
          },
        }),
      },
    } as unknown as Freestyle);
    await expect(
      failing.readFileContained("vm-1", `${root}/report.txt`, 0, 64),
    ).rejects.toThrow();
    expect(reads).toEqual([]);
    expect(execs).toHaveLength(2);
    expect(execs[1]?.startsWith("rm -rf -- '/run/swarmforge-read/")).toBe(true);
  }
});

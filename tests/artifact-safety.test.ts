import { expect, test } from "bun:test";
import { WorkerFiles } from "../src/files";
import { excerptText, Redactor } from "../src/security";
import { baseEnv, harness, runToRunning, task } from "./helpers";

const root = "/workspace/.swarmforge/artifacts";

async function running(h: ReturnType<typeof harness>) {
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  return { id: w.worker_id, vm: h.store.get(w.worker_id).vm_id! };
}

test("an artifact swapped to a symlink after the check never leaks outside-root content", async () => {
  const h = harness();
  const { id, vm } = await running(h);
  const files = new WorkerFiles(h.coordinator);
  await h.provider.writeFile(vm, `${root}/report.txt`, "safe artifact body\n");
  await h.provider.writeFile(
    vm,
    "/etc/shadow",
    "root:$6$outside:19000:0:99999:7:::",
  );
  const clean = await files.readArtifact(id, "report.txt", 0, 64);
  expect(new TextDecoder().decode(clean)).toContain("safe artifact body");
  // Swap the checked path for a symlink the instant the check completes.
  h.provider.links.set(`${vm}:${root}/report.txt`, "/etc/shadow");
  h.provider.onStat = (path) => {
    if (path !== `${root}/report.txt`) return;
    h.provider.onStat = null;
    h.provider.links.delete(`${vm}:${root}/report.txt`);
  };
  // The old path-based read follows the name again and yields outside-root bytes.
  h.provider.readFile = async () => {
    h.provider.reads++;
    return new TextEncoder().encode("root:$6$outside:19000:0:99999:7:::");
  };
  await expect(files.readArtifact(id, "report.txt", 0, 64)).rejects.toThrow();
  expect(h.provider.reads).toBe(0);
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
  expect(h.provider.stats).toBeLessThanOrEqual(17);
  h.store.close();
});

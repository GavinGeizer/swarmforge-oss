import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { WorkerProvider } from "../src/domain";
import { Metrics } from "../src/metrics";
import { guestRoot, guestTransport, writeGuestFile } from "./artifact-double";
import { harness, runToRunning, task } from "./helpers";

const kinds = new Set([
  "file",
  "directory",
  "snapshot",
  "diagnostics",
  "log",
  "other",
]);

async function observed() {
  const h = harness();
  const root = guestRoot();
  (h.provider as WorkerProvider).artifactTransport = guestTransport(root);
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const vm = h.store.get(w.worker_id).vm_id!;
  const workspace = h.coordinator.config.SWARMFORGE_WORKSPACE;
  return {
    ...h,
    root,
    workerId: w.worker_id,
    write: (path: string, content: string | Uint8Array) =>
      writeGuestFile(root, vm, workspace, path, content),
    done: () => {
      h.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const labels = (text: string, name: string) =>
  [...text.matchAll(new RegExp(`${name}\\{([^}]*)\\}`, "g"))].flatMap((m) =>
    (m[1] ?? "")
      .split(",")
      .map((pair) => (pair.split("=")[1] ?? "").replaceAll('"', "")),
  );

test("artifact metrics are derived from persisted records with bounded labels", async () => {
  const h = await observed();
  try {
    h.write("findings.json", '{"secret":"model-secret","verdict":"ok"}');
    h.write("logs/run.log", "worker output\n");
    await h.coordinator.artifacts.preserve(h.workerId, "findings.json", {});
    await h.coordinator.artifacts.collectDirectory(h.workerId, "logs", {});
    const text = await new Metrics(h.coordinator).render();
    expect(text).toContain("swarmforge_artifacts_preserved_total");
    expect(text).toContain("swarmforge_artifacts_bytes_total");
    expect(text).toContain("swarmforge_artifacts_failed_total");
    expect(text).toContain("swarmforge_artifact_collection_duration_seconds");
    for (const label of labels(text, "swarmforge_artifacts_preserved_total"))
      expect(kinds.has(label)).toBe(true);
    for (const label of labels(text, "swarmforge_artifacts_bytes_total"))
      expect(kinds.has(label)).toBe(true);
    for (const label of labels(text, "swarmforge_artifacts_failed_total"))
      expect(kinds.has(label)).toBe(true);
    // No worker, task, path or content may reach the metrics surface.
    expect(text).not.toContain(h.workerId);
    expect(text).not.toContain("task_id");
    expect(text).not.toContain("findings.json");
    expect(text).not.toContain("worker output");
    expect(text).not.toContain("model-secret");
    expect(text).not.toContain("swarmforge_worker_id");
  } finally {
    h.done();
  }
});

test("unbounded artifact kinds collapse into a bounded label instead of creating cardinality", async () => {
  const h = await observed();
  try {
    h.write("a.txt", "a");
    h.write("b.txt", "b");
    const noisy = `tenant-${Math.random().toString(36).slice(2)}-run-${Date.now()}`;
    await h.coordinator.artifacts.preserve(h.workerId, "a.txt", {
      kind: noisy,
    });
    await h.coordinator.artifacts.preserve(h.workerId, "b.txt", {
      kind: "file",
    });
    const text = await new Metrics(h.coordinator).render();
    expect(text).not.toContain(noisy);
    expect(text).toContain(
      'swarmforge_artifacts_preserved_total{kind="other"}',
    );
    expect(text).toContain('swarmforge_artifacts_preserved_total{kind="file"}');
  } finally {
    h.done();
  }
});

test("finalization gauges and salvage attempts follow the persisted worker record", async () => {
  const h = await observed();
  try {
    h.write(".swarmforge/artifacts/findings.json", '{"verdict":"salvage"}');
    h.write(".swarmforge/logs/run.log", "log");
    h.write(
      ".swarmforge/result.json",
      '{"status":"completed","summary":"done"}',
    );
    await h.coordinator.control(h.workerId, "cancel");
    await h.coordinator.retryFinalization(h.workerId);
    const text = await new Metrics(h.coordinator).render();
    expect(text).toContain("swarmforge_finalizations");
    expect(text).toContain("swarmforge_finalization_attempts_total");
    expect(text).toMatch(/swarmforge_finalizations\{state="preserved"\} 1/);
    expect(text).toMatch(/swarmforge_finalization_attempts_total \d/);
    expect(text).not.toContain(h.workerId);
    h.store.patch(h.workerId, {
      finalization: {
        state: "pending",
        run_id: null,
        attempts: 2,
        error: "model-secret capture failed",
        next_retry_at: Date.now() + 2000,
        started_at: Date.now(),
        completed_at: null,
      },
    } as never);
    const pending = await new Metrics(h.coordinator).render();
    expect(pending).toMatch(/swarmforge_finalizations\{state="pending"\} 1/);
    expect(pending).not.toContain("model-secret");
  } finally {
    h.done();
  }
});

test("artifact metrics are empty but well formed with no persisted artifacts", async () => {
  const h = await observed();
  try {
    const text = await new Metrics(h.coordinator).render();
    expect(text).toContain("swarmforge_artifacts_preserved_total");
    expect(text).not.toContain('kind="file"');
    expect(text).toContain("swarmforge_finalizations");
  } finally {
    h.done();
  }
});

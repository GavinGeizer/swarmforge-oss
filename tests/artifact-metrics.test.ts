import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerProvider } from "../src/domain";
import { Metrics } from "../src/metrics";
import { harness, runToRunning, task } from "./helpers";
import { localWorkspace } from "./local-artifact-provider";

const kinds = new Set([
  "file",
  "directory",
  "snapshot",
  "diagnostics",
  "log",
  "other",
]);

async function observed() {
  // The coordinator reads the artifact root and storage root once, at construction.
  const workspace = await localWorkspace();
  const storage = mkdtempSync(join(tmpdir(), "swarmforge-test-storage-"));
  const h = harness({
    SWARMFORGE_WORKSPACE: workspace.root,
    SWARMFORGE_ARTIFACT_DIR: storage,
  });
  (h.provider as WorkerProvider).artifactTransport = workspace.transport;
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  // Materialise the real service so its artifact repository table exists in the shared store.
  void h.coordinator.artifacts;
  return {
    ...h,
    workspace,
    workerId: w.worker_id,
    write: (path: string, content: string | Uint8Array) => {
      const target = join(workspace.root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    },
    done: async () => {
      h.store.close();
      await workspace.cleanup();
      rmSync(storage, { recursive: true, force: true });
    },
  };
}
// One exported sample per metric family line, with its labels and value.
const sample = (text: string, name: string) =>
  [
    ...text.matchAll(new RegExp(`^${name}(\\{[^}]*\\})? ([0-9.e+-]+)$`, "gm")),
  ].map((m) => ({ labels: m[1] ?? "", value: Number(m[2]) }));
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
    await h.done();
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
    await h.done();
  }
});

test("finalization stage and durable events follow a real collection cycle", async () => {
  const h = await observed();
  try {
    h.write(".swarmforge/artifacts/findings.json", '{"verdict":"salvage"}');
    h.write(".swarmforge/logs/run.log", "log");
    h.write(
      ".swarmforge/result.json",
      '{"status":"completed","summary":"done"}',
    );
    h.write(".swarmforge/task.json", '{"task":"metrics-cycle"}');
    h.write(".swarmforge/metadata.json", '{"role":"coder"}');
    await h.coordinator.control(h.workerId, "cancel");
    await h.coordinator.retryFinalization(h.workerId);
    const text = await new Metrics(h.coordinator).render();
    expect(text).toContain("swarmforge_finalizations");
    expect(text).toContain("swarmforge_finalization_attempts_total");
    // The stage gauge reports the live record; the counters report what was persisted.
    expect(text).toMatch(/swarmforge_finalizations\{state="preserved"\} 1/);
    const outcomes = new Map(
      sample(text, "swarmforge_finalization_attempts_total").map((series) => [
        series.labels,
        series.value,
      ]),
    );
    expect(outcomes.get('{outcome="attempted"}')).toBeGreaterThan(0);
    expect(outcomes.get('{outcome="preserved"}')).toBeGreaterThan(0);
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
    await h.done();
  }
});

test("finalization attempts and failures come from durable events, not from the live record", async () => {
  const h = await observed();
  try {
    // The lifecycle contract: a claim persists finalization.collecting before any effect, so a
    // restart mid-attempt still leaves one event per attempt, and attempt_failed records an
    // attempt that will be retried. Three collection cycles follow, each resetting the live
    // record, so a counter derived from that record alone would fall back towards zero.
    h.store.event(h.workerId, "finalization.pending" as never);
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (let attempt = 0; attempt < cycle; attempt++)
        h.store.event(h.workerId, "finalization.collecting" as never, {
          attempt: attempt + 1,
        });
      const preserved = cycle < 3;
      if (!preserved)
        h.store.event(h.workerId, "finalization.attempt_failed" as never, {
          error: "model-secret must not be a metric value",
        });
      h.store.event(
        h.workerId,
        preserved
          ? ("finalization.preserved" as never)
          : ("finalization.failed" as never),
        { error: "model-secret must not be a metric value" },
      );
      h.store.patch(h.workerId, {
        finalization: {
          state: preserved ? "preserved" : "failed",
          run_id: null,
          attempts: cycle,
          error: "model-secret must not be a metric value",
          next_retry_at: preserved ? null : Date.now() + 2000,
          started_at: 1,
          completed_at: 2,
        },
      } as never);
    }
    const text = await new Metrics(h.coordinator).render();
    const attempts = sample(text, "swarmforge_finalization_attempts_total");
    expect(attempts).toEqual([
      { labels: '{outcome="pending"}', value: 1 },
      { labels: '{outcome="attempted"}', value: 6 },
      { labels: '{outcome="attempt_failed"}', value: 1 },
      { labels: '{outcome="preserved"}', value: 2 },
      { labels: '{outcome="failed"}', value: 1 },
      { labels: '{outcome="abandoned"}', value: 0 },
      { labels: '{outcome="other"}', value: 0 },
    ]);
    expect(text).not.toContain("model-secret");
    // The live record is only the current stage, not the history.
    expect(text).toMatch(/swarmforge_finalizations\{state="failed"\} 1/);
    expect(text).not.toMatch(/swarmforge_finalizations\{state="preserved"}/);
    // A database that recorded nothing still exposes the whole label set with zeroes.
    const fresh = harness();
    try {
      const empty = await new Metrics(fresh.coordinator).render();
      expect(
        sample(empty, "swarmforge_finalization_attempts_total").map(
          (series) => series.labels,
        ),
      ).toEqual([
        '{outcome="pending"}',
        '{outcome="attempted"}',
        '{outcome="attempt_failed"}',
        '{outcome="preserved"}',
        '{outcome="failed"}',
        '{outcome="abandoned"}',
        '{outcome="other"}',
      ]);
      expect(
        sample(empty, "swarmforge_finalization_attempts_total").every(
          (series) => series.value === 0,
        ),
      ).toBe(true);
    } finally {
      fresh.store.close();
    }
  } finally {
    await h.done();
  }
});

test("artifact metrics survive a repository that cannot be read", async () => {
  const h = await observed();
  try {
    h.store.db.exec("DROP TABLE artifacts");
    const service = h.coordinator.artifacts as unknown as {
      list: () => unknown;
    };
    service.list = () => {
      throw new Error("artifact repository unavailable");
    };
    const text = await new Metrics(h.coordinator).render();
    expect(text).toContain("swarmforge_workers");
    expect(text).toMatch(/swarmforge_artifacts_scan_complete 0/);
    expect(text).not.toContain("artifact repository unavailable");
  } finally {
    await h.done();
  }
});

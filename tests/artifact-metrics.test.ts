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
    // The stage gauge follows the persisted record; the cumulative counters below are rebuilt
    // from durable finalization events, which this lifecycle scaffold does not persist yet.
    expect(text).toMatch(/swarmforge_finalizations\{state="preserved"\} 1/);
    expect(
      sample(text, "swarmforge_finalization_attempts_total").every(
        (s) => s.value === 0,
      ),
    ).toBe(true);
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

type Record_ = {
  artifact_id: string;
  task_id: string;
  worker_id: string;
  run_id: string | null;
  original_path: string;
  storage_key: string;
  filename: string;
  size: number;
  sha256: string | null;
  created_at: number;
  retrieved_at: number | null;
  state: "preserving" | "preserved" | "failed";
  attempts: number;
  error: string | null;
  kind: string;
};
const record = (over: Partial<Record_> = {}): Record_ => ({
  artifact_id: `a-${Math.random().toString(36).slice(2)}`,
  task_id: "task",
  worker_id: "w-1",
  run_id: null,
  original_path: "findings.json",
  storage_key: "/var/lib/swarmforge/private/key",
  filename: "findings.json",
  size: 10,
  sha256: "a".repeat(64),
  created_at: 1_000,
  retrieved_at: 1_200,
  state: "preserved",
  attempts: 1,
  error: null,
  kind: "file",
  ...over,
});
// Replaces the persisted artifact repository with a deterministic page source so the metrics
// aggregation itself is measured, not the capture path.
function repository(
  h: Awaited<ReturnType<typeof observed>>,
  pages: Record_[][],
) {
  const service = h.coordinator.artifacts as unknown as {
    list: (filter: { offset?: number; limit?: number }) => unknown;
  };
  service.list = ({ offset = 0, limit = 100 }) => ({
    artifacts: (pages[Math.floor(offset / limit)] ?? []).slice(0, limit),
    next_offset:
      Math.floor(offset / limit) + 1 < pages.length
        ? Math.floor(offset / limit) * limit + limit
        : null,
  });
}
const sample = (text: string, name: string) =>
  [
    ...text.matchAll(new RegExp(`^${name}(\\{[^}]*\\})? ([0-9.e+-]+)$`, "gm")),
  ].map((m) => ({ labels: m[1] ?? "", value: Number(m[2]) }));

test("an artifact still being captured is not reported as a failure", async () => {
  const h = await observed();
  try {
    repository(h, [
      [
        record({ state: "preserved", size: 10 }),
        record({ state: "preserving", size: 0, retrieved_at: null }),
        record({ state: "failed", size: 0, retrieved_at: null, error: "x" }),
      ],
    ]);
    const text = await new Metrics(h.coordinator).render();
    expect(sample(text, "swarmforge_artifacts_preserved_total")).toEqual([
      { labels: '{kind="file"}', value: 1 },
    ]);
    expect(sample(text, "swarmforge_artifacts_failed_total")).toEqual([
      { labels: '{kind="file"}', value: 1 },
    ]);
    expect(sample(text, "swarmforge_artifacts_bytes_total")).toEqual([
      { labels: '{kind="file"}', value: 10 },
    ]);
    // An in-flight capture is its own state, never folded into failures.
    expect(text).toMatch(/swarmforge_artifacts_in_flight\{kind="file"\} 1/);
    expect(
      sample(text, "swarmforge_artifact_collection_duration_seconds_count"),
    ).toEqual([{ labels: "", value: 1 }]);
  } finally {
    h.done();
  }
});

test("artifact metrics aggregate every persisted record instead of a capped page", async () => {
  const h = await observed();
  try {
    // 30,000 records is far beyond one page; a capped scan would report 20,000.
    const pages: Record_[][] = [];
    for (let page = 0; page < 300; page++)
      pages.push(
        Array.from({ length: 100 }, (_, n) =>
          record({ artifact_id: `a-${page}-${n}`, size: n + 1 }),
        ),
      );
    repository(h, pages);
    const text = await new Metrics(h.coordinator).render();
    expect(sample(text, "swarmforge_artifacts_preserved_total")).toEqual([
      { labels: '{kind="file"}', value: 30_000 },
    ]);
    // 300 pages of 100 records with sizes 1..100 each: a capped scan would report far less.
    expect(sample(text, "swarmforge_artifacts_bytes_total")).toEqual([
      { labels: '{kind="file"}', value: (300 * (100 * 101)) / 2 },
    ]);
    expect(
      sample(text, "swarmforge_artifact_collection_duration_seconds_count"),
    ).toEqual([{ labels: "", value: 30_000 }]);
    expect(text).toMatch(/swarmforge_artifacts_scan_complete 1/);
  } finally {
    h.done();
  }
});

test("an incomplete artifact scan is reported instead of silently truncating totals", async () => {
  const h = await observed();
  try {
    const service = h.coordinator.artifacts as unknown as {
      list: (filter: { offset?: number }) => unknown;
    };
    // A repository that never signals its end cannot be scanned to completion; the metrics
    // must say so rather than present a partial total as complete.
    service.list = ({ offset = 0 }) => ({
      artifacts: [record({ artifact_id: `a-${offset}`, size: 1 })],
      next_offset: offset + 100,
    });
    const text = await new Metrics(h.coordinator).render();
    expect(text).toMatch(/swarmforge_artifacts_scan_complete 0/);
    const preserved = sample(text, "swarmforge_artifacts_preserved_total");
    expect(preserved).toHaveLength(1);
  } finally {
    h.done();
  }
});

test("finalization attempts and failures come from durable events, not from the live record", async () => {
  const h = await observed();
  try {
    // Three collection cycles. Each one persists its attempts and outcome as events and then
    // resets the live record, so a counter derived from the record alone would fall back
    // towards zero while the durable total keeps growing.
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (let attempt = 0; attempt < cycle; attempt++)
        h.store.event(h.workerId, "finalization.attempted" as never);
      const preserved = cycle < 3;
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
      { labels: '{outcome="attempted"}', value: 6 },
      { labels: '{outcome="preserved"}', value: 2 },
      { labels: '{outcome="failed"}', value: 1 },
      { labels: '{outcome="abandoned"}', value: 0 },
    ]);
    expect(text).not.toContain("model-secret");
    // The live record is only the current stage, not the history.
    expect(text).toMatch(/swarmforge_finalizations\{state="failed"\} 1/);
    expect(text).not.toMatch(/swarmforge_finalizations\{state="preserved"}/);
    // A repository that has recorded nothing still exposes the label set with zeroes.
    const fresh = harness();
    try {
      const empty = await new Metrics(fresh.coordinator).render();
      expect(sample(empty, "swarmforge_finalization_attempts_total")).toEqual([
        { labels: '{outcome="attempted"}', value: 0 },
        { labels: '{outcome="preserved"}', value: 0 },
        { labels: '{outcome="failed"}', value: 0 },
        { labels: '{outcome="abandoned"}', value: 0 },
      ]);
    } finally {
      fresh.store.close();
    }
  } finally {
    h.done();
  }
});

test("artifact metrics survive a repository that cannot be read", async () => {
  const h = await observed();
  try {
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
    h.done();
  }
});

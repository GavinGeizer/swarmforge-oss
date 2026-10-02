import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerProvider } from "../src/domain";
import { Metrics } from "../src/metrics";
import { harness, runToRunning, task } from "./helpers";
import { localWorkspace } from "./local-artifact-provider";

const kinds = new Set(["file", "declared", "snapshot", "diagnostic", "other"]);

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
let sequence = 0;
// One record per source: the repository keeps a unique index over worker, run, path and kind.
const record = (over: Partial<Record_> = {}): Record_ => {
  const id = `art-${(sequence++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    artifact_id: id,
    task_id: "task",
    worker_id: "w-1",
    run_id: null,
    original_path: `${id}.json`,
    storage_key: "/var/lib/swarmforge/private/key",
    filename: `${id}.json`,
    size: 10,
    sha256: "b".repeat(64),
    created_at: 1_000,
    retrieved_at: 1_200,
    state: "preserved",
    attempts: 1,
    error: null,
    kind: "file",
    ...over,
  };
};
// Writes records straight into the persisted artifact repository, so the aggregation is measured
// against the real table the coordinator and the service share.
function seed(h: Awaited<ReturnType<typeof observed>>, records: Record_[]) {
  for (const row of records)
    h.store.db
      .query(
        "INSERT OR REPLACE INTO artifacts(artifact_id,worker_id,task_id,run_id,original_path,storage_key,filename,size,sha256,kind,state,attempts,error,created_at,retrieved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.artifact_id,
        row.worker_id,
        row.task_id,
        row.run_id,
        row.original_path,
        row.storage_key,
        row.filename,
        row.size,
        row.sha256,
        row.kind,
        row.state,
        row.attempts,
        row.error,
        row.created_at,
        row.retrieved_at,
      );
}
// Writes rows into the durable artifact event table the data plane appends to.
function events(
  h: Awaited<ReturnType<typeof observed>>,
  rows: {
    kind: string;
    artifact_kind: string;
    size?: number | null;
    outcome?: string | null;
    error?: string;
  }[],
) {
  for (const row of rows)
    h.store.db
      .query(
        `INSERT INTO artifact_events(kind,artifact_id,worker_id,task_id,run_id,attempt,artifact_kind,outcome,size,sha256,error,at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.kind,
        `art-${row.kind.replace(/\W/g, "")}-${Math.random().toString(36).slice(2, 8)}`,
        "w-1",
        "task",
        null,
        1,
        row.artifact_kind,
        row.outcome ?? null,
        row.size ?? null,
        row.size === undefined ? null : "d".repeat(64),
        row.error ?? null,
        1_500,
      );
}
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
    for (const name of [
      "swarmforge_artifacts_attempts_total",
      "swarmforge_artifacts_preserved_total",
      "swarmforge_artifacts_bytes_total",
      "swarmforge_artifacts_failed_total",
      "swarmforge_artifacts_stored",
      "swarmforge_artifacts_stored_bytes",
      "swarmforge_artifact_collection_duration_seconds",
    ])
      expect(text).toContain(name);
    for (const name of [
      "swarmforge_artifacts_attempts_total",
      "swarmforge_artifacts_preserved_total",
      "swarmforge_artifacts_bytes_total",
      "swarmforge_artifacts_failed_total",
      "swarmforge_artifacts_stored",
      "swarmforge_artifacts_stored_bytes",
    ])
      for (const label of labels(text, name))
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

test("cumulative artifact counters follow the durable event log, not the record table", async () => {
  const h = await observed();
  try {
    // Three attempts, two of which stored verified bytes, and one failure. The event log is
    // append-only, so these totals only grow, while the record table can lose a published copy to
    // a superseding recapture and its bytes to a later cleanup.
    seed(h, [
      record({ state: "preserved", size: 10, kind: "file" }),
      record({
        state: "preserved",
        size: 20,
        kind: "file",
        original_path: "second.json",
        filename: "second.json",
      }),
      record({
        state: "failed",
        size: 0,
        retrieved_at: null,
        kind: "file",
        original_path: "broken.json",
        filename: "broken.json",
      }),
    ]);
    events(h, [
      { kind: "artifact.attempted", artifact_kind: "file" },
      { kind: "artifact.attempted", artifact_kind: "file" },
      { kind: "artifact.attempted", artifact_kind: "file" },
      {
        kind: "artifact.preserved",
        artifact_kind: "file",
        size: 10,
        outcome: "preserved",
      },
      {
        kind: "artifact.preserved",
        artifact_kind: "file",
        size: 20,
        outcome: "preserved",
      },
      {
        kind: "artifact.failed",
        artifact_kind: "file",
        outcome: "failed",
        error: "model-secret must not be a metric value",
      },
    ]);
    const text = await new Metrics(h.coordinator).render();
    expect(sample(text, "swarmforge_artifacts_attempts_total")).toEqual([
      { labels: '{kind="file"}', value: 3 },
    ]);
    expect(sample(text, "swarmforge_artifacts_preserved_total")).toEqual([
      { labels: '{kind="file"}', value: 2 },
    ]);
    expect(sample(text, "swarmforge_artifacts_bytes_total")).toEqual([
      { labels: '{kind="file"}', value: 30 },
    ]);
    expect(sample(text, "swarmforge_artifacts_failed_total")).toEqual([
      { labels: '{kind="file"}', value: 1 },
    ]);
    expect(text).not.toContain("model-secret");
  } finally {
    await h.done();
  }
});

test("a superseded recapture leaves the cumulative totals alone and shrinks the stored gauge", async () => {
  const h = await observed();
  try {
    const first = record({ state: "preserved", size: 10, kind: "file" });
    const second = record({
      state: "preserved",
      size: 40,
      kind: "file",
      original_path: "second.json",
      filename: "second.json",
    });
    seed(h, [first, second]);
    // The second capture published over the first: the first record keeps its state and its
    // history, but it is no longer the current copy.
    h.store.db
      .query("UPDATE artifacts SET superseded_by=? WHERE artifact_id=?")
      .run(second.artifact_id, first.artifact_id);
    events(h, [
      { kind: "artifact.attempted", artifact_kind: "file" },
      { kind: "artifact.attempted", artifact_kind: "file" },
      {
        kind: "artifact.preserved",
        artifact_kind: "file",
        size: 10,
        outcome: "preserved",
      },
      {
        kind: "artifact.preserved",
        artifact_kind: "file",
        size: 40,
        outcome: "preserved",
      },
    ]);
    const text = await new Metrics(h.coordinator).render();
    // Cumulative: both verified copies are still counted, fifty bytes in total.
    expect(sample(text, "swarmforge_artifacts_preserved_total")).toEqual([
      { labels: '{kind="file"}', value: 2 },
    ]);
    expect(sample(text, "swarmforge_artifacts_bytes_total")).toEqual([
      { labels: '{kind="file"}', value: 50 },
    ]);
    expect(sample(text, "swarmforge_artifacts_attempts_total")).toEqual([
      { labels: '{kind="file"}', value: 2 },
    ]);
    // Current state: one published copy, and only its bytes.
    expect(sample(text, "swarmforge_artifacts_stored")).toEqual([
      { labels: '{kind="file"}', value: 1 },
    ]);
    expect(sample(text, "swarmforge_artifacts_stored_bytes")).toEqual([
      { labels: '{kind="file"}', value: 40 },
    ]);
  } finally {
    await h.done();
  }
});

test("an artifact still being captured is in flight, never a failure", async () => {
  const h = await observed();
  try {
    seed(h, [
      record({ state: "preserved", size: 10, kind: "file" }),
      record({
        state: "preserving",
        size: 0,
        retrieved_at: null,
        kind: "file",
      }),
    ]);
    events(h, [
      { kind: "artifact.attempted", artifact_kind: "file" },
      { kind: "artifact.attempted", artifact_kind: "file" },
      {
        kind: "artifact.preserved",
        artifact_kind: "file",
        size: 10,
        outcome: "preserved",
      },
    ]);
    const text = await new Metrics(h.coordinator).render();
    expect(sample(text, "swarmforge_artifacts_in_flight")).toEqual([
      { labels: '{kind="file"}', value: 1 },
    ]);
    // A capture still running is neither a failure nor a published copy, but it is an attempt.
    // The failure series exists for the kind with a zero value, so a dashboard never has to
    // distinguish "no failures" from "no data".
    expect(sample(text, "swarmforge_artifacts_failed_total")).toEqual([
      { labels: '{kind="file"}', value: 0 },
    ]);
    expect(sample(text, "swarmforge_artifacts_stored")).toEqual([
      { labels: '{kind="file"}', value: 1 },
    ]);
    expect(sample(text, "swarmforge_artifacts_attempts_total")).toEqual([
      { labels: '{kind="file"}', value: 2 },
    ]);
    expect(
      sample(text, "swarmforge_artifact_collection_duration_seconds_count"),
    ).toEqual([{ labels: "", value: 1 }]);
  } finally {
    await h.done();
  }
});

test("capture kinds are the published names and anything else collapses into other", async () => {
  const h = await observed();
  try {
    seed(h, [
      record({ kind: "diagnostic" }),
      record({ kind: "snapshot", original_path: "snap.json" }),
      record({ kind: "tenant-42-run-9f2c", original_path: "noisy.json" }),
      record({ kind: "declared", original_path: "declared.json" }),
    ]);
    events(h, [
      { kind: "artifact.attempted", artifact_kind: "diagnostic" },
      {
        kind: "artifact.preserved",
        artifact_kind: "diagnostic",
        size: 5,
        outcome: "preserved",
      },
      { kind: "artifact.attempted", artifact_kind: "declared" },
      {
        kind: "artifact.preserved",
        artifact_kind: "declared",
        size: 7,
        outcome: "preserved",
      },
      // A plural or unknown kind is not a new time series.
      { kind: "artifact.attempted", artifact_kind: "diagnostics" },
      {
        kind: "artifact.preserved",
        artifact_kind: "diagnostics",
        size: 3,
        outcome: "preserved",
      },
    ]);
    const text = await new Metrics(h.coordinator).render();
    expect(text).toContain(
      'swarmforge_artifacts_preserved_total{kind="diagnostic"} 1',
    );
    expect(text).toContain(
      'swarmforge_artifacts_preserved_total{kind="declared"} 1',
    );
    expect(text).toContain(
      'swarmforge_artifacts_preserved_total{kind="other"} 1',
    );
    for (const name of [
      "swarmforge_artifacts_preserved_total",
      "swarmforge_artifacts_stored",
    ])
      for (const label of labels(text, name))
        expect(kinds.has(label)).toBe(true);
    expect(text).not.toContain("tenant-42-run-9f2c");
    expect(text).not.toContain("diagnostics");
  } finally {
    await h.done();
  }
});

test("an incomplete duration scan is reported instead of silently truncating the histogram", async () => {
  const h = await observed();
  try {
    // One row more than the histogram budget, inserted in a single statement.
    h.store.db.exec(`INSERT INTO artifacts(
        artifact_id,worker_id,task_id,run_id,original_path,storage_key,filename,size,sha256,
        kind,state,attempts,error,created_at,retrieved_at)
      SELECT 'art-bulk-'||x,'w-1','task',NULL,'bulk-'||x||'.json','k','bulk.json',1,
        '${"a".repeat(64)}','file','preserved',1,NULL,1000,1010
      FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<50001) SELECT x FROM c)`);
    const text = await new Metrics(h.coordinator).render();
    expect(text).toMatch(/swarmforge_artifacts_scan_complete 0/);
    // The histogram reports exactly what it observed, never a silently larger total.
    expect(
      sample(text, "swarmforge_artifact_collection_duration_seconds_count"),
    ).toEqual([{ labels: "", value: 50000 }]);
    // Current state is a grouped query, so it stays exact however many rows exist.
    expect(sample(text, "swarmforge_artifacts_stored")).toEqual([
      { labels: '{kind="file"}', value: 50001 },
    ]);
  } finally {
    await h.done();
  }
});

test("artifact metrics stay well formed without any artifact history", async () => {
  const h = await observed();
  try {
    const text = await new Metrics(h.coordinator).render();
    expect(text).toContain("swarmforge_artifacts_attempts_total");
    expect(text).toContain("swarmforge_artifacts_stored");
    expect(text).toMatch(/swarmforge_artifacts_scan_complete 1/);
    expect(sample(text, "swarmforge_artifacts_preserved_total")).toEqual([]);
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
    // The published lifecycle contract: a claim persists finalization.attempted before any
    // effect, so a restart mid-attempt still leaves exactly one event per attempt, and a settled
    // collection records preserved, failed or abandoned once. Three collection cycles follow, each
    // resetting the live record, so a counter derived from that record alone falls towards zero.
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (let attempt = 0; attempt < cycle; attempt++)
        h.store.event(h.workerId, "finalization.attempted" as never, {
          attempt: attempt + 1,
        });
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
        '{outcome="attempted"}',
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

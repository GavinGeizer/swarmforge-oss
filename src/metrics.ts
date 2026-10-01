import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Coordinator } from "./coordinator";

// Artifact kinds are recorded by the capture path, so the label set is fixed here: an
// unexpected kind becomes "other" instead of creating unbounded metric cardinality.
const artifactKinds = new Set([
  "file",
  "directory",
  "snapshot",
  "diagnostics",
  "log",
]);
const finalizationStates = [
  "pending",
  "collecting",
  "preserved",
  "failed",
  "abandoned",
] as const;
const artifactPages = 200;
export class Metrics {
  constructor(readonly c: Coordinator) {}
  async render() {
    const registry = new Registry();
    const allowed = new Set(
      this.c.config.SWARMFORGE_METRICS_TEAMS.split(",").map((s) => s.trim()),
    );
    const team = (t: string) => (allowed.has(t) ? t : "other");
    const workers = new Gauge({
      name: "swarmforge_workers",
      help: "Retained worker records by state",
      labelNames: ["team", "state"],
      registers: [registry],
    });
    const active = new Gauge({
      name: "swarmforge_workers_active",
      help: "Workers running or waiting on an active task",
      registers: [registry],
    });
    const waiting = new Gauge({
      name: "swarmforge_workers_waiting",
      help: "Workers waiting on OpenCode",
      registers: [registry],
    });
    const queued = new Gauge({
      name: "swarmforge_tasks_queued",
      help: "Workers waiting for VM capacity",
      registers: [registry],
    });
    const inference = new Gauge({
      name: "swarmforge_inference_requests_active",
      help: "Observed incomplete OpenCode assistant messages (estimate)",
      registers: [registry],
    });
    const created = new Counter({
      name: "swarmforge_workers_created_total",
      help: "Worker requests persisted",
      labelNames: ["team"],
      registers: [registry],
    });
    const completed = new Counter({
      name: "swarmforge_workers_completed_total",
      help: "Completed worker turns",
      labelNames: ["team"],
      registers: [registry],
    });
    const failed = new Counter({
      name: "swarmforge_workers_failed_total",
      help: "Failed worker transitions including recovery required",
      labelNames: ["team"],
      registers: [registry],
    });
    const tokens = new Counter({
      name: "swarmforge_tokens_total",
      help: "Observed OpenCode tokens by direction",
      labelNames: ["team", "model", "direction"],
      registers: [registry],
    });
    const provision = new Histogram({
      name: "swarmforge_worker_provision_duration_seconds",
      help: "Time from provision start to readiness",
      labelNames: ["backend"],
      buckets: [1, 5, 15, 30, 60, 120, 300],
      registers: [registry],
    });
    const duration = new Histogram({
      name: "swarmforge_worker_task_duration_seconds",
      help: "Completed turn duration including waiting",
      buckets: [1, 10, 60, 300, 900, 3600, 14400],
      registers: [registry],
    });
    const preserved = new Counter({
      name: "swarmforge_artifacts_preserved_total",
      help: "Artifacts captured from workers and verified in coordinator storage",
      labelNames: ["kind"],
      registers: [registry],
    });
    const bytes = new Counter({
      name: "swarmforge_artifacts_bytes_total",
      help: "Verified artifact bytes stored by the coordinator",
      labelNames: ["kind"],
      registers: [registry],
    });
    const captureFailures = new Counter({
      name: "swarmforge_artifacts_failed_total",
      help: "Artifact captures that failed or were abandoned",
      labelNames: ["kind"],
      registers: [registry],
    });
    const collection = new Histogram({
      name: "swarmforge_artifact_collection_duration_seconds",
      help: "Time from capture start to a verified preserved artifact",
      buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
      registers: [registry],
    });
    const finalizations = new Gauge({
      name: "swarmforge_finalizations",
      help: "Worker artifact finalization records by stage",
      labelNames: ["state"],
      registers: [registry],
    });
    const salvage = new Counter({
      name: "swarmforge_finalization_attempts_total",
      help: "Automatic and operator-triggered artifact collection attempts",
      registers: [registry],
    });
    const all = this.c.store.all();
    active.set(
      all.filter((w) => ["running", "waiting"].includes(w.state)).length,
    );
    waiting.set(all.filter((w) => w.state === "waiting").length);
    queued.set(all.filter((w) => w.state === "queued").length);
    inference.set([...this.c.inference.values()].reduce((a, b) => a + b, 0));
    for (const w of all) {
      workers.inc({ team: team(w.team_id), state: w.state });
      created.inc({ team: team(w.team_id) });
      const usage = this.c.store.tokens({ worker_id: w.worker_id });
      for (const direction of [
        "input",
        "output",
        "reasoning",
        "cache_read",
        "cache_write",
      ] as const)
        tokens.inc(
          {
            team: team(w.team_id),
            model: this.c.config.SWARMFORGE_MODEL_NAME,
            direction,
          },
          usage[direction],
        );
      const counts = this.c.store.db
        .query(
          "SELECT type,count(*) n FROM events WHERE worker_id=? GROUP BY type",
        )
        .all(w.worker_id) as { type: string; n: number }[];
      for (const count of counts) {
        if (count.type === "worker.completed")
          completed.inc({ team: team(w.team_id) }, count.n);
        if (["worker.failed", "worker.recovery_required"].includes(count.type))
          failed.inc({ team: team(w.team_id) }, count.n);
      }
      const ready = this.c.store.db
        .query(
          "SELECT min(at) at FROM events WHERE worker_id=? AND type='worker.ready'",
        )
        .get(w.worker_id) as { at: number | null };
      if (ready.at && w.provision_started_at)
        provision.observe(
          { backend: "freestyle" },
          Math.max(0, (ready.at - w.provision_started_at) / 1000),
        );
      for (const d of this.c.store.dispatches(w.worker_id)) {
        if (d.state !== "completed" || !d.sent_at) continue;
        const end = this.c.store.db
          .query(
            "SELECT at FROM events WHERE worker_id=? AND type='result.received' AND json_extract(data,'$.run_id')=? LIMIT 1",
          )
          .get(w.worker_id, d.run_id) as { at: number } | null;
        if (end) duration.observe((end.at - d.sent_at) / 1000);
      }
    }
    await this.artifacts(preserved, bytes, captureFailures, collection);
    let attempts = 0;
    for (const w of all) {
      const finalization = w.finalization;
      if (!finalization) continue;
      finalizations.inc({
        state: finalizationStates.includes(finalization.state)
          ? finalization.state
          : "pending",
      });
      attempts += Math.max(0, finalization.attempts);
    }
    salvage.inc(attempts);
    return registry.metrics();
  }
  // Preserved records and their finalization attempts are reconstructed from durable
  // storage on every scrape, so restarts and manual retries keep the same totals. Nothing
  // worker-, task-, path- or content-specific is used as a label or a value.
  private async artifacts(
    preserved: Counter<"kind">,
    bytes: Counter<"kind">,
    failed: Counter<"kind">,
    collection: Histogram,
  ) {
    const kind = (value: string) =>
      artifactKinds.has(value) ? value : "other";
    let offset = 0;
    for (let page = 0; page < artifactPages; page++) {
      let listed: Awaited<ReturnType<Coordinator["artifacts"]["list"]>>;
      try {
        listed = await this.c.artifacts.list({ offset, limit: 100 });
      } catch {
        return;
      }
      for (const record of listed.artifacts) {
        const label = { kind: kind(record.kind) };
        if (record.state === "preserved") {
          preserved.inc(label);
          bytes.inc(label, Math.max(0, record.size));
          if (record.retrieved_at && record.retrieved_at >= record.created_at)
            collection.observe(
              (record.retrieved_at - record.created_at) / 1000,
            );
        } else failed.inc(label);
      }
      if (listed.next_offset === null || listed.next_offset <= offset) return;
      offset = listed.next_offset;
    }
  }
}

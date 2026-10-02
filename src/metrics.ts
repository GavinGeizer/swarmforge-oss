import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Coordinator } from "./coordinator";

// Artifact kinds are recorded by the capture path, so the label set is fixed here: an
// unexpected kind becomes "other" instead of creating unbounded metric cardinality. The names
// are the ones the capture and lifecycle layers actually write.
const artifactKinds = new Set(["file", "declared", "snapshot", "diagnostic"]);
const finalizationStates = [
  "pending",
  "collecting",
  "preserved",
  "failed",
  "abandoned",
] as const;
// Cumulative finalization totals come from durable events, never from the live record: an
// attempts counter derived from a record that resets per collection cycle would fall back
// towards zero while the history keeps growing. The lifecycle package persists exactly these
// event names, and this mapping is the contract those counters depend on:
//   finalization.attempted one claimed attempt, persisted before any effect, including a
//                       restart that re-enters an interrupted collecting record
//   finalization.preserved the collection settled with its artifacts stored
//   finalization.failed    the collection gave up
//   finalization.abandoned preservation was explicitly abandoned
// Creating the record announces nothing, and a scheduled retry is not an outcome, so neither
// produces an event. Any other event under the prefix counts as "other".
const finalizationEvents: Record<string, string> = {
  attempted: "attempted",
  // Superseded by "attempted"; still counted so an older database keeps its attempt history.
  collecting: "attempted",
  preserved: "preserved",
  failed: "failed",
  abandoned: "abandoned",
};
const finalizationOutcomes = [
  "attempted",
  "preserved",
  "failed",
  "abandoned",
  "other",
] as const;
// The cumulative counters come from one grouped query over the durable artifact event table, so
// they are exact at any size. Only the collection-duration histogram has to walk rows, and it
// streams them with a budget; reaching the budget reports an incomplete histogram rather than
// silently truncating it.
const artifactDurationBound = 50000;
// Durable artifact event names, written by the data plane's artifact repository.
const artifactAttemptedEvent = "artifact.attempted";
const artifactPreservedEvent = "artifact.preserved";
const artifactFailedEvent = "artifact.failed";
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
    const attempts = new Counter({
      name: "swarmforge_artifacts_attempts_total",
      help: "Artifact capture attempts started, from the durable artifact event log",
      labelNames: ["kind"],
      registers: [registry],
    });
    const preserved = new Counter({
      name: "swarmforge_artifacts_preserved_total",
      help: "Artifact captures that stored and verified bytes, cumulative",
      labelNames: ["kind"],
      registers: [registry],
    });
    const bytes = new Counter({
      name: "swarmforge_artifacts_bytes_total",
      help: "Verified artifact bytes written by the coordinator, cumulative",
      labelNames: ["kind"],
      registers: [registry],
    });
    const captureFailures = new Counter({
      name: "swarmforge_artifacts_failed_total",
      help: "Artifact capture attempts that failed, cumulative",
      labelNames: ["kind"],
      registers: [registry],
    });
    const stored = new Gauge({
      name: "swarmforge_artifacts_stored",
      help: "Currently published artifact copies, excluding superseded ones",
      labelNames: ["kind"],
      registers: [registry],
    });
    const storedBytes = new Gauge({
      name: "swarmforge_artifacts_stored_bytes",
      help: "Bytes of the currently published artifact copies",
      labelNames: ["kind"],
      registers: [registry],
    });
    const inFlight = new Gauge({
      name: "swarmforge_artifacts_in_flight",
      help: "Artifact captures that are still running",
      labelNames: ["kind"],
      registers: [registry],
    });
    const scanComplete = new Gauge({
      name: "swarmforge_artifacts_scan_complete",
      help: "1 when the collection-duration histogram covered every completed capture; the cumulative counters are exact regardless",
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
      help: "Durable artifact finalization events by outcome",
      labelNames: ["outcome"],
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
    await this.artifacts(
      attempts,
      preserved,
      bytes,
      captureFailures,
      stored,
      storedBytes,
      inFlight,
      scanComplete,
      collection,
    );
    // The stage gauge describes the current record; the cumulative counters below are
    // rebuilt from the durable event log, so a retried or restarted cycle never loses history.
    for (const w of all) {
      const finalization = w.finalization;
      if (!finalization) continue;
      finalizations.inc({
        state: finalizationStates.includes(finalization.state)
          ? finalization.state
          : "pending",
      });
    }
    this.finalizationEvents(salvage);
    return registry.metrics();
  }
  // Durable event contract, owned by the lifecycle package: the mapping above is this metric's
  // dependency on it. Event payloads are never read, so a recorded error cannot become a
  // label or a value, and an unknown event type is counted as "other" rather than creating a
  // new time series.
  private finalizationEvents(salvage: Counter<"outcome">) {
    const counts = new Map<string, number>();
    let rows: { type: string; n: number }[] = [];
    try {
      rows = this.c.store.db
        .query(
          "SELECT type, count(*) n FROM events WHERE type LIKE 'finalization.%' GROUP BY type",
        )
        .all() as { type: string; n: number }[];
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const suffix = row.type.slice("finalization.".length);
      const label = finalizationEvents[suffix] ?? "other";
      counts.set(label, (counts.get(label) ?? 0) + Math.max(0, row.n));
    }
    for (const outcome of finalizationOutcomes)
      salvage.inc({ outcome }, counts.get(outcome) ?? 0);
  }
  // Cumulative artifact totals come from the durable artifact event table, not from the record
  // table: every attempt is its own record and a recapture supersedes the copy it replaces, so
  // summing records would inflate a byte total while a later cleanup of superseded bytes lowers it
  // again. Events are append-only, so a counter derived from them only ever grows.
  private async artifacts(
    attempts: Counter<"kind">,
    preserved: Counter<"kind">,
    bytes: Counter<"kind">,
    failed: Counter<"kind">,
    stored: Gauge<"kind">,
    storedBytes: Gauge<"kind">,
    inFlight: Gauge<"kind">,
    scanComplete: Gauge,
    collection: Histogram,
  ) {
    const kind = (value: string) =>
      artifactKinds.has(value) ? value : "other";
    // One grouped query per outcome: exact at any repository size, no paging, no truncation.
    try {
      for (const row of this.c.store.db
        .query(
          `SELECT artifact_kind kind, sum(kind=?) attempts, sum(kind=?) preserved,
             coalesce(sum(CASE WHEN kind=? THEN size ELSE 0 END),0) bytes,
             sum(kind=?) failed
           FROM artifact_events GROUP BY artifact_kind`,
        )
        .all(
          artifactAttemptedEvent,
          artifactPreservedEvent,
          artifactPreservedEvent,
          artifactFailedEvent,
        ) as {
        kind: string;
        attempts: number;
        preserved: number;
        bytes: number;
        failed: number;
      }[]) {
        const label = { kind: kind(row.kind) };
        attempts.inc(label, row.attempts);
        preserved.inc(label, row.preserved);
        bytes.inc(label, Math.max(0, row.bytes));
        failed.inc(label, row.failed);
      }
    } catch {
      // A database without the event table has no history to report; the gauges below still do.
    }
    // Current state is a gauge, not a total: exactly one published copy per source exists, and a
    // capture still running is its own state.
    try {
      for (const row of this.c.store.db
        .query(
          `SELECT kind, sum(state='preserved' AND superseded_by IS NULL) stored,
             coalesce(sum(CASE WHEN state='preserved' AND superseded_by IS NULL THEN size ELSE 0 END),0) bytes,
             sum(state='preserving') in_flight
           FROM artifacts GROUP BY kind`,
        )
        .all() as {
        kind: string;
        stored: number;
        bytes: number;
        in_flight: number;
      }[]) {
        const label = { kind: kind(row.kind) };
        stored.set(label, row.stored);
        storedBytes.set(label, Math.max(0, row.bytes));
        inFlight.set(label, row.in_flight);
      }
    } catch {
      // Older databases without superseded_by keep working; the gauges stay empty.
    }
    // Each completed capture is its own record, so its duration is historical even once the copy
    // is superseded. The rows are streamed with a budget rather than materialised, and hitting it
    // is reported instead of silently truncating the histogram.
    let seen = 0;
    let truncated = false;
    try {
      for (const row of this.c.store.db
        .query(
          "SELECT created_at, retrieved_at FROM artifacts WHERE state='preserved' AND retrieved_at IS NOT NULL",
        )
        .iterate() as IterableIterator<{
        created_at: number;
        retrieved_at: number;
      }>) {
        if (++seen > artifactDurationBound) {
          truncated = true;
          break;
        }
        if (row.retrieved_at >= row.created_at)
          collection.observe((row.retrieved_at - row.created_at) / 1000);
      }
    } catch {
      truncated = true;
    }
    scanComplete.set(truncated ? 0 : 1);
  }
}

import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Coordinator } from "./coordinator";
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
    return registry.metrics();
  }
}

import { cleanupReadiness } from "./cleanup";
import type { Coordinator } from "./coordinator";
import type { Worker } from "./domain";

export function retentionCandidate(
  c: Coordinator,
  worker: Worker,
  now = Date.now(),
) {
  const settledAt = Math.max(
    worker.completed_at ?? worker.last_activity_at,
    worker.last_activity_at,
    worker.finalization?.completed_at ?? 0,
  );
  const due = settledAt + c.config.SWARMFORGE_RETENTION_SECONDS * 1000;
  const readiness = cleanupReadiness({
    ...worker,
    pending_control: worker.intent,
    pending_messages: c.store.pendingMessages(worker.worker_id),
  });
  return {
    worker_id: worker.worker_id,
    team_id: worker.team_id,
    task_id: worker.task_id,
    state: worker.state,
    due_at: due,
    overdue: now >= due,
    eligible: readiness.eligible,
    reason: readiness.reason,
    mode: c.config.SWARMFORGE_RETENTION_MODE,
  };
}

export function retentionPreview(c: Coordinator, offset = 0, limit = 20) {
  const page = c.store.queryWorkers({
    retained_only: true,
    sort: "idle",
    offset,
    limit,
  });
  return {
    mode: c.config.SWARMFORGE_RETENTION_MODE,
    seconds: c.config.SWARMFORGE_RETENTION_SECONDS,
    workers: page.workers.map((worker) => retentionCandidate(c, worker)),
    total: page.total,
    next_offset: page.next_offset,
  };
}

/** Bounded periodic pass. Normal, settled-only destruction retains both Git and artifact gates. */
export async function processRetention(c: Coordinator) {
  if (c.config.SWARMFORGE_RETENTION_MODE === "off") return;
  const after = Number(c.store.setting("retention_offset") ?? 0);
  const page = c.store.queryWorkers({
    retained_only: true,
    sort: "age",
    offset: after,
    limit: 20,
  });
  c.store.setting("retention_offset", String(page.next_offset ?? 0));
  for (const worker of page.workers) {
    if (c.stopping) break;
    const candidate = retentionCandidate(c, worker);
    if (!candidate.overdue || !candidate.eligible) continue;
    const key = `retention_notice:${worker.worker_id}`;
    const version = `${candidate.due_at}:${c.config.SWARMFORGE_RETENTION_MODE}`;
    if (c.store.setting(key) !== version) {
      c.store.event(worker.worker_id, "retention.due", {
        due_at: candidate.due_at,
        mode: c.config.SWARMFORGE_RETENTION_MODE,
      });
      c.store.setting(key, version);
    }
    if (c.config.SWARMFORGE_RETENTION_MODE !== "auto") continue;
    // Failed admission is retried after five minutes, rather than flooding the provider/log.
    const retryKey = `retention_retry:${worker.worker_id}`;
    if (Number(c.store.setting(retryKey) ?? 0) > Date.now()) continue;
    try {
      const result = await c.control(
        worker.worker_id,
        "destroy",
        false,
        true,
        candidate.due_at,
      );
      if (result.state !== "destroyed")
        throw new Error(
          "Normal destruction was blocked by preservation or Git safety checks",
        );
      c.store.event(worker.worker_id, "retention.cleaned");
    } catch {
      c.store.setting(retryKey, String(Date.now() + 300000));
      c.store.event(worker.worker_id, "retention.blocked", {
        reason:
          "Normal destruction refused; inspect worker logs and Git/artifact preservation before retrying.",
      });
    }
  }
}

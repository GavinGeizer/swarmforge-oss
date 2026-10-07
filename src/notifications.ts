import type { Coordinator } from "./coordinator";
import { usageEstimate } from "./operator-insights";

const titles: Record<string, string> = {
  "result.followup_required": "Task requests follow-up",
  "worker.completed": "Task completed",
  "worker.failed": "Task failed",
  "worker.cancelled": "Task cancelled",
  "worker.recovery_required": "Recovery required",
  "worker.waiting": "Worker waiting for follow-up",
  "finalization.failed": "Output preservation failed",
  "finalization.preserved": "Outputs preserved",
  "retention.due": "Retained VM cleanup due",
  "retention.blocked": "Automatic cleanup blocked",
  "retention.cleaned": "Expired VM cleaned up",
  "budget.exceeded": "Estimated budget threshold reached",
};
export interface NotificationQuery {
  cursor?: number;
  limit?: number;
  worker_id?: string;
  team_id?: string;
  task_id?: string;
}
export function notificationFeed(
  c: Coordinator,
  query: NotificationQuery = {},
) {
  const cursor = query.cursor ?? 0;
  const ceiling = c.store.latestEventId();
  const limit = query.limit ?? 20;
  const names = Object.keys(titles);
  const where = `events.id>? AND events.id<=? AND events.type IN (${names.map(() => "?").join(",")}) AND (? IS NULL OR events.worker_id=?) AND (? IS NULL OR workers.team_id=?) AND (? IS NULL OR workers.task_id=?)`;
  const args = [
    cursor,
    ceiling,
    ...names,
    query.worker_id ?? null,
    query.worker_id ?? null,
    query.team_id ?? null,
    query.team_id ?? null,
    query.task_id ?? null,
    query.task_id ?? null,
  ];
  const rows = c.store.db
    .query(
      `SELECT events.*,workers.team_id,workers.task_id FROM events JOIN workers USING(worker_id) WHERE ${where} ORDER BY events.id LIMIT ?`,
    )
    .all(...args, limit + 1) as {
    id: number;
    worker_id: string;
    team_id: string;
    task_id: string;
    type: string;
    at: number;
    data: string;
  }[];
  const page = rows.slice(0, limit);
  return {
    notifications: page.map((row) => ({ ...row, title: titles[row.type] })),
    next_cursor:
      rows.length > limit ? page.at(-1)!.id : Math.max(cursor, ceiling),
    has_more: rows.length > limit,
  };
}
export function checkBudget(c: Coordinator) {
  const estimate = usageEstimate(c.store, c.config);
  const key = "budget_alert_threshold";
  if (!estimate.budget_exceeded) {
    if (c.store.setting(key)) c.store.setting(key, "");
    return;
  }
  const threshold = String(estimate.budget_usd);
  if (c.store.setting(key) === threshold) return;
  const worker = c.store.queryWorkers({ sort: "recent", limit: 1 }).workers[0];
  if (!worker) return;
  c.store.event(worker.worker_id, "budget.exceeded", {
    estimated_usd: estimate.estimated_usd,
    budget_usd: estimate.budget_usd,
    complete: estimate.complete,
  });
  c.store.setting(key, threshold);
}

import { retainsVm } from "../cleanup";
import type { WorkerSummary } from "./overview";

export interface WorkerFilters {
  query: string;
  team: string;
  task: string;
  state: string;
  preservation: string;
  retainedOnly: boolean;
}
export type WorkerSort = "recent" | "idle" | "age";
export const sortOrders: WorkerSort[] = ["recent", "idle", "age"];
export const filterShortcuts =
  "/ search · t team · k task · s state · p outputs · v retained · o sort · z reset";

export function emptyFilters(): WorkerFilters {
  return {
    query: "",
    team: "",
    task: "",
    state: "",
    preservation: "",
    retainedOnly: false,
  };
}
export function filterWorkers(
  workers: WorkerSummary[],
  filters: WorkerFilters,
) {
  const query = filters.query.toLowerCase();
  return workers.filter(
    (worker) =>
      (!query ||
        worker.worker_id.toLowerCase().includes(query) ||
        worker.task_id.toLowerCase().includes(query)) &&
      (!filters.team || worker.team_id === filters.team) &&
      (!filters.task || worker.task_id === filters.task) &&
      (!filters.state || worker.state === filters.state) &&
      (!filters.preservation ||
        (worker.finalization?.state ?? "none") === filters.preservation) &&
      (!filters.retainedOnly || retainsVm(worker)),
  );
}
export function sortWorkers(workers: WorkerSummary[], order: WorkerSort) {
  return [...workers].sort(
    (a, b) =>
      (order === "age"
        ? a.created_at - b.created_at
        : order === "idle"
          ? a.last_activity_at - b.last_activity_at
          : b.last_activity_at - a.last_activity_at) ||
      a.worker_id.localeCompare(b.worker_id),
  );
}
export function filterDescription(filters: WorkerFilters, order: WorkerSort) {
  return [
    filters.query ? `search=${filters.query}` : "",
    filters.team ? `team=${filters.team}` : "",
    filters.task ? `task=${filters.task}` : "",
    filters.state ? `state=${filters.state}` : "",
    filters.preservation ? `outputs=${filters.preservation}` : "",
    filters.retainedOnly ? "retained VMs" : "",
    `sort=${order === "recent" ? "recent activity" : order === "idle" ? "longest idle" : "oldest worker"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

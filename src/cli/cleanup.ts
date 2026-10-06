import { cleanupReadiness, retainsVm } from "../cleanup";
import { filterShortcuts, sortWorkers, type WorkerSort } from "./filters";
import type { WorkerSummary } from "./overview";
import { safeTerminalText } from "./terminal";

export { cleanupReadiness, retainsVm } from "../cleanup";
export function retainedWorkers(
  workers: WorkerSummary[],
  order: WorkerSort = "idle",
) {
  return sortWorkers(workers.filter(retainsVm), order);
}

export function duration(milliseconds: number) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

export function retentionSummary(workers: WorkerSummary[], now = Date.now()) {
  const retained = workers.filter(retainsVm);
  return {
    count: new Set(retained.map((worker) => worker.vm_id)).size,
    candidates: retained.filter((worker) => cleanupReadiness(worker).eligible)
      .length,
    oldest: retained.length
      ? duration(
          now -
            retained.reduce(
              (oldest, worker) => Math.min(oldest, worker.created_at),
              now,
            ),
        )
      : "—",
  };
}

export interface CleanupOutcome {
  worker_id: string;
  state: "destroyed" | "blocked" | "skipped" | "failed";
  message: string;
}

export function renderCleanup(
  workers: WorkerSummary[],
  selected: ReadonlySet<string>,
  options: {
    cursor?: string;
    width?: number;
    height?: number;
    now?: number;
    preview?: boolean;
    outcomes?: CleanupOutcome[];
    sort?: WorkerSort;
    filterLabel?: string;
  } = {},
) {
  const now = options.now ?? Date.now();
  const width = Math.max(30, options.width ?? 100);
  const rows = options.preview
    ? workers
    : retainedWorkers(workers, options.sort);
  const pageSize = Math.max(
    1,
    Math.floor(((options.height ?? 40) - 17) / (options.preview ? 4 : 3)),
  );
  const cursor = Math.max(
    0,
    rows.findIndex((worker) => worker.worker_id === options.cursor),
  );
  const start = Math.floor(cursor / pageSize) * pageSize;
  const summary = retentionSummary(workers, now);
  const lines = [
    options.preview
      ? `CLEANUP PREVIEW  ${rows.length} selected workers`
      : `RETAINED VMS  ${summary.count} · ${summary.candidates} cleanup candidates · ${selected.size} selected`,
    "Age is worker age; idle is time since its latest recorded activity.",
    "Only settled workers with preserved outputs can be selected. Git safety is checked on destruction.",
    "",
  ];
  if (!options.preview && options.filterLabel)
    lines.splice(
      1,
      0,
      `VIEW  ${rows.length} retained workers match · ${options.filterLabel}`,
    );
  if (!rows.length) lines.push("  No matching retained VMs");
  for (const worker of rows.slice(start, start + pageSize)) {
    const readiness = cleanupReadiness(worker);
    lines.push(
      `${worker.worker_id === options.cursor ? "›" : " "} ${selected.has(worker.worker_id) ? "[x]" : "[ ]"} ${worker.worker_id}  ${worker.team_id} / ${worker.task_id}`,
      `    ${worker.state} · age ${duration(now - worker.created_at)} · idle ${duration(now - worker.last_activity_at)} · outputs ${worker.finalization?.state ?? "none"}`,
      `    ${options.outcomes?.find((outcome) => outcome.worker_id === worker.worker_id)?.message ?? readiness.reason}`,
    );
    if (options.preview) lines.push(`    VM: ${worker.vm_id}`);
  }
  if (rows.length > pageSize)
    lines.push(
      `  Page ${Math.floor(start / pageSize) + 1}/${Math.ceil(rows.length / pageSize)} · ↑/↓ to browse`,
    );
  if (options.outcomes?.length) {
    const totals = Object.fromEntries(
      ["destroyed", "blocked", "skipped", "failed"].map((state) => [
        state,
        options.outcomes!.filter((outcome) => outcome.state === state).length,
      ]),
    );
    lines.push(
      "",
      `LAST CLEANUP  ${totals.destroyed} destroyed · ${totals.blocked} blocked · ${totals.skipped} skipped · ${totals.failed} failed`,
    );
  }
  lines.push(
    "",
    options.preview
      ? "y confirm normal destruction · Esc/n return to selection"
      : "↑/↓ browse · Space select · a select eligible · n clear · Enter preview",
    ...(options.preview
      ? []
      : ["i inspect · r refresh · Esc back · q quit", filterShortcuts]),
  );
  return lines
    .map((line) => {
      const safe = Array.from(safeTerminalText(line));
      return safe.length > width
        ? `${safe.slice(0, width - 1).join("")}…`
        : safe.join("");
    })
    .join("\n");
}

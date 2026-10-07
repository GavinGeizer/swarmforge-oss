import { chibiStatus, renderChibi } from "./chibi";
import { duration, retentionSummary } from "./cleanup";
import {
  filterDescription,
  filterShortcuts,
  filterWorkers,
  type WorkerFilters,
  type WorkerSort,
} from "./filters";
import { compactNumber, type OverviewData, visibleWorkers } from "./overview";
import { safeTerminalText } from "./terminal";

export interface FriendlyOptions {
  now?: number;
  color?: boolean;
  width?: number;
  height?: number;
  selectedId?: string;
  filters?: WorkerFilters;
  sort?: WorkerSort;
  connectionError?: boolean;
}
const clip = (value: string, width: number) => {
  const chars = Array.from(safeTerminalText(value));
  return chars.length > width
    ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…`
    : chars.join("");
};
const colorLine = (value: string, color: boolean, code: number) =>
  color ? `\u001b[${code}m${value}\u001b[0m` : value;
const names: Record<string, string> = {
  queued: "queued",
  provisioning: "preparing",
  booting: "starting",
  ready: "ready",
  running: "working",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  paused: "paused",
  destroyed: "cleaned up",
  recovery_required: "needs recovery",
};

/** A read-only, mascot-led overview. Navigation order matches the technical renderer. */
export function renderFriendlyOverview(
  data: OverviewData,
  options: FriendlyOptions = {},
) {
  const now = options.now ?? Date.now();
  const width = Math.max(1, Math.floor(options.width ?? 100));
  const height = Math.max(1, Math.floor(options.height ?? 40));
  const color = options.color ?? false;
  const status = chibiStatus(data, now, options.connectionError);
  const matched = options.filters
    ? filterWorkers(data.workers, options.filters)
    : data.workers;
  const workers = visibleWorkers(matched, options.sort ?? "recent");
  const selected = workers.find(
    (worker) => worker.worker_id === options.selectedId,
  );
  const retained = data.retention ?? retentionSummary(data.workers, now);
  const lines: string[] = [];
  const add = (value: string, code?: number) =>
    lines.push(
      colorLine(clip(value, width), color && code !== undefined, code ?? 0),
    );
  const face =
    status.mood === "error"
      ? "(! !)"
      : status.mood === "excited"
        ? "(^ ^)"
        : status.mood === "sleeping"
          ? "(- -)"
          : "(| |)";
  add(
    `SwarmForge  ·  ${options.connectionError ? "refresh failed" : "connected"}  ·  ${status.mood}`,
    status.mood === "error" ? 91 : 94,
  );
  if (width >= 60 && height >= 24) {
    const mascot = renderChibi(status.mood, color, now);
    const mascotWidth = color ? 24 : 18;
    const gap = 3;
    const contentWidth = width - mascotWidth - gap;
    const panel = contentWidth >= 60;
    const speechWidth = panel ? contentWidth - 28 : contentWidth;
    const messageRows = [
      status.title,
      "",
      status.message,
      "",
      `${status.working} working · ${status.waiting} waiting`,
      `${status.completed} completed · ${status.failed} failed`,
      `${status.preparing} queued / preparing`,
    ];
    const stats = [
      "SWARM STATUS",
      "",
      `Tokens       ${compactNumber(data.tokens.total)}`,
      `Retained VMs ${retained.count}`,
      `Cleanup candidates ${retained.candidates}`,
    ];
    if (
      data.usage?.estimated_usd !== null &&
      data.usage?.estimated_usd !== undefined
    )
      stats.push(
        `USD est. $${data.usage.estimated_usd.toFixed(3)}${data.usage.complete ? "" : " (partial)"}`,
      );
    else stats.push("USD estimate unconfigured");
    stats.push(data.usage?.budget_exceeded ? "Budget threshold reached" : "");
    if (!panel)
      messageRows.push(
        `Tokens ${compactNumber(data.tokens.total)} · Retained VMs ${retained.count}`,
        `Cleanup candidates ${retained.candidates}`,
        data.usage?.budget_exceeded
          ? "Budget threshold reached"
          : data.usage?.estimated_usd == null
            ? "USD estimate unconfigured"
            : `USD est. $${data.usage.estimated_usd.toFixed(3)}${data.usage.complete ? "" : " (partial)"}`,
      );
    const right = panel ? stats : [];
    lines.push("");
    for (
      let index = 0;
      index < Math.max(mascot.length, messageRows.length, right.length);
      index++
    ) {
      const art = mascot[index] ?? " ".repeat(mascotWidth);
      const artWidth = color ? 24 : Array.from(art).length;
      const speech = clip(messageRows[index] ?? "", speechWidth);
      const text = colorLine(
        speech.padEnd(speechWidth),
        color,
        index === 0 ? (status.mood === "error" ? 91 : 93) : 39,
      );
      const metrics = right.length
        ? "  " +
          colorLine(clip(right[index] ?? "", 26), color, index === 0 ? 94 : 39)
        : "";
      lines.push(
        art +
          " ".repeat(Math.max(0, mascotWidth - artWidth) + gap) +
          text +
          metrics,
      );
    }
  } else {
    add(`${face}  ${status.title}`, status.mood === "error" ? 91 : 93);
    add(status.message);
    add(
      `${status.working} working · ${status.waiting} waiting · ${status.completed} done · ${status.failed} failed`,
    );
    add(
      `Tokens ${compactNumber(data.tokens.total)} · Retained VMs ${retained.count} · Cleanup ${retained.candidates}`,
    );
    if (data.usage?.budget_exceeded) add("Budget threshold reached", 91);
  }
  // Active tasks never disappear behind the mascot in a small viewport.
  const footers = [
    width < 45
      ? "Tab view · Enter · q quit"
      : "Tab technical · Enter inspect · q quit",
    width < 65
      ? "↑/↓ select · r refresh"
      : "↑/↓ select · x cleanup · a artifacts · n alerts · r refresh",
  ];
  if (width >= 85) footers.push(filterShortcuts);
  if (options.filters)
    add(
      `VIEW  ${data.page?.total ?? matched.length}/${data.total ?? data.workers.length} · ${filterDescription(options.filters, options.sort ?? "recent")}`,
      90,
    );
  if (data.page)
    add(
      `PAGE ${Math.floor(data.page.offset / data.page.limit) + 1}/${Math.max(1, Math.ceil(data.page.total / data.page.limit))} · [ previous · ] next`,
      90,
    );
  lines.push("");
  add("YOUR TASKS", 94);
  const taskBudget = Math.max(0, height - lines.length - footers.length - 1);
  const focusRows = selected && taskBudget >= 3 ? 2 : 0;
  const available = taskBudget - focusRows;
  const selectedIndex = Math.max(
    0,
    workers.findIndex((worker) => worker.worker_id === options.selectedId),
  );
  const start = available
    ? Math.floor(selectedIndex / available) * available
    : 0;
  if (!workers.length && available)
    add(
      options.filters && Object.values(options.filters).some(Boolean)
        ? "No matching tasks · z resets filters"
        : "No tasks in this view yet.",
    );
  for (const worker of workers.slice(start, start + available)) {
    const prefix = worker.worker_id === options.selectedId ? "›" : " ";
    const label = names[worker.state] ?? worker.state;
    const age = duration(
      now - (worker.completed_at ?? worker.started_at ?? worker.created_at),
    );
    const identity =
      width >= 90
        ? `${worker.team_id} / ${worker.task_id} · ${worker.worker_id}`
        : `${worker.team_id} / ${worker.task_id}`;
    add(
      `${prefix} ${label} · ${age} · ${identity}`,
      worker.worker_id === options.selectedId ? 93 : undefined,
    );
  }
  if (selected && height >= lines.length + footers.length + 3) {
    lines.push("");
    add(
      selected.progress?.activity ??
        selected.progress?.summary ??
        (selected.error
          ? `Needs attention: ${selected.error}`
          : `${selected.task_id} · ${names[selected.state] ?? selected.state} · Enter for details`),
    );
  }
  lines.push("");
  for (const footer of footers) add(footer, 90);
  // Tiny terminals retain the toggle/quit instruction instead of an overflowing table.
  if (lines.length > height) {
    const hint = colorLine(clip(footers[0]!, width), color, 90);
    return [...lines.slice(0, Math.max(0, height - 1)), hint].join("\n");
  }
  return lines.join("\n");
}

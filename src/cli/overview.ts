import type { WorkerFinalization } from "../domain";
import { duration, retainsVm, retentionSummary } from "./cleanup";
import type { WorkerDetail } from "./client";
import {
  filterDescription,
  filterShortcuts,
  filterWorkers,
  sortWorkers,
  type WorkerFilters,
  type WorkerSort,
} from "./filters";
import { safeTerminalText } from "./terminal";

export { safeTerminalText } from "./terminal";

export interface WorkerSummary {
  worker_id: string;
  team_id: string;
  task_id: string;
  role: string;
  state: string;
  created_at: number;
  started_at: number | null;
  last_activity_at: number;
  completed_at: number | null;
  tokens: { total: number };
  error?: string | null;
  finalization?: WorkerFinalization | null;
  vm_id?: string | null;
  vm_missing?: boolean;
  pending_control?: string | null;
  pending_messages?: number;
}

export interface OverviewData {
  url: string;
  metrics: { enabled: boolean; port: number };
  states: Record<string, number>;
  tokens: { total: number };
  workers: WorkerSummary[];
}

const activeStates = new Set([
  "provisioning",
  "booting",
  "ready",
  "running",
  "waiting",
  "paused",
  "recovery_required",
]);
const recentStates = new Set(["completed", "failed", "cancelled", "destroyed"]);
const settledStates = new Set([...recentStates, "recovery_required"]);

export function groupWorkers(workers: WorkerSummary[], order?: WorkerSort) {
  const active = workers.filter((worker) => activeStates.has(worker.state));
  const queued = workers.filter((worker) => worker.state === "queued");
  const recent = workers.filter((worker) => recentStates.has(worker.state));
  return {
    active: order
      ? sortWorkers(active, order)
      : active.sort((a, b) => b.last_activity_at - a.last_activity_at),
    queued: order
      ? sortWorkers(queued, order)
      : queued.sort((a, b) => a.created_at - b.created_at),
    recent: order
      ? sortWorkers(recent, order)
      : recent.sort((a, b) => b.last_activity_at - a.last_activity_at),
  };
}

function count(states: Record<string, number>, names: Set<string>) {
  return [...names].reduce((total, name) => total + (states[name] ?? 0), 0);
}

function compactNumber(value: number) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const amount = value / 1_000;
    return `${amount >= 10 ? Math.round(amount) : Number(amount.toFixed(1))}k`;
  }
  return `${Number((value / 1_000_000).toFixed(1))}m`;
}

function elapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function clipped(text: string, width: number) {
  const chars = [...text];
  return chars.length > width
    ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…`
    : text;
}

function colorFor(state: string) {
  if (["failed", "recovery_required"].includes(state)) return 31;
  if (["completed", "destroyed"].includes(state)) return 32;
  if (["queued", "waiting", "paused", "cancelled"].includes(state)) return 33;
  return 36;
}

function symbolFor(state: string) {
  if (state === "completed") return "✓";
  if (["failed", "recovery_required"].includes(state)) return "!";
  if (state === "queued") return "…";
  if (state === "waiting") return "◉";
  if (state === "destroyed") return "×";
  return "●";
}

export function visibleWorkers(workers: WorkerSummary[], order?: WorkerSort) {
  const groups = groupWorkers(workers, order);
  return [...groups.active, ...groups.queued, ...groups.recent];
}

export function renderOverview(
  data: OverviewData,
  options: {
    now?: number;
    color?: boolean;
    width?: number;
    height?: number;
    selectedId?: string;
    interactive?: boolean;
    filters?: WorkerFilters;
    sort?: WorkerSort;
  } = {},
) {
  const now = options.now ?? Date.now();
  const width = Math.max(30, options.width ?? 100);
  const limits =
    (options.height ?? 40) < 22
      ? ([2, 1, 1] as const)
      : (options.height ?? 40) < 30
        ? ([3, 2, 2] as const)
        : ([8, 8, 5] as const);
  const matching = options.filters
    ? filterWorkers(data.workers, options.filters)
    : data.workers;
  const rowLimits: number[] = [...limits];
  if (options.filters) {
    const rowBudget = Math.max(3, (options.height ?? 40) - 23);
    while (rowLimits.reduce((sum, limit) => sum + limit, 0) > rowBudget) {
      const largest = Math.max(...rowLimits);
      rowLimits[rowLimits.indexOf(largest)] = largest - 1;
    }
  }
  const groups = groupWorkers(matching, options.sort);
  const retention = retentionSummary(data.workers, now);
  const lines = [
    "SwarmForge  ● connected",
    `MCP  ${data.url}     Metrics  ${data.metrics.enabled ? `enabled :${data.metrics.port}` : "disabled"}`,
    `Retained VMs  ${retention.count} · ${retention.candidates} cleanup candidates · oldest worker ${retention.oldest}`,
    `Preservation  ${data.workers.filter((w) => ["pending", "collecting", "failed"].includes(w.finalization?.state ?? "")).length} need attention`,
    `Workers${options.filters ? " (all)" : ""}  ${count(data.states, activeStates)} active · ${data.states.queued ?? 0} queued · ${data.states.completed ?? 0} completed     Tokens  ${compactNumber(data.tokens.total)}`,
  ];
  if (options.filters)
    lines.push(
      `VIEW  ${matching.length}/${data.workers.length} workers · ${filterDescription(options.filters, options.sort ?? "recent")}`,
    );
  if (options.filters && !matching.length)
    lines.push("No matching workers · z resets filters");
  const section = (name: string, workers: WorkerSummary[], limit: number) => {
    lines.push("", name);
    if (!workers.length) {
      lines.push("  None");
      return;
    }
    const selectedIndex = workers.findIndex(
      (worker) => worker.worker_id === options.selectedId,
    );
    const start =
      selectedIndex < limit ? 0 : Math.floor(selectedIndex / limit) * limit;
    if (start) lines.push(`  … ${start} earlier`);
    for (const worker of workers.slice(start, start + limit)) {
      const recent = recentStates.has(worker.state);
      const when = recent
        ? `${elapsed(now - (worker.completed_at ?? worker.last_activity_at))} ago`
        : worker.started_at
          ? elapsed(now - worker.started_at)
          : "";
      const tokenText = worker.tokens.total
        ? `${compactNumber(worker.tokens.total)} tokens`
        : "";
      const id = clipped(worker.worker_id, 12);
      const prefix = options.selectedId === worker.worker_id ? "›" : " ";
      const row = [
        `${prefix} ${symbolFor(worker.state)} ${id.padEnd(12)}`,
        `${worker.team_id} / ${worker.task_id}`,
        worker.state.toUpperCase(),
        when,
        worker.finalization ? `outputs:${worker.finalization.state}` : "",
        tokenText,
      ]
        .filter(Boolean)
        .join("   ");
      const limited = clipped(row, width);
      const symbol = symbolFor(worker.state);
      lines.push(
        options.color
          ? limited.replace(
              symbol,
              `\u001b[${colorFor(worker.state)}m${symbol}\u001b[0m`,
            )
          : limited,
      );
    }
    if (workers.length > start + limit)
      lines.push(`  … ${workers.length - start - limit} more`);
  };
  section("ACTIVE", groups.active, rowLimits[0]!);
  section("QUEUED", groups.queued, rowLimits[1]!);
  section("RECENT", groups.recent, rowLimits[2]!);
  if (options.interactive)
    lines.push(
      "",
      "↑/↓ select · Enter inspect · x cleanup · r refresh · q quit",
      filterShortcuts,
    );
  return lines
    .map((line) => (line.includes("\u001b[") ? line : clipped(line, width)))
    .join("\n");
}

export function renderWorkerDetail(
  detail: WorkerDetail,
  options: { now?: number; width?: number } = {},
) {
  const { worker, result, events } = detail;
  const width = Math.max(30, options.width ?? 100);
  const now = options.now ?? Date.now();
  const started = worker.started_at ?? worker.created_at;
  const lines = [
    `WORKER  ${worker.worker_id}`,
    `${worker.team_id} / ${worker.task_id}     ${worker.state.toUpperCase()}     ${elapsed(now - started)}`,
    `Role  ${worker.role}     Tokens  ${compactNumber(worker.tokens.total)}     Pending messages  ${worker.pending_messages ?? 0}`,
  ];
  if (worker.vm_id)
    lines.push(
      `VM  ${worker.vm_id}${retainsVm(worker) ? " · retained" : worker.vm_missing ? " · missing" : " · destroyed"}`,
    );
  if (retainsVm(worker))
    lines.push(
      `Worker age  ${duration(now - worker.created_at)} · Idle  ${duration(now - worker.last_activity_at)}`,
    );
  if (worker.opencode_session_id)
    lines.push(`Session  ${worker.opencode_session_id}`);
  if (worker.finalization) {
    const f = worker.finalization;
    lines.push(
      "",
      `PRESERVATION  ${f.state.toUpperCase()} · ${f.attempts} attempts`,
    );
    if (f.error) lines.push(`  ${f.error}`);
    if (f.next_retry_at)
      lines.push(`  Next retry: ${new Date(f.next_retry_at).toISOString()}`);
    if (["failed", "pending", "collecting"].includes(f.state))
      lines.push(
        "  VM retained until outputs are preserved; inspect failures before destroying.",
      );
  }
  if (detail.artifacts) {
    lines.push("", "ARTIFACTS");
    if (!detail.artifacts.length) lines.push("  No preserved artifacts yet");
    for (const a of detail.artifacts) {
      lines.push(
        `  ${a.filename} · ${a.state} · ${a.size ?? "?"} bytes`,
        `    ID: ${a.artifact_id}`,
      );
      if (a.sha256) lines.push(`    SHA256: ${a.sha256}`);
      if (a.state === "preserved")
        lines.push(
          `    Download: /artifacts/${encodeURIComponent(a.artifact_id)}/download (server authentication required)`,
        );
    }
    if (detail.artifactsNextOffset != null)
      lines.push(
        `  More artifacts: list_artifacts offset=${detail.artifactsNextOffset}`,
      );
  }
  if (worker.error) lines.push("", `ERROR  ${worker.error}`);
  if (worker.excerpt && !settledStates.has(worker.state)) {
    const age = worker.excerpt_at
      ? elapsed(now - worker.excerpt_at)
      : "unknown";
    const safeExcerpt = safeTerminalText(worker.excerpt);
    const chars = [...safeExcerpt];
    const available = Math.max(1, width - 2);
    const visible =
      chars.length > available
        ? `…${chars.slice(-(available - 1)).join("")}`
        : safeExcerpt;
    lines.push(
      "",
      `RESPONSE  ${worker.excerpt_partial ? "partial" : "latest reply"} · ${age} ago`,
      `  ${visible}`,
    );
  }
  lines.push("", "RESULT", result?.summary ?? "  No result yet");
  if (result?.warnings?.length)
    for (const warning of result.warnings.slice(0, 3))
      lines.push(`  Warning: ${warning}`);
  lines.push("", "TIMELINE");
  if (!events.length) lines.push("  No events yet");
  for (const event of events.slice(-8)) {
    const time = new Date(event.at).toISOString().slice(11, 19);
    lines.push(`  ${time}  ${event.type.replace(/^worker\./, "")}`);
  }
  if (detail.serviceLog) {
    lines.push("", "OPENCODE LOG");
    lines.push(
      ...detail.serviceLog
        .trim()
        .split("\n")
        .slice(-4)
        .map((line) => `  ${line}`),
    );
  }
  lines.push(
    "",
    `${[...availableActions(worker.state), ...(canRetryPreservation(worker) ? ["f retry preservation"] : [])].join(" · ")} · Esc back · q quit`,
  );
  return lines.map((line) => clipped(safeTerminalText(line), width)).join("\n");
}

export function availableActions(state: string) {
  if (state === "destroyed") return [];
  if (state === "paused") return ["u resume", "c cancel", "d destroy"];
  if (["ready", "running", "waiting"].includes(state))
    return ["p pause", "c cancel", "d destroy"];
  if (["queued", "provisioning", "booting"].includes(state))
    return ["c cancel", "d destroy"];
  return ["d destroy"];
}

export function canRetryPreservation(worker: WorkerSummary) {
  return (
    worker.state !== "destroyed" &&
    !!worker.vm_id &&
    !worker.vm_missing &&
    ["failed", "pending"].includes(worker.finalization?.state ?? "")
  );
}

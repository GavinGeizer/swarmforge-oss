import type { WorkerDetail } from "./client";

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

export function groupWorkers(workers: WorkerSummary[]) {
  return {
    active: workers
      .filter((worker) => activeStates.has(worker.state))
      .sort((a, b) => b.last_activity_at - a.last_activity_at),
    queued: workers
      .filter((worker) => worker.state === "queued")
      .sort((a, b) => a.created_at - b.created_at),
    recent: workers
      .filter((worker) => recentStates.has(worker.state))
      .sort((a, b) => b.last_activity_at - a.last_activity_at),
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

export function safeTerminalText(text: string) {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 27) {
      const marker = text[index + 1];
      index += 2;
      if (marker === "[") {
        while (index < text.length) {
          const part = text.charCodeAt(index++);
          if (part >= 64 && part <= 126) break;
        }
      } else if (marker === "]") {
        while (index < text.length) {
          const part = text.charCodeAt(index++);
          if (part === 7) break;
          if (part === 27 && text[index] === "\\") {
            index++;
            break;
          }
        }
      }
      continue;
    }
    if (code >= 32 && code !== 127 && (code < 128 || code > 159))
      result += text[index];
    index++;
  }
  return result;
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

export function visibleWorkers(workers: WorkerSummary[]) {
  const groups = groupWorkers(workers);
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
  const groups = groupWorkers(data.workers);
  const lines = [
    "SwarmForge  ● connected",
    `MCP  ${data.url}     Metrics  ${data.metrics.enabled ? `enabled :${data.metrics.port}` : "disabled"}`,
    `Workers  ${count(data.states, activeStates)} active · ${data.states.queued ?? 0} queued · ${data.states.completed ?? 0} completed     Tokens  ${compactNumber(data.tokens.total)}`,
  ];
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
  section("ACTIVE", groups.active, limits[0]);
  section("QUEUED", groups.queued, limits[1]);
  section("RECENT", groups.recent, limits[2]);
  if (options.interactive)
    lines.push("", "↑/↓ select · Enter inspect · r refresh · q quit");
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
  if (worker.vm_id) lines.push(`VM  ${worker.vm_id}`);
  if (worker.opencode_session_id)
    lines.push(`Session  ${worker.opencode_session_id}`);
  if (worker.error) lines.push("", `ERROR  ${worker.error}`);
  if (worker.excerpt && !settledStates.has(worker.state)) {
    const age = worker.excerpt_at
      ? elapsed(now - worker.excerpt_at)
      : "unknown";
    lines.push(
      "",
      `RESPONSE  ${worker.excerpt_partial ? "partial" : "latest reply"} · ${age} ago`,
      `  ${worker.excerpt}`,
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
    `${availableActions(worker.state).join(" · ")} · Esc back · q quit`,
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

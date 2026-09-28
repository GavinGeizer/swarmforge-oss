import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Coordinator } from "./coordinator";
import type { WorkerEvent } from "./domain";
import { redactorFor } from "./security";

type Color = "green" | "blue" | "yellow" | "red" | "magenta" | "cyan" | "gray";
const ansi: Record<Color, string> = {
  green: "32",
  blue: "34",
  yellow: "33",
  red: "31",
  magenta: "35",
  cyan: "36",
  gray: "90",
};
const colorEnabled = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
export function renderStartup(
  info: {
    host: string;
    port: number;
    metricsEnabled: boolean;
    metricsPort: number;
  },
  terminal: boolean,
) {
  if (!terminal)
    return JSON.stringify({
      level: "info",
      message: "SwarmForge listening",
      host: info.host,
      port: info.port,
      metrics_enabled: info.metricsEnabled,
      metrics_port: info.metricsEnabled ? info.metricsPort : null,
    });
  const host = info.host === "0.0.0.0" ? "127.0.0.1" : info.host;
  return [
    "SwarmForge  ● listening",
    `MCP       http://${host}:${info.port}/mcp`,
    `Metrics   ${info.metricsEnabled ? `enabled :${info.metricsPort}` : "disabled"}`,
    "Overview  bun run status",
  ].join("\n");
}
export function colorForEvent(type: string): Color {
  if (type === "worker.destroyed") return "magenta";
  if (["worker.failed", "worker.recovery_required"].includes(type))
    return "red";
  if (
    ["worker.requested", "worker.completed", "result.received"].includes(type)
  )
    return "cyan";
  if (["worker.waiting", "worker.paused", "worker.cancelled"].includes(type))
    return "yellow";
  if (["worker.running", "worker.resumed"].includes(type)) return "blue";
  return "green";
}
export function renderEvent(
  event: Pick<WorkerEvent, "type" | "at" | "data">,
  worker: {
    worker_id: string;
    team_id?: string;
    task_id?: string;
    vm_id?: string | null;
    error?: string | null;
  },
  color = colorEnabled,
): string {
  const paint = (c: Color, t: string) =>
    color ? `\u001b[${ansi[c]}m${t}\u001b[0m` : t;
  const time = new Date(event.at).toISOString().slice(11, 19);
  const where =
    worker.team_id && worker.task_id
      ? `${worker.team_id}/${worker.task_id}`
      : "";
  let detail = event.data;
  try {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    detail = Object.keys(data).length ? JSON.stringify(data) : "";
  } catch {}
  if (worker.error) detail = `${detail} ${worker.error}`.trim();
  return [
    paint("gray", time),
    paint(colorForEvent(event.type), event.type.replace(/^worker\./, "")),
    worker.worker_id,
    where,
    worker.vm_id ? `vm=${worker.vm_id}` : "",
    detail,
  ]
    .filter(Boolean)
    .join("  ");
}
export function acquireProcessLock(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const claim = () => {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    claim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid database lock; inspect it before removing");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("Another SwarmForge process owns this database");
    unlinkSync(path);
    claim();
  }
  return () => {
    if (existsSync(path) && readFileSync(path, "utf8") === String(process.pid))
      unlinkSync(path);
  };
}
export function eventLogger(c: Coordinator, path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let after = Number(c.store.setting("logged_event") ?? 0);
  const redactor = redactorFor(c);
  return () => {
    for (const event of c.store.events(undefined, after, 100)) {
      const w = c.store.get(event.worker_id);
      const meta = {
        team_id: w.team_id,
        task_id: w.task_id,
        vm_id: w.vm_id,
        session_id: w.opencode_session_id,
      };
      const safe = redactor.value({
        ...meta,
        worker_id: event.worker_id,
        error: w.error,
      }) as {
        worker_id: string;
        team_id?: string;
        task_id?: string;
        vm_id?: string | null;
        error?: string | null;
      };
      console.log(renderEvent(event, safe));
      const line = JSON.stringify(
        redactor.value({
          ...event,
          ...meta,
        }),
      );
      if (
        existsSync(path) &&
        statSync(path).size + Buffer.byteLength(line) > 1048576
      )
        renameSync(path, `${path}.1`);
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
      after = event.id;
      c.store.setting("logged_event", String(after));
    }
  };
}

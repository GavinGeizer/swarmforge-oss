import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  groupWorkers,
  renderOverview,
  renderWorkerDetail,
  visibleWorkers,
} from "../src/cli/overview";
import { runDashboard } from "../src/cli/tui";

const now = Date.UTC(2026, 8, 28, 12, 0, 0);
const workers = [
  {
    worker_id: "w-running-12345678",
    team_id: "backend",
    task_id: "auth-refresh",
    role: "coder",
    state: "running",
    created_at: now - 300_000,
    started_at: now - 252_000,
    last_activity_at: now - 1_000,
    completed_at: null,
    tokens: { total: 32_000 },
  },
  {
    worker_id: "w-queued-12345678",
    team_id: "platform",
    task_id: "cache-cleanup",
    role: "coder",
    state: "queued",
    created_at: now - 60_000,
    started_at: null,
    last_activity_at: now - 60_000,
    completed_at: null,
    tokens: { total: 0 },
  },
  {
    worker_id: "w-completed-12345678",
    team_id: "backend",
    task_id: "api-pagination",
    role: "coder",
    state: "completed",
    created_at: now - 900_000,
    started_at: now - 800_000,
    last_activity_at: now - 360_000,
    completed_at: now - 360_000,
    tokens: { total: 10_000 },
  },
  {
    worker_id: "w-failed-12345678",
    team_id: "data",
    task_id: "export-fix",
    role: "coder",
    state: "failed",
    created_at: now - 2_000_000,
    started_at: now - 1_900_000,
    last_activity_at: now - 1_260_000,
    completed_at: now - 1_260_000,
    tokens: { total: 5_000 },
  },
] as const;

test("overview groups live workers and sorts recent terminal workers by activity", () => {
  const groups = groupWorkers([...workers].reverse());
  expect(groups.active.map((worker) => worker.worker_id)).toEqual([
    "w-running-12345678",
  ]);
  expect(groups.queued.map((worker) => worker.worker_id)).toEqual([
    "w-queued-12345678",
  ]);
  expect(groups.recent.map((worker) => worker.worker_id)).toEqual([
    "w-completed-12345678",
    "w-failed-12345678",
  ]);
});

test("plain overview shows connection, counts, tasks and token totals", () => {
  const view = renderOverview(
    {
      url: "http://127.0.0.1:8787/mcp",
      metrics: { enabled: true, port: 9090 },
      states: { running: 1, queued: 1, completed: 1, failed: 1 },
      tokens: { total: 184_000 },
      workers: [...workers],
    },
    { now, color: false, width: 100 },
  );
  expect(view).toContain("SwarmForge  ● connected");
  expect(view).toContain("MCP  http://127.0.0.1:8787/mcp");
  expect(view).toContain("Metrics  enabled :9090");
  expect(view).toContain("1 active · 1 queued · 1 completed");
  expect(view).toContain("Tokens  184k");
  expect(view).toContain("backend / auth-refresh");
  expect(view).toContain("RECENT");
  expect(view).not.toContain("\u001b[");
});

test("worker inspection shows the result and lifecycle events with valid actions", () => {
  const view = renderWorkerDetail(
    {
      worker: {
        ...workers[2],
        vm_id: "vm-1",
        opencode_session_id: "ses-1",
        pending_messages: 0,
      },
      result: { status: "completed", summary: "Updated API pagination" },
      events: [
        { id: 1, type: "worker.running", at: now - 500_000, data: "{}" },
        { id: 2, type: "worker.completed", at: now - 360_000, data: "{}" },
      ],
      serviceLog: null,
    },
    { now, width: 100 },
  );
  expect(view).toContain("backend / api-pagination");
  expect(view).toContain("Updated API pagination");
  expect(view).toContain("running");
  expect(view).toContain("completed");
  expect(view).toContain("d destroy");
  expect(view).not.toContain("p pause");
});

test("worker text cannot inject terminal control sequences", () => {
  const view = renderWorkerDetail({
    worker: workers[2]!,
    result: {
      status: "completed",
      summary: "Finished\u001b[2J\u001b]0;spoofed title\u0007 safely",
    },
    events: [],
    serviceLog: "tool output\u001b[31m red",
  });
  expect(view).toContain("Finished safely");
  expect(view).toContain("tool output red");
  expect(view).not.toContain("\u001b");
});

test("selection reveals workers beyond the first overview page", () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    ...workers[0]!,
    worker_id: `w-worker-${index}`,
    task_id: `task-${index}`,
    last_activity_at: now - index * 1_000,
  }));
  expect(visibleWorkers(many)).toHaveLength(10);
  const view = renderOverview(
    {
      url: "http://127.0.0.1:8787/mcp",
      metrics: { enabled: true, port: 9090 },
      states: { running: 10 },
      tokens: { total: 0 },
      workers: many,
    },
    { selectedId: "w-worker-9", now, width: 100 },
  );
  expect(view).toContain("task-9");
  expect(view).toContain("earlier");
});

test("interactive overview inspects workers and confirms destruction", async () => {
  const data = {
    url: "http://127.0.0.1:8787/mcp",
    metrics: { enabled: true, port: 9090 },
    states: { running: 1 },
    tokens: { total: 32_000 },
    workers: [workers[0]!],
  };
  const detail = {
    worker: workers[0]!,
    result: { status: "completed", summary: "Worker result is visible" },
    events: [{ id: 1, type: "worker.running", at: now, data: "{}" }],
    serviceLog: null,
  };
  const chunks: string[] = [];
  const raw: boolean[] = [];
  const controls: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    setRawMode: (value: boolean) => raw.push(value),
    resume: () => {},
    pause: () => {},
  }) as unknown as typeof process.stdin;
  const output = Object.assign(new EventEmitter(), {
    columns: 100,
    write: (value: string) => {
      chunks.push(value);
      return true;
    },
  }) as unknown as typeof process.stdout;
  const client = {
    overview: async () => data,
    inspect: async () => detail,
    control: async (_id: string, action: string) => {
      controls.push(action);
      return workers[0]!;
    },
    close: async () => {},
  } as unknown as Parameters<typeof runDashboard>[0];
  const session = runDashboard(client, data, input, output);
  input.emit("keypress", "", { name: "return" });
  await Bun.sleep(0);
  expect(chunks.join("")).toContain("Worker result is visible");
  input.emit("keypress", "", { name: "d" });
  expect(controls).toEqual([]);
  input.emit("keypress", "", { name: "n" });
  input.emit("keypress", "", { name: "d" });
  input.emit("keypress", "", { name: "y" });
  await Bun.sleep(0);
  expect(controls).toEqual(["destroy"]);
  input.emit("keypress", "", { name: "q" });
  await session;
  expect(raw).toEqual([true, false]);
  expect(chunks.at(-1)).toContain("\u001b[?1049l");
});

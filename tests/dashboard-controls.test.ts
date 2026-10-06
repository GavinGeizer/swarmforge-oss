import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { connectSwarmForge, WorkerDetail } from "../src/cli/client";
import type { OverviewData, WorkerSummary } from "../src/cli/overview";
import { runDashboard } from "../src/cli/tui";
import { harness, task } from "./helpers";

const worker = (id: string, team: string): WorkerSummary => ({
  worker_id: id,
  team_id: team,
  task_id: id,
  role: "coder",
  state: "completed",
  created_at: 1,
  last_activity_at: 1,
  completed_at: 1,
  started_at: 1,
  tokens: { total: 0 },
  vm_id: `vm-${id}`,
  pending_messages: 0,
  finalization: {
    state: "preserved",
    run_id: null,
    attempts: 1,
    error: null,
    next_retry_at: null,
    started_at: null,
    completed_at: 1,
  },
});
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
async function dashboard() {
  const workers = [worker("worker-a", "a"), worker("worker-b", "b")];
  const data: OverviewData = {
    url: "local",
    metrics: { enabled: false, port: 0 },
    states: { completed: 2 },
    tokens: { total: 0 },
    workers,
  };
  const frames: string[] = [];
  const calls: string[] = [];
  let finish!: () => void;
  let block = false;
  let interrupted = false;
  const client = {
    overview: async () => data,
    worker: async (id: string) => workers.find((w) => w.worker_id === id)!,
    inspect: async (id: string): Promise<WorkerDetail> => ({
      worker: workers.find((w) => w.worker_id === id)!,
      result: null,
      events: [],
      serviceLog: null,
    }),
    control: async (
      id: string,
      _action: string,
      options: { settledOnly?: boolean },
    ) => {
      expect(options.settledOnly).toBe(true);
      calls.push(id);
      if (interrupted) throw new Error("request interrupted");
      if (block)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return {
        ...workers.find((w) => w.worker_id === id)!,
        state: "destroyed",
      };
    },
  } as unknown as Awaited<ReturnType<typeof connectSwarmForge>>;
  const input = Object.assign(new EventEmitter(), {
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
  }) as unknown as typeof process.stdin;
  const output = Object.assign(new EventEmitter(), {
    columns: 140,
    rows: 50,
    write: (text: string) => {
      frames.push(text);
      return true;
    },
  }) as unknown as typeof process.stdout;
  const session = runDashboard(client, data, input, output, 60000);
  const key = (name: string, text = "") =>
    input.emit("keypress", text, { name });
  return {
    workers,
    frames,
    calls,
    key,
    block: () => {
      block = true;
    },
    interrupt: () => {
      interrupted = true;
    },
    release: () => finish?.(),
    close: async () => {
      key("q");
      await session;
    },
  };
}

test("changing filters removes hidden cleanup selections and preview remains frozen", async () => {
  const d = await dashboard();
  try {
    d.key("x");
    d.key("a");
    d.key("t");
    d.key("a", "a");
    d.key("return");
    d.key("return");
    expect(d.frames.at(-1)).toContain("1 selected workers");
    d.key("z");
    expect(d.frames.at(-1)).toContain("1 selected workers");
    d.key("y");
    await wait(() => d.calls.length === 1);
    expect(d.calls).toEqual(["worker-a"]);
  } finally {
    await d.close();
  }
});

test("changed eligibility is skipped and duplicate confirmation/quit starts no additional request", async () => {
  const d = await dashboard();
  try {
    d.key("x");
    d.key("a");
    d.key("return");
    d.workers[0]!.state = "running";
    d.block();
    d.key("y");
    await wait(() => d.calls.length === 1);
    d.key("y");
    expect(d.calls).toEqual(["worker-b"]);
    await d.close();
    d.release();
    await Bun.sleep(20);
    expect(d.calls).toEqual(["worker-b"]);
  } finally {
    d.release();
    await d.close();
  }
});

test("server atomically rejects a worker activated after preview without recording destruction", async () => {
  const h = harness();
  const w = h.store.create({ ...task, timeout_seconds: 60 });
  h.store.patch(w.worker_id, { vm_id: "vm", state: "running" });
  try {
    await expect(
      h.coordinator.control(w.worker_id, "destroy", false, true),
    ).rejects.toThrow("active or paused");
    expect(h.store.get(w.worker_id).intent).toBeNull();
  } finally {
    await h.coordinator.stop();
    h.store.close();
  }
});

test("interrupted requests are reported as failures and are never force-retried", async () => {
  const d = await dashboard();
  try {
    d.interrupt();
    d.key("x");
    d.key("a");
    d.key("return");
    d.key("y");
    await wait(() =>
      d.frames.some((frame) => frame.includes("2 failed requests")),
    );
    expect(d.calls).toEqual(["worker-a", "worker-b"]);
    expect(d.frames.at(-1)?.split("Cleanup finished:")[1]).not.toContain(
      "retained",
    );
  } finally {
    await d.close();
  }
});

test("quitting during the first cleanup request never starts the next selected worker", async () => {
  const d = await dashboard();
  try {
    d.block();
    d.key("x");
    d.key("a");
    d.key("return");
    d.key("y");
    await wait(() => d.calls.length === 1);
    d.key("y");
    await d.close();
    d.release();
    await Bun.sleep(20);
    expect(d.calls).toEqual(["worker-a"]);
  } finally {
    d.release();
    await d.close();
  }
});

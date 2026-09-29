import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Coordinator } from "../src/coordinator";
import { createHttpHandler } from "../src/http";
import { createMcpServer } from "../src/mcp";
import { Store } from "../src/store";
import {
  config,
  FakeAgent,
  FakeProvider,
  harness,
  runToRunning,
  task,
} from "./helpers";

const keys = [
  "at",
  "changed",
  "event_id",
  "next_cursor",
  "state",
  "task_id",
  "team_id",
  "vm_id",
  "worker_id",
];
async function listening(h: { store: Store }, expected: number) {
  for (let i = 0; i < 200 && h.store.listenerCount < expected; i++)
    await Bun.sleep(5);
  return h.store.listenerCount;
}

test("a wait returns the next lifecycle transition with ownership, VM and event identity", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  const pending = h.coordinator.waitForStateChange(
    { worker_id: w.worker_id },
    { timeoutMs: 5000 },
  );
  expect(await listening(h, 1)).toBe(1);
  h.store.transition(w.worker_id, "provisioning");
  const out = await pending;
  expect(out).toMatchObject({
    changed: true,
    worker_id: w.worker_id,
    team_id: "team",
    task_id: "task",
    vm_id: null,
    state: "provisioning",
  });
  expect(out.event_id).toBe(h.store.events(w.worker_id, 0, 10).at(-1)!.id);
  expect(out.next_cursor).toBe(out.event_id!);
  expect(out.at).toBeGreaterThan(0);
  // Lifecycle metadata only: no event payload, prompt, or guest power state.
  expect(Object.keys(out).sort()).toEqual(keys);
  expect(JSON.stringify(out)).not.toContain(task.prompt);
  expect(h.store.listenerCount).toBe(0);
  h.store.close();
});

test("a state filter ignores intermediate transitions and reports the matching one", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  const pending = h.coordinator.waitForStateChange(
    { worker_id: w.worker_id, states: ["ready"] },
    { timeoutMs: 5000 },
  );
  expect(await listening(h, 1)).toBe(1);
  h.store.transition(w.worker_id, "provisioning");
  h.store.transition(w.worker_id, "booting");
  h.store.transition(w.worker_id, "ready");
  const out = await pending;
  expect(out.state).toBe("ready");
  expect(out.event_id).toBe(h.store.events(w.worker_id, 0, 10).at(-1)!.id);
  expect(h.store.listenerCount).toBe(0);
  h.store.close();
});

test("task and team filters ignore other lifecycles and leave their events replayable", async () => {
  const h = harness();
  const a = h.coordinator.spawn(task);
  const b = h.coordinator.spawn({ ...task, task_id: "other" });
  const c = h.coordinator.spawn({
    ...task,
    team_id: "other-team",
    task_id: "elsewhere",
  });
  const base = h.store.latestEventId();
  const pending = h.coordinator.waitForStateChange(
    { task_id: "task" },
    { timeoutMs: 5000 },
  );
  expect(await listening(h, 1)).toBe(1);
  h.store.transition(b.worker_id, "provisioning");
  h.store.transition(c.worker_id, "provisioning");
  h.store.transition(a.worker_id, "provisioning");
  const out = await pending;
  expect(out).toMatchObject({
    changed: true,
    worker_id: a.worker_id,
    team_id: "team",
    task_id: "task",
    state: "provisioning",
  });
  // A filtered wait never consumes another filter's events.
  const other = await h.coordinator.waitForStateChange(
    { task_id: "other", cursor: base },
    { timeoutMs: 0 },
  );
  expect(other).toMatchObject({
    changed: true,
    worker_id: b.worker_id,
    state: "provisioning",
  });
  const team = await h.coordinator.waitForStateChange(
    { team_id: "other-team", cursor: base },
    { timeoutMs: 0 },
  );
  expect(team).toMatchObject({ changed: true, worker_id: c.worker_id });
  h.store.close();
});

test("a cursor replays the first matching event after it in event order", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const ids = h.store.events(w.worker_id, 0, 50).map((e) => e.id);
  const first = await h.coordinator.waitForStateChange(
    { worker_id: w.worker_id, states: ["queued"], cursor: 0 },
    { timeoutMs: 0 },
  );
  // A creation event is reported as the queued transition it always is.
  expect(first).toMatchObject({ changed: true, state: "queued" });
  expect(first.event_id).toBe(ids[0]!);
  const next = await h.coordinator.waitForStateChange(
    { worker_id: w.worker_id, cursor: first.event_id! },
    { timeoutMs: 0 },
  );
  expect(next).toMatchObject({ changed: true, state: "provisioning" });
  expect(next.event_id).toBe(ids[1]!);
  const drained = await h.coordinator.waitForStateChange(
    { worker_id: w.worker_id, cursor: h.store.latestEventId() },
    { timeoutMs: 0 },
  );
  expect(drained.changed).toBe(false);
  h.store.close();
});

test("an expired wait reports no change and the cursor it consumed", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  h.store.transition(w.worker_id, "provisioning");
  const expired = await h.coordinator.waitForStateChange(
    { worker_id: w.worker_id, states: ["ready"] },
    { timeoutMs: 50 },
  );
  expect(expired).toEqual({
    changed: false,
    event_id: null,
    next_cursor: h.store.latestEventId(),
    worker_id: null,
    team_id: null,
    task_id: null,
    vm_id: null,
    state: null,
    at: null,
  });
  const immediate = await h.coordinator.waitForStateChange(
    { worker_id: w.worker_id, states: ["ready"] },
    { timeoutMs: 0 },
  );
  expect(immediate).toEqual(expired);
  expect(h.store.listenerCount).toBe(0);
  h.store.close();
});

test("concurrent waiters wake independently without touching the provider", async () => {
  const h = harness();
  const a = h.coordinator.spawn(task);
  const b = h.coordinator.spawn({ ...task, task_id: "other" });
  const refuse = async () => {
    throw new Error("waiting must not call the provider or the agent");
  };
  const offline = h.provider as unknown as Record<string, unknown>;
  for (const method of [
    "createWorker",
    "getWorker",
    "listWorkers",
    "prepare",
    "pushBranch",
    "pauseWorker",
    "resumeWorker",
    "destroyWorker",
    "exec",
    "readFile",
    "writeFile",
  ])
    offline[method] = refuse;
  const silent = h.agent as unknown as Record<string, unknown>;
  for (const method of ["ensureSession", "submit", "inspect", "abort"])
    silent[method] = refuse;
  const first = h.coordinator.waitForStateChange(
    { worker_id: a.worker_id },
    { timeoutMs: 5000 },
  );
  const second = h.coordinator.waitForStateChange(
    { worker_id: b.worker_id },
    { timeoutMs: 5000 },
  );
  expect(await listening(h, 2)).toBe(2);
  h.store.transition(a.worker_id, "provisioning");
  expect(await first).toMatchObject({ worker_id: a.worker_id });
  expect(
    await Promise.race([
      second.then(() => "resolved"),
      Bun.sleep(30).then(() => "parked"),
    ]),
  ).toBe("parked");
  h.store.transition(b.worker_id, "provisioning");
  expect(await second).toMatchObject({ worker_id: b.worker_id });
  expect(h.store.listenerCount).toBe(0);
  h.store.close();
});

test("a parked wait holds no worker lock and still sees a control transition", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  const pending = h.coordinator.waitForStateChange(
    { worker_id: w.worker_id, states: ["paused"] },
    { timeoutMs: 5000 },
  );
  expect(await listening(h, 1)).toBe(1);
  expect((await h.coordinator.control(w.worker_id, "pause")).state).toBe(
    "paused",
  );
  expect(await pending).toMatchObject({
    changed: true,
    state: "paused",
    worker_id: w.worker_id,
  });
  expect(h.store.listenerCount).toBe(0);
  h.store.close();
});

test("an aborted wait releases its listener and reports the abort", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  const controller = new AbortController();
  const pending = h.coordinator.waitForStateChange(
    { worker_id: w.worker_id },
    { timeoutMs: 5000, signal: controller.signal },
  );
  expect(await listening(h, 1)).toBe(1);
  controller.abort();
  await expect(pending).rejects.toThrow(/aborted/i);
  expect(h.store.listenerCount).toBe(0);
  const stale = new AbortController();
  stale.abort();
  await expect(
    h.coordinator.waitForStateChange(
      { worker_id: w.worker_id },
      { timeoutMs: 0, signal: stale.signal },
    ),
  ).rejects.toThrow(/aborted/i);
  expect(h.store.listenerCount).toBe(0);
  // The store still wakes a later waiter.
  const next = h.coordinator.waitForStateChange(
    { worker_id: w.worker_id },
    { timeoutMs: 5000 },
  );
  expect(await listening(h, 1)).toBe(1);
  h.store.transition(w.worker_id, "provisioning");
  expect(await next).toMatchObject({ changed: true, state: "provisioning" });
  h.store.close();
});

test("cursors survive a restart on a reopened database", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-wait-"));
  const path = join(root, "db.sqlite");
  let store = new Store(path);
  try {
    const c = new Coordinator(
      config,
      store,
      new FakeProvider(),
      new FakeAgent(),
    );
    const w = c.spawn(task);
    await c.tick();
    const latest = store.latestEventId();
    const ids = store.events(w.worker_id, 0, 50).map((e) => e.id);
    store.close();
    store = new Store(path);
    const reopened = new Coordinator(
      config,
      store,
      new FakeProvider(),
      new FakeAgent(),
    );
    expect(store.latestEventId()).toBe(latest);
    const first = await reopened.waitForStateChange(
      { worker_id: w.worker_id, cursor: 0 },
      { timeoutMs: 0 },
    );
    expect(first).toMatchObject({ changed: true, state: "queued" });
    expect(first.event_id).toBe(ids[0]!);
    const resumed = await reopened.waitForStateChange(
      { worker_id: w.worker_id, cursor: first.event_id! },
      { timeoutMs: 0 },
    );
    expect(resumed).toMatchObject({ changed: true, state: "provisioning" });
    expect(resumed.next_cursor).toBeGreaterThan(first.event_id!);
    const ahead = await reopened.waitForStateChange(
      { worker_id: w.worker_id, cursor: latest },
      { timeoutMs: 0 },
    );
    expect(ahead.changed).toBe(false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the MCP wait tool is read-only, bounded and returns durable transitions", async () => {
  const h = harness();
  const server = createMcpServer(h.coordinator);
  const client = new Client({ name: "lead", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "wait_for_state_change");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(tool?.inputSchema)).toContain("timeout_ms");
    const w = h.coordinator.spawn(task);
    const pending = client.callTool({
      name: "wait_for_state_change",
      arguments: {
        worker_id: w.worker_id,
        states: ["ready"],
        cursor: h.store.latestEventId(),
        timeout_ms: 5000,
      },
    });
    expect(await listening(h, 1)).toBe(1);
    await runToRunning(h, w.worker_id);
    const payload = (await pending).structuredContent as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      changed: true,
      state: "ready",
      worker_id: w.worker_id,
      team_id: "team",
      task_id: "task",
      vm_id: h.store.get(w.worker_id).vm_id,
    });
    expect(Object.keys(payload).sort()).toEqual(keys);
    expect(JSON.stringify(payload)).not.toContain(task.prompt);
    const idle = await client.callTool({
      name: "wait_for_state_change",
      arguments: {
        worker_id: w.worker_id,
        states: ["failed"],
        cursor: h.store.latestEventId(),
        timeout_ms: 0,
      },
    });
    expect(idle.structuredContent).toMatchObject({
      changed: false,
      event_id: null,
      state: null,
    });
    const tooLong = await client.callTool({
      name: "wait_for_state_change",
      arguments: { timeout_ms: 25001 },
    });
    expect(tooLong.isError).toBe(true);
    const unknownState = await client.callTool({
      name: "wait_for_state_change",
      arguments: { states: ["hibernating"] },
    });
    expect(unknownState.isError).toBe(true);
    expect(h.store.listenerCount).toBe(0);
  } finally {
    await client.close();
    await server.close();
    h.store.close();
  }
});

test("the HTTP transport wakes a parked wait and releases it when the request aborts", async () => {
  const h = harness();
  const handler = createHttpHandler(h.coordinator);
  const w = h.coordinator.spawn(task);
  const call = (arguments_: Record<string, unknown>, signal?: AbortSignal) =>
    handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wait_for_state_change", arguments: arguments_ },
        }),
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      }),
    );
  const woken = call({
    worker_id: w.worker_id,
    states: ["provisioning"],
    timeout_ms: 20000,
  });
  expect(await listening(h, 1)).toBe(1);
  h.store.transition(w.worker_id, "provisioning");
  const payload = (await (await woken).json()) as {
    result: { structuredContent: Record<string, unknown> };
  };
  expect(payload.result.structuredContent).toMatchObject({
    changed: true,
    state: "provisioning",
    worker_id: w.worker_id,
  });
  expect(h.store.listenerCount).toBe(0);
  const controller = new AbortController();
  const dropped = call(
    { worker_id: w.worker_id, states: ["completed"], timeout_ms: 20000 },
    controller.signal,
  );
  expect(await listening(h, 1)).toBe(1);
  controller.abort();
  const aborted = (await (await dropped).json()) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  expect(aborted.result.isError).toBe(true);
  expect(aborted.result.content[0]?.text).toContain("aborted");
  expect(h.store.listenerCount).toBe(0);
  h.store.close();
});

import { expect, test } from "bun:test";
import { Coordinator } from "../src/coordinator";
import type { Worker } from "../src/domain";
import { OpenCodeAgent } from "../src/providers/opencode";
import { Store } from "../src/store";
import { config, FakeProvider, harness, runToRunning, task } from "./helpers";

const idle = config.SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS * 1000;
const tokens = {
  input: 1,
  output: 2,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
const session = {
  id: "ses-1",
  title: "swarmforge:worker",
  time: { created: 1 },
};
// /session/status reports every session on the VM; the message page reports this session.
type Remote = { status: unknown; messages: unknown[] };
const user = (id: string) => ({
  info: { id, role: "user", sessionID: "ses-1", time: { created: 1 }, tokens },
  parts: [{ type: "text", text: "work" }],
});
const assistant = (
  id: string,
  parent: string,
  over: { streaming?: boolean; text?: string } = {},
) => ({
  info: {
    id,
    parentID: parent,
    role: "assistant",
    modelID: "qwen",
    time: over.streaming ? { created: 1 } : { created: 1, completed: 2 },
    tokens,
  },
  parts: [
    {
      type: "text",
      text: over.text ?? '{"status":"completed","summary":"done"}',
    },
  ],
});
function opencode(remote: Remote) {
  return new OpenCodeAgent(config, (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    if (path.endsWith("/status")) return Response.json(remote.status);
    if (path.endsWith("/message")) return Response.json(remote.messages);
    if (path.endsWith("/prompt_async")) return Response.json({});
    if (path === "/session" && request.method !== "POST")
      return Response.json([]);
    return Response.json(session);
  }) as typeof fetch);
}
function worker(): Worker {
  const s = new Store(":memory:");
  const w = s.create({
    team_id: "team",
    task_id: "task",
    role: "coder",
    prompt: "work",
    timeout_seconds: 60,
  });
  s.close();
  return {
    ...w,
    vm_id: "vm-1",
    endpoint: "https://worker.example",
    opencode_session_id: "ses-1",
  };
}
function wired(remote: Remote) {
  const store = new Store(":memory:");
  const provider = new FakeProvider();
  const coordinator = new Coordinator(
    { ...config },
    store,
    provider,
    opencode(remote),
  );
  return { store, provider, coordinator };
}
async function toRunning(w: ReturnType<typeof wired>, id: string) {
  for (let i = 0; i < 8; i++) {
    await w.coordinator.tick();
    if (w.store.get(id).state === "running") return;
  }
  throw new Error("did not run");
}
async function writeResult(
  w: { store: Store; provider: FakeProvider },
  id: string,
  summary: string,
) {
  const d = w.store.dispatch(id)!;
  await w.provider.writeFile(
    w.store.get(id).vm_id!,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: id,
      run_id: d.run_id,
      status: "completed",
      summary,
    }),
  );
}

test("a session omitted from /session/status is not idle while a message streams", async () => {
  const agent = opencode({
    status: { "ses-other": { type: "busy" } },
    messages: [assistant("msg-1", "msg-task", { streaming: true })],
  });
  const snapshot = await agent.inspect(worker());
  expect(snapshot.status).toBe("busy");
  expect(snapshot.inference_active).toBe(1);
});

test("silence from /session/status is unknown, never a finished turn", async () => {
  for (const status of [{}, null, { "ses-other": { type: "idle" } }]) {
    const settled = opencode({
      status,
      messages: [assistant("msg-1", "msg-task")],
    });
    expect((await settled.inspect(worker())).status).toBe("unknown");
    const streaming = opencode({
      status,
      messages: [assistant("msg-1", "msg-task", { streaming: true })],
    });
    expect((await streaming.inspect(worker())).status).toBe("busy");
  }
});

test("only a reported session status settles a turn", async () => {
  for (const type of ["idle", "busy", "retry"] as const) {
    const agent = opencode({
      status: { "ses-1": { type } },
      messages: [assistant("msg-1", "msg-task")],
    });
    expect((await agent.inspect(worker())).status).toBe(type);
  }
  // An unrecognized type is silence too, never a licence to finish the turn.
  const unknown = opencode({
    status: { "ses-1": { type: "compacting" } },
    messages: [assistant("msg-1", "msg-task")],
  });
  expect((await unknown.inspect(worker())).status).toBe("unknown");
  const unknownStreaming = opencode({
    status: { "ses-1": { type: "compacting" } },
    messages: [assistant("msg-1", "msg-task", { streaming: true })],
  });
  expect((await unknownStreaming.inspect(worker())).status).toBe("busy");
});

test("a turn still streaming keeps its run when /session/status omits the session", async () => {
  const remote: Remote = {
    status: { "ses-1": { type: "busy" } },
    messages: [],
  };
  const w = wired(remote);
  const worker_id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, worker_id);
  const d = w.store.dispatch(worker_id)!;
  remote.status = {};
  remote.messages = [
    user(d.message_id),
    assistant("msg-1", d.message_id, { streaming: true, text: "working" }),
  ];
  await w.coordinator.tick();
  const after = w.store.get(worker_id);
  expect(after.state).toBe("running");
  expect(w.coordinator.inference.get(worker_id)).toBe(1);
  expect(w.store.result(worker_id)).toBeNull();
  w.store.close();
});

test("an omitted session cannot complete a still streaming turn from its result file", async () => {
  const remote: Remote = {
    status: { "ses-1": { type: "busy" } },
    messages: [],
  };
  const w = wired(remote);
  const worker_id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, worker_id);
  const d = w.store.dispatch(worker_id)!;
  await writeResult(w, worker_id, "written before the turn ended");
  remote.status = {};
  remote.messages = [
    user(d.message_id),
    assistant("msg-1", d.message_id, { streaming: true, text: "working" }),
  ];
  await w.coordinator.tick();
  const after = w.store.get(worker_id);
  expect(after.state).toBe("running");
  expect(w.store.result(worker_id)).toBeNull();
  w.store.close();
});

test("a reported idle turn still completes", async () => {
  const remote: Remote = {
    status: { "ses-1": { type: "busy" } },
    messages: [],
  };
  const w = wired(remote);
  const worker_id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, worker_id);
  const d = w.store.dispatch(worker_id)!;
  remote.status = { "ses-1": { type: "idle" } };
  remote.messages = [user(d.message_id), assistant("msg-1", d.message_id)];
  await w.coordinator.tick();
  const after = w.store.get(worker_id);
  expect(after.state).toBe("completed");
  expect(w.store.result(worker_id)?.summary).toBe("done");
  w.store.close();
});

test("a lost session is not mistaken for a finished turn and still resolves", async () => {
  const remote: Remote = {
    status: { "ses-1": { type: "busy" } },
    messages: [],
  };
  const w = wired(remote);
  const worker_id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, worker_id);
  // OpenCode no longer lists the session and no message for it remains.
  remote.status = {};
  remote.messages = [];
  await w.coordinator.tick();
  const silent = w.store.get(worker_id);
  expect(silent.state).toBe("waiting");
  expect(w.store.result(worker_id)).toBeNull();
  // Silence still ends in a decision: the no-progress budget quiesces the worker.
  w.store.patch(worker_id, { token_progress_at: Date.now() - idle });
  await w.coordinator.tick();
  expect(w.store.get(worker_id).state).toBe("failed");
  expect(w.store.get(worker_id).error).toContain("No token progress");
  w.store.close();
});

test("a lost session that already wrote this run's result still completes", async () => {
  const remote: Remote = {
    status: { "ses-1": { type: "busy" } },
    messages: [],
  };
  const w = wired(remote);
  const worker_id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, worker_id);
  await writeResult(w, worker_id, "finished before the session was lost");
  remote.status = {};
  remote.messages = [];
  await w.coordinator.tick();
  expect(w.store.get(worker_id).state).toBe("completed");
  expect(w.store.result(worker_id)?.summary).toBe(
    "finished before the session was lost",
  );
  w.store.close();
});

test("a reported idle status is not terminal while this dispatch is streaming", async () => {
  const h = harness();
  const worker_id = h.coordinator.spawn(task).worker_id;
  await runToRunning(h, worker_id);
  const d = h.store.dispatch(worker_id)!;
  await h.provider.writeFile(
    h.store.get(worker_id).vm_id!,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id,
      run_id: d.run_id,
      status: "completed",
      summary: "written early",
    }),
  );
  h.agent.snapshots.set(worker_id, {
    status: "idle",
    inference_active: 1,
    messages: [
      {
        id: d.message_id,
        role: "user",
        completed: true,
        input: 0,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
      },
      {
        id: "msg-1",
        parent_id: d.message_id,
        role: "assistant",
        completed: false,
        input: 1,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
        model: "qwen",
      },
    ],
  });
  await h.coordinator.tick();
  expect(h.store.get(worker_id).state).not.toBe("completed");
  expect(h.store.result(worker_id)).toBeNull();
  h.store.close();
});

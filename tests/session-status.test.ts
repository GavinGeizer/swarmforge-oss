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
// OpenCode reports every session with work; a finished one is simply absent from the map,
// and a message without time.completed is what a restart, OOM or abort leaves behind.
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
const quiet = (): Remote => ({ status: {}, messages: [] });

test("a session absent from /session/status is the normal idle shape", async () => {
  for (const status of [{}, null, { "ses-other": { type: "busy" } }]) {
    const agent = opencode({
      status,
      messages: [assistant("msg-1", "msg-task")],
    });
    expect((await agent.inspect(worker())).status).toBe("idle");
  }
});

test("stale message history never promotes an absent session to busy", async () => {
  // The inference gauge estimates from incomplete messages; the status does not, so a
  // message stranded by an earlier turn cannot block this turn.
  const agent = opencode({
    status: {},
    messages: [assistant("msg-1", "msg-task", { streaming: true })],
  });
  const snapshot = await agent.inspect(worker());
  expect(snapshot.status).toBe("idle");
  expect(snapshot.inference_active).toBe(1);
});

test("a reported status this version does not recognize is never idle", async () => {
  for (const streaming of [false, true]) {
    const agent = opencode({
      status: { "ses-1": { type: "compacting" } },
      messages: [assistant("msg-1", "msg-task", { streaming })],
    });
    const snapshot = await agent.inspect(worker());
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.inference_active).toBe(streaming ? 1 : 0);
  }
});

test("recognized session statuses pass through unchanged", async () => {
  for (const type of ["idle", "busy", "retry"] as const) {
    const agent = opencode({
      status: { "ses-1": { type } },
      messages: [assistant("msg-1", "msg-task")],
    });
    expect((await agent.inspect(worker())).status).toBe(type);
  }
});

test("a finished turn completes while /session/status omits the session", async () => {
  const remote = quiet();
  remote.status = { "ses-1": { type: "busy" } };
  const w = wired(remote);
  const id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, id);
  const d = w.store.dispatch(id)!;
  remote.status = {};
  remote.messages = [user(d.message_id), assistant("msg-1", d.message_id)];
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("completed");
  expect(w.store.result(id)?.summary).toBe("done");
  w.store.close();
});

test("an interrupted message still completes from its result file", async () => {
  // A restart or OOM leaves the last assistant message without time.completed; the run
  // that produced a matching result file is finished regardless.
  const remote = quiet();
  remote.status = { "ses-1": { type: "busy" } };
  const w = wired(remote);
  const id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, id);
  const d = w.store.dispatch(id)!;
  await writeResult(w, id, "finished before the restart");
  remote.status = {};
  remote.messages = [
    user(d.message_id),
    assistant("msg-1", d.message_id, { streaming: true, text: "working" }),
  ];
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("completed");
  expect(w.store.result(id)?.summary).toBe("finished before the restart");
  w.store.close();
});

test("stale history from an earlier dispatch cannot block a finished follow-up", async () => {
  const remote = quiet();
  remote.status = { "ses-1": { type: "busy" } };
  const w = wired(remote);
  const id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, id);
  const first = w.store.dispatch(id)!;
  remote.status = { "ses-1": { type: "idle" } };
  remote.messages = [
    user(first.message_id),
    assistant("msg-1", first.message_id),
  ];
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("completed");
  remote.status = { "ses-1": { type: "busy" } };
  remote.messages = [
    user(first.message_id),
    assistant("msg-1", first.message_id),
    user("msg-next"),
  ];
  w.coordinator.message(id, "next");
  await toRunning(w, id);
  const second = w.store.dispatch(id)!;
  expect(second.message_id).not.toBe(first.message_id);
  // The newest message in the session is stranded output of the first dispatch.
  remote.status = {};
  remote.messages = [
    user(first.message_id),
    assistant("msg-1", first.message_id),
    user(second.message_id),
    assistant("msg-2", second.message_id, {
      text: '{"status":"completed","summary":"second"}',
    }),
    assistant("msg-stale", first.message_id, { streaming: true, text: "cut" }),
  ];
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("completed");
  expect(w.store.result(id)?.summary).toBe("second");
  w.store.close();
});

test("an unrecognized busy status does not complete a mid-turn result file", async () => {
  const remote = quiet();
  remote.status = { "ses-1": { type: "busy" } };
  const w = wired(remote);
  const id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, id);
  const d = w.store.dispatch(id)!;
  await writeResult(w, id, "written mid-turn");
  remote.status = { "ses-1": { type: "compacting" } };
  remote.messages = [
    user(d.message_id),
    assistant("msg-1", d.message_id, { streaming: true, text: "working" }),
  ];
  await w.coordinator.tick();
  const unsettled = w.store.get(id);
  expect(unsettled.state).not.toBe("completed");
  expect(w.store.result(id)).toBeNull();
  w.store.patch(id, { token_progress_at: Date.now() - idle });
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("failed");
  w.store.close();
});

test("a reported busy turn is not completed by its result file", async () => {
  const remote = quiet();
  remote.status = { "ses-1": { type: "busy" } };
  const w = wired(remote);
  const id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, id);
  const d = w.store.dispatch(id)!;
  await writeResult(w, id, "written mid-turn");
  remote.messages = [
    user(d.message_id),
    assistant("msg-1", d.message_id, { streaming: true, text: "working" }),
  ];
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("running");
  expect(w.store.result(id)).toBeNull();
  w.store.close();
});

test("a lost session is not mistaken for a finished turn and still resolves", async () => {
  const remote = quiet();
  remote.status = { "ses-1": { type: "busy" } };
  const w = wired(remote);
  const id = w.coordinator.spawn(task).worker_id;
  await toRunning(w, id);
  // OpenCode no longer lists the session and no message for it remains.
  remote.status = {};
  remote.messages = [];
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("waiting");
  expect(w.store.result(id)).toBeNull();
  // Silence still ends in a decision: the no-progress budget quiesces the worker.
  w.store.patch(id, { token_progress_at: Date.now() - idle });
  await w.coordinator.tick();
  expect(w.store.get(id).state).toBe("failed");
  expect(w.store.get(id).error).toContain("No token progress");
  w.store.close();
});

test("a status the adapter could not interpret is not a settled turn", async () => {
  const h = harness();
  const id = h.coordinator.spawn(task).worker_id;
  await runToRunning(h, id);
  const d = h.store.dispatch(id)!;
  await h.provider.writeFile(
    h.store.get(id).vm_id!,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: id,
      run_id: d.run_id,
      status: "completed",
      summary: "written early",
    }),
  );
  h.agent.snapshots.set(id, {
    status: "unknown",
    inference_active: 0,
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
        completed: true,
        result: { status: "completed", summary: "done" },
        input: 10,
        output: 20,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
        model: "qwen",
      },
    ],
  });
  await h.coordinator.tick();
  expect(h.store.get(id).state).not.toBe("completed");
  expect(h.store.result(id)).toBeNull();
  h.store.patch(id, { token_progress_at: Date.now() - idle });
  await h.coordinator.tick();
  expect(h.store.get(id).state).toBe("failed");
  h.store.close();
});

test("an idle turn with an interrupted message still completes", async () => {
  const h = harness();
  const id = h.coordinator.spawn(task).worker_id;
  await runToRunning(h, id);
  const d = h.store.dispatch(id)!;
  await h.provider.writeFile(
    h.store.get(id).vm_id!,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: id,
      run_id: d.run_id,
      status: "completed",
      summary: "written before the interruption",
    }),
  );
  h.agent.snapshots.set(id, {
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
  expect(h.store.get(id).state).toBe("completed");
  expect(h.store.result(id)?.summary).toBe("written before the interruption");
  h.store.close();
});

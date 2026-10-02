import { expect, test } from "bun:test";
import type { Worker } from "../src/domain";
import { OpenCodeAgent } from "../src/providers/opencode";
import { Store } from "../src/store";
import { config } from "./helpers";

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
type Call = { path: string; search: URLSearchParams };
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

// The real 1.18.31 route accepts `limit` only. Anything else is a 400, exactly as the SDK's
// passthrough query serializer puts it on the wire.
function opencode(remote: {
  status?: unknown;
  messages: unknown[];
  limit?: number;
  reject?: number[];
}) {
  const calls: Call[] = [];
  const agent = new OpenCodeAgent(config, (async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    const path = url.pathname;
    calls.push({ path, search: url.searchParams });
    if (path.endsWith("/status")) return Response.json(remote.status ?? {});
    if (path.endsWith("/message")) {
      const before = url.searchParams.get("before");
      if (before)
        return Response.json(
          { message: "unrecognized key before" },
          { status: 400 },
        );
      for (const key of url.searchParams.keys())
        if (key !== "limit" && key !== "directory")
          return Response.json(
            { message: `unrecognized key ${key}` },
            { status: 400 },
          );
      const status = remote.reject?.find((code) => code === 400);
      if (
        status === 400 &&
        url.searchParams.get("limit") !== String(remote.limit ?? 100)
      )
        return Response.json({ message: "bad request" }, { status: 400 });
      const limit = Number(url.searchParams.get("limit") ?? "0");
      // Newest first, then sliced: the shape the server actually returns.
      const all = remote.messages;
      return Response.json(all.slice(Math.max(0, all.length - limit)));
    }
    if (path.endsWith("/prompt_async")) return Response.json({});
    if (path === "/session" && request.method !== "POST")
      return Response.json([]);
    return Response.json(session);
  }) as typeof fetch);
  return { agent, calls };
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
    server_password: "pw",
    opencode_session_id: "ses-1",
  };
}
function history(count: number, current: { id: string; parent: string }) {
  const old = Array.from({ length: count }, (_, i) =>
    assistant(`msg-old-${String(i).padStart(4, "0")}`, "msg-old-0000"),
  );
  return [...old, user(current.id), assistant("msg-current", current.parent)];
}

test("a session with more than 100 messages reports the newest window and never paginates", async () => {
  const messages = history(300, { id: "msg-task", parent: "msg-old-0000" });
  const { agent, calls } = opencode({ status: {}, messages });
  const snapshot = await agent.inspect(worker());
  const pages = calls.filter((c) => c.path.endsWith("/message"));
  expect(pages).toHaveLength(1);
  // Only the supported knob is sent, and the window is bounded.
  const keys = [...(pages[0]?.search.keys() ?? [])].sort();
  expect(keys).toEqual(["directory", "limit"]);
  expect(Number(pages[0]?.search.get("limit"))).toBe(100);
  expect(snapshot.messages).toHaveLength(100);
  // The current dispatch's turn survives the truncation, and lexicographic order is never
  // used to decide what is old.
  expect(snapshot.messages.some((m) => m.id === "msg-task")).toBe(true);
  expect(snapshot.messages.some((m) => m.id === "msg-current")).toBe(true);
});

test("a busy server stays observable with a long history instead of freezing the snapshot", async () => {
  // The regression: `before` used to 400 at the first extra page and reject the whole
  // inspect, so status, usage and completion all froze while the worker kept running.
  const messages = history(250, { id: "msg-task", parent: "msg-old-0000" });
  const { agent, calls } = opencode({
    status: { "ses-1": { type: "busy" } },
    messages,
  });
  const snapshot = await agent.inspect(worker());
  expect(snapshot.status).toBe("busy");
  expect(snapshot.inference_active).toBe(0);
  expect(calls.filter((c) => c.search.has("before"))).toHaveLength(0);
  // Usage comes from per-message rows, so a truncated window never restates old totals.
  expect(snapshot.messages.reduce((sum, m) => sum + m.input, 0)).toBe(99);
});

test("a busy turn with an unfinished newest message is still reported as active", async () => {
  const messages = history(400, { id: "msg-task", parent: "msg-old-0000" });
  messages.push(
    assistant("msg-live", "msg-task", { streaming: true, text: "working" }),
  );
  const { agent } = opencode({
    status: { "ses-1": { type: "busy" } },
    messages,
  });
  const snapshot = await agent.inspect(worker());
  expect(snapshot.status).toBe("busy");
  expect(snapshot.inference_active).toBe(1);
  expect(snapshot.messages.at(-1)?.completed).toBe(false);
});

test("the completed reply of the current dispatch is found in a truncated window", async () => {
  const old = Array.from({ length: 400 }, (_, i) =>
    assistant(`msg-old-${String(i).padStart(4, "0")}`, "msg-old-0000"),
  );
  const messages = [
    ...old,
    user("msg-task"),
    assistant("msg-stale", "msg-old-0000", {
      streaming: true,
      text: '{"status":"completed","summary":"stale"}',
    }),
    assistant("msg-current", "msg-task"),
  ];
  const { agent } = opencode({ status: {}, messages });
  const snapshot = await agent.inspect(worker());
  const reply = snapshot.messages
    .filter(
      (m) =>
        m.role === "assistant" && m.parent_id === "msg-task" && m.completed,
    )
    .at(-1);
  expect(reply?.id).toBe("msg-current");
});

test("a server that rejects the full window is retried once at a smaller supported bound", async () => {
  const messages = history(300, { id: "msg-task", parent: "msg-old-0000" });
  const { agent, calls } = opencode({
    status: { "ses-1": { type: "busy" } },
    messages,
    limit: 20,
    reject: [400],
  });
  const snapshot = await agent.inspect(worker());
  const pages = calls.filter((c) => c.path.endsWith("/message"));
  expect(pages.map((p) => p.search.get("limit"))).toEqual(["100", "20"]);
  expect(snapshot.status).toBe("busy");
  expect(snapshot.messages).toHaveLength(20);
});

test("a server that rejects every window degrades to the status instead of retrying forever", async () => {
  const { agent, calls } = opencode({
    status: { "ses-1": { type: "busy" } },
    messages: [],
    limit: -1,
    reject: [400],
  });
  const snapshot = await agent.inspect(worker());
  const pages = calls.filter((c) => c.path.endsWith("/message"));
  expect(pages.map((p) => p.search.get("limit"))).toEqual(["100", "20"]);
  expect(snapshot.status).toBe("busy");
  expect(snapshot.messages).toEqual([]);
  expect(snapshot.inference_active).toBe(0);
});

test("a fault that is not a rejected query stays a retryable failure", async () => {
  const boom = new OpenCodeAgent(config, (async (input: RequestInfo | URL) => {
    const path = new URL((input as Request).url).pathname;
    if (path.endsWith("/status")) return Response.json({});
    throw new Error("ECONNRESET");
  }) as typeof fetch);
  expect(boom.inspect(worker())).rejects.toThrow("ECONNRESET");
});

test("a status this call cannot read is never guessed", async () => {
  const { agent } = opencode({
    status: { "ses-1": { type: "busy" } },
    messages: [],
  });
  const failing = new OpenCodeAgent(config, (async (
    input: RequestInfo | URL,
  ) => {
    const path = new URL((input as Request).url).pathname;
    if (path.endsWith("/status")) throw new Error("status unavailable");
    return Response.json([assistant("msg-1", "msg-task")]);
  }) as typeof fetch);
  expect(failing.inspect(worker())).rejects.toThrow("status unavailable");
  expect((await agent.inspect(worker())).status).toBe("busy");
});

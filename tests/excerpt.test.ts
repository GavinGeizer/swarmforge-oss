import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config";
import type { AgentMessage, AgentSnapshot } from "../src/domain";
import { createMcpServer } from "../src/mcp";
import { Metrics } from "../src/metrics";
import { OpenCodeAgent } from "../src/providers/opencode";
import { excerptText, publicWorker, Redactor } from "../src/security";
import { Store } from "../src/store";
import { harness, runToRunning, task } from "./helpers";

const c = loadConfig({
  FREESTYLE_API_TOKEN: "infra-secret",
  FREESTYLE_SNAPSHOT_ID: "snap",
  SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
  SWARMFORGE_MODEL_API_KEY: "model-secret",
  SWARMFORGE_MODEL_NAME: "qwen",
  SWARMFORGE_GIT_TREE: "opaque-tree",
  SWARMFORGE_DB_PATH: ":memory:",
});

function agentWorker() {
  const store = new Store(":memory:");
  const w = store.create({
    team_id: "team",
    task_id: "task",
    role: "coder",
    prompt: "work",
    timeout_seconds: 60,
  });
  store.close();
  return {
    ...w,
    vm_id: "vm-1",
    endpoint: "https://worker.example",
    opencode_session_id: "ses-1",
  };
}

function message(over: Partial<AgentMessage>): AgentMessage {
  return {
    id: "msg-answer",
    role: "assistant",
    completed: false,
    input: 1,
    output: 2,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    ...over,
  };
}

test("the live excerpt reuses the polled snapshot without extra provider calls", async () => {
  let calls = 0;
  const streamed = `HEAD_MARKER ${"long context ".repeat(500)}tail of the answer`;
  const agent = new OpenCodeAgent(c, (async (input: RequestInfo | URL) => {
    calls++;
    const path = (input as Request).url;
    if (path.includes("/status"))
      return Response.json({ "ses-1": { type: "busy" } });
    return Response.json([
      {
        info: {
          id: "msg-answer",
          parentID: "msg_123",
          role: "assistant",
          modelID: "qwen",
          time: { created: 1 },
          tokens: {
            input: 1,
            output: 2,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [{ type: "text", text: streamed }],
      },
    ]);
  }) as typeof fetch);
  const snapshot = await agent.inspect(agentWorker());
  expect(calls).toBe(2);
  const text = snapshot.messages[0]?.text ?? "";
  expect([...text].length).toBeLessThanOrEqual(4096);
  expect(text.length).toBeLessThan(streamed.length);
  expect(text.endsWith("tail of the answer")).toBe(true);
  expect(text).not.toContain("HEAD_MARKER");
});

test("excerpts collapse to one safe bounded line with secrets redacted", () => {
  const redact = (value: string) =>
    new Redactor(() => ["model-secret"]).text(value);
  expect(
    excerptText(
      "line one\n\u001b[31mred\u001b[0m\ttab\u200b model-secret",
      redact,
    ),
  ).toBe("line one red tab [REDACTED]");
  expect(excerptText("\u001b]0;spoofed title\u0007visible tail", redact)).toBe(
    "visible tail",
  );
  expect(excerptText("\u001b[2J\u0007\u202e\u200b\u00a0", redact)).toBe("");
  const bounded = excerptText(
    `${"padding word ".repeat(60)}final words here`,
    redact,
  );
  expect(bounded.startsWith("…")).toBe(true);
  expect([...bounded].length).toBeLessThanOrEqual(181);
  expect(bounded.endsWith("final words here")).toBe(true);
});

test("an active turn publishes a bounded excerpt only on the focused worker view", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const d = h.store.dispatch(w.worker_id)!;
  const snapshot: AgentSnapshot = {
    status: "busy",
    inference_active: 1,
    messages: [
      message({
        parent_id: d.message_id,
        text: `Rewriting status render\u001b[31m now\u001b[0m with model-secret ${"filler ".repeat(80)}done reading the diff`,
      }),
    ],
  };
  h.agent.snapshots.set(w.worker_id, snapshot);
  await h.coordinator.tick();
  const focused = publicWorker(h.coordinator, w.worker_id, true);
  expect(focused.excerpt).toContain("done reading the diff");
  expect(focused.excerpt).not.toContain("model-secret");
  expect(focused.excerpt).not.toContain("\n");
  expect(focused.excerpt).not.toContain("\u001b");
  expect(focused.excerpt_partial).toBe(true);
  expect(typeof focused.excerpt_at).toBe("number");
  expect([...(focused.excerpt ?? "")].length).toBeLessThanOrEqual(181);
  expect("excerpt" in publicWorker(h.coordinator, w.worker_id)).toBe(false);
  const durable = JSON.stringify([
    h.store.db.query("SELECT body FROM workers").all(),
    h.store.db.query("SELECT * FROM events").all(),
    h.store.db.query("SELECT * FROM dispatches").all(),
  ]);
  expect(durable).not.toContain("done reading the diff");
  expect(await new Metrics(h.coordinator).render()).not.toContain(
    "done reading the diff",
  );
  h.store.close();
});

test("the excerpt is dropped on completion, failure and a new dispatch", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const first = h.store.dispatch(w.worker_id)!;
  h.agent.snapshots.set(w.worker_id, {
    status: "busy",
    inference_active: 1,
    messages: [
      message({ parent_id: first.message_id, text: "live partial answer" }),
    ],
  });
  await h.coordinator.tick();
  expect(h.coordinator.excerpt(w.worker_id)?.partial).toBe(true);
  h.agent.complete(h.store.get(w.worker_id), {
    status: "completed",
    summary: "done",
  });
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("completed");
  expect(h.coordinator.excerpt(w.worker_id)).toBeNull();
  h.coordinator.message(w.worker_id, "follow-up");
  await h.coordinator.tick();
  await h.coordinator.tick();
  const second = h.store.dispatch(w.worker_id)!;
  expect(h.store.get(w.worker_id).state).toBe("running");
  expect(second.message_id).not.toBe(first.message_id);
  expect(h.coordinator.excerpt(w.worker_id)).toBeNull();
  h.agent.snapshots.set(w.worker_id, {
    status: "busy",
    inference_active: 1,
    messages: [
      message({ parent_id: first.message_id, text: "stale earlier turn text" }),
    ],
  });
  await h.coordinator.tick();
  expect(h.coordinator.excerpt(w.worker_id)).toBeNull();
  h.agent.complete(h.store.get(w.worker_id), { bad: true });
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("failed");
  expect(h.coordinator.excerpt(w.worker_id)).toBeNull();
  expect(h.store.result(w.worker_id, second.run_id)).toBeNull();
  h.store.close();
});

test("cancellation and destruction clear the ephemeral excerpt", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const d = h.store.dispatch(w.worker_id)!;
  h.agent.snapshots.set(w.worker_id, {
    status: "busy",
    inference_active: 1,
    messages: [
      message({ parent_id: d.message_id, text: "still writing the summary" }),
    ],
  });
  await h.coordinator.tick();
  expect(h.coordinator.excerpt(w.worker_id)?.text).toBe(
    "still writing the summary",
  );
  await h.coordinator.control(w.worker_id, "cancel");
  expect(h.store.get(w.worker_id).state).toBe("cancelled");
  expect(h.coordinator.excerpt(w.worker_id)).toBeNull();
  h.coordinator.excerpts.set(w.worker_id, {
    text: "planted",
    at: Date.now(),
    partial: true,
  });
  await h.coordinator.control(w.worker_id, "destroy", true);
  expect(h.store.get(w.worker_id).state).toBe("destroyed");
  expect(h.coordinator.excerpt(w.worker_id)).toBeNull();
  h.store.close();
});

test("MCP returns the excerpt for one worker and never lists it", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const d = h.store.dispatch(w.worker_id)!;
  h.agent.snapshots.set(w.worker_id, {
    status: "busy",
    inference_active: 1,
    messages: [
      message({ parent_id: d.message_id, text: "reviewing the coordinator" }),
    ],
  });
  await h.coordinator.tick();
  const server = createMcpServer(h.coordinator);
  const client = new Client({ name: "excerpt-reader", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const focused = await client.callTool({
      name: "get_worker",
      arguments: { worker_id: w.worker_id },
    });
    expect(focused.structuredContent).toMatchObject({
      excerpt: "reviewing the coordinator",
      excerpt_partial: true,
    });
    const listed = await client.callTool({
      name: "list_workers",
      arguments: {},
    });
    expect(JSON.stringify(listed)).not.toContain("reviewing the coordinator");
    expect(JSON.stringify(listed)).not.toContain("excerpt");
  } finally {
    await client.close();
    await server.close();
    h.store.close();
  }
});

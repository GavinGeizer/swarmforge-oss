import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkerFiles } from "../src/files";
import { createMcpServer } from "../src/mcp";
import { Metrics } from "../src/metrics";
import { Redactor } from "../src/security";
import { harness, runToRunning, task } from "./helpers";

test("log inspection does not execute guest commands for paused workers and retains destroyed-worker events", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  await h.coordinator.control(w.worker_id, "pause");
  let execCalls = 0;
  h.provider.exec = async () => {
    execCalls++;
    throw new Error("Log retrieval must not wake the paused VM");
  };
  const files = new WorkerFiles(h.coordinator);
  const paused = await files.logs(w.worker_id);
  expect(execCalls).toBe(0);
  expect(paused.opencode).toBeNull();
  expect(paused.events.some((e) => e.type === "worker.paused")).toBe(true);
  await h.coordinator.control(w.worker_id, "destroy", true);
  const destroyed = await files.logs(w.worker_id);
  expect(destroyed.events.some((e) => e.type === "worker.destroyed")).toBe(
    true,
  );
  h.store.close();
});

test("log inspection retains audit events during provider outages", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.provider.getWorker = async () => {
    throw new Error("provider unavailable");
  };
  const logs = await new WorkerFiles(h.coordinator).logs(w.worker_id);
  expect(logs.events.length).toBeGreaterThan(0);
  expect(logs.opencode).toBeNull();
  h.store.close();
});

test("MCP client can create, observe, message, query team/task and collect a structured result", async () => {
  const h = harness();
  const server = createMcpServer(h.coordinator);
  const client = new Client({ name: "test-lead", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(16);
  const created = await client.callTool({
    name: "spawn_worker",
    arguments: task,
  });
  const out = created.structuredContent as { worker_id: string; state: string };
  expect(out.state).toBe("queued");
  expect(JSON.stringify(created)).not.toContain("server_password");
  await runToRunning(h, out.worker_id);
  h.agent.complete(h.store.get(out.worker_id), {
    status: "completed",
    summary: "done model-secret",
  });
  await h.coordinator.tick();
  const result = await client.callTool({
    name: "get_worker_result",
    arguments: { worker_id: out.worker_id },
  });
  expect(JSON.stringify(result)).toContain("[REDACTED]");
  expect(JSON.stringify(result)).not.toContain("model-secret");
  for (const name of ["get_worker", "get_worker_logs", "list_worker_artifacts"])
    expect(
      (await client.callTool({ name, arguments: { worker_id: out.worker_id } }))
        .isError,
    ).not.toBe(true);
  for (const name of ["get_task", "list_tasks", "get_team_status"])
    expect(
      (
        await client.callTool({
          name,
          arguments: { team_id: "team", task_id: "task" },
        })
      ).isError,
    ).not.toBe(true);
  expect(
    (await client.callTool({ name: "get_swarm_status", arguments: {} }))
      .isError,
  ).not.toBe(true);
  await client.close();
  await server.close();
  h.store.close();
});
test("artifact handles are bounded and path traversal and secret contents are blocked", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const vm = h.store.get(w.worker_id).vm_id!;
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/report.txt",
    "x".repeat(100000),
  );
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/secret.txt",
    "model-secret",
  );
  const files = new WorkerFiles(h.coordinator);
  const handle = await files.artifact(w.worker_id, "report.txt");
  expect(handle.size).toBe(100000);
  expect(handle.uri).toContain("swarmforge://");
  const bytes = await files.readArtifact(w.worker_id, "report.txt", 0, 1024);
  expect(bytes.length).toBe(1024);
  await expect(files.artifact(w.worker_id, "../start.sh")).rejects.toThrow();
  await expect(
    files.readArtifact(w.worker_id, "secret.txt", 0, 1024),
  ).rejects.toThrow();
  h.store.close();
});
test("metrics aggregate durable tokens and never label by worker/task identifiers", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.agent.complete(h.store.get(w.worker_id));
  await h.coordinator.tick();
  const metrics = new Metrics(h.coordinator);
  const text = await metrics.render();
  expect(text).toContain("swarmforge_tokens_total");
  expect(text).toContain('direction="output"');
  expect(text).not.toContain(w.worker_id);
  expect(text).not.toContain("task_id");
  h.store.close();
});
test("redaction scrubs known secrets, credential fields and URL passwords recursively", () => {
  const r = new Redactor(() => ["known-secret"]);
  expect(
    r.value({
      summary: "key known-secret",
      apiKey: "anything",
      url: "https://u:password@example.test",
    }),
  ).toEqual({
    summary: "key [REDACTED]",
    apiKey: "[REDACTED]",
    url: "https://[REDACTED]@example.test",
  });
});

test("artifact resource links can actually be read through an MCP client", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  await h.provider.writeFile(
    h.store.get(w.worker_id).vm_id!,
    "/workspace/.swarmforge/artifacts/report.txt",
    "hello",
  );
  const server = createMcpServer(h.coordinator);
  const client = new Client({ name: "reader", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const link = await client.callTool({
      name: "get_worker_artifact",
      arguments: { worker_id: w.worker_id, path: "report.txt" },
    });
    const uri = (link.structuredContent as { uri: string }).uri;
    const read = await client.readResource({ uri });
    expect(read.contents[0]).toMatchObject({ blob: "aGVsbG8=" });
  } finally {
    await client.close();
    await server.close();
    h.store.close();
  }
});
test("artifact directory listing rejects symlink roots", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.provider.stat = async () => ({ size: 0, isFile: false, isSymlink: true });
  const files = new WorkerFiles(h.coordinator);
  await expect(files.artifacts(w.worker_id)).rejects.toThrow();
  h.store.close();
});

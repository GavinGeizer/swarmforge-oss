import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WorkerProvider } from "../src/domain";
import { WorkerFiles } from "../src/files";
import { createMcpServer } from "../src/mcp";
import { Metrics } from "../src/metrics";
import { Redactor } from "../src/security";
import { harness, runToRunning, task } from "./helpers";
import { type LocalWorkspace, localWorkspace } from "./local-artifact-provider";

// The live artifact surfaces capture through the guest helper, so a test that touches them needs
// a real local guest. The coordinator reads the artifact root and storage root once, at
// construction, so the harness has to be built with them rather than patched afterwards.
async function harnessWithGuest(overrides: Parameters<typeof harness>[0] = {}) {
  const workspace: LocalWorkspace = await localWorkspace();
  const storage = mkdtempSync(join(tmpdir(), "swarmforge-test-storage-"));
  const h = harness({
    ...overrides,
    SWARMFORGE_WORKSPACE: workspace.root,
    SWARMFORGE_ARTIFACT_DIR: storage,
  });
  (h.provider as WorkerProvider).artifactTransport = workspace.transport;
  // The provider's guest preparation creates these; the transport fixture does not.
  for (const directory of ["artifacts", "logs"])
    mkdirSync(join(workspace.root, ".swarmforge", directory), {
      recursive: true,
    });
  return {
    h,
    write: (path: string, content: string) => {
      const target = join(workspace.root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    },
    cleanup: async () => {
      rmSync(workspace.base, { recursive: true, force: true });
      await workspace.cleanup();
      rmSync(storage, { recursive: true, force: true });
    },
  };
}

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
  const { h, cleanup: guestCleanup } = await harnessWithGuest();
  const server = createMcpServer(h.coordinator);
  const client = new Client({ name: "test-lead", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(31);
  expect(tools.tools.some((tool) => tool.name === "read_worker_artifact")).toBe(
    true,
  );
  expect(tools.tools.some((tool) => tool.name === "get_dashboard_view")).toBe(
    true,
  );
  expect(tools.tools.map((t) => t.name)).toContain("wait_for_state_change");
  expect(tools.tools.map((t) => t.name)).toEqual(
    expect.arrayContaining([
      "list_artifacts",
      "get_artifact_metadata",
      "preserve_artifact",
      "read_artifact",
      "snapshot_worker",
      "retry_worker_finalization",
      "list_worker_files",
    ]),
  );
  // Retrieval is read-only; only explicit preservation and retry may mutate a worker.
  for (const name of [
    "list_artifacts",
    "get_artifact_metadata",
    "read_artifact",
    "list_worker_files",
  ])
    expect(
      tools.tools.find((t) => t.name === name)?.annotations?.readOnlyHint,
    ).toBe(true);
  for (const name of [
    "preserve_artifact",
    "snapshot_worker",
    "retry_worker_finalization",
  ])
    expect(
      tools.tools.find((t) => t.name === name)?.annotations?.readOnlyHint,
    ).toBe(false);
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
  const swarm = await client.callTool({
    name: "get_swarm_status",
    arguments: {},
  });
  expect(swarm.isError).not.toBe(true);
  expect(swarm.structuredContent).toMatchObject({
    metrics: { enabled: true, port: 9090 },
  });
  await client.close();
  await server.close();
  h.store.close();
  await guestCleanup();
});
test("artifact handles are bounded and path traversal and secret contents are blocked", async () => {
  const {
    h,
    write: guestWrite,
    cleanup: guestCleanup,
  } = await harnessWithGuest();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  guestWrite(".swarmforge/artifacts/report.txt", "x".repeat(100000));
  guestWrite(".swarmforge/artifacts/secret.txt", "model-secret");
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
  await guestCleanup();
});

for (const sample of [
  {
    name: "long MCP bearer",
    field: "SWARMFORGE_API_TOKEN",
    secret: `bearer-${"a".repeat(5000)}`,
    variant: "raw",
  },
  {
    name: "multibyte provider key",
    field: "FREESTYLE_API_TOKEN",
    secret: "界".repeat(2500),
    variant: "raw",
  },
  {
    name: "URL-encoded model key",
    field: "SWARMFORGE_MODEL_API_KEY",
    secret: "界".repeat(2000),
    variant: "url",
  },
  {
    name: "base64 provider key",
    field: "FREESTYLE_API_TOKEN",
    secret: `provider-${"b".repeat(5000)}`,
    variant: "base64",
  },
] as const) {
  test(`artifact chunk screening includes the full ${sample.name}`, async () => {
    const h = harness();
    try {
      h.coordinator.config[sample.field] = sample.secret;
      const w = h.coordinator.spawn(task);
      await runToRunning(h, w.worker_id);
      const secret =
        sample.variant === "url"
          ? encodeURIComponent(sample.secret)
          : sample.variant === "base64"
            ? Buffer.from(sample.secret).toString("base64")
            : sample.secret;
      const prefix = "artifact begins here ";
      await h.provider.writeFile(
        h.store.get(w.worker_id).vm_id!,
        "/workspace/.swarmforge/artifacts/credential.txt",
        `${prefix}${secret} harmless suffix`,
      );
      const offset = Buffer.byteLength(prefix + secret) - 64;
      await expect(
        new WorkerFiles(h.coordinator).readArtifact(
          w.worker_id,
          "credential.txt",
          offset,
          32,
        ),
      ).rejects.toThrow("Artifact contains credentials");
    } finally {
      h.store.close();
    }
  });
}
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
  const {
    h,
    write: guestWrite,
    cleanup: guestCleanup,
  } = await harnessWithGuest();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  guestWrite(".swarmforge/artifacts/report.txt", "hello");
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
    await guestCleanup();
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

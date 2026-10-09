import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectSwarmForge } from "../src/cli/client";
import { emptyFilters } from "../src/cli/filters";
import { Coordinator } from "../src/coordinator";
import { readOauthCredential } from "../src/github-oauth";
import { createHttpHandler } from "../src/http";
import { Store } from "../src/store";
import { harness, task } from "./helpers";

test("dashboard revisions include newly discovered repository credential redaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "swarmforge-dashboard-auth-"));
  const h = harness();
  const worker = h.store.create({ ...task, timeout_seconds: 60 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const client = await connectSwarmForge(`http://127.0.0.1:${server.port}/mcp`);
  try {
    const first = (await client.dashboard(emptyFilters(), "age"))!;
    const token = `dashboard_fixture_${randomUUID().replaceAll("-", "")}`;
    const path = join(directory, "github-oauth.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        clientId: "test_client",
        repository: "test/repository",
        login: "testuser",
        accessToken: token,
      }),
      { mode: 0o600 },
    );
    readOauthCredential(path);
    h.store.patch(worker.worker_id, { error: `repository rejected ${token}` });
    const update = (await client.dashboard(
      emptyFilters(),
      "age",
      0,
      first.revision,
    ))!;
    expect(update.workers[0]?.error).not.toContain(token);
    expect(update.revision).toBe(h.store.revision());
    expect(
      await client.dashboard(emptyFilters(), "age", 0, update.revision),
    ).toBeNull();
  } finally {
    await client.close();
    await server.stop(true);
    await h.coordinator.stop();
    h.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dashboard transfers bounded pages, detects unchanged data, applies deltas and resynchronizes query changes", async () => {
  const h = harness();
  for (let i = 0; i < 120; i++)
    h.store.create({ ...task, task_id: `task-${i}`, timeout_seconds: 60 });
  h.store.all = () => {
    throw new Error("Unbounded read");
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const client = await connectSwarmForge(`http://127.0.0.1:${server.port}/mcp`);
  try {
    const filters = emptyFilters();
    const first = (await client.dashboard(filters, "age"))!;
    expect(first.workers).toHaveLength(50);
    expect(first.page?.total).toBe(120);
    expect(first.total).toBe(120);
    expect(
      await client.dashboard(filters, "age", 0, first.revision),
    ).toBeNull();
    h.store.patch(first.workers[0]!.worker_id, { error: "new error" });
    const update = (await client.dashboard(filters, "age", 0, first.revision))!;
    expect("delta" in update && update.delta).toBe(true);
    expect(
      (update as typeof update & { changed_workers: unknown[] })
        .changed_workers,
    ).toHaveLength(1);
    expect(update.workers).toHaveLength(50);
    expect(update.workers[0]?.error).toBe("new error");
    const next = (await client.dashboard(filters, "age", 50, update.revision))!;
    expect(next.workers).toHaveLength(50);
    expect(next.workers[0]?.worker_id).not.toBe(first.workers[0]?.worker_id);
    const filtered = (await client.dashboard(
      { ...filters, task: "task-119" },
      "age",
      0,
      next.revision,
    ))!;
    expect(filtered.page?.total).toBe(1);
    expect(filtered.workers[0]?.task_id).toBe("task-119");
    // Unknown revision simulates reconnect/eviction; the server returns a complete snapshot.
    const recovered = (await client.dashboard(
      filters,
      "age",
      0,
      "old-process:revision",
    ))!;
    expect(recovered.workers).toHaveLength(50);
  } finally {
    await client.close();
    await server.stop(true);
    await h.coordinator.stop();
    h.store.close();
  }
});

test("older servers cannot silently execute settled cleanup", async () => {
  const h = harness();
  const handler = createHttpHandler(h.coordinator);
  let destructionRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "POST") {
        const rpc = (await request.clone().json()) as {
          id: unknown;
          method: string;
          params?: { name?: string };
        };
        if (rpc.method === "tools/list") {
          const tools = [
            {
              name: "destroy_worker",
              inputSchema: {
                type: "object",
                properties: {
                  worker_id: { type: "string" },
                  force: { type: "boolean" },
                },
              },
            },
          ];
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { tools },
          });
        }
        if (rpc.params?.name === "destroy_worker") destructionRequests++;
      }
      return handler(request);
    },
  });
  const client = await connectSwarmForge(`http://127.0.0.1:${server.port}/mcp`);
  try {
    await expect(
      client.control("worker", "destroy", { settledOnly: true }),
    ).rejects.toThrow("does not support settled cleanup");
    expect(destructionRequests).toBe(0);
  } finally {
    await client.close();
    await server.stop(true);
    h.store.close();
  }
});

test("a coordinator replacement at the same endpoint forces a complete revision resync", async () => {
  const h = harness();
  h.store.create({ ...task, timeout_seconds: 60 });
  let coordinator = h.coordinator;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => createHttpHandler(coordinator)(request),
  });
  const client = await connectSwarmForge(`http://127.0.0.1:${server.port}/mcp`);
  const next = new Store(":memory:");
  try {
    const first = (await client.dashboard(emptyFilters(), "recent"))!;
    next.create({ ...task, task_id: "after-restart", timeout_seconds: 60 });
    coordinator = new Coordinator(
      h.coordinator.config,
      next,
      h.provider,
      h.agent,
    );
    const recovered = (await client.dashboard(
      emptyFilters(),
      "recent",
      0,
      first.revision,
    ))!;
    expect(recovered.revision).not.toBe(first.revision);
    expect(recovered.workers[0]?.task_id).toBe("after-restart");
    expect("delta" in recovered && recovered.delta).toBe(false);
  } finally {
    await client.close();
    await server.stop(true);
    await coordinator.stop();
    await h.coordinator.stop();
    next.close();
    h.store.close();
  }
});

test("bounded dashboard navigation and filters clear page selections before a cleanup preview", async () => {
  const { EventEmitter } = await import("node:events");
  const { runDashboard } = await import("../src/cli/tui");
  const h = harness();
  for (let i = 0; i < 120; i++) {
    const w = h.store.create({
      ...task,
      task_id: `task-${i}`,
      timeout_seconds: 60,
    });
    h.store.cancelDispatches(w.worker_id);
    h.store.patch(w.worker_id, {
      state: "completed",
      vm_id: `vm-${i}`,
      finalization: {
        state: "preserved",
        attempts: 1,
        run_id: null,
        error: null,
        next_retry_at: null,
        started_at: null,
        completed_at: 1,
      },
    });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const client = await connectSwarmForge(`http://127.0.0.1:${server.port}/mcp`);
  const frames: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
  }) as unknown as typeof process.stdin;
  const output = Object.assign(new EventEmitter(), {
    columns: 150,
    rows: 50,
    write: (frame: string) => {
      frames.push(frame);
      return true;
    },
  }) as unknown as typeof process.stdout;
  const key = (name: string, text = "") =>
    input.emit("keypress", text, { name });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
    expect(predicate()).toBe(true);
  };
  const session = runDashboard(
    client,
    (await client.dashboard(emptyFilters(), "recent"))!,
    input,
    output,
    60000,
  );
  try {
    key("x");
    await wait(() => !!frames.at(-1)?.includes("HISTORY PAGE 1/3"));
    key("a");
    expect(frames.at(-1)).toContain("50 selected");
    key("]", "]");
    await wait(() => !!frames.at(-1)?.includes("HISTORY PAGE 2/3"));
    expect(frames.at(-1)).toContain("0 selected");
    key("a");
    key("k");
    for (const character of "task-119") key(character, character);
    key("return");
    await wait(() => !!frames.at(-1)?.includes("1 retained workers match"));
    expect(frames.at(-1)).toContain("0 selected");
    key("a");
    key("return");
    expect(frames.at(-1)).toContain("1 selected workers");
    key("z");
    expect(frames.at(-1)).toContain("1 selected workers");
    key("n");
    key("z");
    await wait(() => !!frames.at(-1)?.includes("HISTORY PAGE 1/3"));
    key("]", "]");
    await wait(() => !!frames.at(-1)?.includes("HISTORY PAGE 2/3"));
    for (const w of h.store.queryWorkers({ limit: 100 }).workers)
      h.store.patch(w.worker_id, { state: "destroyed" });
    for (const w of h.store.queryWorkers({ limit: 100, offset: 100 }).workers)
      h.store.patch(w.worker_id, { state: "destroyed" });
    key("r");
    await wait(() => !!frames.at(-1)?.includes("HISTORY PAGE 1/1"));
    expect(frames.at(-1)).toContain("No matching retained VMs");
  } finally {
    key("q");
    await session;
    await client.close();
    await server.stop(true);
    await h.coordinator.stop();
    h.store.close();
  }
});

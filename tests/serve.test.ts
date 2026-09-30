import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Subprocess } from "bun";
import { type Config, loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import { acquireProcessLock } from "../src/runtime";
import { startServer, startupGate } from "../src/serve";
import { runServe, shutdownTimeoutMs } from "../src/serve-command";
import { Store } from "../src/store";
import { FakeAgent, FakeProvider, task } from "./helpers";

const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

function freePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const { port } = probe;
  void probe.stop(true);
  if (port === undefined) throw new Error("probe listener reported no port");
  return port;
}

async function reservePort(port: number) {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("free"),
  });
  await probe.stop(true);
}

// SQLite is a real file: an open database still has live descriptors, so an unclosed store
// is observable instead of inferred from a successful restart.
function openDatabaseHandles(path: string): number {
  let open = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`).startsWith(path)) open++;
    } catch {}
  }
  return open;
}

function deferred<T = void>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function gate() {
  const opened = deferred();
  return { released: opened.promise, open: () => opened.settle() };
}

function serveConfig(
  dbPath: string,
  port: number,
  metricsPort: number,
  extra: Record<string, string> = {},
): Config {
  return loadConfig({
    FREESTYLE_API_TOKEN: "infra-secret",
    FREESTYLE_SNAPSHOT_ID: "snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "model-secret",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "opaque-tree",
    SWARMFORGE_DB_PATH: dbPath,
    SWARMFORGE_HOST: "127.0.0.1",
    SWARMFORGE_PORT: String(port),
    SWARMFORGE_METRICS_PORT: String(metricsPort),
    SWARMFORGE_POLL_INTERVAL_MS: "50",
    ...extra,
  });
}

function seedQueued(dbPath: string, config: Config) {
  const store = new Store(dbPath);
  const worker = new Coordinator(
    config,
    store,
    new FakeProvider(),
    new FakeAgent(),
  ).spawn(task);
  store.close();
  return worker;
}

async function seedRunning(dbPath: string, config: Config) {
  const provider = new FakeProvider();
  const agent = new FakeAgent();
  const store = new Store(dbPath);
  const coordinator = new Coordinator(config, store, provider, agent);
  const worker = coordinator.spawn(task);
  for (let pass = 0; pass < 8; pass++) {
    await coordinator.tick();
    if (store.get(worker.worker_id).state === "running") break;
  }
  expect(store.get(worker.worker_id).state).toBe("running");
  store.close();
  return { worker, provider, agent };
}

function mcpRequest(url: string) {
  return new Request(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "serve-test", version: "1" },
      },
    }),
  });
}

function collect(stream: ReadableStream<Uint8Array>) {
  let text = "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return { read: () => text, done };
}

function spawnServeChild(
  dbPath: string,
  port: number,
  metricsPort: number,
  mode: string,
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      fixture("serve-command-child.ts"),
      dbPath,
      String(port),
      String(metricsPort),
      mode,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  const out = collect(proc.stdout as ReadableStream<Uint8Array>);
  const err = collect(proc.stderr as ReadableStream<Uint8Array>);
  return {
    proc,
    stdout: out.read,
    stderr: err.read,
    done: Promise.all([out.done, err.done]).then(() => {}),
  } satisfies {
    proc: Subprocess;
    stdout: () => string;
    stderr: () => string;
    done: Promise<void>;
  };
}

async function waitFor(read: () => string, needle: string, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  while (!read().includes(needle)) {
    if (Date.now() > deadline)
      throw new Error(`serve child never reported ${needle}: ${read()}`);
    await Bun.sleep(20);
  }
}

test("importing the serve modules acquires no resources and installs no signal handlers", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-import-"));
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", fixture("serve-import.ts")],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    // The child exits on its own: no timer, listener or signal handler kept it alive.
    expect(
      await Promise.race([proc.exited, Bun.sleep(10000).then(() => "hung")]),
    ).toBe(0);
    expect(err).toBe("");
    expect(JSON.parse(out.trim())).toEqual({
      sigterm: 0,
      sigint: 0,
      beforeExit: 0,
      exit: 0,
      handles: [],
      exports: [
        "abortError",
        "defaultShutdownTimeoutMs",
        "forcedShutdownExitCode",
        "isAbortError",
        "runServe",
        "shutdownTimeoutMs",
        "startServer",
        "startupGate",
      ],
    });
  } finally {
    proc.kill(9);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("an occupied API port releases the metrics listener and the lock and never provisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-api-bind-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const worker = seedQueued(dbPath, config);
  const squatter = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("held"),
  });
  const provider = new FakeProvider();
  try {
    await expect(
      startServer(config, { provider, agent: new FakeAgent() }),
    ).rejects.toThrow(/in use/i);
    // Listeners are reserved before periodic provisioning, so no VM was requested.
    expect(provider.created).toBe(0);
    await squatter.stop(true);
    await reservePort(metricsPort);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
    const store = new Store(dbPath);
    expect(store.get(worker.worker_id).state).toBe("queued");
    store.close();
  } finally {
    await squatter.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an occupied metrics port releases the API listener and the lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-metrics-bind-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const squatter = Bun.serve({
    hostname: "127.0.0.1",
    port: metricsPort,
    fetch: () => new Response("held"),
  });
  const provider = new FakeProvider();
  try {
    await expect(
      startServer(config, { provider, agent: new FakeAgent() }),
    ).rejects.toThrow(/in use/i);
    await squatter.stop(true);
    await reservePort(port);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
    const locked = acquireProcessLock(`${dbPath}.lock`);
    locked();
  } finally {
    await squatter.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a database owned by another instance rolls back every acquired resource", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-owner-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const seeded = new Store(dbPath);
  seeded.setting("instance_id", "other");
  seeded.close();
  try {
    await expect(
      startServer(config, {
        provider: new FakeProvider(),
        agent: new FakeAgent(),
      }),
    ).rejects.toThrow(/instance id differs/i);
    await reservePort(port);
    await reservePort(metricsPort);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
    const store = new Store(dbPath);
    expect(store.setting("instance_id")).toBe("other");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed recovery releases the lock, the database and both ports", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-recover-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const provider = new FakeProvider();
  provider.listWorkers = async () => {
    throw new Error("provider unavailable");
  };
  try {
    await expect(
      startServer(config, { provider, agent: new FakeAgent() }),
    ).rejects.toThrow(/provider unavailable/);
    await reservePort(port);
    await reservePort(metricsPort);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a startup aborted before any resource is acquired opens nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-preabort-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const controller = new AbortController();
  controller.abort();
  try {
    const failure = await startServer(config, {
      signal: controller.signal,
      provider: new FakeProvider(),
      agent: new FakeAgent(),
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.name).toBe("AbortError");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an abort during recovery keeps the database open until the in-flight writer finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-abort-recovery-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  new Store(dbPath).close();
  const provider = new FakeProvider();
  const reconciling = deferred();
  const blocked = gate();
  provider.listWorkers = async () => [
    { id: "vm-orphan", slug: "orphan", state: "running" },
  ];
  // Recovery adopts the orphan durably, then blocks on a provider call that cannot be
  // cancelled: the rollback must wait for that writer instead of closing under it.
  provider.getWorker = async () => {
    reconciling.settle();
    await blocked.released;
    return { id: "vm-orphan", slug: "orphan", state: "running" };
  };
  const controller = new AbortController();
  const outcome = startServer(config, {
    signal: controller.signal,
    provider,
    agent: new FakeAgent(),
  }).then(
    () => "resolved" as const,
    (error: unknown) => (error as Error).name,
  );
  try {
    await reconciling.promise;
    controller.abort();
    await Bun.sleep(50);
    expect(openDatabaseHandles(dbPath)).toBeGreaterThan(0);
    blocked.open();
    expect(await outcome).toBe("AbortError");
    expect(openDatabaseHandles(dbPath)).toBe(0);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    await reservePort(port);
    const store = new Store(dbPath);
    const [retained] = store.all();
    expect(retained?.state).toBe("recovery_required");
    expect(retained?.vm_id).toBe("vm-orphan");
    store.close();
  } finally {
    controller.abort();
    blocked.open();
    await outcome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("listeners are reserved before provisioning, refuse mutations until ready, and an abort then frees both ports", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-notready-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const worker = seedQueued(dbPath, config);
  const provider = new FakeProvider();
  const observed = deferred<{ mutation: number; health: number }>();
  const blocked = gate();
  let provisions = 0;
  provider.createWorker = async (w) => {
    provisions++;
    // Startup is past recovery and serving, so the probe can only meet the readiness gate.
    observed.settle({
      mutation: (await fetch(mcpRequest(`http://127.0.0.1:${port}`))).status,
      health: (await fetch(`http://127.0.0.1:${port}/health`)).status,
    });
    await blocked.released;
    return {
      id: `vm-${w.worker_id}`,
      slug: w.worker_id,
      state: "running",
      worker_id: w.worker_id,
    };
  };
  const controller = new AbortController();
  const outcome = startServer(config, {
    signal: controller.signal,
    provider,
    agent: new FakeAgent(),
  }).then(
    () => "resolved" as const,
    (error: unknown) => (error as Error).name,
  );
  try {
    expect(await observed.promise).toEqual({ mutation: 503, health: 200 });
    // Provisioning started only once the listeners were reserved.
    expect(provisions).toBe(1);
    controller.abort();
    await Bun.sleep(50);
    expect(openDatabaseHandles(dbPath)).toBeGreaterThan(0);
    blocked.open();
    expect(await outcome).toBe("AbortError");
    await reservePort(port);
    await reservePort(metricsPort);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
    // The interrupted write survived: it landed before the database was closed.
    const store = new Store(dbPath);
    expect(store.get(worker.worker_id).state).toBe("booting");
    expect(store.get(worker.worker_id).vm_id).not.toBeNull();
    const settled = store.latestEventId();
    store.close();
    // No periodic provisioning survives the rollback: a 50 ms poll would move this worker on.
    await Bun.sleep(200);
    const quiet = new Store(dbPath);
    expect(quiet.latestEventId()).toBe(settled);
    expect(quiet.get(worker.worker_id).state).toBe("booting");
    quiet.close();
  } finally {
    controller.abort();
    blocked.open();
    await outcome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("the startup gate refuses mutations while starting and delegates only once open", async () => {
  const seen: string[] = [];
  const gate = startupGate(async (request) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ ok: true });
  });
  const refused = await gate.fetch(
    new Request("http://127.0.0.1/mcp", { method: "POST" }),
  );
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ error: expect.any(String) });
  expect(
    (await gate.fetch(new Request("http://127.0.0.1/health"))).status,
  ).toBe(200);
  gate.open();
  expect(
    (await gate.fetch(new Request("http://127.0.0.1/mcp", { method: "POST" })))
      .status,
  ).toBe(200);
  gate.close();
  expect(
    (await gate.fetch(new Request("http://127.0.0.1/health"))).status,
  ).toBe(503);
  expect(seen).toEqual(["GET /health", "POST /mcp"]);
});

test("a normal stop flushes events, releases both listeners and the lock and closes the database", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-stop-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  seedQueued(dbPath, config);
  const provider = new FakeProvider();
  const handle = await startServer(config, {
    provider,
    agent: new FakeAgent(),
  });
  try {
    expect((await fetch(`${handle.url}/health`)).status).toBe(200);
    const metrics = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("swarmforge_workers");
    const client = new Client({ name: "serve-lead", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`)),
    );
    const spawned = await client.callTool({
      name: "spawn_worker",
      arguments: { ...task, task_id: "after-startup" },
    });
    expect(spawned.isError).not.toBe(true);
    await client.close();
    await handle.stop();
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
    await reservePort(port);
    await reservePort(metricsPort);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
    expect(readFileSync(`${dbPath}.log`, "utf8")).toContain("worker.requested");
  } finally {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("repeated stop calls share one idempotent shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-repeat-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const handle = await startServer(config, {
    provider: new FakeProvider(),
    agent: new FakeAgent(),
  });
  try {
    const first = handle.stop();
    expect(handle.stop()).toBe(first);
    await Promise.all([first, handle.stop(), handle.stop()]);
    await handle.stop();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    expect(openDatabaseHandles(dbPath)).toBe(0);
    await reservePort(port);
  } finally {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("a blocked worker operation finishes its durable write before the database closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-drain-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const seeded = await seedRunning(dbPath, config);
  const provider = seeded.provider;
  const observed = provider.getWorker.bind(provider);
  const reconciling = deferred();
  const blocked = gate();
  let armed = false;
  provider.getWorker = async (id) => {
    if (!armed) return observed(id);
    reconciling.settle();
    await blocked.released;
    return {
      id,
      slug: id,
      state: "paused",
      worker_id: seeded.worker.worker_id,
    };
  };
  const handle = await startServer(config, {
    provider,
    agent: seeded.agent,
  });
  try {
    armed = true;
    await reconciling.promise;
    const stopping = handle.stop();
    expect(
      await Promise.race([
        stopping.then(() => "stopped"),
        Bun.sleep(150).then(() => "still-draining"),
      ]),
    ).toBe("still-draining");
    expect(openDatabaseHandles(dbPath)).toBeGreaterThan(0);
    blocked.open();
    await stopping;
    expect(openDatabaseHandles(dbPath)).toBe(0);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    // The paused transition is durable, so it was written while the database was still open.
    const store = new Store(dbPath);
    expect(store.get(seeded.worker.worker_id).state).toBe("paused");
    store.close();
  } finally {
    blocked.open();
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("shutdown is not held open by an in-flight state-change wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-wait-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort, {
    SWARMFORGE_POLL_INTERVAL_MS: "60000",
  });
  const handle = await startServer(config, {
    provider: new FakeProvider(),
    agent: new FakeAgent(),
  });
  const client = new Client({ name: "serve-waiter", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`)),
    );
    const waiting = client
      .callTool({
        name: "wait_for_state_change",
        arguments: { timeout_ms: 25000 },
      })
      .then(
        () => "settled",
        () => "settled",
      );
    await Bun.sleep(100);
    const startedAt = Date.now();
    await handle.stop();
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(await waiting).toBe("settled");
    expect(openDatabaseHandles(dbPath)).toBe(0);
  } finally {
    await client.close();
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("the serve command reports a startup failure as a nonzero exit code", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-command-fail-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const config = serveConfig(dbPath, port, metricsPort);
  const lines: string[] = [];
  const errors: string[] = [];
  const held = acquireProcessLock(`${dbPath}.lock`);
  try {
    expect(
      await runServe(config, {
        provider: new FakeProvider(),
        agent: new FakeAgent(),
        env: {},
        log: (line) => lines.push(line),
        logError: (line) => errors.push(line),
      }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/Startup failed/);
    expect(lines).toEqual([]);
  } finally {
    held();
    expect(process.listenerCount("SIGTERM")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(0);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("the serve command refuses a shutdown deadline that is not a positive integer", async () => {
  expect(shutdownTimeoutMs({})).toBe(60000);
  expect(shutdownTimeoutMs({ SWARMFORGE_SHUTDOWN_TIMEOUT_MS: " 1500 " })).toBe(
    1500,
  );
  for (const value of ["0", "-1", "1.5", "soon"])
    expect(() =>
      shutdownTimeoutMs({ SWARMFORGE_SHUTDOWN_TIMEOUT_MS: value }),
    ).toThrow(/positive integer/);
  const root = mkdtempSync(join(tmpdir(), "sf-serve-command-deadline-value-"));
  const config = serveConfig(join(root, "db.sqlite"), freePort(), freePort());
  const errors: string[] = [];
  try {
    expect(
      await runServe(config, {
        provider: new FakeProvider(),
        agent: new FakeAgent(),
        env: { SWARMFORGE_SHUTDOWN_TIMEOUT_MS: "0" },
        logError: (line) => errors.push(line),
      }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/positive integer/);
    expect(existsSync(`${config.SWARMFORGE_DB_PATH}.lock`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("the serve command exits cleanly once when SIGTERM and SIGINT both arrive", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-command-term-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const child = spawnServeChild(dbPath, port, metricsPort, "clean");
  try {
    await waitFor(child.stdout, "SwarmForge listening");
    child.proc.kill("SIGTERM");
    child.proc.kill("SIGINT");
    expect(
      await Promise.race([
        Promise.all([child.proc.exited, child.done]),
        Bun.sleep(20000).then(() => "hung" as const),
      ]),
    ).toEqual([0, undefined]);
    // A repeated signal is ignored by the shutdown that already owns the release.
    expect(child.stdout().split("Shutdown requested")).toHaveLength(2);
    expect(child.stdout().split("Shutdown complete")).toHaveLength(2);
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    const store = new Store(dbPath);
    expect(store.all()).toHaveLength(1);
    store.close();
  } finally {
    child.proc.kill(9);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("a signal during a slow startup cancels it and exits zero once the in-flight recovery drains", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-command-slow-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const child = spawnServeChild(dbPath, port, metricsPort, "slow");
  try {
    await waitFor(child.stdout, "recovery-blocked");
    child.proc.kill("SIGTERM");
    expect(
      await Promise.race([
        Promise.all([child.proc.exited, child.done]),
        Bun.sleep(20000).then(() => "hung" as const),
      ]),
    ).toEqual([0, undefined]);
    expect(child.stdout()).toContain("Startup cancelled");
    // Nothing was ever serving, so there is no running server to shut down.
    expect(child.stdout()).not.toContain("Shutdown complete");
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    const store = new Store(dbPath);
    expect(store.all()).toHaveLength(1);
    store.close();
  } finally {
    child.proc.kill(9);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("the serve command hard-exits nonzero at the shutdown deadline with durable state retained", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-serve-command-deadline-"));
  const dbPath = join(root, "db.sqlite");
  const port = freePort();
  const metricsPort = freePort();
  const child = spawnServeChild(dbPath, port, metricsPort, "blocked", {
    SWARMFORGE_SHUTDOWN_TIMEOUT_MS: "400",
  });
  try {
    await waitFor(child.stdout, "provisioning-blocked");
    const signalledAt = Date.now();
    child.proc.kill("SIGTERM");
    expect(
      await Promise.race([
        Promise.all([child.proc.exited, child.done]),
        Bun.sleep(20000).then(() => "hung" as const),
      ]),
    ).toEqual([70, undefined]);
    expect(Date.now() - signalledAt).toBeLessThan(15000);
    expect(child.stderr()).toContain("Shutdown deadline exceeded");
    expect(child.stdout()).not.toContain("Shutdown complete");
    // The interrupted intent is still durable and the operating system released the lock.
    const store = new Store(dbPath);
    expect(store.all()[0]?.state).toBe("provisioning");
    store.close();
    const reacquired = acquireProcessLock(`${dbPath}.lock`);
    reacquired();
  } finally {
    child.proc.kill(9);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { localFixture } from "./local-fixture.ts";

// Load the actual sibling package at runtime. Each package type-checks its
// own platform globals separately: importing Bun engine implementation into
// the Workers compilation would mix incompatible process/HTTP declarations.
// This adapter exists only in the cross-package integration test.
const engine = (file: string) =>
  import(new URL(`../../../src/${file}`, import.meta.url).href);
const [
  { runSupervisorLoop },
  { loadConfig },
  { Coordinator },
  { HostedTaskClient, SupervisorClient },
  { ControlledAgent, ControlledProcessProvider },
  { HostedStore },
  { HostedSupervisor },
  { Store },
] = await Promise.all([
  engine("cli/hosted.ts"),
  engine("config.ts"),
  engine("coordinator.ts"),
  engine("hosted-client.ts"),
  engine("hosted-runtime.ts"),
  engine("hosted-store.ts"),
  engine("hosted-supervisor.ts"),
  engine("store.ts"),
]);

// Real production Worker handlers + production Bun supervisor/coordinator +
// real fixed inert subprocess. Cloud storage uses the complementary SQLite
// adapter; fetch is injected in-process. No live D1/HTTP/durable-file claim.
async function fixture() {
  const cloud = await localFixture();
  const a = await cloud.login();
  const w = await cloud.enrolledWorker(a);
  await cloud.seedPolicy(a.tenant, {
    capabilities: {
      hosted_control_plane: true,
      remote_worker_enrollment: true,
      hosted_task_execution: true,
    },
    max_concurrent_workers: 1,
    max_active_tasks: 1,
    max_task_runtime: 60000,
    maximum_resource_reservations: 1,
    valid_for_ms: 3600000,
    allowances: [
      {
        resource: "compute_ms",
        unit: "millisecond",
        resource_class: "controlled",
        allowed_quantity: "120000",
      },
    ],
  });
  const linked = await cloud.linked(a);
  const grantResponse = await cloud.request(
    `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
    { ...a.headers, "idempotency-key": crypto.randomUUID() },
    "POST",
    {},
  );
  expect(grantResponse.status).toBe(201);
  const grant = (await grantResponse.json()) as { credential: string };
  const s = await cloud.registerSupervisor(a, w.worker_id);
  const origin = cloud.env.APP_ORIGIN;
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      cloud.fetch(new Request(input, init)),
    { preconnect: () => {} },
  );
  const taskClient = new HostedTaskClient(
    origin,
    grant.credential,
    a.tenant,
    transport,
  );
  const client = new SupervisorClient(
    origin,
    s.credential,
    a.tenant,
    transport,
  );
  expect((await client.identity()).supervisor_id).toBe(s.supervisor_id);
  const config = loadConfig({
    FREESTYLE_API_TOKEN: "synthetic-hosted-test-token",
    FREESTYLE_SNAPSHOT_ID: "synthetic-hosted-test-snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example.invalid/v1",
    SWARMFORGE_MODEL_API_KEY: "synthetic-hosted-test-model-key",
    SWARMFORGE_MODEL_NAME: "synthetic-hosted-test-model",
    SWARMFORGE_GIT_TREE: "synthetic-hosted-test-tree",
    SWARMFORGE_DB_PATH: ":memory:",
    SWARMFORGE_GIT_PUSH_MODE: "none",
    SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "0",
  });
  const store = new Store(":memory:");
  const hostedStore = new HostedStore(":memory:");
  const provider = new ControlledProcessProvider();
  const agent = new ControlledAgent();
  const coordinator = new Coordinator(config, store, provider, agent);
  const supervisor = new HostedSupervisor({
    config,
    store,
    hostedStore,
    provider,
    agent,
    coordinator,
    client,
    supervisorCredential: () => s,
  });
  return {
    cloud,
    a,
    w,
    taskClient,
    supervisor,
    provider,
    store,
    hostedStore,
    async close() {
      await supervisor.close();
      await coordinator.stop();
      hostedStore.close();
      store.close();
      cloud.close();
    },
  };
}

test("controlled task crosses real Worker/Bun code, completes its child, and settles the reserved meter once", async () => {
  const h = await fixture();
  try {
    const admitted = await h.taskClient.submitTask(h.w.worker_id, 60000, 350);
    const result = await runSupervisorLoop(h.supervisor);
    expect(result).toEqual({
      claimed: 1,
      completed: [admitted.task.task_id],
      cancelled: [],
      failed: [],
      held: [],
      claim_failed: false,
    });
    expect((await h.taskClient.readTask(admitted.task.task_id)).state).toBe(
      "completed",
    );
    const mapping = h.hostedStore.get(admitted.task.task_id)!;
    expect(mapping.state).toBe("settled");
    expect(mapping.stop_confirmed).toBe(true);
    expect(mapping.consumed_runtime_ms).toBeGreaterThanOrEqual(350);
    expect(mapping.consumed_runtime_unknown).toBe(false);
    expect(h.provider.spawnedCommands).toHaveLength(1);
    expect(
      h.cloud.db.sqlite
        .query(
          "SELECT consumed_quantity,reserved_quantity FROM hosted_allowances",
        )
        .get(),
    ).toEqual({
      consumed_quantity: String(mapping.consumed_runtime_ms),
      reserved_quantity: "0",
    });
    await h.supervisor.settle(admitted.task.task_id, "completed");
    expect(h.provider.spawnedCommands).toHaveLength(1);
    expect(
      h.cloud.db.sqlite
        .query(
          "SELECT count(*) n FROM hosted_operations WHERE operation='dispatch.settle'",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    await h.close();
  }
}, 15000);

test("cloud cancellation stops the actual child, retains capacity until stop proof, and exposes no ambient credentials", async () => {
  const h = await fixture();
  const secretName = "SWARMFORGE_HOSTED_TEST_SECRET";
  const original = process.env[secretName];
  process.env[secretName] = "synthetic-exfiltration-sentinel";
  try {
    const admitted = await h.taskClient.submitTask(h.w.worker_id, 60000, 25000);
    const loop = runSupervisorLoop(h.supervisor);
    const deadline = performance.now() + 3000;
    while (
      h.hostedStore.get(admitted.task.task_id)?.state !== "running" &&
      performance.now() < deadline
    )
      await Bun.sleep(10);
    const mapping = h.hostedStore.get(admitted.task.task_id)!;
    expect(mapping.state).toBe("running");
    expect(mapping.child_pid).toBeGreaterThan(0);
    const childEnv = readFileSync(`/proc/${mapping.child_pid}/environ`, "utf8");
    expect(childEnv).not.toContain(secretName);
    expect(childEnv).not.toContain("synthetic-hosted-test-model-key");
    expect(childEnv).not.toContain("GITHUB");
    await h.taskClient.cancelTask(admitted.task.task_id);
    expect(
      h.cloud.db.sqlite.query("SELECT state FROM hosted_reservations").get(),
    ).toEqual({ state: "quarantined" });
    expect(
      h.cloud.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "60000" });
    const result = await loop;
    expect(result.cancelled).toEqual([admitted.task.task_id]);
    expect(result.completed).toEqual([]);
    expect(result.held).toEqual([]);
    expect(() => process.kill(mapping.child_pid!, 0)).toThrow();
    expect(h.hostedStore.get(admitted.task.task_id)?.stop_confirmed).toBe(true);
    expect((await h.taskClient.readTask(admitted.task.task_id)).state).toBe(
      "cancelled",
    );
    expect(
      h.cloud.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "0" });
  } finally {
    if (original === undefined) delete process.env[secretName];
    else process.env[secretName] = original;
    await h.close();
  }
}, 35000);

test("task client retries preserve logical admission across client calls and reject changed work", async () => {
  const h = await fixture();
  try {
    const key = crypto.randomUUID();
    const first = await h.taskClient.submitTask(h.w.worker_id, 60000, 350, key);
    const retry = await h.taskClient.submitTask(h.w.worker_id, 60000, 350, key);
    expect(retry.task.task_id).toBe(first.task.task_id);
    expect(
      h.cloud.db.sqlite.query("SELECT count(*) n FROM hosted_tasks").get(),
    ).toEqual({ n: 1 });
    await expect(
      h.taskClient.submitTask(h.w.worker_id, 60000, 351, key),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      h.cloud.db.sqlite
        .query("SELECT count(*) n FROM hosted_reservations")
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    await h.close();
  }
});

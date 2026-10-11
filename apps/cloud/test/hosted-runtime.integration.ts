import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PolicyInput } from "../src/hosted-entitlements.ts";
import { fixture } from "./machine-helpers.ts";

// End-to-end hosted lifecycle qualification.
//
// This is the integration point the two existing suites leave open:
//   * hosted-bun.test.ts runs the real Bun HostedSupervisor over the real
//     production Worker handlers with in-process fetch and bun:sqlite.
//   * worker-client.integration.ts runs a real Bun client against real
//     workerd/D1 through a Node loopback HTTP bridge.
// This file joins them on the actual DEFAULT production worker: the existing
// machine-helpers.ts fixture bundles and runs src/index.ts createWorker (the
// real default route/middleware, not a hosted-only router source) under real
// local Miniflare/workerd with real D1, reached over the same Node loopback
// HTTP bridge pattern, while the real Bun HostedSupervisor + Coordinator +
// ControlledProcessProvider + HostedTaskClient + SupervisorClient run in an
// actual Bun subprocess with protected temporary SQLite journals and a real
// inert child process. The GitHub identity fixture is synthetic (user100)
// and no live Cloudflare or customer endpoint is contacted.

const BUN = process.env.SWARMFORGE_TEST_BUN ?? "bun";
const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

const policy = {
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
} satisfies PolicyInput;

interface DriverInput {
  origin: string;
  tenant: string;
  workerId: string;
  taskCredential: string;
  supervisor: {
    credential: string;
    supervisor_id: string;
    tenant_id: string;
    expires_at: number;
    authorization_expires_at: number;
  };
  dbPath: string;
  statePath: string;
  runtimeMs: number;
  controlledDurationMs: number;
  ackMode?: "none" | "once" | "always";
  submit?: boolean;
  expired?: boolean;
  crash?: boolean;
  exitEarly?: boolean;
}

function driverScript(): string {
  return `
const SRC = ${JSON.stringify(SRC)};
const [
  { loadConfig },
  { Coordinator },
  { HostedTaskClient, SupervisorClient },
  { ControlledAgent, ControlledProcessProvider },
  { HostedStore },
  { HostedSupervisor },
  { Store },
  { runSupervisorLoop },
] = await Promise.all([
  import(SRC + "config.ts"),
  import(SRC + "coordinator.ts"),
  import(SRC + "hosted-client.ts"),
  import(SRC + "hosted-runtime.ts"),
  import(SRC + "hosted-store.ts"),
  import(SRC + "hosted-supervisor.ts"),
  import(SRC + "store.ts"),
  import(SRC + "cli/hosted.ts"),
]);

const input = JSON.parse(await Bun.stdin.text());
const out = {};

// Test-only minimal hook: emit intentionally unparsable stdout and exit 0 so
// the harness rejection path (malformed stdout / early exit) is exercised.
if (input.exitEarly) {
  process.stdout.write("synthetic malformed non-json driver output");
  process.exit(0);
}

// Production objects live in these outer bindings so the finally block can
// stop the actual grandchild through the production supervisor/provider (not
// a bare parent kill) before the process exits.
let supervisor = null;
let coordinator = null;
let store = null;
let hostedStore = null;
let provider = null;
let taskClient = null;
let childPid = null;
let taskId = null;
let cleaned = false;
const cleanupErrors = [];
const message = (error) => (error instanceof Error ? error.message : String(error));

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    if (supervisor) await supervisor.close();
  } catch (error) {
    cleanupErrors.push("supervisor.close: " + message(error));
  }
  try {
    if (coordinator) await coordinator.stop();
  } catch (error) {
    cleanupErrors.push("coordinator.stop: " + message(error));
  }
  try {
    if (store) store.close();
  } catch (error) {
    cleanupErrors.push("store.close: " + message(error));
  }
}

// Bounded graceful shutdown: a parent SIGTERM runs the production cleanup
// (verified child stop) before exit. If the parent is SIGKILLed instead, the
// child's stdin EOF/close handler still terminates the grandchild, so no
// runtime is left executing.
let terminating = false;
const terminate = (code) => {
  if (terminating) return;
  terminating = true;
  void cleanup().finally(() => process.exit(code));
};
process.on("SIGTERM", () => terminate(143));
process.on("SIGINT", () => terminate(130));

try {
  const config = loadConfig({
    FREESTYLE_API_TOKEN: "synthetic-hosted-test-token",
    FREESTYLE_SNAPSHOT_ID: "synthetic-hosted-test-snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example.invalid/v1",
    SWARMFORGE_MODEL_API_KEY: "synthetic-hosted-test-model-key",
    SWARMFORGE_MODEL_NAME: "synthetic-hosted-test-model",
    SWARMFORGE_GIT_TREE: "synthetic-hosted-test-tree",
    SWARMFORGE_DB_PATH: input.dbPath,
    SWARMFORGE_GIT_PUSH_MODE: "none",
    SWARMFORGE_METRICS_ENABLED: "false",
    SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "0",
  });
  store = new Store(input.dbPath);
  hostedStore = new HostedStore(input.statePath);
  provider = new ControlledProcessProvider();
  const agent = new ControlledAgent();
  coordinator = new Coordinator(config, store, provider, agent);

  let ackCalls = 0;
  let renewCalls = 0;
  const mode = input.ackMode ?? "none";
  const baseFetch = fetch;
  const transport = Object.assign(
    async (url, init) => {
      const target = String(url);
      const isAck = target.includes("/ack");
      const isRenew = target.includes("/renew");
      if (isAck) {
        ackCalls++;
        if (mode === "always") throw new Error("synthetic ack network loss");
        if (mode === "once" && ackCalls === 1) {
          const response = await baseFetch(url, init);
          // Consume the real (small) reply body before deliberately failing,
          // so the lost-ACK simulation leaks no unconsumed stream. The reply
          // is discarded, never fed back to the client as a fake delivery.
          await response.arrayBuffer();
          throw new Error("synthetic lost ack reply");
        }
      }
      if (isRenew) renewCalls++;
      return baseFetch(url, init);
    },
    { preconnect() {} },
  );
  const active = mode !== "none";
  taskClient = new HostedTaskClient(
    input.origin,
    input.taskCredential,
    input.tenant,
    active ? transport : undefined,
  );
  const client = new SupervisorClient(
    input.origin,
    input.supervisor.credential,
    input.tenant,
    active ? transport : undefined,
  );
  if (!input.expired) {
    const identity = await client.identity();
    out.identity_ok = identity.supervisor_id === input.supervisor.supervisor_id;
  }
  supervisor = new HostedSupervisor({
    config,
    store,
    hostedStore,
    provider,
    agent,
    coordinator,
    client,
    supervisorCredential: () =>
      input.expired ? { ...input.supervisor, expires_at: 1 } : input.supervisor,
  });
  let submitted = null;
  if (input.submit !== false) {
    submitted = await taskClient.submitTask(
      input.workerId,
      input.runtimeMs,
      input.controlledDurationMs,
    );
    taskId = submitted.task.task_id;
    out.submitted_task_id = taskId;
  }
  // Failure-path regression: start the real child, then throw while it is
  // alive. The finally block must stop it through the production supervisor.
  if (input.crash) {
    const task = await supervisor.claimOnce();
    if (!task) throw new Error("crash mode expected a claimable task");
    taskId = task.task_id;
    out.submitted_task_id = taskId;
    const run = await supervisor.ackAndStart(task);
    void run;
    const mapping = hostedStore.get(taskId);
    childPid = mapping ? mapping.child_pid : null;
    out.child_pid = childPid;
    throw new Error("synthetic in-flight failure while real child is alive");
  }
  const result = await runSupervisorLoop(supervisor, { maxTasks: 1 });
  out.loop_result = result;
  if (taskId) {
    out.task_state = (await taskClient.readTask(taskId)).state;
    const mapping = hostedStore.get(taskId);
    out.mapping = mapping
      ? {
          state: mapping.state,
          stop_confirmed: mapping.stop_confirmed,
          consumed_runtime_ms: mapping.consumed_runtime_ms,
          consumed_runtime_unknown: mapping.consumed_runtime_unknown,
          local_worker_id: mapping.local_worker_id,
          child_pid: mapping.child_pid,
        }
      : null;
    if (mapping && mapping.child_pid) childPid = mapping.child_pid;
  }
  out.ack_calls = ackCalls;
  out.renew_calls = renewCalls;
  out.ok = true;
} catch (error) {
  out.ok = false;
  out.error = message(error);
  out.errorName = error instanceof Error ? error.constructor.name : typeof error;
} finally {
  await cleanup();
}

if (provider) out.spawned = provider.spawnedCommands.slice();

// Durability evidence: the journal is reopened from the protected temp file
// after the production cleanup closed it, and the same mapping/stop proof is
// read. Retained on both the success and the failure path.
try {
  const reopened = new HostedStore(input.statePath);
  if (taskId) {
    const row = reopened.get(taskId);
    out.reopened_mapping = row
      ? {
          state: row.state,
          stop_confirmed: row.stop_confirmed,
          lease_id: row.lease_id,
          fence: row.fence,
        }
      : null;
  }
  reopened.close();
} catch (error) {
  out.reopen_error = message(error);
}

// Child absence is only proven by a real ESRCH AFTER production cleanup.
// EPERM (alive but not signalable) or any other/unknown error must fail the
// qualification rather than be reported as a confirmed dead child.
if (childPid) {
  if (!out.child_pid) out.child_pid = childPid;
  try {
    process.kill(childPid, 0);
    out.pid_dead = false;
  } catch (error) {
    if (error && error.code === "ESRCH") out.pid_dead = true;
    else throw error;
  }
}
if (cleanupErrors.length) out.cleanup_errors = cleanupErrors;
process.stdout.write(JSON.stringify(out) + "\\n");
`;
}

interface DriverHandle {
  child: ReturnType<typeof spawn>;
  result: Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
}

function clip(text: string, limit = 2000): string {
  return text.length <= limit ? text : `...${text.slice(-limit)}`;
}

async function runDriver(
  directory: string,
  input: DriverInput,
  drivers: Set<DriverHandle>,
): Promise<DriverHandle> {
  const child = spawn(
    BUN,
    ["--no-env-file", "--config=/dev/null", "-e", driverScript()],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let stdinError: Error | null = null;
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  // Report stdin failures instead of swallowing them (a noop listener would
  // hide EPIPE). The error is recorded and surfaced through `result`.
  child.stdin!.on("error", (error) => {
    stdinError = error;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const result = exited.then((code) => {
    if (stdinError)
      throw new Error(
        `Bun driver stdin error: ${stdinError.message}; stderr=${clip(stderr)}`,
      );
    if (code !== 0)
      throw new Error(
        `Bun driver exited ${code}: stderr=${clip(stderr)} stdout=${clip(stdout)}`,
      );
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    try {
      return JSON.parse(lastLine) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Bun driver produced unparsable result (early exit/malformed stdout): stdout=${clip(stdout)} stderr=${clip(stderr)}`,
      );
    }
  });
  // Never leave an unobserved rejection while a test is waiting elsewhere.
  void result.catch(() => {});
  const handle: DriverHandle = { child, result, exited };
  drivers.add(handle);
  void exited.finally(() => drivers.delete(handle));
  child.stdin!.write(JSON.stringify(input));
  child.stdin!.end();
  return handle;
}

// Bounded graceful teardown: SIGTERM lets the driver run its production
// cleanup (verified child stop) and exit; we await that exit BEFORE the
// harness closes the bridge/D1 or removes the temp dir. If the driver does not
// exit within the bound it is SIGKILLed and the uncertainty is recorded;
// the grandchild still exits on stdin EOF once the parent stdio is gone.
async function stopDriver(handle: DriverHandle): Promise<string | null> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    await handle.exited.catch(() => {});
    return null;
  }
  try {
    handle.child.kill("SIGTERM");
  } catch {}
  const graceful = await Promise.race([
    handle.exited.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15000)),
  ]);
  if (graceful) return null;
  try {
    handle.child.kill("SIGKILL");
  } catch {}
  await Promise.race([
    handle.exited.catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
  return "driver did not exit after SIGTERM+SIGKILL within bound; runtime state uncertain";
}

type CloudFixture = Awaited<ReturnType<typeof fixture>>;
type Account = Awaited<ReturnType<CloudFixture["login"]>>;

interface SupervisorCredential {
  credential: string;
  credential_id: string;
  supervisor_id: string;
  worker_id: string;
  subject_id: string;
  tenant_id: string;
  scopes: string[];
  expires_at: number;
  authorization_expires_at: number;
}

interface Setup {
  h: CloudFixture;
  account: Account;
  workerId: string;
  supervisor: SupervisorCredential;
  taskCredential: string;
}

// Direct production operator seam (putPolicy) over the fixture's real D1,
// mirroring the local shorthand used by the existing hosted helpers. No
// shared-fixture edit: the shorthand lives only in this new test.
async function seedPolicy(
  h: CloudFixture,
  origin: string,
  tenant: string,
  input: PolicyInput,
  operator: string,
) {
  const { putPolicy } = await import("../src/hosted-entitlements.ts");
  const ctx = {
    env: {
      DB: h.db,
      AUTH_SECRET: "test-auth-secret-with-at-least-thirty-two-characters",
      APP_ORIGIN: origin,
      WEBSITE_ORIGIN: origin,
      ENVIRONMENT: "local",
    },
    request: new Request(`${origin}/`),
    request_id: crypto.randomUUID(),
    route: "operator.policy",
    actor: operator,
  };
  return putPolicy(ctx as never, tenant, input, operator);
}

// Worker enrollment, policy, supervisor registration, CLI link and execution
// grant are all exercised through the actual DEFAULT worker routes (h.request)
// plus the production putPolicy seam, not a hosted-only router source.
async function setup(origin: string): Promise<Setup> {
  const h = await fixture(origin);
  const account = await h.login();
  const enrollment = await h.enroll(account);
  const registered = await h.register(enrollment);
  assert.equal(registered.status, 201);
  const worker = (await registered.json()) as {
    credential: string;
    worker_id: string;
  };
  await seedPolicy(h, origin, account.tenant, policy, account.user);
  const supervisorResponse = await h.request(
    `/v1/tenants/${account.tenant}/supervisors`,
    { ...account.headers, "idempotency-key": crypto.randomUUID() },
    "POST",
    { worker_id: worker.worker_id, name: "integration-supervisor" },
  );
  assert.equal(supervisorResponse.status, 201);
  const supervisor = (await supervisorResponse.json()) as SupervisorCredential;
  const device = await h.linked(account);
  const granted = await h.request(
    `/v1/tenants/${account.tenant}/cli-installations/${device.installation_id}/execution-authorizations`,
    { ...account.headers, "idempotency-key": crypto.randomUUID() },
    "POST",
    {},
  );
  assert.equal(granted.status, 201);
  const grant = (await granted.json()) as { credential: string };
  return {
    h,
    account,
    workerId: worker.worker_id,
    supervisor,
    taskCredential: grant.credential,
  };
}

async function withHarness(
  run: (context: {
    directory: string;
    origin: string;
    setup: Setup;
    drivers: Set<DriverHandle>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "swarmforge-hosted-runtime-"));
  const drivers = new Set<DriverHandle>();
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          headers[key] = Array.isArray(value) ? value.join(",") : value;
      const result = await context.setup.h.request(
        req.url!,
        headers,
        req.method,
        chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : undefined,
      );
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "fixture_failure", message: "Fixture failed" },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  // The fixture is created after the server so its origin matches the bridge.
  const context = {
    directory,
    origin,
    setup: undefined as unknown as Setup,
    drivers,
  };
  let failure: unknown;
  let cleanupUncertainty: string | null = null;
  try {
    context.setup = await setup(origin);
    await run(context);
  } catch (error) {
    failure = error;
  } finally {
    // Stop and await every driver (and therefore its production-stopped child)
    // BEFORE closing the bridge, disposing D1, or removing the journals.
    const uncertainties: string[] = [];
    for (const handle of [...drivers]) {
      const uncertainty = await stopDriver(handle).catch(
        (error) => `driver stop failed: ${String(error)}`,
      );
      if (uncertainty) uncertainties.push(uncertainty);
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await context.setup?.h.mf.dispose();
    await rm(directory, { recursive: true, force: true });
    if (uncertainties.length) cleanupUncertainty = uncertainties.join("; ");
  }
  // Teardown uncertainty must fail the qualification, never be hidden. A
  // SIGKILL of the driver parent is NOT proof about a foreign grandchild, so
  // the only accepted proof remains the tested graceful production stop.
  if (failure && cleanupUncertainty)
    throw new Error(
      `${String(failure)}; Driver cleanup uncertainty: ${cleanupUncertainty}`,
    );
  if (failure) throw failure;
  if (cleanupUncertainty)
    throw new Error(`Driver cleanup uncertainty: ${cleanupUncertainty}`);
}

function driverInput(context: {
  directory: string;
  origin: string;
  setup: Setup;
}): Omit<DriverInput, "runtimeMs" | "controlledDurationMs"> {
  const { setup } = context;
  return {
    origin: context.origin,
    tenant: setup.account.tenant,
    workerId: setup.workerId,
    taskCredential: setup.taskCredential,
    supervisor: {
      credential: setup.supervisor.credential,
      supervisor_id: setup.supervisor.supervisor_id,
      tenant_id: setup.supervisor.tenant_id,
      expires_at: setup.supervisor.expires_at,
      authorization_expires_at: setup.supervisor.authorization_expires_at,
    },
    dbPath: join(context.directory, "workers.sqlite"),
    statePath: join(context.directory, "hosted-journal.sqlite"),
  };
}

test(
  "hosted task completes across real workerd/D1 and a real Bun supervisor with multiple renewals and lost-ack recovery, with no duplicate execution",
  { timeout: 120000 },
  async () => {
    await withHarness(async (context) => {
      const handle = await runDriver(
        context.directory,
        {
          ...driverInput(context),
          runtimeMs: 60000,
          controlledDurationMs: 31000,
          ackMode: "once",
        },
        context.drivers,
      );
      const out = await handle.result;
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.identity_ok, true);
      assert.ok(String(out.submitted_task_id));
      assert.deepEqual(out.loop_result, {
        claimed: 1,
        completed: [out.submitted_task_id],
        cancelled: [],
        failed: [],
        held: [],
        claim_failed: false,
      });
      assert.equal(out.task_state, "completed");
      // A single real child process, started exactly once even though the
      // first ack reply was lost and retried with the same durable key.
      assert.equal((out.spawned as unknown[]).length, 1);
      assert.ok((out.ack_calls as number) >= 2);
      // 31s of controlled runtime under a 30s lease forces real renewals.
      assert.ok((out.renew_calls as number) >= 2, JSON.stringify(out));
      const mapping = out.mapping as {
        state: string;
        stop_confirmed: boolean;
        consumed_runtime_ms: number;
        consumed_runtime_unknown: boolean;
        child_pid: number;
      };
      assert.equal(mapping.state, "settled");
      assert.equal(mapping.stop_confirmed, true);
      assert.equal(mapping.consumed_runtime_unknown, false);
      assert.ok(mapping.consumed_runtime_ms >= 31000);
      assert.equal(out.pid_dead, true);
      const reopened = out.reopened_mapping as {
        state: string;
        stop_confirmed: boolean;
      };
      assert.equal(reopened.state, "settled");
      assert.equal(reopened.stop_confirmed, true);

      // Cloud D1 agrees: meter settled exactly once, reservation released.
      const meter = await context.setup.h.db
        .prepare(
          "SELECT reserved_quantity,consumed_quantity FROM hosted_allowances",
        )
        .first<{ reserved_quantity: string; consumed_quantity: string }>();
      assert.equal(meter!.reserved_quantity, "0");
      assert.equal(
        meter!.consumed_quantity,
        String(mapping.consumed_runtime_ms),
      );

      // Journals are real protected files on disk (0600).
      for (const file of ["workers.sqlite", "hosted-journal.sqlite"]) {
        const info = await stat(join(context.directory, file));
        assert.equal(info.mode & 0o777, 0o600);
      }
    });
  },
);

test(
  "cloud cancellation stops the real child and releases the reservation only on verified stop",
  { timeout: 90000 },
  async () => {
    await withHarness(async (context) => {
      const handle = await runDriver(
        context.directory,
        {
          ...driverInput(context),
          runtimeMs: 60000,
          controlledDurationMs: 31000,
        },
        context.drivers,
      );
      const taskId = await waitForTaskState(context, "running");
      const cancelled = await context.setup.h.request(
        `/v1/tenants/${context.setup.account.tenant}/tasks/${taskId}/cancel`,
        {
          ...context.setup.account.headers,
          "idempotency-key": crypto.randomUUID(),
        },
        "POST",
        {},
      );
      assert.ok([200, 202].includes(cancelled.status));
      const out = await handle.result;
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.deepEqual(out.loop_result, {
        claimed: 1,
        completed: [],
        cancelled: [taskId],
        failed: [],
        held: [],
        claim_failed: false,
      });
      assert.equal(out.task_state, "cancelled");
      const mapping = out.mapping as {
        stop_confirmed: boolean;
        child_pid: number;
      };
      assert.equal(mapping.stop_confirmed, true);
      assert.equal(out.pid_dead, true);
      // Trusted verified stop releases the reservation; the meter is returned.
      const reservation = await context.setup.h.db
        .prepare("SELECT state FROM hosted_reservations WHERE task_id=?")
        .bind(taskId)
        .first<{ state: string }>();
      assert.equal(reservation!.state, "released");
      const meter = await context.setup.h.db
        .prepare("SELECT reserved_quantity FROM hosted_allowances")
        .first<{ reserved_quantity: string }>();
      assert.equal(meter!.reserved_quantity, "0");
    });
  },
);

test(
  "network loss at ack holds uncertain durable state without execution and expired supervisor authority is rejected",
  { timeout: 90000 },
  async () => {
    await withHarness(async (context) => {
      const handle = await runDriver(
        context.directory,
        {
          ...driverInput(context),
          runtimeMs: 60000,
          controlledDurationMs: 5000,
          ackMode: "always",
        },
        context.drivers,
      );
      const out = await handle.result;
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal((out.spawned as unknown[]).length, 0);
      assert.deepEqual((out.loop_result as { held: string[] }).held, [
        out.submitted_task_id,
      ]);
      assert.equal(
        (out.loop_result as { claim_failed: boolean }).claim_failed,
        false,
      );
      const mapping = out.mapping as {
        state: string;
        child_pid: number | null;
      };
      assert.equal(mapping.state, "held");
      assert.equal(mapping.child_pid, null);
      // Network loss is not a trusted stop: the durable journal still holds the
      // uncertain row after reopen and the cloud reservation is not released.
      const reopened = out.reopened_mapping as {
        state: string;
        stop_confirmed: boolean;
      };
      assert.equal(reopened.state, "held");
      assert.equal(reopened.stop_confirmed, false);
      const reservation = await context.setup.h.db
        .prepare("SELECT state,quantity FROM hosted_reservations")
        .first<{ state: string; quantity: string }>();
      assert.notEqual(reservation!.state, "released");
      assert.equal(reservation!.quantity, "60000");
      const meter = await context.setup.h.db
        .prepare("SELECT reserved_quantity FROM hosted_allowances")
        .first<{ reserved_quantity: string }>();
      assert.equal(meter!.reserved_quantity, "60000");

      // Stale/expired supervisor authority never reaches claim or execution.
      const expired = await runDriver(
        context.directory,
        {
          ...driverInput(context),
          runtimeMs: 60000,
          controlledDurationMs: 5000,
          expired: true,
          submit: false,
        },
        context.drivers,
      );
      const staleOut = await expired.result;
      assert.equal(staleOut.ok, true, JSON.stringify(staleOut));
      assert.equal(
        (staleOut.loop_result as { claim_failed: boolean }).claim_failed,
        true,
      );
      assert.equal((staleOut.spawned as unknown[]).length, 0);
    });
  },
);

test(
  "driver failure while the real child is alive stops the runtime through production cleanup and retains the durable journal",
  { timeout: 90000 },
  async () => {
    await withHarness(async (context) => {
      const handle = await runDriver(
        context.directory,
        {
          ...driverInput(context),
          runtimeMs: 60000,
          controlledDurationMs: 31000,
          crash: true,
        },
        context.drivers,
      );
      const out = await handle.result;
      assert.equal(out.ok, false, JSON.stringify(out));
      assert.match(String(out.error), /synthetic in-flight failure/);
      // A real child was actually started, then production cleanup stopped it.
      assert.ok(Number(out.child_pid) > 0, JSON.stringify(out));
      assert.equal(out.pid_dead, true);
      assert.ok((out.spawned as unknown[]).length >= 1);
      const reopened = out.reopened_mapping as {
        state: string;
        stop_confirmed: boolean;
      } | null;
      assert.ok(reopened, JSON.stringify(out));
      assert.equal(reopened.stop_confirmed, true);
      assert.equal(out.cleanup_errors, undefined);
    });
  },
);

test(
  "unparsable or early-exiting driver is rejected cleanly with bounded diagnostics",
  { timeout: 30000 },
  async () => {
    await withHarness(async (context) => {
      const handle = await runDriver(
        context.directory,
        {
          ...driverInput(context),
          runtimeMs: 60000,
          controlledDurationMs: 5000,
          exitEarly: true,
        },
        context.drivers,
      );
      await assert.rejects(
        () => handle.result,
        (error: unknown) =>
          error instanceof Error &&
          /unparsable result|exited/.test(error.message),
      );
    });
  },
);

async function waitForTaskState(
  context: { setup: Setup },
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 30000;
  for (;;) {
    const row = await context.setup.h.db
      .prepare("SELECT task_id,state FROM hosted_tasks LIMIT 1")
      .first<{ task_id: string; state: string }>();
    if (row?.state === expected) return row.task_id;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for hosted task state ${expected} (saw ${row?.state ?? "none"})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

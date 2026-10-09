// New-process recovery writer: writes one claim row via the real HostedStore
// and exits. Used by the D1 new-PROCESS recovery test to prove on-disk
// durability across a real process boundary (not same-process reopen).

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import { type HostedTask, SupervisorClient } from "../src/hosted-client";
import {
  ControlledAgent,
  ControlledProcessProvider,
  identityMatches,
} from "../src/hosted-runtime";
import { HOSTED_MONO_ORIGIN, HostedStore } from "../src/hosted-store";
import { HostedSupervisor } from "../src/hosted-supervisor";
import { Store } from "../src/store";

// Actual process-boundary regressions. HTTP is explicitly a transport mock;
// the Coordinator, two durable Stores, inert child and OS proof are production.
if (process.argv[2] === "runtime-phase") {
  const [phase, statePath, planPath] = process.argv.slice(3);
  if (!phase || !statePath || !planPath) process.exit(2);
  const plan = (await Bun.file(planPath).json()) as {
    task: HostedTask;
    lostReply: boolean;
  };
  const task = plan.task;
  const server = new Database(`${statePath}.transport-mock.sqlite`, {
    create: true,
  });
  server.exec(
    "CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,payload TEXT NOT NULL,response TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attempts(key TEXT,payload TEXT);",
  );
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/claim"))
      return Response.json({ task, server_time: Date.now() });
    if (path.endsWith("/ack") || path.endsWith("/renew"))
      return Response.json({
        task: { ...task, state: "running" },
        directive: "continue",
        server_time: Date.now(),
      });
    if (path.endsWith("/settle")) {
      const key = request.headers.get("idempotency-key")!;
      const payload = await request.text();
      const body = JSON.parse(payload) as { outcome: string };
      const response = JSON.stringify({
        task: { ...task, state: body.outcome },
      });
      const reply = server.transaction(() => {
        server
          .query("INSERT INTO attempts(key,payload) VALUES(?,?)")
          .run(key, payload);
        const old = server
          .query("SELECT payload,response FROM operations WHERE key=?")
          .get(key) as { payload: string; response: string } | null;
        if (old && old.payload !== payload)
          return new Response("conflict", { status: 409 });
        if (!old)
          server
            .query("INSERT INTO operations(key,payload,response) VALUES(?,?,?)")
            .run(key, payload, response);
        return new Response(old?.response ?? response, {
          headers: { "content-type": "application/json" },
        });
      })();
      if (plan.lostReply && phase === "a") {
        // The mock server committed its effect; abruptly exit before the HTTP
        // caller sees any response or can remember a receipt locally.
        console.log(
          JSON.stringify({
            phase,
            event: "lost-response",
            intent: hostedStore.settlementIntent(task.task_id),
            mapping: hostedStore.get(task.task_id),
            origin: HOSTED_MONO_ORIGIN,
          }),
        );
        process.exit(0);
      }
      return reply;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const config = loadConfig({
    FREESTYLE_API_TOKEN: "inert-unused",
    FREESTYLE_SNAPSHOT_ID: "inert-unused",
    SWARMFORGE_MODEL_BASE_URL: "https://inert.invalid",
    SWARMFORGE_MODEL_API_KEY: "inert-unused",
    SWARMFORGE_MODEL_NAME: "inert-unused",
    SWARMFORGE_GIT_TREE: "none",
    SWARMFORGE_DB_PATH: `${statePath}.workers.sqlite`,
    SWARMFORGE_GIT_PUSH_MODE: "none",
  });
  const store = new Store(config.SWARMFORGE_DB_PATH);
  const hostedStore = new HostedStore(statePath);
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
    client: new SupervisorClient(
      "https://transport-mock.invalid",
      `sfsuper_${"b".repeat(43)}`,
      task.tenant_id,
      transport,
    ),
    supervisorCredential: () => ({
      credential: `sfsuper_${"b".repeat(43)}`,
      supervisor_id: task.supervisor_id!,
      tenant_id: task.tenant_id,
      expires_at: Date.now() + 60000,
      authorization_expires_at: Date.now() + 60000,
    }),
    minLifetimeMs: 1,
    safetyMarginMs: 0,
  });
  if (phase === "a") {
    const claimed = await supervisor.claimOnce();
    await supervisor.ackAndStart(claimed!);
    await Bun.sleep(350);
    const mapping = hostedStore.get(task.task_id)!;
    const worker = store.get(mapping.local_worker_id);
    const record = provider.recordFor(worker.vm_id!)!;
    if (!identityMatches(record))
      throw new Error("Child must still be alive after >=300ms.");
    if (plan.lostReply) {
      await supervisor.stopAndConfirm(task.task_id, "completed");
      await supervisor.settle(task.task_id, "completed");
      throw new Error("Expected abrupt lost-response exit");
    }
    console.log(
      JSON.stringify({
        phase,
        event: "live",
        mapping,
        origin: HOSTED_MONO_ORIGIN,
        pid: record.pid,
      }),
    );
    process.stdin.resume();
    await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  } else {
    const before = hostedStore.get(task.task_id)!;
    supervisor.recover();
    const result = await supervisor.reconcile();
    console.log(
      JSON.stringify({
        phase,
        event: "reconciled",
        before,
        result,
        mapping: hostedStore.get(task.task_id),
        intent: hostedStore.settlementIntent(task.task_id),
        origin: HOSTED_MONO_ORIGIN,
        spawned: provider.spawnedCommands.length,
      }),
    );
  }
  await supervisor.close();
  await coordinator.stop();
  store.close();
  server.close();
  process.exit(0);
}

const [dbPath, taskId] = process.argv.slice(2);
if (!dbPath || !taskId) {
  console.error("usage: hosted-recovery-writer.ts <db> <task>");
  process.exit(2);
}
// Fixed deterministic UUIDs matching the test harness constants are passed
// via argv for task only; the rest are fresh (schema validity is what matters).
const store = new HostedStore(dbPath);
store.claimMapping({
  task_id: taskId,
  tenant_id: randomUUID(),
  worker_id: randomUUID(),
  local_worker_id: `pending-${taskId}`,
  lease_id: "11111111-1111-4111-8111-111111111111",
  fence: 7,
  supervisor_id: randomUUID(),
  reservation_id: randomUUID(),
  stop_confirmed: false,
  consumed_runtime_ms: 0,
  idempotency_key: randomUUID(),
  rotation_key: null,
  settlement_key: null,
});
store.close();
process.exit(0);

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import { createMcpServer } from "../src/mcp";
import { FreestyleProvider } from "../src/providers/freestyle";
import { OpenCodeAgent } from "../src/providers/opencode";
import { acquireProcessLock } from "../src/runtime";
import { Store } from "../src/store";

export async function smoke() {
  if (process.env.SWARMFORGE_RUN_SMOKE !== "true") {
    console.log(
      "SKIP: set SWARMFORGE_RUN_SMOKE=true and the required infrastructure configuration.",
    );
    return;
  }
  const config = loadConfig();
  const unlock = acquireProcessLock(`${config.SWARMFORGE_DB_PATH}.lock`);
  const store = new Store(config.SWARMFORGE_DB_PATH);
  const owner = store.setting("instance_id");
  if (owner && owner !== config.SWARMFORGE_INSTANCE_ID) {
    store.close();
    unlock();
    throw new Error("Instance ID differs from persisted database owner");
  }
  store.setting("instance_id", config.SWARMFORGE_INSTANCE_ID);
  const coordinator = new Coordinator(
    config,
    store,
    new FreestyleProvider(config),
    new OpenCodeAgent(config),
  );
  const server = createMcpServer(coordinator);
  const client = new Client({ name: "swarmforge-smoke", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let workerId: string | undefined;
  try {
    await coordinator.recover();
    await server.connect(a);
    await client.connect(b);
    const created = await client.callTool({
      name: "spawn_worker",
      arguments: {
        team_id: "smoke",
        task_id: `smoke-${Date.now()}`,
        role: "tester",
        timeout_seconds: 180,
        prompt:
          "Verify SWARMFORGE_GIT_TREE is present without printing its value. Do not modify the external Git tree. Write a tiny Python add(a,b) implementation and passing assertions under .swarmforge/artifacts/smoke.py, run it, and return the required structured result with tests.ran=true and tests.passed=true. All smoke output must stay under .swarmforge.",
      },
    });
    if (created.isError) throw new Error("Smoke spawn failed");
    workerId = (created.structuredContent as { worker_id: string }).worker_id;
    console.log(JSON.stringify({ smoke_worker_id: workerId }));
    const until =
      Date.now() + (config.SWARMFORGE_PROVISION_TIMEOUT_SECONDS + 210) * 1000;
    while (Date.now() < until) {
      await coordinator.tick();
      const w = store.get(workerId);
      if (w.state === "completed") {
        const result = await client.callTool({
          name: "get_worker_result",
          arguments: { worker_id: workerId },
        });
        const structured = result.structuredContent as {
          result?: { tests?: { ran: boolean; passed?: boolean } };
        };
        if (!structured.result?.tests?.ran || !structured.result.tests.passed)
          throw new Error("Smoke did not report passing tests");
        // Only this explicit smoke run is force-cleaned. It was instructed to create disposable artifacts only.
        await coordinator.control(workerId, "destroy", true);
        if (store.get(workerId).state !== "destroyed")
          throw new Error(
            "Smoke VM destruction failed; retained for inspection",
          );
        console.log(JSON.stringify({ smoke: "passed", worker_id: workerId }));
        return;
      }
      if (["failed", "recovery_required", "cancelled"].includes(w.state))
        throw new Error(`Smoke worker entered ${w.state}`);
      await Bun.sleep(config.SWARMFORGE_POLL_INTERVAL_MS);
    }
    throw new Error("Smoke timed out");
  } catch (error) {
    if (workerId) {
      await coordinator.control(workerId, "cancel").catch(() => {});
      console.error(
        JSON.stringify({
          retained_worker_id: workerId,
          vm_id: store.get(workerId).vm_id,
        }),
      );
    }
    throw error;
  } finally {
    await client.close();
    await server.close();
    await coordinator.stop();
    store.close();
    unlock();
  }
}

if (import.meta.main) await smoke();

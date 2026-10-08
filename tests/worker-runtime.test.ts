import { expect, test } from "bun:test";
import type { Worker, WorkerProvider } from "../src/domain";
import { FreestyleProvider } from "../src/providers/freestyle";
import { config, harness, runToRunning, task } from "./helpers";

test("cancellation delegates verified runtime stop to an injected provider", async () => {
  const h = harness();
  const stopped: string[] = [];
  (h.provider as WorkerProvider).stopWorkerRuntime = async (worker: Worker) => {
    stopped.push(worker.worker_id);
  };
  try {
    const worker = h.coordinator.spawn(task);
    await runToRunning(h, worker.worker_id);
    h.provider.execCommands.length = 0;
    h.coordinator.control(worker.worker_id, "cancel");
    await h.coordinator.tick();
    expect(stopped).toEqual([worker.worker_id]);
    expect(
      h.provider.execCommands.some((command) =>
        command.includes("swarmforge-opencode.service"),
      ),
    ).toBe(false);
    expect(h.store.get(worker.worker_id).state).toBe("cancelled");
    expect(
      h.provider.vms.get(h.store.get(worker.worker_id).vm_id!)?.state,
    ).toBe("running");
  } finally {
    h.store.close();
  }
});

test("an uncertain runtime stop pauses the VM without a legacy service fallback", async () => {
  const h = harness();
  (h.provider as WorkerProvider).stopWorkerRuntime = async () => {
    throw new Error("runtime still active");
  };
  try {
    const worker = h.coordinator.spawn(task);
    await runToRunning(h, worker.worker_id);
    h.provider.execCommands.length = 0;
    h.coordinator.control(worker.worker_id, "cancel");
    await h.coordinator.tick();
    expect(
      h.provider.execCommands.some((command) =>
        command.includes("swarmforge-opencode.service"),
      ),
    ).toBe(false);
    expect(
      h.provider.vms.get(h.store.get(worker.worker_id).vm_id!)?.state,
    ).toBe("paused");
    expect(h.store.get(worker.worker_id).state).toBe("cancelled");
  } finally {
    h.store.close();
  }
});

test("Freestyle proves runtime stop only after a successful command", async () => {
  const provider = new FreestyleProvider(config);
  const h = harness();
  try {
    const worker = { ...h.coordinator.spawn(task), vm_id: "vm-1" };
    let code: number | null = 0;
    const commands: string[] = [];
    provider.exec = async (_id, command) => {
      commands.push(command);
      return { stdout: "", stderr: "", code };
    };
    await provider.stopWorkerRuntime(worker);
    expect(commands[0]).toContain("! systemctl is-active --quiet");
    for (const failure of [1, null]) {
      code = failure;
      await expect(provider.stopWorkerRuntime(worker)).rejects.toThrow(
        "runtime stop could not be verified",
      );
    }
    await expect(
      provider.stopWorkerRuntime({ ...worker, vm_id: null }),
    ).rejects.toThrow("Worker has no VM");
  } finally {
    h.store.close();
  }
});

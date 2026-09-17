import { expect, test } from "bun:test";
import { Coordinator } from "../src/coordinator";
import { config, harness, runToRunning, task } from "./helpers";

test("creation retries retain idempotency when the queue is full", () => {
  const h = harness();
  const c = new Coordinator(
    { ...config, SWARMFORGE_MAX_QUEUE: 1 },
    h.store,
    h.provider,
    h.agent,
  );
  const first = c.spawn({ ...task, request_id: "same" });
  expect(c.spawn({ ...task, request_id: "same" }).worker_id).toBe(
    first.worker_id,
  );
  expect(() => c.spawn({ ...task, request_id: "new" })).toThrow(
    "Creation queue full",
  );
  h.store.close();
});

test("spawn returns queued before provisioning and preserves session for follow-ups", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  expect(w.state).toBe("queued");
  expect(h.provider.created).toBe(0);
  await runToRunning(h, w.worker_id);
  expect(h.store.get(w.worker_id).opencode_session_id).toBeTruthy();
  h.agent.complete(h.store.get(w.worker_id));
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("completed");
  h.coordinator.message(w.worker_id, "fix race");
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("running");
  expect(h.agent.submitted[0]?.session).toBe(h.agent.submitted[1]?.session);
  expect(h.agent.sessions).toBe(1);
  h.store.close();
});
test("limits both provisioning and retained VM capacity, and resumes queue after destroy", async () => {
  const h = harness();
  const workers = [1, 2, 3].map((i) =>
    h.coordinator.spawn({ ...task, task_id: `task-${i}` }),
  );
  await h.coordinator.tick();
  expect(h.provider.created).toBe(1);
  for (let i = 0; i < 8; i++) await h.coordinator.tick();
  expect(h.provider.vms.size).toBe(2);
  expect(h.store.get(workers[2]!.worker_id).state).toBe("queued");
  await h.coordinator.control(workers[0]!.worker_id, "destroy", true);
  await h.coordinator.tick();
  expect(h.store.get(workers[2]!.worker_id).state).not.toBe("queued");
  h.store.close();
});
test("running messages queue durably instead of resetting active context", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.coordinator.message(w.worker_id, "follow-up");
  await h.coordinator.tick();
  expect(h.agent.submitted).toHaveLength(1);
  h.agent.complete(h.store.get(w.worker_id));
  await h.coordinator.tick();
  await h.coordinator.tick();
  expect(h.agent.submitted).toHaveLength(2);
  h.store.close();
});
test("malformed OpenCode result falls back to current run file and duplicate completion is harmless", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const d = h.store.dispatch(w.worker_id)!;
  h.agent.complete(h.store.get(w.worker_id), { bad: true });
  await h.provider.writeFile(
    h.store.get(w.worker_id).vm_id!,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: w.worker_id,
      run_id: d.run_id,
      status: "completed",
      summary: "fallback",
    }),
  );
  await h.coordinator.tick();
  await h.coordinator.tick();
  expect(h.store.result(w.worker_id)?.summary).toBe("fallback");
  expect(
    h.store.events(w.worker_id).filter((e) => e.type === "worker.completed"),
  ).toHaveLength(1);
  expect(h.store.tokens()).toMatchObject({ input: 10, output: 20, total: 30 });
  h.store.close();
});
test("missing, malformed and stale fallback cannot declare successful completion", async () => {
  for (const value of [
    undefined,
    "{broken",
    JSON.stringify({ status: "completed", summary: "old", run_id: "old" }),
  ]) {
    const h = harness();
    const w = h.coordinator.spawn(task);
    await runToRunning(h, w.worker_id);
    h.agent.complete(h.store.get(w.worker_id), null);
    if (value)
      await h.provider.writeFile(
        h.store.get(w.worker_id).vm_id!,
        "/workspace/.swarmforge/result.json",
        value,
      );
    await h.coordinator.tick();
    expect(h.store.get(w.worker_id).state).toBe("failed");
    h.store.close();
  }
});
test("pause preserves deadline budget and resume retains session; cancellation retains VM", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  await h.coordinator.control(w.worker_id, "pause");
  expect(h.store.get(w.worker_id).state).toBe("paused");
  await h.coordinator.control(w.worker_id, "resume");
  expect(h.store.get(w.worker_id).state).toBe("running");
  await h.coordinator.control(w.worker_id, "cancel");
  expect(h.store.get(w.worker_id).state).toBe("cancelled");
  expect(h.provider.vms.size).toBe(1);
  h.store.close();
});
test("safe destroy protects dirty work; explicit force destroys; failures retain VM identity", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.provider.dirty = true;
  await h.coordinator.control(w.worker_id, "destroy");
  expect(h.store.get(w.worker_id).state).toBe("recovery_required");
  expect(h.provider.vms.size).toBe(1);
  h.provider.destroyFailure = true;
  await h.coordinator.control(w.worker_id, "destroy", true);
  expect(h.store.get(w.worker_id).vm_id).toBeTruthy();
  expect(h.store.get(w.worker_id).state).not.toBe("destroyed");
  h.provider.destroyFailure = false;
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("destroyed");
  h.store.close();
});
test("timeout terminates monitoring and marks dirty VM recovery_required", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.provider.dirty = true;
  h.store.patch(w.worker_id, { deadline_at: Date.now() - 1 });
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("recovery_required");
  expect(h.provider.vms.size).toBe(1);
  h.store.close();
});
test("provider creation failures retry within provisioning deadline, then fail", async () => {
  const h = harness();
  h.provider.failure = true;
  const w = h.coordinator.spawn(task);
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("provisioning");
  h.store.patch(w.worker_id, { provision_started_at: Date.now() - 400000 });
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("failed");
  h.store.close();
});
test("restart reconnects existing VM and session without resubmitting active task", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const fresh = new Coordinator(config, h.store, h.provider, h.agent);
  await fresh.recover();
  await fresh.tick();
  expect(h.agent.submitted).toHaveLength(1);
  h.agent.complete(h.store.get(w.worker_id));
  await fresh.tick();
  expect(h.store.get(w.worker_id).state).toBe("completed");
  h.store.close();
});
test("restart during provisioning adopts VM found by metadata; unknown orphans are retained visibly", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  h.store.transition(w.worker_id, "provisioning", {
    provision_started_at: Date.now(),
  });
  const vm = await h.provider.createWorker(w);
  h.provider.vms.set("orphan", {
    id: "orphan",
    slug: "unknown",
    state: "running",
    worker_id: "lost-worker",
  });
  await h.coordinator.recover();
  expect(h.store.get(w.worker_id).vm_id).toBe(vm.id);
  expect(
    h.store
      .all()
      .some((x) => x.vm_id === "orphan" && x.state === "recovery_required"),
  ).toBe(true);
  expect(h.provider.vms.size).toBe(2);
  h.store.close();
});
test("VM disappearance is failed, not silently re-provisioned", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.provider.vms.clear();
  await h.coordinator.recover();
  expect(h.store.get(w.worker_id).state).toBe("failed");
  expect(h.provider.created).toBe(1);
  h.store.close();
});
test("OpenCode crash after file completion still recovers structured output", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.agent.broken = true;
  const d = h.store.dispatch(w.worker_id)!;
  await h.provider.writeFile(
    h.store.get(w.worker_id).vm_id!,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      status: "completed",
      summary: "survived",
      run_id: d.run_id,
    }),
  );
  await h.coordinator.tick();
  expect(h.store.result(w.worker_id)?.summary).toBe("survived");
  h.store.close();
});

test("persisting a completion atomically makes queued follow-ups runnable after restart", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.coordinator.message(w.worker_id, "next");
  h.store.finish(w.worker_id, h.store.dispatch(w.worker_id)!, {
    status: "completed",
    summary: "done",
    files_changed: [],
    warnings: [],
    needs_followup: false,
  });
  const fresh = new Coordinator(config, h.store, h.provider, h.agent);
  await fresh.recover();
  await fresh.tick();
  expect(h.agent.submitted).toHaveLength(2);
  h.store.close();
});
test("restart in ready with sending intent inspects accepted messages instead of replaying task", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const d = h.store.dispatch(w.worker_id)!;
  h.store.saveDispatch({ ...d, state: "sending" });
  h.store.transition(w.worker_id, "ready");
  const fresh = new Coordinator(config, h.store, h.provider, h.agent);
  await fresh.recover();
  await fresh.tick();
  expect(h.agent.submitted).toHaveLength(1);
  expect(h.store.get(w.worker_id).state).toBe("running");
  h.store.close();
});
test("failed abort on timeout quiesces the service so retained workers stop generating", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.agent.abort = async () => {
    throw new Error("unavailable");
  };
  let stopped = false;
  const exec = h.provider.exec.bind(h.provider);
  h.provider.exec = async (id, command) => {
    if (command.includes("systemctl stop")) stopped = true;
    return exec(id, command);
  };
  h.store.patch(w.worker_id, { deadline_at: Date.now() - 1 });
  await h.coordinator.tick();
  expect(stopped).toBe(true);
  expect(["failed", "recovery_required"]).toContain(
    h.store.get(w.worker_id).state,
  );
  h.store.close();
});

test("follow-up queued while completed worker is paused becomes runnable on resume", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.agent.complete(h.store.get(w.worker_id));
  await h.coordinator.tick();
  await h.coordinator.control(w.worker_id, "pause");
  h.coordinator.message(w.worker_id, "next");
  await h.coordinator.control(w.worker_id, "resume");
  await h.coordinator.tick();
  expect(h.agent.submitted).toHaveLength(2);
  h.store.close();
});
test("paused queued workers do not bypass VM limits when resumed", async () => {
  const h = harness();
  const a = h.coordinator.spawn(task);
  await h.coordinator.control(a.worker_id, "pause");
  expect(h.store.get(a.worker_id).vm_id).toBeNull();
  await h.coordinator.control(a.worker_id, "resume");
  expect(h.store.get(a.worker_id).state).toBe("queued");
  h.store.close();
});

test("reconciliation does not overwrite a destroy requested during its VM query", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const get = h.provider.getWorker.bind(h.provider);
  h.provider.getWorker = async (id) => {
    entered();
    await gate;
    return get(id);
  };
  const recovery = h.coordinator.recover();
  await started;
  const destroy = h.coordinator.control(w.worker_id, "destroy", true);
  release();
  await recovery;
  await destroy;
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("destroyed");
  h.store.close();
});
test("lost VMs free capacity while preserving their IDs for diagnosis", async () => {
  const h = harness();
  const a = h.coordinator.spawn({ ...task, task_id: "a" });
  const b = h.coordinator.spawn({ ...task, task_id: "b" });
  await runToRunning(h, a.worker_id);
  await runToRunning(h, b.worker_id);
  const lost = h.store.get(a.worker_id).vm_id!;
  h.provider.vms.delete(lost);
  await h.coordinator.recover();
  const next = h.coordinator.spawn({ ...task, task_id: "next" });
  await h.coordinator.tick();
  expect(h.store.get(a.worker_id).vm_id).toBe(lost);
  expect(h.store.get(next.worker_id).state).not.toBe("queued");
  h.store.close();
});
test("reconciliation discovers a late-created VM even if destroy previously saw no VM", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  h.store.transition(w.worker_id, "provisioning");
  await h.coordinator.control(w.worker_id, "destroy", true);
  await h.provider.createWorker(w);
  await h.coordinator.recover();
  expect(h.store.get(w.worker_id).state).toBe("recovery_required");
  expect(h.store.get(w.worker_id).vm_id).toBeTruthy();
  h.store.close();
});

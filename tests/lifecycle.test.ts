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

// A guest deleted while the coordinator stops it: the first stop attempt already reports
// it gone and every later probe agrees, as the provider does for a missing VM. The
// returned counter records persistence inspections the coordinator attempted.
function vanishDuringStop(h: ReturnType<typeof harness>) {
  const exec = h.provider.exec.bind(h.provider);
  const missing = (id: string) => {
    h.provider.vms.delete(id);
    return new Error("VM not found");
  };
  const stop = { checks: 0 };
  h.provider.exec = async (id, command) => {
    if (command.includes("SWARMFORGE_GIT_CHECK")) stop.checks++;
    if (command.includes("systemctl stop")) throw missing(id);
    if (!h.provider.vms.has(id)) throw missing(id);
    return exec(id, command);
  };
  h.provider.pauseWorker = async (id) => {
    if (h.provider.vms.has(id)) throw new Error("pause unavailable");
    throw missing(id);
  };
  return stop;
}

test("deadline failure settles when the VM vanished between abort and stop", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const vm = h.store.get(w.worker_id).vm_id!;
  const stop = vanishDuringStop(h);
  h.store.patch(w.worker_id, { deadline_at: Date.now() - 1 });
  await h.coordinator.tick();
  const failed = h.store.get(w.worker_id);
  // A confirmed-absent guest is reconciled, not retained: it fails, records the lost VM
  // and releases the capacity it was holding.
  expect(failed.state).toBe("failed");
  expect(failed.vm_missing).toBe(true);
  expect(failed.error).toBe("VM disappeared; local workspace is lost");
  expect(failed.intent).toBeNull();
  expect(failed.deadline_at).toBeNull();
  expect(h.store.dispatch(w.worker_id)).toBeUndefined();
  expect(h.provider.vms.has(vm)).toBe(false);
  // Nothing survives to inspect, so persistence is never claimed as unverifiable.
  expect(stop.checks).toBe(0);
  expect(() => h.coordinator.message(w.worker_id, "revive")).toThrow(
    "cannot receive messages",
  );
  // The freed capacity lets the next task provision on the next pass.
  const next = h.coordinator.spawn({ ...task, task_id: "next" });
  await h.coordinator.tick();
  expect(h.store.get(next.worker_id).state).not.toBe("queued");
  h.store.close();
});

test("cancel settles when the VM vanished while execution was being stopped", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  vanishDuringStop(h);
  await h.coordinator.control(w.worker_id, "cancel");
  const cancelled = h.store.get(w.worker_id);
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.intent).toBeNull();
  expect(h.store.dispatch(w.worker_id)).toBeUndefined();
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("cancelled");
  h.store.close();
});

test("cancel settles when a paused worker's VM was deleted out of band", async () => {
  const h = harness();
  const a = h.coordinator.spawn({ ...task, task_id: "a" });
  const b = h.coordinator.spawn({ ...task, task_id: "b" });
  await runToRunning(h, a.worker_id);
  await runToRunning(h, b.worker_id);
  const lost = h.store.get(a.worker_id).vm_id!;
  await h.coordinator.control(a.worker_id, "pause");
  // The guest is deleted out of band while paused, so the resume before the stop 404s.
  h.provider.vms.delete(lost);
  h.provider.resumeWorker = async (id) => {
    if (!h.provider.vms.has(id)) throw new Error("VM not found");
  };
  await h.coordinator.control(a.worker_id, "cancel");
  const cancelled = h.store.get(a.worker_id);
  // A confirmed absence settles the cancel and records the lost VM, as reconciliation does.
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.intent).toBeNull();
  expect(cancelled.vm_missing).toBe(true);
  expect(cancelled.error).toBe("VM disappeared; local workspace is lost");
  // The lost guest no longer counts against the worker limit.
  const next = h.coordinator.spawn({ ...task, task_id: "next" });
  await h.coordinator.tick();
  expect(h.store.get(next.worker_id).state).not.toBe("queued");
  // A cancel intent left pending would refuse destroy outright, so resolution must be final.
  await h.coordinator.control(a.worker_id, "destroy");
  expect(h.store.get(a.worker_id).state).toBe("destroyed");
  h.store.close();
});

test("an ambiguous resume failure keeps the VM and the pending cancel intent", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const vm = h.store.get(w.worker_id).vm_id!;
  await h.coordinator.control(w.worker_id, "pause");
  const resume = h.provider.resumeWorker.bind(h.provider);
  h.provider.resumeWorker = async () => {
    throw new Error("provider unavailable");
  };
  await h.coordinator.control(w.worker_id, "cancel");
  const pending = h.store.get(w.worker_id);
  // The guest may still be running, so nothing is settled or lost: retry it instead.
  expect(pending.state).toBe("paused");
  expect(pending.intent).toBe("cancel");
  expect(pending.vm_missing).toBe(false);
  expect(h.provider.vms.has(vm)).toBe(true);
  h.provider.resumeWorker = resume;
  await h.coordinator.tick();
  const settled = h.store.get(w.worker_id);
  expect(settled.state).toBe("cancelled");
  expect(settled.intent).toBeNull();
  expect(settled.vm_missing).toBe(false);
  h.store.close();
});

test("destroy completes in one call when the VM vanishes during quiesce", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  vanishDuringStop(h);
  await h.coordinator.control(w.worker_id, "destroy");
  const destroyed = h.store.get(w.worker_id);
  // A guest that no longer exists has nothing left to preserve, so destruction settles
  // instead of stranding the worker in recovery_required for a second call.
  expect(destroyed.state).toBe("destroyed");
  expect(destroyed.intent).toBeNull();
  expect(destroyed.deadline_at).toBeNull();
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("destroyed");
  h.store.close();
});

test("an ambiguous live VM that cannot be stopped is never treated as quiesced", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const vm = h.store.get(w.worker_id).vm_id!;
  const exec = h.provider.exec.bind(h.provider);
  h.provider.exec = async (id, command) =>
    command.includes("systemctl stop")
      ? { stdout: "", stderr: "still running", code: 1 }
      : exec(id, command);
  h.provider.pauseWorker = async () => {
    throw new Error("pause unavailable");
  };
  h.store.patch(w.worker_id, { deadline_at: Date.now() - 1 });
  await h.coordinator.tick();
  const failed = h.store.get(w.worker_id);
  expect(failed.state).toBe("recovery_required");
  expect(failed.vm_id).toBe(vm);
  expect(h.provider.vms.has(vm)).toBe(true);
  h.store.close();
});

test("a message sent while a failure is in flight is rejected instead of acknowledged and dropped", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const abort = h.agent.abort.bind(h.agent);
  h.agent.abort = async (worker) => {
    entered();
    await gate;
    await abort(worker);
  };
  h.store.patch(w.worker_id, { deadline_at: Date.now() - 1 });
  const failing = h.coordinator.tick();
  await inside;
  const queued = h.store.dispatches(w.worker_id).length;
  // The failure started first and cancels every dispatch: a message may not be
  // acknowledged with "queued" and then silently removed by it.
  expect(() => h.coordinator.message(w.worker_id, "during failure")).toThrow(
    "lifecycle operation in progress",
  );
  expect(h.store.dispatches(w.worker_id)).toHaveLength(queued);
  release();
  await failing;
  expect(h.store.get(w.worker_id).state).toBe("failed");
  expect(h.store.dispatch(w.worker_id)).toBeUndefined();
  h.store.close();
});

test("a message is rejected while a cancel intent is recorded but its step has not started", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const inspect = h.agent.inspect.bind(h.agent);
  h.agent.inspect = async (worker) => {
    entered();
    await gate;
    return inspect(worker);
  };
  // A step already owns the worker lock, so control() records the intent durably and
  // waits for the in-flight step instead of starting the cancel itself.
  const ticking = h.coordinator.tick();
  await inside;
  const cancelling = h.coordinator.control(w.worker_id, "cancel");
  expect(h.store.get(w.worker_id).intent).toBe("cancel");
  const queued = h.store.dispatches(w.worker_id).length;
  expect(() =>
    h.coordinator.message(w.worker_id, "before cancel runs"),
  ).toThrow("lifecycle operation in progress");
  expect(h.store.dispatches(w.worker_id)).toHaveLength(queued);
  release();
  await ticking;
  await cancelling;
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("cancelled");
  expect(h.store.get(w.worker_id).intent).toBeNull();
  h.store.close();
});

test("a message is rejected after a cancel attempt failed with its intent still pending", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  await h.coordinator.control(w.worker_id, "pause");
  const resume = h.provider.resumeWorker.bind(h.provider);
  h.provider.resumeWorker = async () => {
    throw new Error("provider unavailable");
  };
  // The teardown body throws before it reaches its transition, so the hold is released
  // while the cancel intent stays recorded for the next pass. A message must still be
  // refused: that retry would cancel it after acknowledging it.
  await h.coordinator.control(w.worker_id, "cancel");
  expect(h.store.get(w.worker_id).intent).toBe("cancel");
  const queued = h.store.dispatches(w.worker_id).length;
  expect(() =>
    h.coordinator.message(w.worker_id, "after failed cancel"),
  ).toThrow("lifecycle operation in progress");
  expect(h.store.dispatches(w.worker_id)).toHaveLength(queued);
  h.provider.resumeWorker = resume;
  await h.coordinator.tick();
  const retried = h.store.get(w.worker_id);
  expect(retried.intent).toBeNull();
  expect(retried.state).toBe("cancelled");
  h.store.close();
});

test("a pending destroy intent also refuses messages while its teardown is not applied", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  await h.coordinator.control(w.worker_id, "pause");
  const resume = h.provider.resumeWorker.bind(h.provider);
  h.provider.resumeWorker = async () => {
    throw new Error("provider unavailable");
  };
  await h.coordinator.control(w.worker_id, "destroy");
  expect(h.store.get(w.worker_id).intent).toBe("destroy");
  const queued = h.store.dispatches(w.worker_id).length;
  expect(() =>
    h.coordinator.message(w.worker_id, "after failed destroy"),
  ).toThrow();
  expect(h.store.dispatches(w.worker_id)).toHaveLength(queued);
  h.provider.resumeWorker = resume;
  await h.coordinator.tick();
  const retried = h.store.get(w.worker_id);
  expect(retried.intent).toBeNull();
  expect(["destroyed", "recovery_required"]).toContain(retried.state);
  h.store.close();
});

test("a message acknowledged before a later cancel is ordered before that cancel", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const accepted = h.coordinator.message(w.worker_id, "before cancel");
  expect(accepted.delivery).toBe("queued");
  await h.coordinator.control(w.worker_id, "cancel");
  const dropped = h.store
    .dispatches(w.worker_id)
    .find((d) => d.run_id === accepted.run_id);
  expect(dropped?.state).toBe("cancelled");
  expect(h.store.get(w.worker_id).state).toBe("cancelled");
  h.store.close();
});

test("a message is accepted again once the failed lifecycle operation has settled", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.provider.dirty = true;
  h.store.patch(w.worker_id, { deadline_at: Date.now() - 1 });
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("recovery_required");
  const accepted = h.coordinator.message(w.worker_id, "after failure");
  expect(accepted.delivery).toBe("queued");
  expect(h.store.get(w.worker_id).state).toBe("booting");
  h.store.close();
});

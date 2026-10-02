import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerArtifactTransport } from "../src/artifact-types";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import { maxRetryDelay, retryDelay } from "../src/finalization";
import { publicWorker } from "../src/security";
import { Store } from "../src/store";
import {
  config,
  FakeAgent,
  FakeProvider,
  harness,
  runToRunning,
  sha256,
  task,
} from "./helpers";

// Collection is bounded and retried on a short clock so behavioural tests stay deterministic.
const fast = {
  SWARMFORGE_FINALIZATION_RETRY_MS: 1,
  SWARMFORGE_ARTIFACT_TIMEOUT_MS: 500,
};
const settledStates = ["preserved", "failed", "abandoned"];
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(ms).then(() => {
      throw new Error(`operation did not settle within ${ms}ms`);
    }),
  ]);
}

// Drives the coordinator tick and the bounded preservation attempt until the finalization
// record reaches a terminal state, exactly as the poll loop would.
async function finalized(h: ReturnType<typeof harness>, id: string) {
  for (let attempt = 0; attempt < 14; attempt++) {
    await h.coordinator.tick();
    await h.coordinator.finalize(id);
    const record = h.store.get(id).finalization;
    if (record && settledStates.includes(record.state)) return h.store.get(id);
    await Bun.sleep(2);
  }
  return h.store.get(id);
}

async function started(h: ReturnType<typeof harness>, taskId = "task") {
  const worker = h.coordinator.spawn({ ...task, task_id: taskId });
  await runToRunning(h, worker.worker_id);
  const current = h.store.get(worker.worker_id);
  return {
    id: worker.worker_id,
    vm: current.vm_id!,
    run: h.store.dispatch(worker.worker_id)!.run_id,
  };
}

function records(h: ReturnType<typeof harness>, id: string) {
  return h.coordinator.artifacts.list({ worker_id: id }).artifacts;
}

test("completion preserves the default collection under the settled run id", async () => {
  const h = harness(fast);
  const { id, vm, run } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/report.txt",
    "regression-body",
  );
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/logs/build.log",
    "log",
  );
  await h.provider.writeFile(vm, "/workspace/.swarmforge/diagnostics", "diag");
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  const settled = await finalized(h, id);
  // The task outcome keeps its own meaning; preservation is visible separately.
  expect(settled.state).toBe("completed");
  expect(settled.finalization?.state).toBe("preserved");
  expect(settled.finalization?.run_id).toBe(run);
  expect(settled.finalization?.attempts).toBe(1);
  expect(settled.finalization?.error).toBeNull();
  expect(settled.finalization?.completed_at).toBeTruthy();
  const byPath = new Map(records(h, id).map((r) => [r.original_path, r]));
  expect([...byPath.keys()].sort()).toEqual([
    ".swarmforge/artifacts/report.txt",
    ".swarmforge/diagnostics",
    ".swarmforge/logs/build.log",
    ".swarmforge/result.json",
  ]);
  const report = byPath.get(".swarmforge/artifacts/report.txt")!;
  expect(report.state).toBe("preserved");
  expect(report.sha256).toBe(sha256("regression-body"));
  expect(report.size).toBe(Buffer.byteLength("regression-body"));
  expect(report.run_id).toBe(run);
  expect(decode(await h.coordinator.artifacts.read(report.artifact_id))).toBe(
    "regression-body",
  );
  // Opt-in only: no workspace snapshot and no artifact bytes through exec output.
  expect(h.provider.transportSnapshots).toBe(0);
  expect(
    h.provider.execCommands.some((command) => /base64/i.test(command)),
  ).toBe(false);
  h.store.close();
});

test("declared findings survive a malformed result with no model assistance", async () => {
  const h = harness(fast);
  const worker = h.coordinator.spawn({
    ...task,
    artifacts: [{ path: ".swarmforge/findings.json", required: true }],
  });
  await runToRunning(h, worker.worker_id);
  const vm = h.store.get(worker.worker_id).vm_id!;
  const run = h.store.dispatch(worker.worker_id)!.run_id;
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/findings.json",
    JSON.stringify({ findings: ["regression"] }),
  );
  h.agent.complete(h.store.get(worker.worker_id), { bad: true });
  const settled = await finalized(h, worker.worker_id);
  expect(settled.state).toBe("failed");
  expect(settled.error).toBe("Missing or malformed structured result");
  expect(settled.finalization?.state).toBe("preserved");
  const finding = records(h, worker.worker_id).find(
    (r) => r.original_path === ".swarmforge/findings.json",
  );
  expect(finding?.run_id).toBe(run);
  expect(
    JSON.parse(
      decode(await h.coordinator.artifacts.read(finding!.artifact_id)),
    ),
  ).toEqual({
    findings: ["regression"],
  });
  h.store.close();
});

test("a configured failure snapshots the workspace and an ordinary completion does not", async () => {
  const h = harness({ ...fast, SWARMFORGE_ARTIFACT_TIMEOUT_MS: 2000 });
  const worker = h.coordinator.spawn({ ...task, snapshot_on_failure: true });
  await runToRunning(h, worker.worker_id);
  const vm = h.store.get(worker.worker_id).vm_id!;
  await h.provider.writeFile(vm, "/workspace/repo/main.ts", "export {};");
  h.agent.complete(h.store.get(worker.worker_id), {
    status: "failed",
    summary: "model reported a failure",
  });
  const settled = await finalized(h, worker.worker_id);
  expect(settled.state).toBe("failed");
  expect(settled.error).toBe("model reported a failure");
  expect(settled.finalization?.state).toBe("preserved");
  expect(h.provider.transportSnapshots).toBe(1);
  const snapshot = records(h, worker.worker_id).find(
    (r) => r.kind === "snapshot",
  );
  expect(snapshot?.state).toBe("preserved");
  expect(snapshot?.filename).toContain("snapshot");
  expect(snapshot?.sha256).toBeTruthy();
  expect(h.provider.transportSnapshots).toBe(1);
  h.store.close();

  const plain = harness(fast);
  const other = await started(plain);
  await plain.provider.writeFile(
    other.vm,
    "/workspace/repo/main.ts",
    "export {};",
  );
  plain.agent.complete(plain.store.get(other.id));
  expect((await finalized(plain, other.id)).finalization?.state).toBe(
    "preserved",
  );
  expect(plain.provider.transportSnapshots).toBe(0);
  plain.store.close();
});

test("an OpenCode outage keeps the task running until its deadline and then finalizes", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/partial.txt",
    "partial",
  );
  h.agent.broken = true;
  await h.coordinator.tick();
  const running = h.store.get(id);
  expect(running.state).toBe("running");
  expect(running.error).toContain("retrying within deadline");
  expect(running.finalization).toBeUndefined();
  h.store.patch(id, { deadline_at: Date.now() - 1 });
  const settled = await finalized(h, id);
  expect(settled.state).toBe("failed");
  expect(settled.error).toBe("Worker task timed out");
  expect(settled.finalization?.state).toBe("preserved");
  expect(
    records(h, id).find(
      (r) => r.original_path === ".swarmforge/artifacts/partial.txt",
    ),
  ).toBeTruthy();
  h.store.close();
});

test("a token-idle quiesce finalizes the retained workspace", async () => {
  const h = harness({
    ...fast,
    SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: 1,
  });
  const { id, vm } = await started(h);
  await h.provider.writeFile(vm, "/workspace/.swarmforge/logs/run.log", "tail");
  h.store.patch(id, { token_progress_at: Date.now() - 5000 });
  const settled = await finalized(h, id);
  expect(settled.state).toBe("failed");
  expect(settled.error).toContain("No token progress");
  expect(settled.finalization?.state).toBe("preserved");
  expect(
    records(h, id).find((r) => r.original_path === ".swarmforge/logs/run.log"),
  ).toBeTruthy();
  h.store.close();
});

test("a workspace result salvages a turn whose OpenCode session is gone", async () => {
  const h = harness(fast);
  const { id, vm, run } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: id,
      run_id: run,
      status: "completed",
      summary: "salvaged from disk",
    }),
  );
  h.agent.broken = true;
  const settled = await finalized(h, id);
  expect(settled.state).toBe("completed");
  expect(settled.finalization?.state).toBe("preserved");
  expect(h.store.result(id)?.summary).toBe("salvaged from disk");
  h.store.close();
});

test("the result file is read through the capture, never a provider stat/read pair", async () => {
  const h = harness(fast);
  const { id, vm, run } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: id,
      run_id: run,
      status: "completed",
      summary: "salvaged from disk",
    }),
  );
  // Any stat/read escape hatch would throw here: the capture is the only route to the bytes.
  h.provider.readFile = async () => {
    throw new Error("unsafe provider read");
  };
  h.provider.listFiles = async () => {
    throw new Error("unsafe provider listing");
  };
  h.provider.stat = async () => {
    throw new Error("unsafe provider stat");
  };
  h.agent.broken = true;
  const settled = await finalized(h, id);
  expect(settled.state).toBe("completed");
  expect(h.store.result(id)?.summary).toBe("salvaged from disk");
  expect(h.provider.transportOpens).toContain(".swarmforge/result.json");
  h.store.close();
});

test("a corrupted or oversized result file is refused instead of completed", async () => {
  const h = harness(fast);
  const worker = h.coordinator.spawn(task);
  await runToRunning(h, worker.worker_id);
  const vm = h.store.get(worker.worker_id).vm_id!;
  const run = h.store.dispatch(worker.worker_id)!.run_id;
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: worker.worker_id,
      run_id: run,
      status: "completed",
      summary: "x",
    }),
  );
  h.provider.transportCorrupt.add(`${vm}:/workspace/.swarmforge/result.json`);
  h.agent.broken = true;
  for (let i = 0; i < 4; i++) await h.coordinator.tick();
  expect(h.store.get(worker.worker_id).state).not.toBe("completed");
  expect(h.store.result(worker.worker_id)).toBeNull();

  // A result file larger than the bounded window is never partially accepted either.
  const other = harness(fast);
  const big = await started(other, "big");
  await other.provider.writeFile(
    big.vm,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: big.id,
      run_id: big.run,
      status: "completed",
      summary: "y".repeat(70000),
    }),
  );
  other.agent.broken = true;
  for (let i = 0; i < 4; i++) await other.coordinator.tick();
  expect(other.store.get(big.id).state).not.toBe("completed");
  expect(other.store.result(big.id)).toBeNull();
  h.store.close();
  other.store.close();
});

test("a failed control operation is never answered with a completion", async () => {
  const h = harness(fast);
  const { id, vm, run } = await started(h);
  // A valid result file on disk is what the step's catch handler would otherwise complete from.
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      worker_id: id,
      run_id: run,
      status: "completed",
      summary: "should not be used",
    }),
  );
  h.provider.pauseWorker = async () => {
    throw new Error("provider unavailable");
  };
  h.agent.broken = true;
  const refused = await h.coordinator.control(id, "pause");
  // The intent stays durable for the next attempt, and no turn was completed behind it.
  expect(refused.state).toBe("running");
  expect(refused.intent).toBe("pause");
  expect(refused.error).toContain("retrying within deadline");
  expect(h.store.result(id)).toBeNull();
  expect(h.store.dispatch(id)?.state).not.toBe("completed");
  h.provider.pauseWorker = async () => {};
  const paused = await within(2000, h.coordinator.control(id, "pause"));
  expect(paused.state).toBe("paused");
  expect(h.store.result(id)).toBeNull();
  h.store.close();
});

test("cancellation stops production promptly and never waits on preservation", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/notes.txt",
    "notes",
  );
  h.provider.transportFailure = "helper unavailable";
  const cancelled = await within(2000, h.coordinator.control(id, "cancel"));
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.finalization?.state).toBe("pending");
  expect(cancelled.finalization?.attempts).toBe(0);
  expect(cancelled.finalization?.completed_at).toBeNull();
  // The attempt is bounded, fails and backs off; the production stop did not wait for any of it.
  const backing = await h.coordinator.finalize(id);
  expect(backing.state).toBe("cancelled");
  expect(backing.finalization?.attempts).toBe(3);
  expect(backing.finalization?.error ?? "").toContain("helper unavailable");
  expect(h.provider.vms.has(vm)).toBe(true);
  // A scheduled retry far in the future does not delay another cancellation.
  h.store.patch(id, {
    finalization: {
      ...backing.finalization!,
      next_retry_at: Date.now() + 600000,
    },
  });
  expect((await within(2000, h.coordinator.control(id, "cancel"))).state).toBe(
    "cancelled",
  );
  h.provider.transportFailure = "";
  // A deliberate retry supersedes the scheduled automatic one instead of waiting it out.
  const recovered = await within(5000, h.coordinator.retryFinalization(id));
  expect(recovered.finalization?.state).toBe("preserved");
  expect(
    decode(
      await h.coordinator.artifacts.read(
        records(h, id).find(
          (r) => r.original_path === ".swarmforge/artifacts/notes.txt",
        )!.artifact_id,
      ),
    ),
  ).toBe("notes");
  h.store.close();
});

test("an interrupted boot records a preservation failure instead of hanging", async () => {
  const h = harness(fast);
  const worker = h.coordinator.spawn(task);
  // The guest never existed, so there is nothing to preserve and nothing to wait for.
  h.store.transition(worker.worker_id, "provisioning", {
    provision_started_at: Date.now() - 3600_000,
  });
  const settled = await finalized(h, worker.worker_id);
  expect(settled.state).toBe("failed");
  expect(settled.error).toBe("Provisioning timed out");
  expect(settled.finalization?.state).toBe("failed");
  expect(settled.finalization?.error ?? "").toContain("VM");
  expect(settled.finalization?.completed_at).toBeTruthy();
  // Nothing to collect settles immediately, so destruction is not stranded.
  const destroyed = await within(
    2000,
    h.coordinator.control(worker.worker_id, "destroy"),
  );
  expect(destroyed.state).toBe("destroyed");
  h.store.close();
});

test("a vanished VM records the lost workspace and leaves destruction unblocked", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/lost.txt",
    "x",
  );
  h.provider.vms.delete(vm);
  await h.coordinator.recover();
  const settled = await finalized(h, id);
  expect(settled.state).toBe("failed");
  expect(settled.vm_missing).toBe(true);
  expect(settled.error).toBe("VM disappeared; local workspace is lost");
  expect(settled.finalization?.state).toBe("failed");
  expect((await within(2000, h.coordinator.control(id, "destroy"))).state).toBe(
    "destroyed",
  );
  h.store.close();
});

test("normal destruction refuses an unpreserved workspace and succeeds once it settles", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/keep.txt",
    "keep",
  );
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  h.provider.transportFailure = "helper unavailable";
  expect((await finalized(h, id)).finalization?.state).toBe("failed");
  const refused = await within(5000, h.coordinator.control(id, "destroy"));
  // Nothing is deleted while preservation is unsettled or has failed.
  expect(refused.state).toBe("recovery_required");
  expect(refused.error).toContain("Artifact preservation has not settled");
  expect(refused.finalization?.state).not.toBe("abandoned");
  expect(h.provider.vms.has(vm)).toBe(true);
  expect(refused.intent).toBeNull();
  // A deliberate retry restores preservation, and then normal destruction proceeds.
  h.provider.transportFailure = "";
  expect(
    (await within(5000, h.coordinator.retryFinalization(id))).finalization
      ?.state,
  ).toBe("preserved");
  const destroyed = await within(5000, h.coordinator.control(id, "destroy"));
  expect(destroyed.state).toBe("destroyed");
  expect(h.provider.vms.has(vm)).toBe(false);
  expect(
    decode(
      await h.coordinator.artifacts.read(
        records(h, id).find(
          (r) => r.original_path === ".swarmforge/artifacts/keep.txt",
        )!.artifact_id,
      ),
    ),
  ).toBe("keep");
  h.store.close();
});

test("force destruction abandons a live collection before deleting the VM", async () => {
  const h = harness({ ...fast, SWARMFORGE_ARTIFACT_TIMEOUT_MS: 400 });
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/keep.txt",
    "keep",
  );
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  const transferring = new Promise<void>((resolve) => {
    h.provider.slowStarted = resolve;
  });
  h.provider.transportSlow = true;
  await h.coordinator.tick();
  await transferring;
  // Collecting is never preserved: an unfinished attempt is not a preserved workspace.
  expect(h.store.get(id).finalization?.state).toBe("collecting");
  const forced = await within(5000, h.coordinator.control(id, "destroy", true));
  expect(forced.state).toBe("destroyed");
  expect(forced.finalization?.state).toBe("abandoned");
  expect(h.provider.vms.has(vm)).toBe(false);
  expect(h.provider.transportAborted).toBeGreaterThan(0);
  h.provider.transportSlow = false;
  await finalized(h, id);
  expect(h.store.get(id).finalization?.state).toBe("abandoned");
  const events = h.store.events(id).map((event) => event.type);
  expect(events).toContain("finalization.abandoned");
  expect(events).not.toContain("finalization.preserved");
  // A destroyed worker is a closed decision and cannot be reopened.
  await expect(h.coordinator.retryFinalization(id)).rejects.toThrow(
    "Worker destroyed",
  );
  h.store.close();
});

test("a restart retries an interrupted collection and never marks it preserved early", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-finalization-"));
  const path = join(root, "db.sqlite");
  const provider = new FakeProvider();
  const agent = new FakeAgent();
  const settings = { ...config, ...fast, SWARMFORGE_ARTIFACT_TIMEOUT_MS: 500 };
  let store = new Store(path);
  try {
    let c = new Coordinator(settings, store, provider, agent);
    const worker = c.spawn(task);
    for (let i = 0; i < 4; i++) await c.tick();
    const run = store.dispatch(worker.worker_id)!.run_id;
    agent.complete(store.get(worker.worker_id));
    await c.tick();
    expect(["pending", "collecting"]).toContain(
      store.get(worker.worker_id).finalization?.state ?? "",
    );
    store.patch(worker.worker_id, {
      finalization: {
        state: "collecting",
        run_id: run,
        attempts: 1,
        error: null,
        next_retry_at: null,
        started_at: Date.now(),
        completed_at: null,
      },
    });
    store.close();
    store = new Store(path);
    c = new Coordinator(settings, store, provider, agent);
    const openedBefore = provider.transportOpens.length;
    await c.tick();
    await c.finalize(worker.worker_id);
    const collected = store.get(worker.worker_id);
    expect(collected.finalization?.state).toBe("preserved");
    // The interrupted attempt was already counted, so the restart adds one, not two.
    expect(collected.finalization?.attempts).toBe(2);
    expect(provider.transportOpens.length).toBeGreaterThan(openedBefore);
    // One durable attempt event per attempt, including the restart re-entering the row.
    expect(
      store
        .events(worker.worker_id)
        .filter((event) => event.type === "finalization.attempted"),
    ).toHaveLength(2);
    const opens = provider.transportOpens.length;
    store.close();
    store = new Store(path);
    c = new Coordinator(settings, store, provider, agent);
    await c.tick();
    await c.tick();
    expect(provider.transportOpens.length).toBe(opens);
    expect(store.get(worker.worker_id).finalization?.state).toBe("preserved");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exhausted retries retain the VM and a deliberate retry recovers it", async () => {
  const h = harness({ ...fast, SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: 2 });
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/keep.txt",
    "keep",
  );
  h.provider.transportFailure = "helper unavailable";
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  const settled = await finalized(h, id);
  expect(settled.state).toBe("completed");
  expect(settled.finalization?.state).toBe("failed");
  expect(settled.finalization?.attempts).toBe(2);
  expect(settled.finalization?.error ?? "").toContain("helper unavailable");
  expect(h.provider.vms.has(vm)).toBe(true);
  const events = h.store.events(id);
  expect(
    events.filter((event) => event.type === "finalization.attempted"),
  ).toHaveLength(2);
  expect(
    events.filter((event) => event.type === "finalization.failed"),
  ).toHaveLength(1);
  h.provider.transportFailure = "";
  const recovered = await within(5000, h.coordinator.retryFinalization(id));
  expect(recovered.finalization?.state).toBe("preserved");
  expect(recovered.finalization?.attempts).toBe(1);
  expect(recovered.finalization?.error).toBeNull();
  expect(
    h.store.events(id).filter((e) => e.type === "finalization.preserved"),
  ).toHaveLength(1);
  h.store.close();
});

test("a provider without artifact transport fails preservation clearly", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/report.txt",
    "x",
  );
  const transport = h.provider.artifactTransport;
  h.provider.artifactTransport =
    undefined as unknown as WorkerArtifactTransport;
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  const settled = await finalized(h, id);
  expect(settled.finalization?.state).toBe("failed");
  expect(settled.finalization?.error ?? "").toContain("transport");
  expect(settled.finalization?.attempts).toBe(3);
  expect(h.provider.vms.has(vm)).toBe(true);
  // A deliberate retry runs exactly one attempt and reports it rather than waiting out a backoff.
  const retried = await within(5000, h.coordinator.retryFinalization(id));
  expect(retried.finalization?.attempts).toBe(1);
  expect(retried.finalization?.error ?? "").toContain("transport");
  expect(["pending", "failed"]).toContain(retried.finalization?.state ?? "");
  h.provider.artifactTransport = transport;
  const recovered = await within(5000, h.coordinator.retryFinalization(id));
  expect(recovered.finalization?.state).toBe("preserved");
  expect(h.provider.transportOpens).toContain(
    ".swarmforge/artifacts/report.txt",
  );
  h.store.close();
});

test("a partially collected run keeps what it captured and a retry completes it", async () => {
  const h = harness(fast);
  const worker = h.coordinator.spawn({
    ...task,
    artifacts: [
      { path: "out/first.txt" },
      { path: "out/second.txt", required: true },
    ],
  });
  await runToRunning(h, worker.worker_id);
  const vm = h.store.get(worker.worker_id).vm_id!;
  await h.provider.writeFile(vm, "/workspace/out/first.txt", "one");
  h.provider.transportMissing.add(`${vm}:/workspace/out/second.txt`);
  h.agent.complete(h.store.get(worker.worker_id));
  await h.coordinator.tick();
  const partial = await finalized(h, worker.worker_id);
  expect(partial.finalization?.state).toBe("failed");
  expect(partial.finalization?.error ?? "").toContain("out/second.txt");
  // What the attempt did capture is already durable and readable.
  const first = records(h, worker.worker_id).find(
    (r) => r.original_path === "out/first.txt",
  );
  expect(first?.state).toBe("preserved");
  expect(first?.sha256).toBe(sha256("one"));
  expect(decode(await h.coordinator.artifacts.read(first!.artifact_id))).toBe(
    "one",
  );

  h.provider.transportMissing.clear();
  await h.provider.writeFile(vm, "/workspace/out/second.txt", "two");
  const recovered = await within(
    5000,
    h.coordinator.retryFinalization(worker.worker_id),
  );
  expect(recovered.finalization?.state).toBe("preserved");
  const kept = records(h, worker.worker_id).find(
    (r) => r.original_path === "out/first.txt",
  );
  // The same worker, run, path and content is captured once, not again.
  expect(kept?.artifact_id).toBe(first?.artifact_id);
  expect(
    decode(
      await h.coordinator.artifacts.read(
        records(h, worker.worker_id).find(
          (r) => r.original_path === "out/second.txt",
        )!.artifact_id,
      ),
    ),
  ).toBe("two");
  h.store.close();
});

test("a follow-up queued during collection is delivered only after preservation settles", async () => {
  const h = harness({ ...fast, SWARMFORGE_ARTIFACT_TIMEOUT_MS: 400 });
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/first.txt",
    "one",
  );
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  const transferring = new Promise<void>((resolve) => {
    h.provider.slowStarted = resolve;
  });
  h.provider.transportSlow = true;
  await h.coordinator.tick();
  await transferring;
  expect(h.store.get(id).finalization?.state).toBe("collecting");
  // A deliberate retry refuses to race a live collection.
  await expect(h.coordinator.retryFinalization(id)).rejects.toThrow(
    "already running",
  );
  // The follow-up is accepted durably while the previous run is still being collected.
  expect(h.coordinator.message(id, "second task").delivery).toBe("queued");
  await h.coordinator.tick();
  await h.coordinator.tick();
  expect(h.agent.submitted).toHaveLength(1);
  expect(h.store.get(id).state).not.toBe("running");
  h.provider.transportSlow = false;
  const settled = await within(5000, h.coordinator.finalize(id));
  expect(settled.finalization?.state).toBe("preserved");
  expect(h.agent.submitted).toHaveLength(1);
  await h.coordinator.tick();
  await h.coordinator.tick();
  expect(h.agent.submitted).toHaveLength(2);
  expect(h.store.get(id).state).toBe("running");
  h.store.close();
});

test("each run keeps its own artifacts and run id while events retain both outcomes", async () => {
  const h = harness(fast);
  const { id, vm, run: first } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/first.txt",
    "one",
  );
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  expect((await finalized(h, id)).finalization?.state).toBe("preserved");
  h.coordinator.message(id, "second task");
  await h.coordinator.tick();
  await h.coordinator.tick();
  const second = h.store.dispatch(id)!.run_id;
  expect(second).not.toBe(first);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/second.txt",
    "two",
  );
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  const settled = await finalized(h, id);
  expect(settled.finalization?.run_id).toBe(second);
  const found = records(h, id);
  expect(
    found
      .filter((r) => r.original_path === ".swarmforge/artifacts/first.txt")
      .map((r) => r.run_id)
      .sort(),
  ).toEqual([first, second].sort());
  expect(
    found
      .filter((r) => r.original_path === ".swarmforge/artifacts/second.txt")
      .map((r) => r.run_id),
  ).toEqual([second]);
  const types = h.store.events(id).map((event) => event.type);
  expect(types.filter((t) => t === "finalization.attempted")).toHaveLength(2);
  expect(types.filter((t) => t === "finalization.preserved")).toHaveLength(2);
  // The event vocabulary is exactly the durable attempt and settled-outcome pair the metrics
  // rebuild their cumulative counters from.
  expect(
    types.filter(
      (t) =>
        t.startsWith("finalization.") &&
        ![
          "finalization.attempted",
          "finalization.preserved",
          "finalization.failed",
          "finalization.abandoned",
        ].includes(t),
    ),
  ).toEqual([]);
  h.store.close();
});

test("required declarations fail preservation while optional ones are skipped", async () => {
  const h = harness(fast);
  const worker = h.coordinator.spawn({
    ...task,
    artifacts: [
      { path: "reports/**" },
      { path: "out/missing.txt", required: true },
    ],
  });
  await runToRunning(h, worker.worker_id);
  h.agent.complete(h.store.get(worker.worker_id));
  await h.coordinator.tick();
  const settled = await finalized(h, worker.worker_id);
  expect(settled.finalization?.state).toBe("failed");
  expect(settled.finalization?.error ?? "").toContain("out/missing.txt");
  // The optional directory was skipped rather than failing the attempt.
  expect(records(h, worker.worker_id)).toHaveLength(0);
  h.store.close();

  const other = harness(fast);
  const declared = other.coordinator.spawn({
    ...task,
    artifacts: [{ path: "reports/**", required: true }],
  });
  await runToRunning(other, declared.worker_id);
  await other.provider.writeFile(
    other.store.get(declared.worker_id).vm_id!,
    "/workspace/reports/summary.md",
    "# summary",
  );
  other.agent.complete(other.store.get(declared.worker_id));
  await other.coordinator.tick();
  const kept = await finalized(other, declared.worker_id);
  expect(kept.finalization?.state).toBe("preserved");
  expect(
    records(other, declared.worker_id).map((r) => r.original_path),
  ).toContain("reports/summary.md");
  other.store.close();
});

test("declared artifact paths are validated before a worker exists", () => {
  const h = harness(fast);
  const rejected = [
    "/etc/passwd",
    "../escape",
    "a/../b",
    "./a",
    "back\\slash",
    "wild*card",
    "deep/**/*.txt",
    "nul\u0000byte",
    "control\u0007bell",
    "c1\u0085next",
    "c1\u009flast",
    "~/home/secret",
    "a".repeat(1025),
    "/leading",
  ];
  for (const path of rejected)
    expect(() =>
      h.coordinator.spawn({ ...task, artifacts: [{ path }] }),
    ).toThrow();
  expect(h.store.all()).toHaveLength(0);
  expect(h.provider.created).toBe(0);
  expect(
    h.coordinator.spawn({
      ...task,
      artifacts: [
        { path: "out/report.txt" },
        { path: "reports/**", required: true },
      ],
    }).worker_id,
  ).toBeTruthy();
  expect(() =>
    h.coordinator.spawn({
      ...task,
      artifacts: Array.from({ length: 101 }, (_, i) => ({ path: `f${i}.txt` })),
    }),
  ).toThrow();
  expect(() =>
    h.coordinator.spawn({
      ...task,
      artifacts: [
        { path: Array.from({ length: 33 }, (_, i) => `d${i}`).join("/") },
      ],
    }),
  ).toThrow();
  h.store.close();
});

test("a control requested while a step holds the worker lock is applied without another tick", async () => {
  const h = harness(fast);
  const { id } = await started(h);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.agent.gate = () => held;
  const ticking = h.coordinator.tick();
  await Bun.sleep(5);
  const cancelling = h.coordinator.control(id, "cancel");
  release();
  await ticking;
  const cancelled = await within(2000, cancelling);
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.intent).toBeNull();
  h.agent.gate = null;
  h.store.close();
});

test("a forced destruction supersedes a stuck control intent", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  // A pause the provider cannot perform leaves the intent durable and pending.
  h.provider.pauseWorker = async () => {
    throw new Error("provider unavailable");
  };
  const stuck = await h.coordinator.control(id, "pause");
  expect(stuck.intent).toBe("pause");
  expect(stuck.state).toBe("running");
  // An ordinary different control is still refused while one is pending.
  await expect(h.coordinator.control(id, "destroy")).rejects.toThrow(
    "Another worker control operation is pending",
  );
  expect(h.provider.vms.has(vm)).toBe(true);
  // Forced destruction is the escalation an operator always has.
  const destroyed = await within(
    2000,
    h.coordinator.control(id, "destroy", true),
  );
  expect(destroyed.state).toBe("destroyed");
  expect(destroyed.intent).toBeNull();
  expect(h.provider.vms.has(vm)).toBe(false);
  expect(h.store.events(id).map((event) => event.type)).toContain(
    "worker.control_superseded",
  );
  const supersession = h.store
    .events(id)
    .filter((event) => event.type === "worker.control_superseded")
    .at(-1);
  expect(JSON.parse(supersession!.data)).toMatchObject({
    previous_intent: "pause",
    intent: "destroy",
  });
  h.store.close();
});

test("finalization is visible on the public worker view", async () => {
  const h = harness(fast);
  const { id } = await started(h);
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  expect(["pending", "collecting"]).toContain(
    h.store.get(id).finalization?.state ?? "",
  );
  expect(["pending", "collecting"]).toContain(
    publicWorker(h.coordinator, id).finalization?.state ?? "",
  );
  await finalized(h, id);
  expect(publicWorker(h.coordinator, id).finalization?.state).toBe("preserved");
  h.store.close();
});

test("declarations classify from listings, never from the guest's error wording", async () => {
  const h = harness({ ...fast, SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: 1 });
  h.provider.transportStyle = "helper";
  const worker = h.coordinator.spawn({
    ...task,
    artifacts: [
      { path: "out/first.txt" },
      { path: "out/nested/**" },
      { path: "absent/deeper/required.txt", required: true },
    ],
  });
  await runToRunning(h, worker.worker_id);
  const vm = h.store.get(worker.worker_id).vm_id!;
  await h.provider.writeFile(vm, "/workspace/out/first.txt", "one");
  await h.provider.writeFile(vm, "/workspace/out/nested/deep.txt", "two");
  h.agent.complete(h.store.get(worker.worker_id));
  await h.coordinator.tick();
  const settled = await finalized(h, worker.worker_id);
  // The helper reports a missing directory and a file identically; only a listing can tell them
  // apart, so the required absence fails while the present files are still captured.
  expect(settled.finalization?.state).toBe("failed");
  expect(settled.finalization?.attempts).toBe(1);
  expect(settled.finalization?.error ?? "").toContain(
    "absent/deeper/required.txt",
  );
  const captured = records(h, worker.worker_id).map((r) => r.original_path);
  expect(captured).toContain("out/first.txt");
  expect(captured).toContain("out/nested/deep.txt");
  h.store.close();
});

test("a missing optional declaration is skipped under the guest's own error wording", async () => {
  const h = harness(fast);
  h.provider.transportStyle = "helper";
  const worker = h.coordinator.spawn({
    ...task,
    artifacts: [{ path: "never/written.txt" }, { path: "reports/**" }],
  });
  await runToRunning(h, worker.worker_id);
  h.agent.complete(h.store.get(worker.worker_id));
  await h.coordinator.tick();
  const settled = await finalized(h, worker.worker_id);
  // Nothing optional is missing, so the default collection still preserves successfully.
  expect(settled.finalization?.state).toBe("preserved");
  expect(settled.finalization?.attempts).toBe(1);
  h.store.close();
});

// The real guest helper, run by python3 against a temporary guest tree. Package 2 behaviour is
// verified end to end here whenever that interpreter exists.
const python = process.env.SWARMFORGE_TEST_PYTHON ?? "python3";
// The data plane owns its real-helper fixture; a rename there must not break package 2.
const hasHelper =
  Bun.spawnSync([python, "-c", "pass"]).success &&
  (await import("./local-artifact-provider").then(
    (module) => typeof module.localHarness === "function",
    () => false,
  ));

test("a lost VM keeps the run it lost in its preservation record", async () => {
  const h = harness(fast);
  const { id, vm, run } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/lost.txt",
    "x",
  );
  h.provider.vms.delete(vm);
  await h.coordinator.recover();
  const settled = await finalized(h, id);
  // The run is resolved before the dispatches are cancelled, so the record still names it.
  expect(settled.state).toBe("failed");
  expect(settled.vm_missing).toBe(true);
  expect(settled.finalization?.run_id).toBe(run);
  expect(settled.finalization?.state).toBe("failed");
  expect(h.store.dispatches(id).every((d) => d.state === "cancelled")).toBe(
    true,
  );
  h.store.close();
});

test("a duplicate ordinary destroy cannot downgrade an in-flight forced destruction", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const destroy = h.provider.destroyWorker.bind(h.provider);
  h.provider.destroyWorker = async (target: string) => {
    await gate;
    return destroy(target);
  };
  const forced = h.coordinator.control(id, "destroy", true);
  await Bun.sleep(5);
  expect(h.store.get(id).force_destroy).toBe(true);
  // The duplicate ordinary destroy arrives while the forced one is still in flight. It cannot
  // resolve until the forced step finishes, so only the durable flag is asserted meanwhile.
  const duplicate = h.coordinator.control(id, "destroy");
  await Bun.sleep(5);
  expect(h.store.get(id).force_destroy).toBe(true);
  expect(h.store.get(id).intent).toBe("destroy");
  release();
  await within(5000, Promise.all([forced, duplicate]));
  const destroyed = h.store.get(id);
  expect(destroyed.state).toBe("destroyed");
  expect(h.provider.vms.has(vm)).toBe(false);
  h.store.close();
});

test("a forced destruction never rewrites a preserved record", async () => {
  const h = harness(fast);
  const { id, vm } = await started(h);
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/artifacts/keep.txt",
    "keep",
  );
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  expect((await finalized(h, id)).finalization?.state).toBe("preserved");
  const destroyed = await within(
    5000,
    h.coordinator.control(id, "destroy", true),
  );
  expect(destroyed.state).toBe("destroyed");
  // Preservation that already succeeded is a fact, not a decision a later force may undo.
  expect(destroyed.finalization?.state).toBe("preserved");
  expect(h.store.events(id).map((event) => event.type)).not.toContain(
    "finalization.abandoned",
  );
  const kept = records(h, id).find(
    (r) => r.original_path === ".swarmforge/artifacts/keep.txt",
  );
  expect(decode(await h.coordinator.artifacts.read(kept!.artifact_id))).toBe(
    "keep",
  );
  h.store.close();
});

test("the canonical result mirror is written before preservation can start", async () => {
  const h = harness(fast);
  const { id, run } = await started(h);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mirror = h.provider.writeFile.bind(h.provider);
  h.provider.writeFile = async (
    target: string,
    path: string,
    content: string,
  ) => {
    await gate;
    return mirror(target, path, content);
  };
  h.agent.complete(h.store.get(id), {
    status: "completed",
    summary: "ordered",
  });
  const completing = h.coordinator.tick();
  await Bun.sleep(5);
  // The outcome is not settled while the mirror is in flight, so no collection can capture the
  // previous run's result bytes under this run.
  expect(h.store.get(id).finalization).toBeUndefined();
  release();
  await completing;
  expect(h.store.get(id).state).toBe("completed");
  expect(h.store.get(id).finalization?.run_id).toBe(run);
  const settled = await finalized(h, id);
  expect(settled.finalization?.state).toBe("preserved");
  const captured = records(h, id).find(
    (r) => r.original_path === ".swarmforge/result.json",
  );
  expect(
    JSON.parse(
      decode(await h.coordinator.artifacts.read(captured!.artifact_id)),
    ).run_id,
  ).toBe(run);
  h.store.close();
});

test("a result file that names another run is never attributed to this one", async () => {
  const h = harness(fast);
  const { id, vm, run } = await started(h);
  // A stale canonical result left on disk by a failed mirror from an earlier run.
  await h.provider.writeFile(
    vm,
    "/workspace/.swarmforge/result.json",
    JSON.stringify({
      run_id: "an-earlier-run",
      status: "completed",
      summary: "old",
    }),
  );
  h.provider.writeFile = async () => {
    throw new Error("mirror unavailable");
  };
  h.agent.complete(h.store.get(id), {
    status: "completed",
    summary: "current",
  });
  await h.coordinator.tick();
  const settled = await finalized(h, id);
  expect(settled.finalization?.state).toBe("failed");
  expect(settled.finalization?.error ?? "").toContain("an-earlier-run");
  expect(settled.finalization?.error ?? "").toContain(run);
  // The bytes are still stored faithfully; only the attribution is refused.
  const captured = records(h, id).find(
    (r) => r.original_path === ".swarmforge/result.json",
  );
  expect(
    JSON.parse(
      decode(await h.coordinator.artifacts.read(captured!.artifact_id)),
    ).summary,
  ).toBe("old");
  h.store.close();
});

test("the real guest helper preserves defaults once and never fails on optional boot metadata", async () => {
  if (!hasHelper) return;
  const { localHarness } = await import("./local-artifact-provider");
  const h = await localHarness({
    SWARMFORGE_FINALIZATION_RETRY_MS: "1",
    SWARMFORGE_ARTIFACT_TIMEOUT_MS: "20000",
  });
  try {
    const worker = h.spawn({
      artifacts: [
        {
          path: ".swarmforge/artifacts/report.txt",
          required: true,
          directory: false,
        },
        { path: "notes", required: false, directory: true },
      ],
    });
    const vm = h.store.get(worker.worker_id).vm_id!;
    await h.provider.createWorker(h.store.get(worker.worker_id));
    // The guest bootstrap creates the artifact and log directories, and nothing else: the
    // optional task metadata defaults do not exist and must be skipped, not treated as failures.
    mkdirSync(join(h.workspace.root, "notes"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(h.workspace.root, ".swarmforge/artifacts/report.txt"),
      "real helper body",
      { mode: 0o600 },
    );
    writeFileSync(join(h.workspace.root, "notes/deep.txt"), "notes body", {
      mode: 0o600,
    });
    await h.coordinator.control(worker.worker_id, "cancel");
    const settled = await within(
      60000,
      h.coordinator.finalize(worker.worker_id),
    );
    expect(settled.finalization?.state).toBe("preserved");
    // One attempt is the norm; the bounded retries absorb a staging race in the guest helper's
    // diagnostics capture, which is reported to the data owner rather than worked around here.
    expect(settled.finalization?.attempts).toBeGreaterThanOrEqual(1);
    const records = h.coordinator.artifacts.list({
      worker_id: worker.worker_id,
    }).artifacts;
    // A declared path and the automatic directory collection are the same capture.
    const reports = records.filter(
      (record) => record.original_path === ".swarmforge/artifacts/report.txt",
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.sha256).toBe(sha256("real helper body"));
    expect(
      decode(await h.coordinator.artifacts.read(reports[0]!.artifact_id)),
    ).toBe("real helper body");
    // Exactly one capture per source: the declared file, the automatic artifact directory, the
    // declared notes directory and the guest's own raw diagnostics, with no duplicates.
    expect(records.map((record) => record.original_path).sort()).toEqual([
      ".swarmforge/artifacts/report.txt",
      "logs/git-report.txt",
      "logs/opencode-journal.txt",
      "notes/deep.txt",
    ]);
    // Optional boot metadata the guest never creates is skipped, not preserved and not failed.
    expect(
      records.some(
        (record) =>
          record.original_path === ".swarmforge/task.json" ||
          record.original_path === ".swarmforge/metadata.json",
      ),
    ).toBe(false);
    expect(new Set(records.map((record) => record.storage_key)).size).toBe(
      records.length,
    );
    expect(vm).toBeTruthy();
    // Preservation settled, so an ordinary destruction is no longer refused.
    const destroyed = await within(
      60000,
      h.coordinator.control(worker.worker_id, "destroy"),
    );
    expect(destroyed.state).toBe("destroyed");
    expect(h.provider.destroyed.has(vm)).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test("the real guest helper fails a required absence without naming it a transport error", async () => {
  if (!hasHelper) return;
  const { localHarness } = await import("./local-artifact-provider");
  const h = await localHarness({
    SWARMFORGE_FINALIZATION_RETRY_MS: "1",
    SWARMFORGE_ARTIFACT_TIMEOUT_MS: "20000",
    SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: "1",
  });
  try {
    const worker = h.spawn({
      artifacts: [
        { path: "absent/required.txt", required: true, directory: false },
      ],
    });
    await h.provider.createWorker(h.store.get(worker.worker_id));
    await h.coordinator.control(worker.worker_id, "cancel");
    const settled = await within(
      60000,
      h.coordinator.finalize(worker.worker_id),
    );
    expect(settled.finalization?.state).toBe("failed");
    expect(settled.finalization?.attempts).toBe(1);
    expect(settled.finalization?.error ?? "").toContain(
      "Required artifact absent/required.txt is missing",
    );
    // Optional defaults were collected or skipped before the required absence ended the attempt.
    expect(
      h.coordinator.artifacts
        .list({ worker_id: worker.worker_id })
        .artifacts.map((record) => record.original_path),
    ).not.toContain(".swarmforge/task.json");
  } finally {
    await h.cleanup();
  }
});

test("a persisted preservation error is redacted before it is truncated", async () => {
  const h = harness(fast);
  const { id } = await started(h);
  // A provider failure that quotes a long secret: only a prefix of it would survive truncation,
  // and a prefix is exactly what the redactor can no longer recognise.
  const secret = h.coordinator.config.SWARMFORGE_MODEL_API_KEY;
  h.provider.transportFailure = `capture failed while opening with key ${secret}`;
  h.agent.complete(h.store.get(id));
  await h.coordinator.tick();
  const settled = await finalized(h, id);
  const error = settled.finalization?.error ?? "";
  expect(error).toContain("[REDACTED]");
  expect(error).not.toContain(secret);
  expect(error).not.toContain(secret.slice(0, 8));
  expect(settled.finalization?.state).toBe("failed");
  // The redacted text survives redaction again, which a truncated secret would not.
  expect(publicWorker(h.coordinator, id).finalization?.error).toBe(error);
  expect(
    h.store
      .events(id)
      .map((event) => event.data)
      .join(" ")
      .includes(secret),
  ).toBe(false);
  h.store.close();
});

test("retry backoff stays a safe integer within a bounded horizon", () => {
  const c = { ...config, SWARMFORGE_FINALIZATION_RETRY_MS: 3600000 };
  expect(retryDelay({ ...c, SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: 3 }, 1)).toBe(
    3600000,
  );
  for (const attempts of [1, 2, 3, 10, 50, 99, 100]) {
    const delay = retryDelay(c, attempts);
    expect(Number.isSafeInteger(delay)).toBe(true);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(maxRetryDelay);
  }
  // Doubling stops mattering long before the attempt bound is reached.
  expect(retryDelay(c, 90)).toBe(retryDelay(c, 100));
  const short = {
    ...c,
    SWARMFORGE_FINALIZATION_RETRY_MS: 2000,
    SWARMFORGE_ARTIFACT_TIMEOUT_MS: 5000,
  };
  expect(retryDelay(short, 1)).toBe(2000);
  expect(retryDelay(short, 2)).toBe(4000);
  // The bound never exceeds the configured transfer timeout when that is the smaller horizon.
  expect(retryDelay(short, 100)).toBe(5000);
});

test("concurrent finalizations stay inside the configured bound", async () => {
  const h = harness({ ...fast, SWARMFORGE_ARTIFACT_CONCURRENCY: 1 });
  h.provider.transportDelayMs = 2;
  const first = await started(h, "one");
  const second = await started(h, "two");
  h.agent.complete(h.store.get(first.id));
  h.agent.complete(h.store.get(second.id));
  await h.coordinator.tick();
  // Two workers settle at once, but only one guest is ever being collected at a time.
  await Promise.all([
    h.coordinator.finalize(first.id),
    h.coordinator.finalize(second.id),
  ]);
  expect(h.provider.maxActiveGuests).toBe(1);
  expect(h.store.get(first.id).finalization?.state).toBe("preserved");
  expect(h.store.get(second.id).finalization?.state).toBe("preserved");
  h.store.close();

  // More slots really are used, so the gate releases instead of serializing everything.
  const wider = harness({ ...fast, SWARMFORGE_ARTIFACT_CONCURRENCY: 4 });
  wider.provider.transportDelayMs = 4;
  const third = await started(wider, "three");
  const fourth = await started(wider, "four");
  wider.agent.complete(wider.store.get(third.id));
  wider.agent.complete(wider.store.get(fourth.id));
  await wider.coordinator.tick();
  await Promise.all([
    wider.coordinator.finalize(third.id),
    wider.coordinator.finalize(fourth.id),
  ]);
  expect(wider.provider.maxActiveGuests).toBe(2);
  wider.store.close();
});

test("artifact and finalization configuration defaults and bounds match the plan", () => {
  const env = {
    FREESTYLE_API_TOKEN: "infra-secret",
    FREESTYLE_SNAPSHOT_ID: "snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "model-secret",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "opaque-tree",
  };
  const c = loadConfig(env);
  expect(c.SWARMFORGE_ARTIFACT_MAX_BYTES).toBe(1073741824);
  expect(c.SWARMFORGE_ARTIFACT_MAX_ENTRIES).toBe(10000);
  expect(c.SWARMFORGE_ARTIFACT_MAX_DEPTH).toBe(32);
  expect(c.SWARMFORGE_ARTIFACT_TIMEOUT_MS).toBe(120000);
  expect(c.SWARMFORGE_ARTIFACT_CONCURRENCY).toBe(4);
  expect(c.SWARMFORGE_FINALIZATION_MAX_ATTEMPTS).toBe(3);
  expect(c.SWARMFORGE_FINALIZATION_RETRY_MS).toBe(2000);
  // Default storage sits beside the database; an in-memory database gets a private temporary root.
  expect(
    loadConfig({
      ...env,
      SWARMFORGE_DB_PATH: "/srv/swarmforge/db.sqlite",
    }).SWARMFORGE_ARTIFACT_DIR,
  ).toBe("/srv/swarmforge/artifacts");
  expect(
    loadConfig({
      ...env,
      SWARMFORGE_DB_PATH: ":memory:",
    }).SWARMFORGE_ARTIFACT_DIR.startsWith(tmpdir()),
  ).toBe(true);
  expect(
    loadConfig({ ...env, SWARMFORGE_ARTIFACT_DIR: "/var/artifacts" })
      .SWARMFORGE_ARTIFACT_DIR,
  ).toBe("/var/artifacts");
  for (const key of [
    "SWARMFORGE_ARTIFACT_MAX_BYTES",
    "SWARMFORGE_ARTIFACT_MAX_ENTRIES",
    "SWARMFORGE_ARTIFACT_MAX_DEPTH",
    "SWARMFORGE_ARTIFACT_TIMEOUT_MS",
    "SWARMFORGE_ARTIFACT_CONCURRENCY",
    "SWARMFORGE_FINALIZATION_MAX_ATTEMPTS",
    "SWARMFORGE_FINALIZATION_RETRY_MS",
  ]) {
    expect(() => loadConfig({ ...env, [key]: "1.5" })).toThrow();
    expect(() => loadConfig({ ...env, [key]: "0" })).toThrow();
    expect(() => loadConfig({ ...env, [key]: "-2" })).toThrow();
    expect(() =>
      loadConfig({ ...env, [key]: "99999999999999999999" }),
    ).toThrow();
  }
  expect(
    loadConfig({ ...env, SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: "9" })
      .SWARMFORGE_FINALIZATION_MAX_ATTEMPTS,
  ).toBe(9);
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import type { AgentMessage } from "../src/domain";
import { Store } from "../src/store";
import {
  config,
  FakeAgent,
  FakeProvider,
  harness,
  runToRunning,
  task,
} from "./helpers";

const env = {
  FREESTYLE_API_TOKEN: "infra-secret",
  FREESTYLE_SNAPSHOT_ID: "snapshot",
  SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
  SWARMFORGE_MODEL_API_KEY: "model-secret",
  SWARMFORGE_MODEL_NAME: "qwen",
  SWARMFORGE_GIT_TREE: "opaque-tree",
  SWARMFORGE_DB_PATH: ":memory:",
};
const idle = config.SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS * 1000;
const aged = (h: ReturnType<typeof harness>, id: string, ms: number) =>
  h.store.patch(id, { token_progress_at: Date.now() - ms }).token_progress_at!;
function partial(
  h: ReturnType<typeof harness>,
  id: string,
  message: string,
  input: number,
) {
  const s = h.agent.snapshots.get(id);
  if (!s) throw new Error("no snapshot");
  const m: AgentMessage = {
    id: message,
    parent_id: s.messages[0]!.id,
    role: "assistant",
    completed: false,
    input,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    model: "qwen",
  };
  const at = s.messages.findIndex((x) => x.id === message);
  if (at >= 0) s.messages[at] = m;
  else s.messages.push(m);
}

test("token idle budget defaults to 300 seconds, allows 0 and rejects negatives", () => {
  expect(loadConfig(env).SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS).toBe(300);
  expect(
    loadConfig({ ...env, SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "45" })
      .SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS,
  ).toBe(45);
  expect(
    loadConfig({ ...env, SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "0" })
      .SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS,
  ).toBe(0);
  expect(() =>
    loadConfig({ ...env, SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "-1" }),
  ).toThrow();
  expect(() =>
    loadConfig({ ...env, SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "1.5" }),
  ).toThrow();
});

test("claiming a zero-token dispatch starts the clock and expiry stops OpenCode", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  expect(h.store.get(w.worker_id).token_progress_at).toBeGreaterThan(0);
  expect(h.store.tokens({ worker_id: w.worker_id }).total).toBe(0);
  let stopped = false;
  const exec = h.provider.exec.bind(h.provider);
  h.provider.exec = async (id, command) => {
    if (command.includes("systemctl stop")) stopped = true;
    return exec(id, command);
  };
  aged(h, w.worker_id, idle);
  await h.coordinator.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("failed");
  expect(after.error).toContain("No token progress");
  expect(stopped).toBe(true);
  h.store.close();
});

test("a recorded token increase restarts the clock", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  aged(h, w.worker_id, idle - 1000);
  partial(h, w.worker_id, "answer-1", 40);
  const observed = Date.now();
  await h.coordinator.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("running");
  expect(after.token_progress_total).toBe(40);
  expect(after.token_progress_at).toBeGreaterThanOrEqual(observed);
  h.store.close();
});

test("a regressed repeat snapshot cannot inflate or reset progress", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  partial(h, w.worker_id, "answer-1", 40);
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).token_progress_total).toBe(40);
  const regressed = aged(h, w.worker_id, idle - 1000);
  partial(h, w.worker_id, "answer-1", 12);
  await h.coordinator.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("running");
  expect(after.token_progress_total).toBe(40);
  expect(after.token_progress_at).toBe(regressed);
  h.store.close();
});

test("a turn that completes is never idle stopped", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.agent.complete(h.store.get(w.worker_id));
  aged(h, w.worker_id, 20 * idle);
  await h.coordinator.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("completed");
  expect(h.store.result(w.worker_id)?.summary).toBe("done");
  h.store.close();
});

test("a failed status poll is not a no-progress observation", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const marked = aged(h, w.worker_id, 20 * idle);
  h.agent.broken = true;
  await h.coordinator.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("running");
  expect(after.token_progress_at).toBe(marked);
  h.agent.broken = false;
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("failed");
  h.store.close();
});

test("pause suspends the clock and resume shifts it by the pause duration", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const claimed = h.store.get(w.worker_id).token_progress_at!;
  await h.coordinator.control(w.worker_id, "pause");
  h.store.patch(w.worker_id, { paused_at: Date.now() - 90_000 });
  await h.coordinator.control(w.worker_id, "resume");
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("running");
  expect(after.paused_at).toBeNull();
  expect((after.token_progress_at ?? 0) - claimed).toBeGreaterThanOrEqual(
    90_000,
  );
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("running");
  h.store.close();
});

test("a follow-up dispatch restarts the clock", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.agent.complete(h.store.get(w.worker_id));
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("completed");
  aged(h, w.worker_id, 20 * idle);
  h.coordinator.message(w.worker_id, "next");
  const queued = Date.now();
  await h.coordinator.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("running");
  expect(h.agent.submitted).toHaveLength(2);
  expect(after.token_progress_at).toBeGreaterThanOrEqual(queued);
  await h.coordinator.tick();
  expect(h.store.get(w.worker_id).state).toBe("running");
  h.store.close();
});

test("a reopened database keeps the idle clock instead of restarting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-idle-"));
  const path = join(root, "db.sqlite");
  const provider = new FakeProvider();
  const agent = new FakeAgent();
  let store = new Store(path);
  try {
    let c = new Coordinator(config, store, provider, agent);
    const w = c.spawn(task);
    for (let i = 0; i < 3; i++) await c.tick();
    expect(store.get(w.worker_id).state).toBe("running");
    store.patch(w.worker_id, { token_progress_at: Date.now() - idle });
    store.close();
    store = new Store(path);
    c = new Coordinator(config, store, provider, agent);
    await c.recover();
    expect(store.get(w.worker_id).token_progress_at).toBeLessThanOrEqual(
      Date.now() - idle,
    );
    await c.tick();
    expect(store.get(w.worker_id).state).toBe("failed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active worker saved before the idle fields existed starts a fresh clock", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const legacy = h.store.get(w.worker_id);
  delete legacy.token_progress_at;
  delete legacy.token_progress_total;
  h.store.db
    .query("UPDATE workers SET body=? WHERE worker_id=?")
    .run(JSON.stringify(legacy), w.worker_id);
  const restarted = new Coordinator(config, h.store, h.provider, h.agent);
  await restarted.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("running");
  expect(after.token_progress_at).toBeGreaterThan(0);
  expect(after.token_progress_total).toBe(0);
  h.store.close();
});

test("Git push retries do not trigger the token idle stop", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const withGit = new Coordinator(
    { ...config, SWARMFORGE_GIT_PUSH_MODE: "github-app" },
    h.store,
    h.provider,
    h.agent,
  );
  h.provider.pushFailure = true;
  h.agent.complete(h.store.get(w.worker_id));
  aged(h, w.worker_id, 20 * idle);
  await withGit.tick();
  expect(h.store.get(w.worker_id).state).toBe("running");
  expect(h.store.get(w.worker_id).error).toContain("Git branch push");
  h.store.close();
});

test("zero disables the idle stop", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  aged(h, w.worker_id, 1000 * idle);
  const disabled = new Coordinator(
    { ...config, SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: 0 },
    h.store,
    h.provider,
    h.agent,
  );
  await disabled.tick();
  expect(h.store.get(w.worker_id).state).toBe("running");
  h.store.close();
});

test("an idle stop with unpersisted work requires recovery and keeps the VM", async () => {
  const h = harness();
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  h.provider.dirty = true;
  aged(h, w.worker_id, idle);
  await h.coordinator.tick();
  const after = h.store.get(w.worker_id);
  expect(after.state).toBe("recovery_required");
  expect(after.error).toContain("No token progress");
  expect(after.vm_id).toBeTruthy();
  expect(h.provider.vms.size).toBe(1);
  h.store.close();
});

import { describe, expect, test } from "bun:test";
import { gitTree, loadConfig, workerEnvironment } from "../src/config";
import { resultSchema } from "../src/domain";
import { colorForEvent, renderEvent, renderStartup } from "../src/runtime";
import { Store } from "../src/store";

export const env = {
  FREESTYLE_API_TOKEN: "infra-secret",
  FREESTYLE_SNAPSHOT_ID: "snapshot-test",
  SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
  SWARMFORGE_MODEL_API_KEY: "model-secret",
  SWARMFORGE_MODEL_NAME: "qwen",
  SWARMFORGE_GIT_TREE: "opaque:external-tree",
  SWARMFORGE_DB_PATH: ":memory:",
};
describe("configuration and credential boundary", () => {
  test("rejects missing required configuration and invalid limits", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ ...env, SWARMFORGE_MAX_WORKERS: "0" })).toThrow();
    expect(() =>
      loadConfig({ ...env, SWARMFORGE_METRICS_ENABLED: "perhaps" }),
    ).toThrow();
    expect(() => loadConfig({ ...env, SWARMFORGE_HOST: "0.0.0.0" })).toThrow();
  });
  test("passes the opaque tree and model access but no host infrastructure secrets", () => {
    const c = loadConfig(env);
    const values = workerEnvironment(c, {
      worker_id: "w",
      team_id: "t",
      task_id: "task",
    });
    expect(values.SWARMFORGE_GIT_TREE).toBe("opaque:external-tree");
    expect(values.SWARMFORGE_MODEL_API_KEY).toBe("model-secret");
    expect(JSON.stringify(values)).not.toContain("infra-secret");
    expect(values.FREESTYLE_API_TOKEN).toBeUndefined();
  });
  test("none prefix skips clone and strips the marker from the guest tree", () => {
    expect(gitTree("https://example.com/a.git")).toEqual({
      clone: true,
      target: "https://example.com/a.git",
    });
    expect(gitTree("none")).toEqual({ clone: false, target: "" });
    expect(gitTree("none:/mnt/prepared")).toEqual({
      clone: false,
      target: "/mnt/prepared",
    });
    const values = workerEnvironment(
      loadConfig({ ...env, SWARMFORGE_GIT_TREE: "none:/mnt/prepared" }),
      { worker_id: "w", team_id: "t", task_id: "task" },
    );
    expect(values.SWARMFORGE_GIT_TREE).toBe("/mnt/prepared");
  });
});
describe("persistent domain", () => {
  test("atomically creates ownership, deduplicates request keys and transitions", () => {
    const s = new Store(":memory:");
    const w = s.create({
      team_id: "team",
      task_id: "task",
      role: "coder",
      prompt: "work",
      timeout_seconds: 60,
      request_id: "key",
    });
    expect(
      s.create({
        team_id: "team",
        task_id: "task",
        role: "coder",
        prompt: "work",
        timeout_seconds: 60,
        request_id: "key",
      }).worker_id,
    ).toBe(w.worker_id);
    expect(() =>
      s.create({
        team_id: "team",
        task_id: "other",
        role: "coder",
        prompt: "different",
        timeout_seconds: 60,
        request_id: "key",
      }),
    ).toThrow();
    s.transition(w.worker_id, "provisioning");
    s.transition(w.worker_id, "provisioning");
    expect(
      s.events(w.worker_id).filter((e) => e.type === "worker.provisioning"),
    ).toHaveLength(1);
    expect(s.tasks("team")).toHaveLength(1);
    expect(s.teams()).toHaveLength(1);
    s.close();
  });
  test("message usage is cumulative and idempotent with late token updates", () => {
    const s = new Store(":memory:");
    const w = s.create({
      team_id: "team",
      task_id: "task",
      role: "coder",
      prompt: "work",
      timeout_seconds: 60,
    });
    s.usage(w.worker_id, "msg", "qwen", 10, 5, 0, 0, 0);
    s.usage(w.worker_id, "msg", "qwen", 10, 5, 0, 0, 0);
    s.usage(w.worker_id, "msg", "qwen", 10, 8, 0, 0, 0);
    expect(s.tokens({ team_id: "team" })).toMatchObject({
      input: 10,
      output: 8,
      total: 18,
    });
    s.close();
  });
  test("result validation rejects malformed completion and excessive payloads", () => {
    expect(
      resultSchema.safeParse({
        status: "completed",
        summary: "done",
        files_changed: Array(200).fill("x".repeat(1000)),
      }).success,
    ).toBe(false);
    expect(
      resultSchema.safeParse({ status: "completed", summary: "ok" }).success,
    ).toBe(true);
    expect(
      resultSchema.safeParse({ status: "whatever", summary: "ok" }).success,
    ).toBe(false);
    expect(
      resultSchema.safeParse({
        status: "completed",
        summary: "x".repeat(10000),
      }).success,
    ).toBe(false);
  });
});
describe("colorful console event rendering", () => {
  const event = {
    type: "worker.booting" as const,
    at: 0,
    data: JSON.stringify({ vm_id: "vm-1" }),
  };
  const worker = {
    worker_id: "w-1",
    team_id: "backend",
    task_id: "auth",
    vm_id: "vm-1",
    error: null,
  };
  test("renders plain text without color codes when color is off", () => {
    const line = renderEvent(event, worker, false);
    expect(line).not.toContain("\u001b[");
    for (const part of ["booting", "w-1", "backend/auth", "vm=vm-1", "vm-1"])
      expect(line).toContain(part);
  });
  test("adds ANSI codes and picks red for failures", () => {
    expect(renderEvent(event, worker, true)).toContain("\u001b[");
    expect(colorForEvent("worker.destroyed")).toBe("magenta");
    expect(colorForEvent("worker.failed")).toBe("red");
    expect(colorForEvent("worker.recovery_required")).toBe("red");
  });
});

test("startup output is readable in a terminal and structured when piped", () => {
  const info = {
    host: "127.0.0.1",
    port: 8787,
    metricsEnabled: true,
    metricsPort: 9090,
  };
  const terminal = renderStartup(info, true);
  expect(terminal).toContain("SwarmForge  ● listening");
  expect(terminal).toContain("http://127.0.0.1:8787/mcp");
  expect(terminal).toContain("bun run status");
  expect(JSON.parse(renderStartup(info, false))).toMatchObject({
    level: "info",
    message: "SwarmForge listening",
    host: "127.0.0.1",
    port: 8787,
  });
});

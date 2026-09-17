import { describe, expect, test } from "bun:test";
import { loadConfig, workerEnvironment } from "../src/config";
import { resultSchema } from "../src/domain";
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

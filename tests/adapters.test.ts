import { expect, test } from "bun:test";
import { Freestyle } from "freestyle";
import { loadConfig } from "../src/config";
import { FreestyleProvider } from "../src/providers/freestyle";
import { OpenCodeAgent } from "../src/providers/opencode";
import { Store } from "../src/store";

const c = loadConfig({
  FREESTYLE_API_TOKEN: "infra-secret",
  FREESTYLE_SNAPSHOT_ID: "snap",
  SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
  SWARMFORGE_MODEL_API_KEY: "model-secret",
  SWARMFORGE_MODEL_NAME: "qwen",
  SWARMFORGE_GIT_TREE: "opaque-tree",
  SWARMFORGE_DB_PATH: ":memory:",
});
function worker() {
  const s = new Store(":memory:");
  const w = s.create({
    team_id: "team",
    task_id: "task",
    role: "coder",
    prompt: "work",
    timeout_seconds: 60,
  });
  s.close();
  return {
    ...w,
    vm_id: "vm-1",
    endpoint: "https://worker.example",
    opencode_session_id: "ses-1",
  };
}
test("OpenCode accounting reads older message pages after downtime", async () => {
  const a = new OpenCodeAgent(c, (async (input: RequestInfo | URL) => {
    const url = new URL((input as Request).url);
    if (url.pathname.endsWith("/status"))
      return Response.json({ "ses-1": { type: "idle" } });
    const message = (id: string) => ({
      info: {
        id,
        parentID: "msg-task",
        role: "assistant",
        modelID: "qwen",
        time: { created: 1, completed: 2 },
        tokens: {
          input: 1,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [],
    });
    return Response.json(
      url.searchParams.has("before")
        ? [message("msg-000")]
        : Array.from({ length: 100 }, (_, i) =>
            message(`msg-${String(i + 1).padStart(3, "0")}`),
          ),
    );
  }) as typeof fetch);
  const snapshot = await a.inspect(worker());
  expect(snapshot.messages).toHaveLength(101);
  expect(snapshot.messages.reduce((total, m) => total + m.output, 0)).toBe(202);
});
test("Freestyle creates persistent uniquely discoverable VMs without management secrets in guest config", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (init?.method === "GET")
      return Response.json(
        { code: "NOT_FOUND", message: "missing" },
        { status: 404 },
      );
    return Response.json({
      id: "vm-1",
      slug: "sf-default-test",
      state: "running",
      resources: {},
    });
  };
  const p = new FreestyleProvider(
    c,
    new Freestyle({ apiKey: "infra-secret", fetch: fetcher as typeof fetch }),
  );
  await p.createWorker(worker());
  expect(calls[0]?.path).toContain("/v5/vms");
  expect(calls[1]?.body).toMatchObject({
    snapshotId: "snap",
    autoDeleteSeconds: -1,
    metadata: { swarmforge: "default" },
  });
  expect(JSON.stringify(calls[1]?.body)).not.toContain("infra-secret");
});
test("Freestyle routes workers through the configured custom domain suffix", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      path: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (init?.method === "GET")
      return Response.json(
        { code: "NOT_FOUND", message: "missing" },
        { status: 404 },
      );
    return Response.json({
      id: "vm-1",
      slug: "sf-default-test",
      state: "running",
      resources: {},
    });
  };
  const custom = loadConfig({
    ...Object.fromEntries(
      Object.entries(c).map(([key, value]) => [key, String(value)]),
    ),
    SWARMFORGE_METRICS_ENABLED: "true",
    SWARMFORGE_WORKER_DOMAIN_SUFFIX: "workers.example.com",
  });
  const p = new FreestyleProvider(
    custom,
    new Freestyle({ apiKey: "infra-secret", fetch: fetcher as typeof fetch }),
  );
  const w = worker();
  await p.createWorker(w);
  expect(calls[1]?.body).toMatchObject({
    tls: {
      rules: [
        {
          domain: `sf-default-${w.worker_id.slice(2)}.workers.example.com`,
        },
      ],
    },
  });
});
test("Freestyle clones the configured tree into workspace/repo unless none is set", async () => {
  const execs: string[] = [];
  const fakeClient = {
    vms: {
      ref: () => ({
        exec: async ({ command }: { command: string }) => {
          execs.push(command);
          return { statusCode: 0, stdout: "", stderr: "" };
        },
        fs: { writeTextFile: async () => undefined },
      }),
    },
  } as unknown as Freestyle;
  const p = new FreestyleProvider(c, fakeClient);
  await p.prepare(worker());
  expect(execs.some((cmd) => cmd.includes("git clone"))).toBe(true);
  expect(execs.some((cmd) => cmd.includes("opaque-tree"))).toBe(true);
  expect(
    execs.some((cmd) => cmd.includes("repo/.git") && cmd.includes("rm -rf")),
  ).toBe(true);
  execs.length = 0;
  await p.prepare(worker());
  expect(execs.every((cmd) => !cmd.startsWith("git clone"))).toBe(true);
  const none = new FreestyleProvider(
    loadConfig({
      ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])),
      SWARMFORGE_GIT_TREE: "none",
    }),
    fakeClient,
  );
  execs.length = 0;
  await none.prepare(worker());
  expect(execs.some((cmd) => cmd.includes("git clone"))).toBe(false);
});
test("OpenCode async prompt requests JSON text and keeps the stable message id", async () => {
  let body: Record<string, unknown> = {};
  let path = "";
  const a = new OpenCodeAgent(c, (async (input: RequestInfo | URL) => {
    const r = input as Request;
    path = r.url;
    body = (await r.json()) as Record<string, unknown>;
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  const w = worker();
  const d = {
    run_id: "run-1",
    worker_id: w.worker_id,
    message_id: "msg_123",
    message: "implement",
    state: "pending" as const,
    created_at: Date.now(),
    sent_at: null,
    result: null,
  };
  await a.submit(w, d);
  expect(path).toContain("/session/ses-1/prompt_async");
  expect(body.messageID).toBe("msg_123");
  expect(body.format).toBeUndefined();
  expect(body.system).toContain("one JSON object and no markdown");
  expect(JSON.stringify(body)).toContain("run-1");
  expect(JSON.stringify(body)).not.toContain("model-secret");
});
test("OpenCode reads JSON results from completed assistant text", async () => {
  const a = new OpenCodeAgent(c, (async (input: RequestInfo | URL) => {
    const path = (input as Request).url;
    if (path.includes("/status"))
      return Response.json({ "ses-1": { type: "idle" } });
    return Response.json([
      {
        info: {
          id: "msg-answer",
          parentID: "msg_123",
          role: "assistant",
          modelID: "qwen",
          time: { created: 1, completed: 2 },
          tokens: {
            input: 10,
            output: 20,
            reasoning: 3,
            cache: { read: 2, write: 0 },
          },
        },
        parts: [
          {
            type: "text",
            text: '{"status":"completed","summary":"done"}',
          },
        ],
      },
    ]);
  }) as typeof fetch);
  const snapshot = await a.inspect(worker());
  expect(snapshot.messages[0]?.result).toEqual({
    status: "completed",
    summary: "done",
  });
});
test("OpenCode reads typed structured results and token usage without stdout scraping", async () => {
  const a = new OpenCodeAgent(c, (async (input: RequestInfo | URL) => {
    const path = (input as Request).url;
    if (path.includes("/status"))
      return Response.json({ "ses-1": { type: "idle" } });
    return Response.json([
      {
        info: {
          id: "msg-answer",
          parentID: "msg_123",
          role: "assistant",
          modelID: "qwen",
          time: { created: 1, completed: 2 },
          tokens: {
            input: 10,
            output: 20,
            reasoning: 3,
            cache: { read: 2, write: 0 },
          },
          structured: { status: "completed", summary: "done" },
        },
        parts: [],
      },
    ]);
  }) as typeof fetch);
  const status = await a.inspect(worker());
  expect(status.messages[0]).toMatchObject({
    result: { summary: "done" },
    input: 10,
    output: 20,
    reasoning: 3,
    cache_read: 2,
  });
});

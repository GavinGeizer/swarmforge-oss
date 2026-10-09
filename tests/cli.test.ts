import { expect, test } from "bun:test";
import { connectSwarmForge } from "../src/cli/client";
import { createHttpHandler } from "../src/http";
import { VERSION } from "../src/version";
import { harness, task } from "./helpers";

test("overview client reads every worker page through authenticated MCP", async () => {
  const h = harness();
  h.coordinator.config.SWARMFORGE_API_TOKEN =
    "a-test-token-with-enough-characters";
  for (let index = 0; index < 101; index++)
    h.store.create({
      ...task,
      task_id: `task-${index}`,
      request_id: `request-${index}`,
      timeout_seconds: 60,
    });
  const handler = createHttpHandler(h.coordinator);
  let advertisedVersion: string | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const message = await request.clone().json();
        if (message.method === "initialize")
          advertisedVersion = message.params.clientInfo.version;
      }
      return handler(request);
    },
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  let client: Awaited<ReturnType<typeof connectSwarmForge>> | undefined;
  try {
    client = await connectSwarmForge(
      url,
      "a-test-token-with-enough-characters",
    );
    expect(advertisedVersion).toBe(VERSION);
    const overview = await client.overview();
    expect(overview.url).toBe(url);
    expect(overview.workers).toHaveLength(101);
    expect(overview.states.queued).toBe(101);
    expect(overview.metrics).toEqual({ enabled: true, port: 9090 });
  } finally {
    await client?.close();
    await server.stop(true);
    h.store.close();
  }
});

test("status command prints JSON or a plain snapshot when piped", async () => {
  const h = harness();
  h.coordinator.config.SWARMFORGE_API_TOKEN =
    "a-test-token-with-enough-characters";
  h.store.create({ ...task, timeout_seconds: 60 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const invoke = async (flags: string[]) => {
    const child = Bun.spawn(
      ["bun", "src/cli.ts", "status", ...flags, "--url", url],
      {
        cwd: `${import.meta.dir}/..`,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SWARMFORGE_API_TOKEN: "a-test-token-with-enough-characters",
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  try {
    const json = await invoke(["--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      states: { queued: 1 },
      workers: [{ state: "queued", task_id: task.task_id }],
    });
    const plain = await invoke([]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain("QUEUED");
    expect(plain.stdout).toContain(`team / ${task.task_id}`);
    expect(plain.stdout).not.toContain("\u001b[");
  } finally {
    await server.stop(true);
    h.store.close();
  }
});

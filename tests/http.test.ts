import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import { createHttpHandler } from "../src/http";
import { Store } from "../src/store";
import { FakeAgent, FakeProvider, harness, task } from "./helpers";

test("HTTP transport authenticates leads, rejects hostile origins and serves real MCP calls", async () => {
  const h = harness();
  h.coordinator.config.SWARMFORGE_API_TOKEN =
    "a-test-token-with-enough-characters";
  const handler = createHttpHandler(h.coordinator);
  expect(
    (await handler(new Request("http://localhost/mcp", { method: "POST" })))
      .status,
  ).toBe(401);
  expect(
    (
      await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer a-test-token-with-enough-characters",
            origin: "https://hostile.example",
          },
        }),
      )
    ).status,
  ).toBe(403);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "lead", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
        {
          requestInit: {
            headers: {
              authorization: "Bearer a-test-token-with-enough-characters",
            },
          },
        },
      ),
    );
    const r = await client.callTool({ name: "spawn_worker", arguments: task });
    expect(r.isError).not.toBe(true);
    expect((r.structuredContent as { state: string }).state).toBe("queued");
  } finally {
    await client.close();
    await server.stop(true);
    h.store.close();
    delete h.coordinator.config.SWARMFORGE_API_TOKEN;
  }
});

test("a public allowed hostname behind a loopback bind requires the bearer token", async () => {
  const loopback = harness();
  const loopbackHandler = createHttpHandler(loopback.coordinator);
  const anonymous = await loopbackHandler(
    new Request("http://localhost/health"),
  );
  expect(anonymous.status).toBe(200);
  expect(await anonymous.json()).toEqual({ status: "ok" });
  loopback.store.close();

  const token = "a-test-token-with-enough-characters";
  const proxyEnv = {
    FREESTYLE_API_TOKEN: "infra-secret",
    FREESTYLE_SNAPSHOT_ID: "snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "model-secret",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "opaque-tree",
    SWARMFORGE_DB_PATH: ":memory:",
    SWARMFORGE_HOST: "127.0.0.1",
    SWARMFORGE_ALLOWED_HOSTS: "mcp.example.com",
  };
  expect(() => loadConfig(proxyEnv)).toThrow(/SWARMFORGE_API_TOKEN/);
  const store = new Store(":memory:");
  const coordinator = new Coordinator(
    loadConfig({ ...proxyEnv, SWARMFORGE_API_TOKEN: token }),
    store,
    new FakeProvider(),
    new FakeAgent(),
  );
  const handler = createHttpHandler(coordinator);
  const headers = (bearer?: string) => ({
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  for (const url of [
    "http://mcp.example.com/health",
    "http://127.0.0.1/health",
  ]) {
    expect(
      (await handler(new Request(url, { headers: headers() }))).status,
    ).toBe(401);
    expect(
      (
        await handler(
          new Request(url, {
            headers: headers("a-wrong-token-with-enough-characters"),
          }),
        )
      ).status,
    ).toBe(401);
  }
  const health = await handler(
    new Request("http://mcp.example.com/health", { headers: headers(token) }),
  );
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  const mcp = await handler(
    new Request("http://mcp.example.com/mcp", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "lead", version: "1" },
        },
      }),
    }),
  );
  expect(mcp.status).toBe(200);
  expect(((await mcp.json()) as { result: object }).result).toBeDefined();
  store.close();
});

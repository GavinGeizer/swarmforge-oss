import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpHandler } from "../src/http";
import { harness, task } from "./helpers";

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

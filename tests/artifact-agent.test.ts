import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp";
import { localHarness } from "./local-artifact-provider";

test("agents receive live plaintext or binary metadata without base64 payloads", async () => {
  const h = await localHarness();
  const w = h.spawn();
  await h.provider.createWorker(w);
  writeFileSync(
    join(h.workspace.root, ".swarmforge/artifacts/report.txt"),
    "Readable findings\n",
  );
  writeFileSync(
    join(h.workspace.root, ".swarmforge/artifacts/binary.bin"),
    new Uint8Array([0, 255, 128]),
  );
  writeFileSync(
    join(h.workspace.root, ".swarmforge/artifacts/secret.txt"),
    h.config.SWARMFORGE_MODEL_API_KEY,
  );
  const server = createMcpServer(h.coordinator);
  const client = new Client({ name: "agent-reader-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    expect(client.getInstructions()).toContain("read_worker_artifact");
    expect(client.getInstructions()).toContain("swarmforge artifacts download");
    const result = await client.callTool({
      name: "read_worker_artifact",
      arguments: { worker_id: w.worker_id, path: "report.txt" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      text: "Readable findings\n",
      binary: false,
    });
    expect(JSON.stringify(result)).not.toContain("UmVhZGFibGU");
    expect(
      Array.isArray(result.content) &&
        result.content.some(
          (block: { type?: string }) => block.type === "resource_link",
        ),
    ).toBe(false);
    const binary = await client.callTool({
      name: "read_worker_artifact",
      arguments: { worker_id: w.worker_id, path: "binary.bin" },
    });
    expect(binary.structuredContent).toMatchObject({
      binary: true,
      text: null,
    });
    expect(JSON.stringify(binary)).toContain("swarmforge artifacts download");
    const secret = await client.callTool({
      name: "read_worker_artifact",
      arguments: { worker_id: w.worker_id, path: "secret.txt" },
    });
    expect(secret.isError).toBe(true);
    expect(JSON.stringify(secret)).not.toContain(
      h.config.SWARMFORGE_MODEL_API_KEY,
    );
    const oversized = await client.callTool({
      name: "read_worker_artifact",
      arguments: { worker_id: w.worker_id, path: "report.txt", length: 32769 },
    });
    expect(oversized.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await h.coordinator.stop();
    await h.cleanup();
  }
});

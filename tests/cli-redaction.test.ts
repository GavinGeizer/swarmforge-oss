import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { connectSwarmForge } from "../src/cli/client";
import { runDashboard } from "../src/cli/tui";
import { createHttpHandler } from "../src/http";
import { redactedText, withRedactionContext } from "../src/settings/inspect";
import { harness, runToRunning, task } from "./helpers";

async function fixture() {
  const h = harness();
  const token = "synthetic-client-bearer-with-enough-characters";
  const prior = "synthetic-superseded-config-credential";
  h.coordinator.config.SWARMFORGE_API_TOKEN = token;
  const worker = h.coordinator.spawn(task);
  await runToRunning(h, worker.worker_id);
  const handler = createHttpHandler(h.coordinator);
  let denial: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (denial && request.method === "POST") {
        const rpc = (await request.clone().json()) as {
          id: unknown;
          method: string;
        };
        if (rpc.method === "tools/call")
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              isError: true,
              content: [{ type: "text", text: denial }],
            },
          });
      }
      return handler(request);
    },
  });
  const url = `http://127.0.0.1:${server.port}/mcp?token=${token}`;
  const settings = withRedactionContext(
    { value: { url, token }, configPath: null, provenance: {} },
    [token, prior],
  );
  const client = await connectSwarmForge(url, token, (text: string) =>
    redactedText(settings, text),
  );
  return {
    client,
    settings,
    token,
    prior,
    worker,
    deny(message: string) {
      denial = message;
    },
    async close() {
      await client.close();
      await server.stop(true);
      h.store.close();
    },
  };
}

for (const technical of [false, true]) {
  test(`dashboard ${technical ? "technical" : "chibi"} refreshes keep credentials out of every frame`, async () => {
    const f = await fixture();
    const frames: string[] = [];
    const input = Object.assign(new EventEmitter(), {
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    }) as unknown as typeof process.stdin;
    const output = Object.assign(new EventEmitter(), {
      columns: 120,
      rows: 40,
      write: (value: string) => {
        frames.push(value);
        return true;
      },
    }) as unknown as typeof process.stdout;
    let session: Promise<void> | undefined;
    try {
      const initial = await f.client.overview();
      // The old CLI protected only this first frame; the client must protect later ones too.
      initial.url = redactedText(f.settings, initial.url);
      session = runDashboard(f.client, initial, input, output, 10);
      if (technical) input.emit("keypress", "\t", { name: "tab" });
      const overviewFrame = (frame: string) =>
        frame.includes(technical ? "MCP  " : "YOUR TASKS");
      for (
        let attempts = 0;
        frames.filter(overviewFrame).length < 2 && attempts < 100;
        attempts++
      )
        await Bun.sleep(10);
      expect(frames.filter(overviewFrame).length).toBeGreaterThanOrEqual(2);
      expect(frames.join("")).not.toContain(f.token);
      f.deny(`Proxy echoed ${f.token}`);
      for (
        let attempts = 0;
        !frames.some((frame) => frame.includes("Refresh failed")) &&
        attempts < 100;
        attempts++
      )
        await Bun.sleep(10);
      expect(frames.some((frame) => frame.includes("Refresh failed"))).toBe(
        true,
      );
      expect(frames.join("")).not.toContain(f.token);
      expect(frames.join("")).toContain("Proxy echoed [REDACTED]");
    } finally {
      input.emit("keypress", "", { name: "q" });
      await session;
      await f.close();
    }
  });
}

test("all client operations scrub echoed credentials using the resolved settings context", async () => {
  const f = await fixture();
  try {
    const obscure = `${f.token.slice(0, 8)}\u0001${f.token.slice(8)}`;
    f.deny(`Proxy echoed ${obscure} and ${f.prior}`);
    for (const action of [
      () => f.client.overview(),
      () => f.client.worker(f.worker.worker_id),
      () => f.client.inspect(f.worker.worker_id),
      () => f.client.result(f.worker.worker_id),
      () => f.client.control(f.worker.worker_id, "pause"),
      () => f.client.artifacts(f.worker.worker_id),
      () => f.client.retryPreservation(f.worker.worker_id),
    ])
      await expect(action()).rejects.toThrow(
        "Proxy echoed [REDACTED] and [REDACTED]",
      );
  } finally {
    await f.close();
  }
});

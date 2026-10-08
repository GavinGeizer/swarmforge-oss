import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import * as metrics from "../src/metrics";
import { startServer } from "../src/serve";
import { config, FakeAgent, FakeProvider, harness } from "./helpers";

test("operational metrics deny unauthenticated, hostile-host and cross-origin requests", async () => {
  const h = harness({ SWARMFORGE_API_TOKEN: "private-operator-token-value" });
  const handler = metrics.createMetricsHandler(h.coordinator);
  try {
    expect(
      (await handler(new Request("http://127.0.0.1/metrics"))).status,
    ).toBe(401);
    const headers = { authorization: "Bearer private-operator-token-value" };
    expect(
      (await handler(new Request("http://127.0.0.1/metrics", { headers })))
        .status,
    ).toBe(200);
    expect(
      (await handler(new Request("http://public.example/metrics", { headers })))
        .status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1/metrics", {
            headers: { ...headers, origin: "https://attacker.example" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1/metrics", { method: "POST", headers }),
        )
      ).status,
    ).toBe(405);
  } finally {
    h.store.close();
  }
});

test("loopback diagnostics remain available without a configured instance token", async () => {
  const h = harness();
  try {
    const result = await metrics.createMetricsHandler(h.coordinator)(
      new Request("http://localhost/metrics"),
    );
    expect(result.status).toBe(200);
    expect(await result.text()).toContain("swarmforge_workers");
    expect(result.headers.get("cache-control")).toBe("no-store");
  } finally {
    h.store.close();
  }
});

const nonLoopback = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

test.skipIf(!nonLoopback)(
  "a public API bind does not publish an unauthenticated metrics listener",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-private-metrics-"));
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const metricsPort = probe.port!;
    await probe.stop(true);
    const server = await startServer(
      {
        ...config,
        SWARMFORGE_DB_PATH: join(dir, "state.sqlite"),
        SWARMFORGE_HOST: "0.0.0.0",
        SWARMFORGE_ALLOWED_HOSTS: nonLoopback!,
        SWARMFORGE_PORT: 0,
        SWARMFORGE_METRICS_PORT: metricsPort,
        SWARMFORGE_API_TOKEN: "private-operator-token-value",
      },
      { provider: new FakeProvider(), agent: new FakeAgent() },
    );
    try {
      const result = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
      expect(result.status).toBe(401);
      const publicApi = await fetch(
        `http://${nonLoopback}:${new URL(server.url).port}/health`,
        { headers: { authorization: "Bearer private-operator-token-value" } },
      );
      expect(publicApi.status).toBe(200);
      await expect(
        fetch(`http://${nonLoopback}:${metricsPort}/metrics`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
      expect(await result.text()).not.toContain("swarmforge_workers");
      const authorized = await fetch(
        `http://127.0.0.1:${metricsPort}/metrics`,
        {
          headers: { authorization: "Bearer private-operator-token-value" },
        },
      );
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toContain("swarmforge_workers");
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

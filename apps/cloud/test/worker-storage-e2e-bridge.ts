import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Uniquely named D1-to-Bun E2E bridge helper (worker-client-storage owner).
//
// REAL Node Miniflare/workerd D1 + actual DEFAULT production Cloud Worker
// behind a loopback HTTP bridge, with NO bearer-credential logging. Request
// and response BODIES are never logged; only method/path/status/latency
// observations leave the bridge. Query strings are stripped before logging.
//
// Provisional adapter, explicitly labeled: until the lead integrates the
// approved cloud-route modules into the default Worker, this bridge serves
// the fixture's production handler (real D1/workerd identity + machine
// routes) through the same loopback shape the final bridge will use. Once
// routing lands, the adapter target switches to the default Worker with no
// bridge-shape change. Nothing here is certified as live traffic.

export type BridgeObservation = {
  method: string;
  path: string;
  status: number;
  ms: number;
};

// Miniflare dispatch returns a workerd-flavored Response; the bridge only
// needs status + headers + body bytes, so the handler type stays structural.
export type ProductionHandlerResult = {
  status: number;
  headers: unknown;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type ProductionHandler = (
  path: string,
  headers: Record<string, string>,
  method: string,
  body: unknown,
) => Promise<ProductionHandlerResult>;

export type BridgeOptions = {
  shutdownMs?: number;
};

function stripQuery(path: string) {
  const at = path.indexOf("?");
  return at === -1 ? path : path.slice(0, at);
}

export async function startBridge(
  handler: ProductionHandler,
  options: BridgeOptions = {},
): Promise<{
  origin: string;
  observations: BridgeObservation[];
  close: () => Promise<void>;
}> {
  const observations: BridgeObservation[] = [];
  const server: Server = createServer(async (req, res) => {
    const started = Date.now();
    const loggedPath = stripQuery(req.url ?? "/");
    try {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(",") : v;
      const result = await handler(
        req.url ?? "/",
        headers,
        req.method ?? "GET",
        chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : undefined,
      );
      observations.push({
        method: req.method ?? "GET",
        path: loggedPath,
        status: result.status,
        ms: Date.now() - started,
      });
      res.writeHead(
        result.status,
        Object.fromEntries(
          result.headers as unknown as Iterable<readonly [string, string]>,
        ),
      );
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      observations.push({
        method: req.method ?? "GET",
        path: loggedPath,
        status: 503,
        ms: Date.now() - started,
      });
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "fixture_failure", message: "Fixture failed" },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const shutdownMs = options.shutdownMs ?? 5000;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    observations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("bridge shutdown timed out")),
          shutdownMs,
        );
        server.close((e) => {
          clearTimeout(timer);
          if (e) reject(e);
          else resolve();
        });
      }),
  };
}

export function assertNoCredentialLeak(
  haystacks: string[],
  secrets: string[],
): void {
  for (const hay of haystacks)
    for (const secret of secrets)
      if (secret && hay.includes(secret))
        throw new Error("bridge leaked credential material into logs");
}

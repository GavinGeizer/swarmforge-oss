import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Coordinator } from "./coordinator";
import { createMcpServer } from "./mcp";
import { redactorFor } from "./security";
export function createHttpHandler(c: Coordinator) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const hosts = new Set([
      "127.0.0.1",
      "localhost",
      "[::1]",
      c.config.SWARMFORGE_HOST,
      ...c.config.SWARMFORGE_ALLOWED_HOSTS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ]);
    if (!hosts.has(url.hostname))
      return new Response("Invalid host", { status: 403 });
    const expected = c.config.SWARMFORGE_API_TOKEN;
    if (expected) {
      const actual = request.headers.get("authorization") ?? "";
      const desired = `Bearer ${expected}`;
      if (
        Buffer.byteLength(actual) !== Buffer.byteLength(desired) ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(desired))
      )
        return new Response("Unauthorized", { status: 401 });
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin)
      return new Response("Forbidden origin", { status: 403 });
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/events" && request.method === "GET") {
      const after = Number(
        request.headers.get("last-event-id") ??
          url.searchParams.get("after") ??
          0,
      );
      if (!Number.isSafeInteger(after) || after < 0)
        return new Response("Invalid event cursor", { status: 400 });
      const redactor = redactorFor(c);
      const events = c.store.events(undefined, after, 100);
      return new Response(
        `retry: 2000\n\n${events.map((e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(redactor.value(e))}\n\n`).join("")}`,
        {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        },
      );
    }
    if (url.pathname !== "/mcp")
      return new Response("Not found", { status: 404 });
    if (request.method === "GET" || request.method === "DELETE")
      return new Response("Stateless MCP transport", {
        status: 405,
        headers: { Allow: "POST" },
      });
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    if (Number(request.headers.get("content-length") ?? 0) > 131072)
      return new Response("Request too large", { status: 413 });
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 131072) {
          await reader.cancel();
          return new Response("Request too large", { status: 413 });
        }
        chunks.push(value);
      }
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    // A disconnected client aborts its wait instead of holding a listener open.
    const server = createMcpServer(c, request.signal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { parsedBody: body });
    } catch {
      return new Response("MCP request failed", { status: 500 });
    } finally {
      await server.close();
    }
  };
}

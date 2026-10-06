import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { safeFilename } from "./artifact-types";
import type { Coordinator } from "./coordinator";
import { idSchema } from "./domain";
import { createMcpServer } from "./mcp";
import { redactorFor } from "./security";

// Raw artifact bytes are served only through an authenticated, same-origin download that a
// client fetches explicitly. The response is always an attachment with no sniffing and no
// caching, and one response streams at most this many bytes so a range cannot become an
// unbounded read.
const maxDownloadRange = 8 * 1024 * 1024;
// Reads in small chunks so one bounded range is served through the service's own raw read
// limit whatever that limit is.
const rangeChunk = 32768;
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
    const download = url.pathname.match(/^\/artifacts\/([^/]+)\/download$/);
    if (download) {
      let artifactId: string;
      try {
        artifactId = decodeURIComponent(download[1]!);
      } catch {
        return new Response("Artifact not found", { status: 404 });
      }
      return artifactDownload(c, request, artifactId);
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

// Preserved bytes are private: they are only served to an authenticated, same-origin GET,
// never rendered inline, never cached and never sniffed. Records that are not preserved
// never reach the byte path, and no storage locator or artifact content appears in a body.
async function artifactDownload(
  c: Coordinator,
  request: Request,
  artifactId: string,
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  // A caller that already disappeared receives nothing rather than an open stream.
  if (request.signal?.aborted)
    return new Response("Client closed the request", { status: 499 });
  const parsed = idSchema.safeParse(artifactId);
  if (!parsed.success)
    return new Response("Artifact not found", { status: 404 });
  let record: ReturnType<Coordinator["artifacts"]["metadata"]>;
  try {
    record = c.artifacts.metadata(parsed.data);
  } catch {
    return new Response("Artifact not found", { status: 404 });
  }
  if (record.state !== "preserved")
    return new Response("Artifact is not preserved", { status: 409 });
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${attachmentName(record.filename)}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  });
  const size = Math.max(0, record.size);
  const requested = request.headers.get("range");
  if (requested === null) {
    if (size === 0) return new Response(null, { status: 200, headers });
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await c.artifacts.download(record.artifact_id, request.signal);
    } catch {
      return new Response("Artifact bytes are unavailable", { status: 500 });
    }
    headers.set("content-length", String(size));
    return new Response(stream, { status: 200, headers });
  }
  const range = byteRange(requested, size);
  if (!range)
    return new Response("Requested range is not satisfiable", {
      status: 416,
      headers: {
        ...Object.fromEntries(headers),
        "content-range": `bytes */${size}`,
      },
    });
  const start = range.start;
  // The advertised range is exactly what the response carries: clipped to the artifact and to
  // the per-response window, never past the last byte that exists.
  const end = Math.min(range.end, start + maxDownloadRange - 1);
  headers.set("content-length", String(end - start + 1));
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  return new Response(
    rangedStream(c, record.storage_key!, start, end, request.signal),
    { status: 206, headers },
  );
}
// One validated range per response. Multi-range, reversed, unsatisfiable and non-numeric
// requests are refused instead of silently returning something else.
function byteRange(header: string, size: number) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size === 0) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    start >= size
  )
    return null;
  // An end past the stored size is clipped to it, so Content-Range and Content-Length never
  // advertise bytes the response cannot deliver.
  return { start, end: Math.min(end, size - 1) };
}
async function* rangedChunks(
  c: Coordinator,
  storageKey: string,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
) {
  let offset = start;
  while (offset <= end) {
    if (signal?.aborted) throw new Error("Artifact download aborted");
    const chunk = await c.artifacts.storage.read(
      storageKey,
      offset,
      Math.min(rangeChunk, end - offset + 1),
    );
    if (!chunk.length) return;
    offset += chunk.length;
    yield chunk;
  }
}
function rangedStream(
  c: Coordinator,
  storageKey: string,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
) {
  const chunks = rangedChunks(c, storageKey, start, end, signal);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return?.(undefined);
    },
  });
}
// A stored filename is untrusted, so the attachment header uses the shared storage-side
// filename sanitizer: no separators, no control characters, nothing that breaks the header.
function attachmentName(name: string) {
  return safeFilename(name, "artifact");
}

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerProvider } from "../src/domain";
import { createHttpHandler } from "../src/http";
import { harness, runToRunning, task } from "./helpers";
import { localWorkspace } from "./local-artifact-provider";

const TOKEN = "download-token-with-enough-characters";
const MAX_RANGE = 8 * 1024 * 1024;

// One served worker whose workspace is a real temporary guest driven by the package 1 local
// transport, so downloads move bytes that the production guest helper actually captured.
async function served() {
  const h = harness();
  const workspace = await localWorkspace();
  (h.provider as WorkerProvider).artifactTransport = workspace.transport;
  h.coordinator.config.SWARMFORGE_API_TOKEN = TOKEN;
  h.coordinator.config.SWARMFORGE_WORKSPACE = workspace.root;
  const handler = createHttpHandler(h.coordinator);
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const vm = h.store.get(w.worker_id).vm_id!;
  const write = (path: string, content: string | Uint8Array) => {
    const target = join(workspace.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const authed = (path: string, init: RequestInit = {}) =>
    handler(
      new Request(`http://127.0.0.1${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
      }),
    );
  return {
    ...h,
    workspace,
    vm,
    workerId: w.worker_id,
    handler,
    authed,
    write,
    destroyWorkspace: () =>
      rmSync(workspace.base, { recursive: true, force: true }),
    done: async () => {
      delete h.coordinator.config.SWARMFORGE_API_TOKEN;
      h.store.close();
      await workspace.cleanup();
    },
  };
}
async function preserve(h: Awaited<ReturnType<typeof served>>, path: string) {
  const record = await h.coordinator.artifacts.preserve(h.workerId, path, {});
  return record;
}
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

test("raw artifact download requires the bearer token and rejects cross-origin requests", async () => {
  const h = await served();
  try {
    const payload = "raw-bytes-stay-private";
    h.write("raw.txt", payload);
    const { artifact_id } = await preserve(h, "raw.txt");
    const url = `/artifacts/${artifact_id}/download`;
    expect(
      (await h.handler(new Request(`http://127.0.0.1${url}`))).status,
    ).toBe(401);
    expect(
      (
        await h.handler(
          new Request(`http://127.0.0.1${url}`, {
            headers: {
              authorization: "Bearer a-wrong-token-with-enough-characters",
            },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await h.handler(
          new Request(`http://127.0.0.1${url}`, {
            headers: {
              authorization: `Bearer ${TOKEN}`,
              origin: "https://hostile.example",
            },
          }),
        )
      ).status,
    ).toBe(403);
    expect((await h.authed(url)).status).toBe(200);
    expect(
      (await h.authed(url, { method: "POST", body: "x" })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await h.handler(
          new Request(`http://127.0.0.1/artifacts/..%2F..%2Fetc/download`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          }),
        )
      ).status,
    ).toBe(404);
  } finally {
    await h.done();
  }
});

test("authenticated download streams faithful raw bytes as a non-sniffable attachment", async () => {
  const h = await served();
  try {
    const payload = Buffer.from(
      Array.from({ length: 5000 }, (_, n) => n % 256),
    );
    const content = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      payload,
    ]);
    h.write("evidence.bin", content);
    const record = await preserve(h, "evidence.bin");
    const response = await h.authed(
      `/artifacts/${record.artifact_id}/download`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition.startsWith("attachment;")).toBe(true);
    expect(disposition).toContain("evidence.bin");
    expect(Number(response.headers.get("content-length"))).toBe(content.length);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(content.length);
    expect(record.sha256).toBe(digest(content));
    expect(digest(bytes)).toBe(record.sha256 ?? "");
  } finally {
    await h.done();
  }
});

test("download filenames cannot break out of the content-disposition header", async () => {
  const h = await served();
  try {
    const name = 'report";drop=injected.png';
    h.write(name, "payload");
    const record = await preserve(h, name);
    const response = await h.authed(
      `/artifacts/${record.artifact_id}/download`,
    );
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition.split('"').length - 1).toBe(2);
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"/);
  } finally {
    await h.done();
  }
});

test("byte ranges are validated, reported and bounded", async () => {
  const h = await served();
  try {
    const content = "abcdefghij".repeat(10);
    h.write("ranged.txt", content);
    const record = await preserve(h, "ranged.txt");
    const url = `/artifacts/${record.artifact_id}/download`;
    const first = await h.authed(url, { headers: { range: "bytes=0-9" } });
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(
      `bytes 0-9/${content.length}`,
    );
    expect(first.headers.get("content-length")).toBe("10");
    expect(await first.text()).toBe("abcdefghij");

    const suffix = await h.authed(url, { headers: { range: "bytes=-5" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(
      `bytes ${content.length - 5}-${content.length - 1}/${content.length}`,
    );
    expect(await suffix.text()).toBe("fghij");

    const open = await h.authed(url, {
      headers: { range: `bytes=${content.length - 3}-` },
    });
    expect(open.status).toBe(206);
    expect(await open.text()).toBe("hij");

    for (const header of [
      "bytes=0-4,10-12",
      "items=0-4",
      `bytes=${content.length + 10}-${content.length + 20}`,
      "bytes=9-2",
      "bytes=-0",
      "bytes=abc-def",
    ]) {
      const refused = await h.authed(url, { headers: { range: header } });
      expect([refused.status, header]).toEqual([416, header]);
      expect(refused.headers.get("content-range")).toBe(
        `bytes */${content.length}`,
      );
    }
    const whole = await h.authed(url, {
      headers: { range: `bytes=0-${content.length * 10}` },
    });
    expect(whole.status).toBe(206);
    expect(await whole.text()).toBe(content);
  } finally {
    await h.done();
  }
});

test("a range request larger than the download window is clamped instead of streamed whole", async () => {
  const h = await served();
  try {
    const size = MAX_RANGE + 1024 * 1024;
    const content = Buffer.alloc(size, 0x61);
    h.write("big.bin", content);
    const record = await preserve(h, "big.bin");
    expect(record.size).toBe(size);
    const response = await h.authed(
      `/artifacts/${record.artifact_id}/download`,
      {
        headers: { range: `bytes=0-${size - 1}` },
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 0-${MAX_RANGE - 1}/${size}`,
    );
    expect(Number(response.headers.get("content-length"))).toBe(MAX_RANGE);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(MAX_RANGE);
    expect(digest(body)).toBe(digest(content.subarray(0, MAX_RANGE)));
    // The remaining bytes stay retrievable with a follow-up range.
    const tail = await h.authed(`/artifacts/${record.artifact_id}/download`, {
      headers: { range: `bytes=${MAX_RANGE}-` },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(
      `bytes ${MAX_RANGE}-${size - 1}/${size}`,
    );
  } finally {
    await h.done();
  }
});

test("unknown or unpreserved artifacts are never served as bytes", async () => {
  const h = await served();
  try {
    const missing = await h.authed("/artifacts/a-missing/download");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("a-missing-secret");
    const service = h.coordinator.artifacts as unknown as {
      metadata: (id: string) => unknown;
    };
    const original = service.metadata.bind(h.coordinator.artifacts);
    service.metadata = (id: string) =>
      id === "a-failed"
        ? {
            artifact_id: "a-failed",
            task_id: "task",
            worker_id: h.workerId,
            run_id: null,
            original_path: "logs/broken.log",
            storage_key: "/var/lib/swarmforge/private/key",
            filename: "broken.log",
            size: 12,
            sha256: digest("broken bytes"),
            created_at: 1,
            retrieved_at: null,
            state: "failed",
            attempts: 2,
            error: "capture failed",
            kind: "file",
          }
        : original(id);
    const failed = await h.authed("/artifacts/a-failed/download");
    expect(failed.status).toBe(409);
    const text = await failed.text();
    expect(text).not.toContain("/var/lib/swarmforge");
    expect(text.length).toBeLessThan(200);
    expect(text).not.toContain("broken bytes");
  } finally {
    await h.done();
  }
});

test("preserved artifacts stay downloadable after the worker and its workspace are destroyed", async () => {
  const h = await served();
  try {
    const content = "recovered-before-destruction";
    h.write("findings.json", content);
    const record = await preserve(h, "findings.json");
    await h.coordinator.control(h.workerId, "destroy", true);
    h.destroyWorkspace();
    expect(h.store.get(h.workerId).state).toBe("destroyed");
    const response = await h.authed(
      `/artifacts/${record.artifact_id}/download`,
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes).toString("utf8")).toBe(content);
    expect(digest(bytes)).toBe(record.sha256 ?? "");
  } finally {
    await h.done();
  }
});

test("a cancelled caller receives no artifact bytes", async () => {
  const h = await served();
  try {
    h.write("cancelled.txt", "0123456789");
    const record = await preserve(h, "cancelled.txt");
    const controller = new AbortController();
    controller.abort();
    const response = await h.handler(
      new Request(`http://127.0.0.1/artifacts/${record.artifact_id}/download`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(499);
    expect(await response.text()).not.toContain("0123456789");
  } finally {
    await h.done();
  }
});

test("a range end past the artifact is clipped to the artifact, in the headers and on the wire", async () => {
  const h = await served();
  try {
    const content = "abcdefghij";
    h.write("clip.txt", content);
    const record = await preserve(h, "clip.txt");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: h.handler,
    });
    try {
      const fetchRange = async (range: string) => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/artifacts/${record.artifact_id}/download`,
          { headers: { authorization: `Bearer ${TOKEN}`, range } },
        );
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          declared: response.headers.get("content-length"),
          body: await response.text(),
        };
      };
      // A range end beyond the stored size must not be advertised or sent: the client is
      // told exactly which bytes it received and receives exactly that many.
      for (const [range, expectedRange, expectedBody] of [
        ["bytes=5-999", "bytes 5-9/10", "fghij"],
        ["bytes=8-999", "bytes 8-9/10", "ij"],
        ["bytes=0-999", "bytes 0-9/10", content],
        ["bytes=9-10", "bytes 9-9/10", "j"],
      ] as const) {
        const got = await fetchRange(range);
        expect([range, got.status]).toEqual([range, 206]);
        expect([range, got.contentRange]).toEqual([range, expectedRange]);
        expect([range, got.declared]).toEqual([
          range,
          String(expectedBody.length),
        ]);
        expect([range, Buffer.byteLength(got.body)]).toEqual([
          range,
          expectedBody.length,
        ]);
        expect([range, got.body]).toEqual([range, expectedBody]);
      }
    } finally {
      await server.stop(true);
    }
  } finally {
    await h.done();
  }
});

test("a suffix range larger than the artifact returns the whole artifact, not padding", async () => {
  const h = await served();
  try {
    const content = "0123456789";
    h.write("suffix.txt", content);
    const record = await preserve(h, "suffix.txt");
    const response = await h.authed(
      `/artifacts/${record.artifact_id}/download`,
      {
        headers: { range: "bytes=-4096" },
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-9/10");
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe(content);
  } finally {
    await h.done();
  }
});

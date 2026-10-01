import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WorkerProvider } from "../src/domain";
import { createMcpServer } from "../src/mcp";
import {
  destroyGuestWorkspace,
  guestFile,
  guestRoot,
  guestTransport,
  linkGuestFile,
  writeGuestFile,
} from "./artifact-double";
import { harness, runToRunning, task } from "./helpers";

// A guest worker whose workspace is a real temporary directory served through the artifact
// transport, so preserved bytes, sizes and checksums are the ones a lead would retrieve.
async function artifactWorker() {
  const h = harness();
  const root = guestRoot();
  (h.provider as WorkerProvider).artifactTransport = guestTransport(root);
  const w = h.coordinator.spawn(task);
  await runToRunning(h, w.worker_id);
  const vm = h.store.get(w.worker_id).vm_id!;
  return {
    ...h,
    root,
    vm,
    workspace: h.coordinator.config.SWARMFORGE_WORKSPACE,
    workerId: w.worker_id,
    write: (path: string, content: string | Uint8Array) =>
      writeGuestFile(
        root,
        vm,
        h.coordinator.config.SWARMFORGE_WORKSPACE,
        path,
        content,
      ),
    link: (path: string, target: string) =>
      linkGuestFile(
        root,
        vm,
        h.coordinator.config.SWARMFORGE_WORKSPACE,
        path,
        target,
      ),
    path: (path: string) =>
      guestFile(root, vm, h.coordinator.config.SWARMFORGE_WORKSPACE, path),
    destroyWorkspace: () => destroyGuestWorkspace(root, vm),
    done: () => {
      h.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function lead(
  h: Awaited<ReturnType<typeof artifactWorker>>,
  signal?: AbortSignal,
) {
  const server = createMcpServer(h.coordinator, signal);
  const client = new Client({ name: "artifact-lead", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
const text = (result: unknown) =>
  (result as { content?: { type: string; text?: string }[] }).content?.find(
    (c) => c.type === "text",
  )?.text ?? "";
const body = (result: unknown) =>
  (result as { structuredContent?: Record<string, unknown> })
    .structuredContent ?? {};
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

test("preserve_artifact stores a workspace file and reports verifiable public metadata", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    const findings = `${JSON.stringify({ verdict: "ship it", notes: "line" }, null, 2)}\n`;
    h.write("findings.json", findings);
    const preserved = await client.callTool({
      name: "preserve_artifact",
      arguments: { worker_id: h.workerId, path: "findings.json" },
    });
    expect(preserved.isError).not.toBe(true);
    const artifacts = body(preserved).artifacts as {
      artifact_id: string;
      original_path: string;
      filename: string;
      size: number;
      sha256: string;
      state: string;
      kind: string;
      storage_key?: string;
    }[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.original_path).toBe("findings.json");
    expect(artifacts[0]!.filename).toBe("findings.json");
    expect(artifacts[0]!.size).toBe(Buffer.byteLength(findings));
    expect(artifacts[0]!.sha256).toBe(sha256(findings));
    expect(artifacts[0]!.state).toBe("preserved");
    // Internal storage locators are never part of a lead-facing projection.
    expect(JSON.stringify(preserved)).not.toContain("storage_key");
    expect(JSON.stringify(preserved)).not.toContain(".partial");

    const meta = await client.callTool({
      name: "get_artifact_metadata",
      arguments: { artifact_id: artifacts[0]!.artifact_id },
    });
    expect(meta.isError).not.toBe(true);
    expect(body(meta)).toMatchObject({
      artifact_id: artifacts[0]!.artifact_id,
      worker_id: h.workerId,
      state: "preserved",
      sha256: artifacts[0]!.sha256,
    });
  } finally {
    await close();
    h.done();
  }
});

test("read_artifact returns screened inline text, is capped at 32 KiB and never inlines a whole file", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    const marker = "uniquely-identifiable-tail-marker";
    const line = (n: number) => `line-${n} `.repeat(18);
    const body_ =
      Array.from({ length: 900 }, (_, n) => line(n)).join("") + marker;
    h.write("report.txt", body_);
    const { artifacts } = body(
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: "report.txt" },
      }),
    ) as unknown as { artifacts: { artifact_id: string; size: number }[] };
    const id = artifacts[0]!.artifact_id;
    expect(artifacts[0]!.size).toBe(Buffer.byteLength(body_));

    const first = await client.callTool({
      name: "read_artifact",
      arguments: { artifact_id: id, length: 1024 },
    });
    expect(first.isError).not.toBe(true);
    const view = body(first) as unknown as {
      text: string;
      binary: boolean;
      returned_bytes: number;
      next_offset: number | null;
      download_path: string;
      size: number;
      sha256: string;
    };
    expect(view.binary).toBe(false);
    expect(view.returned_bytes).toBe(1024);
    expect(view.next_offset).toBe(1024);
    expect(view.text.length).toBe(1024);
    expect(view.text).toBe(body_.slice(0, 1024));
    expect(view.size).toBe(Buffer.byteLength(body_));
    expect(view.sha256).toBe(sha256(body_));
    // Large raw bytes are only reachable through the authenticated download handle.
    expect(view.download_path).toBe(`/artifacts/${id}/download`);
    expect(JSON.stringify(first)).not.toContain(marker);

    const maximum = await client.callTool({
      name: "read_artifact",
      arguments: { artifact_id: id, length: 32768 },
    });
    expect(body(maximum).returned_bytes).toBe(32768);
    const refused = await client.callTool({
      name: "read_artifact",
      arguments: { artifact_id: id, length: 32769 },
    });
    expect(refused.isError).toBe(true);
    const past = await client.callTool({
      name: "read_artifact",
      arguments: {
        artifact_id: id,
        offset: artifacts[0]!.size,
        length: 512,
      },
    });
    expect(body(past).returned_bytes).toBe(0);
    expect(body(past).text).toBe("");
    expect(body(past).next_offset).toBeNull();
  } finally {
    await close();
    h.done();
  }
});

test("read_artifact reports binary artifacts as metadata plus a download handle, never as bytes", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x7f, 0x00]),
    ]);
    h.write("screenshot.png", png);
    const { artifacts } = body(
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: "screenshot.png" },
      }),
    ) as unknown as { artifacts: { artifact_id: string }[] };
    const id = artifacts[0]!.artifact_id;
    const view = await client.callTool({
      name: "read_artifact",
      arguments: { artifact_id: id, length: 32768 },
    });
    const read = body(view) as unknown as {
      binary: boolean;
      text: string | null;
      size: number;
      sha256: string;
      download_path: string;
    };
    expect(read.binary).toBe(true);
    expect(read.text).toBeNull();
    expect(read.size).toBe(png.length);
    expect(read.sha256).toBe(sha256(png));
    expect(read.download_path).toBe(`/artifacts/${id}/download`);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(png.toString("base64"));
    expect(serialized).not.toContain("iVBOR");
  } finally {
    await close();
    h.done();
  }
});

test("inline reads refuse artifact contents that carry configured credentials", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write(
      "leaky.env",
      `TOKEN=${h.coordinator.config.SWARMFORGE_MODEL_API_KEY}\n`,
    );
    const { artifacts } = body(
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: "leaky.env" },
      }),
    ) as unknown as { artifacts: { artifact_id: string }[] };
    const id = artifacts[0]!.artifact_id;
    const refused = await client.callTool({
      name: "read_artifact",
      arguments: { artifact_id: id },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).not.toContain("model-secret");
    expect(text(refused).length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(refused)).not.toContain("model-secret");
    // The raw download is a separate, authenticated operation and still offers the bytes.
    expect(
      body(
        await client.callTool({
          name: "get_artifact_metadata",
          arguments: { artifact_id: id },
        }),
      ).state,
    ).toBe("preserved");
  } finally {
    await close();
    h.done();
  }
});

test("list_artifacts paginates with bounded limits and filters by worker or task", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    for (const name of ["a.txt", "b.txt", "c.txt"])
      h.write(name, `content-${name}`);
    for (const name of ["a.txt", "b.txt", "c.txt"])
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: name },
      });
    const page = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { limit: 1 },
      }),
    ) as unknown as {
      artifacts: { artifact_id: string }[];
      next_offset: number | null;
    };
    expect(page.artifacts).toHaveLength(1);
    expect(page.next_offset).toBe(1);
    const rest = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { limit: 2, offset: 1 },
      }),
    ) as unknown as { artifacts: unknown[]; next_offset: number | null };
    expect(rest.artifacts).toHaveLength(2);
    expect(rest.next_offset).toBeNull();
    expect(
      (
        await client.callTool({
          name: "list_artifacts",
          arguments: { limit: 101 },
        })
      ).isError,
    ).toBe(true);
    const scoped = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { worker_id: h.workerId },
      }),
    ) as unknown as { artifacts: unknown[] };
    expect(scoped.artifacts).toHaveLength(3);
    const other = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { worker_id: "w-does-not-exist" },
      }),
    ) as unknown as { artifacts: unknown[] };
    expect(other.artifacts).toHaveLength(0);
    const byTask = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { task_id: "task" },
      }),
    ) as unknown as { artifacts: unknown[] };
    expect(byTask.artifacts).toHaveLength(3);
  } finally {
    await close();
    h.done();
  }
});

test("artifact metadata never exposes storage internals and scrubs reported errors", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write("ok.txt", "fine");
    const { artifacts } = body(
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: "ok.txt" },
      }),
    ) as unknown as { artifacts: { artifact_id: string }[] };
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
            size: 0,
            sha256: null,
            created_at: 1,
            retrieved_at: null,
            state: "failed",
            attempts: 3,
            error: "capture rejected token model-secret",
            kind: "file",
          }
        : original(id);
    const failed = await client.callTool({
      name: "get_artifact_metadata",
      arguments: { artifact_id: "a-failed" },
    });
    expect(body(failed)).toMatchObject({
      state: "failed",
      attempts: 3,
      kind: "file",
    });
    expect(JSON.stringify(failed)).not.toContain("/var/lib/swarmforge");
    expect(JSON.stringify(failed)).not.toContain("model-secret");
    expect(JSON.stringify(failed)).toContain("[REDACTED]");
    const missing = await client.callTool({
      name: "get_artifact_metadata",
      arguments: { artifact_id: "a-does-not-exist" },
    });
    expect(missing.isError).toBe(true);
    expect(artifacts[0]!.artifact_id).toBeTruthy();
  } finally {
    await close();
    h.done();
  }
});

test("preserve_artifact rejects unsafe paths, absolute paths and over-deep paths", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write("safe.txt", "ok");
    for (const path of [
      "../escape.txt",
      "/etc/passwd",
      "logs\\windows.txt",
      `bad${String.fromCharCode(0)}name`,
      Array.from({ length: 33 }, (_, n) => `d${n}`).join("/"),
    ]) {
      const refused = await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path },
      });
      expect(refused.isError).toBe(true);
    }
    const ok = await client.callTool({
      name: "preserve_artifact",
      arguments: { worker_id: h.workerId, path: "safe.txt" },
    });
    expect(ok.isError).not.toBe(true);
  } finally {
    await close();
    h.done();
  }
});

test("preserve_artifact collects a whole worker directory when asked for one", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write("logs/run-1.log", "first");
    h.write("logs/run-2.log", "second");
    h.write("logs/nested/deep.log", "third");
    const collected = await client.callTool({
      name: "preserve_artifact",
      arguments: { worker_id: h.workerId, path: "logs", kind: "directory" },
    });
    expect(collected.isError).not.toBe(true);
    const artifacts = body(collected).artifacts as unknown as {
      original_path: string;
      state: string;
    }[];
    // One directory level is collected; nested paths stay reachable explicitly.
    const paths = artifacts.map((a) => a.original_path).sort();
    expect(paths).toEqual(["logs/run-1.log", "logs/run-2.log"]);
    expect(artifacts.every((a) => a.state === "preserved")).toBe(true);
    expect(body(collected).truncated).toBe(false);
  } finally {
    await close();
    h.done();
  }
});

test("preservation propagates caller cancellation instead of copying after the caller left", async () => {
  const h = await artifactWorker();
  const controller = new AbortController();
  const { client, close } = await lead(h, controller.signal);
  try {
    h.write("cancelled.txt", "content");
    controller.abort();
    const refused = await client.callTool({
      name: "preserve_artifact",
      arguments: { worker_id: h.workerId, path: "cancelled.txt" },
    });
    expect(refused.isError).toBe(true);
    const listed = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { worker_id: h.workerId },
      }),
    ) as unknown as { artifacts: { state: string }[] };
    expect(
      listed.artifacts.filter((a) => a.state === "preserved"),
    ).toHaveLength(0);
  } finally {
    await close();
    h.done();
  }
});

test("snapshot_worker returns a single archived artifact whose bytes are a real archive", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write("findings.json", '{"ok":true}');
    const snapshot = await client.callTool({
      name: "snapshot_worker",
      arguments: { worker_id: h.workerId },
    });
    expect(snapshot.isError).not.toBe(true);
    const artifacts = body(snapshot).artifacts as unknown as {
      artifact_id: string;
      kind: string;
      state: string;
      sha256: string;
      size: number;
    }[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.kind).toBe("snapshot");
    expect(artifacts[0]!.state).toBe("preserved");
    expect(artifacts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifacts[0]!.size).toBeGreaterThan(0);
    const raw = await h.coordinator.artifacts.read(artifacts[0]!.artifact_id);
    expect(raw[0]).toBe(0x1f);
    expect(raw[1]).toBe(0x8b);
  } finally {
    await close();
    h.done();
  }
});

test("retry_worker_finalization re-preserves declared output for a worker that no longer runs", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write(".swarmforge/artifacts/findings.json", '{"verdict":"recovered"}');
    h.write(".swarmforge/logs/run.log", "worker log line");
    h.write(
      ".swarmforge/result.json",
      '{"status":"completed","summary":"done"}',
    );
    await h.coordinator.control(h.workerId, "cancel");
    expect(h.store.get(h.workerId).state).toBe("cancelled");
    const retried = await client.callTool({
      name: "retry_worker_finalization",
      arguments: { worker_id: h.workerId },
    });
    expect(retried.isError).not.toBe(true);
    const out = body(retried) as unknown as {
      worker_id: string;
      finalization: { state: string; attempts: number } | null;
      artifacts: { state: string; sha256: string; original_path: string }[];
    };
    expect(out.worker_id).toBe(h.workerId);
    expect(out.finalization?.state).toBe("preserved");
    expect(out.finalization?.attempts).toBeGreaterThan(0);
    const paths = out.artifacts.map((a) => a.original_path).sort();
    expect(paths).toContain(".swarmforge/artifacts/findings.json");
    expect(paths).toContain(".swarmforge/logs/run.log");
    expect(out.artifacts.every((a) => a.state === "preserved")).toBe(true);
    expect(JSON.stringify(retried)).not.toContain("server_password");
    // A second explicit retry is safe and does not duplicate preserved records.
    const again = await client.callTool({
      name: "retry_worker_finalization",
      arguments: { worker_id: h.workerId },
    });
    expect(again.isError).not.toBe(true);
    expect((body(again).artifacts as unknown as unknown[]).length).toBe(
      out.artifacts.length,
    );
  } finally {
    await close();
    h.done();
  }
});

test("list_worker_files walks the workspace, paginates and never exposes symlinks", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write("docs/a.txt", "a");
    h.write("docs/b.txt", "b");
    h.link("docs/escape", "/etc/passwd");
    const refused = await client.callTool({
      name: "list_worker_files",
      arguments: { worker_id: h.workerId, path: "docs" },
    });
    // A symlinked entry is either refused outright or omitted; it is never listed.
    if (!refused.isError)
      expect(JSON.stringify(refused)).not.toContain("escape");
    expect(
      (
        await client.callTool({
          name: "list_worker_files",
          arguments: { worker_id: h.workerId, path: "../.." },
        })
      ).isError,
    ).toBe(true);
    rmSync(h.path("docs/escape"));
    const listing = body(
      await client.callTool({
        name: "list_worker_files",
        arguments: { worker_id: h.workerId, path: "docs", limit: 1 },
      }),
    ) as unknown as {
      worker_id: string;
      path: string;
      entries: { name: string; kind: string; size: number }[];
      next_offset: number | null;
    };
    expect(listing.worker_id).toBe(h.workerId);
    expect(listing.path).toBe("docs");
    expect(listing.entries[0]).toMatchObject({
      name: "a.txt",
      kind: "file",
      size: 1,
    });
    expect(listing.next_offset).toBe(1);
    h.write("notes.md", "# notes");
    const root = body(
      await client.callTool({
        name: "list_worker_files",
        arguments: { worker_id: h.workerId },
      }),
    ) as unknown as { entries: { name: string }[] };
    expect(root.entries.map((e) => e.name)).toEqual(["docs", "notes.md"]);
  } finally {
    await close();
    h.done();
  }
});

test("preserved artifacts stay listable and readable after the worker and its workspace are gone", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write("findings.json", '{"kept":true}');
    const { artifacts } = body(
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: "findings.json" },
      }),
    ) as unknown as { artifacts: { artifact_id: string }[] };
    await h.coordinator.control(h.workerId, "destroy", true);
    h.destroyWorkspace();
    expect(h.store.get(h.workerId).state).toBe("destroyed");
    const listed = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { worker_id: h.workerId },
      }),
    ) as unknown as { artifacts: { artifact_id: string; state: string }[] };
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0]!.state).toBe("preserved");
    const view = body(
      await client.callTool({
        name: "read_artifact",
        arguments: { artifact_id: artifacts[0]!.artifact_id },
      }),
    ) as unknown as { text: string };
    expect(view.text).toBe('{"kept":true}');
    // Live guest inspection is refused once the workspace is gone.
    expect(
      (
        await client.callTool({
          name: "preserve_artifact",
          arguments: { worker_id: h.workerId, path: "findings.json" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "list_worker_files",
          arguments: { worker_id: h.workerId },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await close();
    h.done();
  }
});

test("a large directory capture returns a byte-budgeted page with an explicit total", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    // Worst legal shape for a lead-facing response: many records with paths at the 1024-byte
    // limit. The response must stay inside the tool response budget and say what was cut.
    const long = (n: number) =>
      `${"segment".repeat(9)}${String(n).padStart(3, "0")}/`.repeat(12) +
      "leaf.json";
    const service = h.coordinator.artifacts as unknown as {
      collectDirectory: (
        workerId: string,
        path: string,
        options: unknown,
      ) => Promise<unknown[]>;
    };
    const captured = Array.from({ length: 400 }, (_, n) => {
      const original_path = long(n).slice(0, 1024);
      return {
        artifact_id: `a-${n}`,
        task_id: h.store.get(h.workerId).task_id,
        worker_id: h.workerId,
        run_id: null,
        original_path,
        storage_key: "/var/lib/swarmforge/private/key",
        filename: "leaf.json",
        size: 1024,
        sha256: "b".repeat(64),
        created_at: 1,
        retrieved_at: 2,
        state: "preserved",
        attempts: 1,
        error: null,
        kind: "directory",
      };
    });
    service.collectDirectory = async () => captured;
    const captured_ = await client.callTool({
      name: "preserve_artifact",
      arguments: { worker_id: h.workerId, path: "logs", kind: "directory" },
    });
    expect(captured_.isError).not.toBe(true);
    const out = body(captured_) as unknown as {
      artifacts: { original_path: string }[];
      truncated: boolean;
      total: number;
      next?: string;
    };
    expect(out.total).toBe(400);
    expect(out.truncated).toBe(true);
    expect(out.next).toBe("list_artifacts");
    expect(out.artifacts.length).toBeGreaterThan(0);
    expect(out.artifacts.length).toBeLessThan(400);
    expect(out.artifacts.length).toBeLessThanOrEqual(100);
    for (const record of out.artifacts)
      expect(record.original_path.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(captured_))).toBeLessThanOrEqual(
      131072,
    );
    // The response names the surface that still holds the cut records instead of pretending
    // the capture returned everything.
    const listed = await client.callTool({
      name: "list_artifacts",
      arguments: { worker_id: h.workerId, limit: 100 },
    });
    expect(listed.isError).not.toBe(true);
  } finally {
    await close();
    h.done();
  }
});

test("a real directory of long file names is captured without exceeding the response budget", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    const segment = (n: number) =>
      `seg-${String(n).padStart(4, "0")}${"x".repeat(40)}`;
    for (let n = 0; n < 120; n++)
      h.write(`logs/${segment(n)}-${"y".repeat(180)}.json`, `{"n":${n}}`);
    const captured = await client.callTool({
      name: "preserve_artifact",
      arguments: { worker_id: h.workerId, path: "logs", kind: "directory" },
    });
    expect(captured.isError).not.toBe(true);
    const out = body(captured) as unknown as {
      artifacts: { original_path: string; state: string }[];
      total: number;
      truncated: boolean;
    };
    expect(out.total).toBe(120);
    expect(out.artifacts.length).toBeGreaterThan(0);
    expect(out.truncated).toBe(out.artifacts.length < 120);
    expect(out.artifacts.every((r) => r.state === "preserved")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(captured))).toBeLessThanOrEqual(
      131072,
    );
    // Everything the capture response cut is still stored and reachable through the listing.
    const seen = new Set<string>();
    for (let offset = 0; ; offset += 100) {
      const page = body(
        await client.callTool({
          name: "list_artifacts",
          arguments: { worker_id: h.workerId, limit: 100, offset },
        }),
      ) as unknown as {
        artifacts: { artifact_id: string }[];
        next_offset: number | null;
      };
      for (const listed of page.artifacts) seen.add(listed.artifact_id);
      if (page.next_offset === null) break;
    }
    expect(seen.size).toBe(120);
  } finally {
    await close();
    h.done();
  }
});

test("list_artifacts state filtering is a returned-page filter and does not change paging", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    const service = h.coordinator.artifacts as unknown as {
      list: (filter: { offset?: number; limit?: number }) => unknown;
    };
    service.list = ({ offset = 0, limit = 20 }) => ({
      artifacts: Array.from({ length: Math.min(limit, 3) }, (_, n) => ({
        artifact_id: `a-${offset + n}`,
        task_id: "task",
        worker_id: h.workerId,
        run_id: null,
        original_path: `f${offset + n}.json`,
        storage_key: "/var/lib/swarmforge/private/key",
        filename: `f${offset + n}.json`,
        size: 1,
        sha256: "c".repeat(64),
        created_at: 1,
        retrieved_at: 2,
        state: (offset + n) % 2 ? "preserved" : "failed",
        attempts: 1,
        error: null,
        kind: "file",
      })),
      next_offset: offset + limit < 6 ? offset + limit : null,
    });
    const page = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { limit: 3, state: "preserved" },
      }),
    ) as unknown as { artifacts: unknown[]; next_offset: number | null };
    // The repository ignores the state argument; the tool filters the returned page and keeps
    // the repository's own paging, so a filtered page may be shorter than the limit.
    expect(page.artifacts).toHaveLength(1);
    expect(page.next_offset).toBe(3);
    const unscoped = body(
      await client.callTool({
        name: "list_artifacts",
        arguments: { limit: 3 },
      }),
    ) as unknown as { artifacts: unknown[] };
    expect(unscoped.artifacts).toHaveLength(3);
  } finally {
    await close();
    h.done();
  }
});

test("terminal output with ANSI colour is screened into text, not refused as binary", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    const esc = String.fromCharCode(27);
    const log = `${esc}[32mPASS${esc}[0m tests: 4 passed\n${esc}[1;31mFAIL${esc}[0m tests: 1 failed\n`;
    h.write("tests.log", log);
    const { artifacts } = body(
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: "tests.log" },
      }),
    ) as unknown as { artifacts: { artifact_id: string }[] };
    const view = body(
      await client.callTool({
        name: "read_artifact",
        arguments: { artifact_id: artifacts[0]!.artifact_id },
      }),
    ) as unknown as { binary: boolean; text: string };
    expect(view.binary).toBe(false);
    expect(view.text).toContain("PASS tests: 4 passed");
    expect(view.text).toContain("FAIL tests: 1 failed");
    // The escape introducer and its parameters are removed, not left as inert text.
    expect(view.text).not.toContain(esc);
    expect(view.text).not.toContain("[32m");
    expect(view.text).not.toContain("[0m");
  } finally {
    await close();
    h.done();
  }
});

test("invalid UTF-8 and NUL-heavy content stay binary metadata", async () => {
  const h = await artifactWorker();
  const { client, close } = await lead(h);
  try {
    h.write(
      "broken.bin",
      new Uint8Array([0xff, 0xfe, 0x41, 0xc3, 0x28, 0x00, 0x01, 0x02]),
    );
    const { artifacts } = body(
      await client.callTool({
        name: "preserve_artifact",
        arguments: { worker_id: h.workerId, path: "broken.bin" },
      }),
    ) as unknown as { artifacts: { artifact_id: string }[] };
    const view = body(
      await client.callTool({
        name: "read_artifact",
        arguments: { artifact_id: artifacts[0]!.artifact_id },
      }),
    ) as unknown as { binary: boolean; text: string | null };
    expect(view.binary).toBe(true);
    expect(view.text).toBeNull();
  } finally {
    await close();
    h.done();
  }
});

// Optional until the package 1 local fixture exists: the smoke module imports it directly.
const smokeModule = import("../scripts/artifact-salvage-smoke" as string).catch(
  () => null,
) as Promise<{
  safeMessage: (error: unknown, ...secrets: string[]) => string;
} | null>;

test.skipIf(!(await smokeModule))(
  "smoke error reporting redacts known bare secrets",
  async () => {
    const smoke = (await smokeModule)!;
    const secret = "bare-secret-value-9f2c";
    const reported = smoke.safeMessage(
      new Error(`capture failed with ${secret} and Bearer ${secret}`),
      secret,
    );
    expect(reported).not.toContain(secret);
    expect(reported).toContain("[REDACTED]");
    expect(reported).not.toContain("token=");
    expect(
      smoke.safeMessage(new Error("y".repeat(5000)), secret).length,
    ).toBeLessThanOrEqual(500);
  },
);

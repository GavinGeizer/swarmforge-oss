import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectSwarmForge } from "../src/cli/client";
import {
  canRetryPreservation,
  renderOverview,
  renderWorkerDetail,
} from "../src/cli/overview";
import { runDashboard } from "../src/cli/tui";
import { createHttpHandler } from "../src/http";
import { localHarness } from "./local-artifact-provider";

test("dashboard exposes durable artifacts and retries exhausted preservation through MCP", async () => {
  const h = await localHarness({ SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: "1" });
  const worker = h.spawn({
    artifacts: [
      { path: "results/findings.txt", required: true, directory: false },
    ],
  });
  await h.provider.createWorker(worker);
  h.store.beginFinalization(worker.worker_id, null);
  await h.coordinator.finalize(worker.worker_id);
  expect(h.store.get(worker.worker_id).finalization?.state).toBe("failed");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const client = await connectSwarmForge(`http://127.0.0.1:${server.port}/mcp`);
  try {
    const failed = await client.inspect(worker.worker_id);
    expect(canRetryPreservation(failed.worker)).toBe(true);
    expect(renderWorkerDetail(failed)).toContain("f retry preservation");
    expect(renderWorkerDetail(failed)).toContain("VM retained");
    expect(renderOverview(await client.overview())).toContain(
      "1 need attention",
    );
    mkdirSync(join(h.workspace.root, "results"));
    writeFileSync(
      join(h.workspace.root, "results/findings.txt"),
      "saved output\n",
    );
    const frames: string[] = [];
    const input = Object.assign(new EventEmitter(), {
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
    }) as unknown as typeof process.stdin;
    const output = Object.assign(new EventEmitter(), {
      columns: 120,
      rows: 50,
      write: (frame: string) => {
        frames.push(frame);
        return true;
      },
    }) as unknown as typeof process.stdout;
    let retries = 0;
    const retry = client.retryPreservation;
    client.retryPreservation = async (id) => {
      retries++;
      return retry(id);
    };
    const dashboard = runDashboard(
      client,
      await client.overview(),
      input,
      output,
      60000,
    );
    try {
      input.emit("keypress", "", { name: "return" });
      for (
        let i = 0;
        i < 200 && !frames.some((f) => f.includes("f retry preservation"));
        i++
      )
        await Bun.sleep(10);
      expect(frames.some((f) => f.includes("f retry preservation"))).toBe(true);
      input.emit("keypress", "", { name: "f" });
      input.emit("keypress", "", { name: "f" });
      for (
        let i = 0;
        i < 200 && !frames.some((f) => f.includes("Preservation: preserved"));
        i++
      )
        await Bun.sleep(10);
      expect(frames.some((f) => f.includes("Preservation: preserved"))).toBe(
        true,
      );
      expect(retries).toBe(1);
    } finally {
      input.emit("keypress", "", { name: "q" });
      await dashboard;
    }
    const preserved = await client.inspect(worker.worker_id);
    expect(preserved.worker.finalization?.state).toBe("preserved");
    expect(canRetryPreservation(preserved.worker)).toBe(false);
    expect(
      preserved.artifacts?.some(
        (a) => a.filename === "findings.txt" && a.state === "preserved",
      ),
    ).toBe(true);
    expect(renderWorkerDetail(preserved)).toContain("SHA256:");
    expect(renderWorkerDetail(preserved)).toContain("/download");
  } finally {
    await client.close();
    await server.stop(true);
    await h.coordinator.stop();
    await h.cleanup();
  }
});

test("shutdown aborts and drains admitted manual preservation before closing the store", async () => {
  const h = await localHarness();
  const worker = h.spawn();
  await h.provider.createWorker(worker);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.provider.artifactTransport.open = async (_vm, _root, _path, options) => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) reject(signal.reason);
      else
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
    });
    throw new Error("unreachable");
  };
  const operation = h.coordinator.operation(() =>
    h.coordinator.artifacts.preserve(worker.worker_id, "output.txt"),
  );
  const outcome = operation.catch((error) => error);
  await started;
  await h.coordinator.stop();
  expect(await outcome).toBeInstanceOf(Error);
  expect(
    h.coordinator.artifacts.list({ worker_id: worker.worker_id }).artifacts[0]
      ?.state,
  ).toBe("failed");
  await expect(
    h.coordinator.operation(() => h.store.get(worker.worker_id)),
  ).rejects.toThrow("Coordinator stopped");
  await h.cleanup();
});

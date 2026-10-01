import { createHash } from "node:crypto";
import {
  type ArtifactTransfer,
  isSha256,
  screeningWindow,
  validateRelativePath,
} from "./artifact-types";
import { ArtifactService } from "./artifacts";
import type { Coordinator } from "./coordinator";
import { redactorFor } from "./security";

// One service per coordinator, so two live reads cannot each build their own
// storage handle or their own concurrency budget. `coordinator.artifacts` wins
// as soon as the lifecycle layer exposes it; until then this builds the same
// service rather than falling back to an unsafe stat/read capture.
const services = new WeakMap<Coordinator, ArtifactService>();

/**
 * Consumes one staged transfer under a hard byte bound and checks it against the
 * size and hash the capture reported. A stream that overruns the bound, ends
 * early or does not hash to what was captured is cancelled and refused, so a
 * damaged transfer can never be presented as the worker's file.
 */
export async function readTransfer(
  transfer: ArtifactTransfer,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(transfer.size) || transfer.size < 0)
    throw new Error("Artifact transfer reported an invalid size");
  if (!isSha256(transfer.sha256))
    throw new Error("Artifact transfer reported an invalid hash");
  if (transfer.size > maxBytes)
    throw new Error("Artifact transfer is larger than the requested window");
  const reader = transfer.stream.getReader();
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      received += value.byteLength;
      if (received > maxBytes)
        throw new Error("Artifact transfer exceeded its bound");
      hash.update(value);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (received !== transfer.size)
    throw new Error("Artifact transfer was truncated");
  if (hash.digest("hex") !== transfer.sha256)
    throw new Error("Artifact transfer failed its integrity check");
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export class WorkerFiles {
  constructor(readonly c: Coordinator) {}
  private service(): ArtifactService {
    const exposed = (this.c as unknown as { artifacts?: ArtifactService })
      .artifacts;
    if (exposed) return exposed;
    let service = services.get(this.c);
    if (!service) {
      service = new ArtifactService(
        this.c.config,
        this.c.store,
        this.c.provider,
      );
      services.set(this.c, service);
    }
    return service;
  }
  private worker(id: string) {
    const w = this.c.store.get(id);
    if (!w.vm_id || w.state === "destroyed")
      throw new Error("Worker files unavailable");
    return w;
  }
  /** Live worker artifacts live under the workspace's own artifact directory. */
  private static readonly root = ".swarmforge/artifacts";
  private relative(path: string) {
    const validated = validateRelativePath(path);
    return `${WorkerFiles.root}/${validated}`;
  }
  /**
   * Finds one live file's size from a bounded, descriptor-relative directory
   * listing. There is deliberately no stat-then-read pair here: the listing and
   * the capture each open the path in one trusted helper run.
   */
  private async entry(id: string, path: string) {
    const worker = this.worker(id);
    const relative = this.relative(path);
    const directory = relative.split("/").slice(0, -1).join("/");
    const name = relative.split("/").at(-1)!;
    const limit = 200;
    const max = 10000;
    for (let offset = 0; offset < max; offset += limit) {
      const listing = await this.service().listWorkerFiles(id, directory, {
        offset,
        limit,
      });
      const found = listing.entries.find((entry) => entry.name === name);
      if (found) return { worker, found };
      if (listing.next_offset === null) break;
    }
    throw new Error("Artifact not found");
  }
  async artifacts(id: string, directory = "", offset = 0, limit = 50) {
    this.worker(id);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid artifact page");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("Invalid artifact page size");
    const listing = await this.service().listWorkerFiles(
      id,
      directory ? this.relative(directory) : WorkerFiles.root,
      { offset, limit },
    );
    return {
      entries: listing.entries.filter(
        (entry) => !entry.name.includes("/") && !entry.name.includes("\\"),
      ),
      next_offset: listing.next_offset,
    };
  }
  async artifact(id: string, path: string, offset = 0, length = 32768) {
    if (redactorFor(this.c).text(path) !== path)
      throw new Error("Artifact path contains credentials");
    const { found } = await this.entry(id, path);
    if (found.kind !== "file" || found.size === undefined)
      throw new Error("Artifact is not a file");
    const size = found.size;
    return {
      name: validateRelativePath(path),
      size,
      mimeType: "application/octet-stream",
      uri: `swarmforge://workers/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(path)}?offset=${offset}&length=${length}`,
      offset,
      length: Math.min(length, Math.max(0, size - offset)),
      next_offset: offset + length < size ? offset + length : null,
    };
  }
  async readArtifact(id: string, path: string, offset = 0, length = 32768) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 32768
    )
      throw new Error("Invalid artifact byte range");
    if (redactorFor(this.c).text(path) !== path)
      throw new Error("Artifact path contains credentials");
    await this.entry(id, path);
    // The overlap comes from the same redactor that screens the bytes, measured
    // in bytes across every encoded variant, so a credential split across the
    // window is still caught however long or multi-byte it is.
    const redactor = redactorFor(this.c);
    const pad = screeningWindow(redactor.secrets());
    const start = Math.max(0, offset - pad);
    const window = length + 2 * pad;
    const transfer = await this.service().openLive(id, this.relative(path), {
      offset: start,
      length: window,
    });
    let bytes: Uint8Array;
    try {
      // Bounded and verified against what the capture reported: a short,
      // oversized or corrupt staging transfer is refused, not returned.
      bytes = await readTransfer(transfer, window);
      if (redactor.contains(bytes))
        throw new Error(
          "Artifact contains credentials; remove them inside the worker before retrieval",
        );
    } finally {
      await transfer.cleanup();
    }
    return bytes.slice(offset - start, offset - start + length);
  }
  async logs(id: string, after = 0, limit = 50) {
    const w = this.c.store.get(id);
    let opencode: string | null = null;
    if (
      w.vm_id &&
      !w.vm_missing &&
      w.state !== "destroyed" &&
      w.state !== "paused" &&
      !w.intent
    ) {
      try {
        const vm = await this.c.bounded(this.c.provider.getWorker(w.vm_id));
        const current = this.c.store.get(id);
        if (
          vm?.state === "running" &&
          !current.intent &&
          current.state !== "paused" &&
          current.state !== "destroyed"
        ) {
          const r = await this.c.bounded(
            this.c.provider.exec(
              w.vm_id,
              "journalctl -u swarmforge-opencode --no-pager -n 100 -o cat 2>/dev/null | tail -c 16384",
            ),
          );
          if (r.code === 0)
            opencode = redactorFor(this.c).text(r.stdout).slice(-16384);
        }
      } catch {
        // Durable audit events remain readable during guest/provider outages.
      }
    }
    return {
      events: this.c.store.events(id, after, limit),
      opencode,
    };
  }
}

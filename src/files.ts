import { validateRelativePath } from "./artifact-types";
import type { ArtifactService } from "./artifacts";
import type { Coordinator } from "./coordinator";
import { redactorFor } from "./security";

// One service per coordinator. The lifecycle layer exposes `coordinator.artifacts`;
// until it does, the first file read builds the same service lazily rather than
// falling back to an unsafe stat/read capture.
const services = new WeakMap<Coordinator, ArtifactService>();

export class WorkerFiles {
  constructor(readonly c: Coordinator) {}
  private service(): ArtifactService {
    const exposed = (this.c as unknown as { artifacts?: ArtifactService })
      .artifacts;
    if (exposed) return exposed;
    let service = services.get(this.c);
    if (!service) {
      // Imported lazily to keep this module free of a load-time cycle.
      const { ArtifactService: Service } = require("./artifacts") as {
        ArtifactService: new (
          ...args: ConstructorParameters<typeof ArtifactService>
        ) => ArtifactService;
      };
      service = new Service(this.c.config, this.c.store, this.c.provider);
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
    // Inspect an overlap so credentials split across chunk boundaries still block retrieval.
    const pad = Math.max(
      4096,
      this.c.config.SWARMFORGE_MODEL_API_KEY.length,
      this.c.config.FREESTYLE_API_TOKEN.length,
    );
    const start = Math.max(0, offset - pad);
    const window = length + 2 * pad;
    const transfer = await this.service().openLive(id, this.relative(path), {
      offset: start,
      length: window,
    });
    try {
      const bytes = new Uint8Array(
        await new Response(transfer.stream).arrayBuffer(),
      );
      if (redactorFor(this.c).contains(bytes))
        throw new Error(
          "Artifact contains credentials; remove them inside the worker before retrieval",
        );
      return bytes.slice(offset - start, offset - start + length);
    } finally {
      await transfer.cleanup();
    }
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

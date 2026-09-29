import type { Coordinator } from "./coordinator";
import { redactorFor } from "./security";

// Artifact paths stay shallow so one request cannot turn into an unbounded chain
// of provider stat calls, each of them a remote round trip.
const maxPathSegments = 16;
// A chunk is screened together with an overlap on both sides so a credential
// straddling the window edge is seen whole; the overlap covers the longest
// credential the redactor knows, within a cap that keeps reads bounded.
const minOverlap = 4096;
const maxOverlap = 32768;
export class WorkerFiles {
  constructor(readonly c: Coordinator) {}
  private worker(id: string) {
    const w = this.c.store.get(id);
    if (!w.vm_id || w.state === "destroyed")
      throw new Error("Worker files unavailable");
    return w;
  }
  private root() {
    return `${this.c.config.SWARMFORGE_WORKSPACE}/.swarmforge/artifacts`;
  }
  private rootSegments() {
    return this.root().split("/").filter(Boolean);
  }
  private segments(path: string) {
    const parts = path.split("/");
    if (
      !path ||
      path.length > 1024 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      parts.length > maxPathSegments ||
      parts.some((p) => !p || p === "." || p === ".." || p.includes("\0"))
    )
      throw new Error("Invalid relative artifact path");
    return parts;
  }
  private path(parts: string[]) {
    return `${this.root()}/${parts.join("/")}`;
  }
  private async checked(id: string, path: string) {
    const w = this.worker(id);
    const parts = this.segments(path);
    await this.noSymlinks(w.vm_id!, parts);
    const full = this.path(parts);
    const stat = await this.c.bounded(this.c.provider.stat(w.vm_id!, full));
    if (!stat.isFile) throw new Error("Artifact is not a file");
    return { w, full, stat };
  }
  // Walk the whole path from the workspace down, not just the part below the
  // artifacts root: the worker owns its workspace, so a component that looks
  // trusted, such as .swarmforge, can itself be replaced with a symlink while
  // provider.stat only ever reports the leaf. The depth cap keeps the number of
  // remote calls a single request can cause fixed.
  private async noSymlinks(vm: string, parts: string[]) {
    let path = "";
    for (const segment of [...this.rootSegments(), ...parts]) {
      path += `/${segment}`;
      const stat = await this.c.bounded(this.c.provider.stat(vm, path));
      if (stat.isSymlink)
        throw new Error("Symlink artifact paths are not allowed");
    }
  }
  async artifacts(id: string, directory = "", offset = 0, limit = 50) {
    const w = this.worker(id);
    const parts = directory ? this.segments(directory) : [];
    const root = this.root();
    await this.noSymlinks(w.vm_id!, parts);
    const entries = await this.c.bounded(
      this.c.provider.listFiles(
        w.vm_id!,
        parts.length ? this.path(parts) : root,
      ),
    );
    const safe = entries
      .filter(
        (e) =>
          e.kind !== "symlink" &&
          !e.name.includes("/") &&
          !e.name.includes("\\") &&
          e.name !== "." &&
          e.name !== "..",
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      entries: safe.slice(offset, offset + limit),
      next_offset: offset + limit < safe.length ? offset + limit : null,
    };
  }
  async artifact(id: string, path: string, offset = 0, length = 32768) {
    if (redactorFor(this.c).text(path) !== path)
      throw new Error("Artifact path contains credentials");
    const { stat } = await this.checked(id, path);
    return {
      name: path,
      size: stat.size,
      mimeType: "application/octet-stream",
      uri: `swarmforge://workers/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(path)}?offset=${offset}&length=${length}`,
      offset,
      length: Math.min(length, Math.max(0, stat.size - offset)),
      next_offset: offset + length < stat.size ? offset + length : null,
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
    const redactor = redactorFor(this.c);
    if (redactor.text(path) !== path)
      throw new Error("Artifact path contains credentials");
    const w = this.worker(id);
    const parts = this.segments(path);
    await this.noSymlinks(w.vm_id!, parts);
    // Inspect an overlap so credentials split across chunk boundaries still block retrieval.
    const overlap = Math.max(minOverlap, redactor.guardWidth());
    if (overlap > maxOverlap)
      throw new Error(
        "Artifact screening cannot cover the longest configured credential",
      );
    const provider = this.c.provider;
    if (typeof provider.readFileContained !== "function")
      throw new Error(
        "Artifact reads require a provider that can guarantee path containment",
      );
    const start = Math.max(0, offset - overlap);
    // The walk, the regular-file check and the read share one descriptor, so a
    // path swapped for a symlink after the check cannot return outside-root bytes.
    const { bytes } = await this.c.bounded(
      provider.readFileContained(
        w.vm_id!,
        this.path(parts),
        start,
        length + 2 * overlap,
      ),
    );
    if (redactor.contains(bytes) || redactor.clippedAtEdge(bytes))
      throw new Error(
        "Artifact contains credentials; remove them inside the worker before retrieval",
      );
    const screened = bytes.slice(offset - start, offset - start + length);
    // These are the bytes the caller keeps, so they are screened on their own:
    // a fragment the wider window does not show can still sit inside them.
    if (redactor.discloses(screened))
      throw new Error(
        "Artifact contains credentials; remove them inside the worker before retrieval",
      );
    return screened;
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

import type { Coordinator } from "./coordinator";
import { redactorFor } from "./security";
export class WorkerFiles {
  constructor(readonly c: Coordinator) {}
  private worker(id: string) {
    const w = this.c.store.get(id);
    if (!w.vm_id || w.state === "destroyed")
      throw new Error("Worker files unavailable");
    return w;
  }
  private path(path: string) {
    if (
      !path ||
      path.length > 1024 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path
        .split("/")
        .some((p) => !p || p === "." || p === ".." || p.includes("\0"))
    )
      throw new Error("Invalid relative artifact path");
    return `${this.c.config.SWARMFORGE_WORKSPACE}/.swarmforge/artifacts/${path}`;
  }
  private async checked(id: string, path: string) {
    const w = this.worker(id);
    const full = this.path(path);
    await this.noSymlinks(w.vm_id!, full);
    const stat = await this.c.bounded(this.c.provider.stat(w.vm_id!, full));
    if (!stat.isFile) throw new Error("Artifact is not a file");
    return { w, full, stat };
  }
  private async noSymlinks(vm: string, full: string) {
    let path = "";
    for (const part of full.split("/").filter(Boolean)) {
      path += `/${part}`;
      const stat = await this.c.bounded(this.c.provider.stat(vm, path));
      if (stat.isSymlink)
        throw new Error("Symlink artifact paths are not allowed");
    }
  }
  async artifacts(id: string, directory = "", offset = 0, limit = 50) {
    const w = this.worker(id);
    const root = directory
      ? this.path(directory)
      : `${this.c.config.SWARMFORGE_WORKSPACE}/.swarmforge/artifacts`;
    if (directory) {
      for (const part of directory.split("/"))
        if (!part || part === "..") throw new Error("Invalid directory");
    }
    await this.noSymlinks(w.vm_id!, root);
    const entries = await this.c.bounded(
      this.c.provider.listFiles(w.vm_id!, root),
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
    const { w, full } = await this.checked(id, path);
    // Inspect an overlap so credentials split across chunk boundaries still block retrieval.
    const redactor = redactorFor(this.c);
    const pad = Math.max(4096, redactor.credentialOverlapBytes());
    const start = Math.max(0, offset - pad);
    const bytes = await this.c.bounded(
      this.c.provider.readFile(w.vm_id!, full, start, length + 2 * pad),
    );
    if (redactor.contains(bytes))
      throw new Error(
        "Artifact contains credentials; remove them inside the worker before retrieval",
      );
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

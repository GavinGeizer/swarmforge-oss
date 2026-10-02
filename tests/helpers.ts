import { createHash } from "node:crypto";
import {
  ArtifactCaptureError,
  type ArtifactEntry,
  type ArtifactListing,
  type ArtifactTransfer,
  artifactErrorCodes,
  type WorkerArtifactTransport,
} from "../src/artifact-types";
import { type Config, loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import type {
  AgentSnapshot,
  CodingAgent,
  Dispatch,
  VmInfo,
  Worker,
  WorkerProvider,
} from "../src/domain";
import { Store } from "../src/store";
export const config = loadConfig({
  FREESTYLE_API_TOKEN: "infra-secret",
  FREESTYLE_SNAPSHOT_ID: "snapshot",
  SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
  SWARMFORGE_MODEL_API_KEY: "model-secret",
  SWARMFORGE_MODEL_NAME: "qwen",
  SWARMFORGE_GIT_TREE: "opaque-tree",
  SWARMFORGE_DB_PATH: ":memory:",
  SWARMFORGE_MAX_WORKERS: "2",
  SWARMFORGE_MAX_PROVISIONING: "1",
});
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
// Bounded streams with real source digests, so preservation assertions never depend on
// contents passing through exec output or any encoding round trip.
export class FakeProvider implements WorkerProvider {
  vms = new Map<string, VmInfo>();
  files = new Map<string, string>();
  directories = new Set<string>();
  failure = false;
  dirty = false;
  destroyFailure = false;
  pushFailure = false;
  created = 0;
  execCommands: string[] = [];
  transportFailure = "";
  // "fake": the double's own wording. "coded": the data plane's stable error codes, the way a
  // production capture refuses. "helper": a vocabulary that conflates an absent path with a
  // non-directory leaf, which only a listing can tell apart.
  transportStyle: "fake" | "coded" | "helper" = "fake";
  transportMissing = new Set<string>();
  // Paths whose capture is refused as unsafe, as a symlinked component would be.
  transportUnsafe = new Set<string>();
  // Paths whose reported digest does not describe the staged bytes.
  transportCorrupt = new Set<string>();
  transportSlow = false;
  transportAborted = 0;
  // Resolves once a hanging transfer has actually started streaming.
  slowStarted: (() => void) | null = null;
  transportOpens: string[] = [];
  transportLists: string[] = [];
  transportSnapshots = 0;
  transportDiagnostics = 0;
  transportDelayMs = 0;
  concurrent = 0;
  maxConcurrent = 0;
  // Distinct guests with a transfer in flight at the same moment.
  activeGuests = new Set<string>();
  maxActiveGuests = 0;
  // Measures in-flight transport work, so the shared bounds are observable from a test.
  private async tracked<T>(
    guest: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.activeGuests.add(guest);
    this.maxActiveGuests = Math.max(
      this.maxActiveGuests,
      this.activeGuests.size,
    );
    try {
      if (this.transportDelayMs) await Bun.sleep(this.transportDelayMs);
      return await operation();
    } finally {
      this.activeGuests.delete(guest);
      this.concurrent--;
    }
  }
  private key(id: string, path: string) {
    return `${id}:${path.replace(/\/{2,}/g, "/")}`;
  }
  private join(root: string, path: string) {
    const joined = `${root}/${path}`.replace(/\/{2,}/g, "/");
    return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
  }
  private fail() {
    if (this.transportFailure) throw new Error(this.transportFailure);
  }
  private refuse(kind: "notFound" | "notDirectory", message: string) {
    return this.transportStyle === "coded"
      ? new ArtifactCaptureError(message, artifactErrorCodes[kind])
      : new Error(message);
  }
  // A trusted guest helper resolves workspace paths descriptor-relatively and
  // refuses a symlinked component, so the fake guest refuses one too instead of
  // reporting a stat-then-read sequence the real capture never performs.
  private async noSymlink(id: string, path: string) {
    const seen = await this.stat(id, path).catch(() => null);
    if (seen?.isSymlink)
      throw new Error(`Symlink artifact paths are not allowed: ${path}`);
  }
  private absent(id: string, path: string) {
    const key = this.key(id, path);
    return this.transportMissing.has(key) || !this.files.has(key);
  }
  private directory(id: string, path: string) {
    if (this.directories.has(this.key(id, path))) return true;
    const prefix = `${this.key(id, path)}/`;
    for (const key of this.files.keys())
      if (key.startsWith(prefix)) return true;
    for (const key of this.directories.keys())
      if (key.startsWith(prefix)) return true;
    return false;
  }
  private transfer(
    id: string,
    path: string,
    bytes: Uint8Array,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): ArtifactTransfer {
    if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes)
      throw new Error("Artifact exceeds the configured byte bound");
    if (options.signal?.aborted) throw new Error("Artifact transfer aborted");
    const slow = this.transportSlow;
    return {
      size: bytes.byteLength,
      // A corrupted staging digest is what a truncated or tampered capture looks like.
      sha256: this.transportCorrupt.has(this.key(id, path))
        ? "0".repeat(64)
        : sha256(bytes),
      filename: path.split("/").pop() ?? "artifact",
      stream: new ReadableStream<Uint8Array>({
        start: (controller) => {
          const abort = () => {
            this.transportAborted++;
            controller.error(new Error("Artifact transfer aborted"));
          };
          if (options.signal?.aborted) return abort();
          options.signal?.addEventListener("abort", abort, { once: true });
          if (slow) {
            this.slowStarted?.();
            this.slowStarted = null;
            return;
          }
          controller.enqueue(bytes);
          controller.close();
          options.signal?.removeEventListener("abort", abort);
        },
      }),
      cleanup: async () => {},
    };
  }
  // A real directory listing names every direct child, and a child that only exists as a
  // prefix of a stored file is still a directory.
  private children(id: string, root: string, path: string) {
    const target = this.join(root, path);
    const prefix = `${this.key(id, target)}/`;
    const names = new Map<string, ArtifactEntry["kind"]>();
    const add = (key: string, kind: ArtifactEntry["kind"]) => {
      if (!key.startsWith(prefix) || this.transportMissing.has(key)) return;
      const tail = key.slice(prefix.length);
      const head = tail.split("/")[0];
      if (!head) return;
      names.set(head, tail.includes("/") ? "directory" : kind);
    };
    for (const key of this.files.keys()) add(key, "file");
    for (const key of this.directories.keys()) add(key, "directory");
    return [...names].sort((a, b) => a[0].localeCompare(b[0]));
  }
  artifactTransport: WorkerArtifactTransport = {
    list: async (
      id: string,
      root: string,
      path: string,
      options = {},
    ): Promise<ArtifactListing> =>
      this.tracked(id, async () => {
        this.fail();
        const target = this.join(root, path);
        await this.noSymlink(id, target);
        if (this.transportUnsafe.has(this.key(id, target)))
          throw new Error(`symlinked component refused: ${target}`);
        if (!this.directory(id, target)) {
          if (this.transportStyle === "helper")
            throw new Error("path component is missing or not a directory");
          if (this.exists(id, target))
            throw this.refuse(
              "notDirectory",
              `ENOTDIR: not a directory, stat '${target}'`,
            );
          throw this.refuse(
            "notFound",
            `ENOENT: no such file or directory, stat '${target}'`,
          );
        }
        this.transportLists.push(path);
        const names = this.children(id, root, path);
        const start = options.offset ?? 0;
        const limit = options.limit ?? names.length;
        const entries: ArtifactEntry[] = [];
        for (const [name, kind] of names.slice(start, start + limit)) {
          const bytes = this.files.get(this.key(id, `${target}/${name}`));
          entries.push({
            name,
            kind,
            ...(bytes === undefined ? {} : { size: Buffer.byteLength(bytes) }),
          });
        }
        return {
          entries,
          next_offset: start + limit < names.length ? start + limit : null,
        };
      }),
    open: async (id: string, root: string, path: string, options) =>
      this.tracked(id, async () => {
        this.fail();
        const target = this.join(root, path);
        await this.noSymlink(id, target);
        if (this.transportUnsafe.has(this.key(id, target)))
          throw new Error(`symlinked component refused: ${target}`);
        if (this.transportUnsafe.has(this.key(id, target)))
          throw new Error(`symlinked component refused: ${target}`);
        if (!this.exists(id, target)) {
          if (this.transportStyle === "helper")
            throw new Error("artifact is missing or is not a regular file");
          throw this.refuse(
            "notFound",
            `ENOENT: no such file or directory, open '${target}'`,
          );
        }
        if (this.directory(id, target))
          throw new Error(
            `EISDIR: illegal operation on a directory, open '${target}'`,
          );
        this.transportOpens.push(path);
        // A windowed open stages only the requested bytes, exactly as the guest helper does.
        const source = new TextEncoder().encode(
          this.files.get(this.key(id, target)) ?? "",
        );
        const offset = options.offset ?? 0;
        const window = options.length ?? source.byteLength;
        return this.transfer(
          id,
          target,
          source.slice(offset, offset + window),
          {
            ...options,
            maxBytes: options.length === undefined ? options.maxBytes : window,
          },
        );
      }),
    snapshot: async (id, root, options) =>
      this.tracked(id, async () => {
        this.fail();
        this.transportSnapshots++;
        const prefix = `${this.key(id, root)}/`;
        const wanted = new Set(options.paths ?? []);
        const manifest: string[] = [];
        for (const key of [...this.files.keys()].sort()) {
          if (!key.startsWith(prefix)) continue;
          if (this.transportMissing.has(key)) continue;
          const relative = key.slice(prefix.length);
          if (
            wanted.size > 0 &&
            ![...wanted].some(
              (p) => p === relative || relative.startsWith(`${p}/`),
            )
          )
            continue;
          if (manifest.length >= options.maxEntries)
            throw new Error("Snapshot entry bound exceeded");
          manifest.push(
            `${relative} ${Buffer.byteLength(this.files.get(key) ?? "")}`,
          );
        }
        return this.transfer(
          id,
          `${root}/workspace.tar.gz`,
          new Uint8Array(
            Bun.gzipSync(Buffer.from(`${manifest.join("\n")}\n`, "utf8")),
          ),
          options,
        );
      }),
    diagnostics: async (id, root, options) =>
      this.tracked(id, async () => {
        this.fail();
        this.transportDiagnostics++;
        const target = this.join(root, ".swarmforge/diagnostics");
        if (this.absent(id, target)) return [];
        return [
          {
            path: ".swarmforge/diagnostics",
            transfer: this.transfer(
              id,
              target,
              new TextEncoder().encode(
                this.files.get(this.key(id, target)) ?? "",
              ),
              options,
            ),
          },
        ];
      }),
  };
  private exists(id: string, path: string) {
    return !this.absent(id, path);
  }
  async createWorker(w: Worker) {
    if (this.failure) throw new Error("provider unavailable");
    this.created++;
    const vm = {
      id: `vm-${w.worker_id}`,
      slug: w.worker_id,
      state: "running",
      worker_id: w.worker_id,
    };
    this.vms.set(vm.id, vm);
    return vm;
  }
  async getWorker(id: string) {
    return this.vms.get(id) ?? null;
  }
  async listWorkers() {
    return [...this.vms.values()];
  }
  async prepare(w: Worker) {
    if (this.failure) throw new Error("boot failure");
    // The real guest bootstrap creates the standard swarmforge directories; the fake guest
    // does the same so listings and collections see a prepared workspace.
    if (w.vm_id)
      for (const dir of [
        ".swarmforge",
        ".swarmforge/artifacts",
        ".swarmforge/logs",
      ])
        this.directories.add(
          `${w.vm_id}:${config.SWARMFORGE_WORKSPACE}/${dir}`,
        );
    return `https://${w.vm_id}.example`;
  }
  async pushBranch(w: Worker) {
    if (this.pushFailure) throw new Error("push failed");
    return {
      branch: `swarmforge/${w.team_id}/${w.task_id}/${w.worker_id}`,
      commit: "a".repeat(40),
      base_commit: "b".repeat(40),
    };
  }
  async pauseWorker(id: string) {
    const vm = this.vms.get(id);
    if (vm) vm.state = "paused";
  }
  async resumeWorker(id: string) {
    const vm = this.vms.get(id);
    if (vm) vm.state = "running";
  }
  async destroyWorker(id: string) {
    if (this.destroyFailure) throw new Error("delete failed");
    this.vms.delete(id);
  }
  async exec(_id: string, command: string) {
    this.execCommands.push(command);
    if (command.includes("SWARMFORGE_GIT_CHECK"))
      return {
        stdout: JSON.stringify({
          safe: !this.dirty,
          reason: this.dirty ? "dirty" : "clean",
        }),
        stderr: "",
        code: 0,
      };
    return { stdout: "log output", stderr: "", code: 0 };
  }
  async readFile(id: string, path: string, offset = 0, length = 65536) {
    const data = this.files.get(`${id}:${path}`);
    if (data === undefined) throw new Error("missing file");
    return new TextEncoder().encode(data).slice(offset, offset + length);
  }
  async writeFile(id: string, path: string, content: string) {
    this.files.set(`${id}:${path}`, content);
  }
  async listFiles(id: string, path: string) {
    return [...this.files.keys()]
      .filter((k) => k.startsWith(`${id}:${path}/`))
      .map((k) => ({ name: k.slice(`${id}:${path}/`.length), kind: "file" }));
  }
  async stat(id: string, path: string) {
    const data = this.files.get(`${id}:${path}`);
    if (data === undefined) {
      if (
        [
          "/workspace",
          "/workspace/.swarmforge",
          "/workspace/.swarmforge/artifacts",
          "/workspace/.swarmforge/logs",
        ].includes(path)
      )
        return { size: 0, isFile: false, isSymlink: false };
      if ([...this.files.keys()].some((k) => k.startsWith(`${id}:${path}/`)))
        return { size: 0, isFile: false, isSymlink: false };
      throw new Error("missing file");
    }
    return { size: Buffer.byteLength(data), isFile: true, isSymlink: false };
  }
}
export class FakeAgent implements CodingAgent {
  snapshots = new Map<string, AgentSnapshot>();
  submitted: { session: string | null; dispatch: Dispatch }[] = [];
  sessions = 0;
  broken = false;
  // Optional gate so a test can hold a step open while it requests a control operation.
  gate: (() => Promise<void>) | null = null;
  async ensureSession(w: Worker) {
    if (w.opencode_session_id) return w.opencode_session_id;
    this.sessions++;
    return `ses-${w.worker_id}`;
  }
  async submit(w: Worker, d: Dispatch) {
    this.submitted.push({ session: w.opencode_session_id, dispatch: d });
    this.snapshots.set(w.worker_id, {
      status: "busy",
      inference_active: 1,
      messages: [
        {
          id: d.message_id,
          role: "user",
          completed: true,
          input: 0,
          output: 0,
          reasoning: 0,
          cache_read: 0,
          cache_write: 0,
        },
      ],
    });
  }
  async inspect(w: Worker) {
    if (this.gate) await this.gate();
    if (this.broken) throw new Error("OpenCode unavailable");
    return (
      this.snapshots.get(w.worker_id) ?? {
        status: "idle",
        messages: [],
        inference_active: 0,
      }
    );
  }
  async abort(w: Worker) {
    const s = this.snapshots.get(w.worker_id);
    if (s) s.status = "idle";
  }
  complete(
    w: Worker,
    result: unknown = { status: "completed", summary: "done" },
  ) {
    const sent = this.submitted
      .filter((s) => s.dispatch.worker_id === w.worker_id)
      .at(-1);
    if (!sent) throw new Error("not submitted");
    this.snapshots.set(w.worker_id, {
      status: "idle",
      inference_active: 0,
      messages: [
        {
          id: sent.dispatch.message_id,
          role: "user",
          completed: true,
          input: 0,
          output: 0,
          reasoning: 0,
          cache_read: 0,
          cache_write: 0,
        },
        {
          id: `answer-${sent.dispatch.run_id}`,
          parent_id: sent.dispatch.message_id,
          role: "assistant",
          completed: true,
          result,
          input: 10,
          output: 20,
          reasoning: 0,
          cache_read: 0,
          cache_write: 0,
          model: "qwen",
        },
      ],
    });
  }
}
export function harness(overrides: Partial<Config> = {}) {
  const store = new Store(":memory:");
  const provider = new FakeProvider();
  const agent = new FakeAgent();
  const coordinator = new Coordinator(
    { ...config, ...overrides },
    store,
    provider,
    agent,
  );
  return { store, provider, agent, coordinator };
}
export async function runToRunning(h: ReturnType<typeof harness>, id: string) {
  for (let i = 0; i < 8; i++) {
    await h.coordinator.tick();
    if (h.store.get(id).state === "running") return;
  }
  throw new Error("did not run");
}
export const task = {
  team_id: "team",
  task_id: "task",
  role: "coder",
  prompt: "Implement a feature",
};

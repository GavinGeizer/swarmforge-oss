import {
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkerArtifactTransport } from "../src/artifact-types";
import type { ArtifactService } from "../src/artifacts";
import { type Config, loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import type {
  AgentSnapshot,
  CodingAgent,
  Dispatch,
  ExecResult,
  FileInfo,
  Spawn,
  VmInfo,
  Worker,
  WorkerProvider,
} from "../src/domain";
import {
  type ArtifactExecResult,
  type ArtifactHost,
  HelperArtifactTransport,
} from "../src/providers/artifact-transport";
import { Store } from "../src/store";

/**
 * A local stand-in for one worker guest: a directory on this host plays the
 * guest filesystem and every capture really runs the production Python helper
 * as a subprocess, with real raw byte streaming for the staged file.
 *
 * There is deliberately no reimplemented helper here. The transport installs
 * the same `src/providers/artifact-helper.py` bytes it installs in a Freestyle
 * VM, so tests exercise production capture, hashing and bounds.
 */
export class LocalArtifactHost implements ArtifactHost {
  readonly helperPath: string;
  readonly staging: string;
  readonly commands: string[] = [];
  /** Injected faults, so transport behaviour can be tested without a real VM. */
  failure: ((command: string) => Error | null) | null = null;
  constructor(
    readonly base: string,
    readonly vmId: string,
  ) {
    this.helperPath = `${base}/opt/swarmforge/artifact-helper.py`;
    this.staging = `${base}/opt/swarmforge/staging`;
  }
  stagingDir() {
    return this.staging;
  }
  async exec(
    _vmId: string,
    command: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ArtifactExecResult> {
    if (options.signal?.aborted) throw new Error("Artifact transfer aborted");
    const injected = this.failure?.(command);
    if (injected) throw injected;
    this.commands.push(command);
    // The guest runs command strings through a shell, so this one does too.
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: this.base },
    });
    const timer = setTimeout(() => proc.kill(), options.timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
    }
  }
  async openRaw(
    _vmId: string,
    path: string,
    options: { signal?: AbortSignal },
  ) {
    if (options.signal?.aborted) throw new Error("Artifact transfer aborted");
    return lazyFileStream(path, options.signal);
  }
  async writeRaw(
    _vmId: string,
    path: string,
    bytes: Uint8Array,
    options: { mode: number },
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: options.mode });
  }
}

/**
 * The exported fixture transport: a real transport driving the real helper, for
 * this package's tests and for package 3's realistic salvage smoke where no
 * Freestyle VM is available.
 */
export class LocalArtifactTransport extends HelperArtifactTransport {
  constructor(readonly local: LocalArtifactHost) {
    super(local, {
      helperPath: local.helperPath,
      python: process.env.SWARMFORGE_TEST_PYTHON ?? "python3",
      timeoutMs: 60000,
    });
  }
}

/**
 * A staged file is opened when the first byte is asked for, not when the
 * transport call returns. That is what the guest's HTTP filesystem transport
 * does, and it is the only honest local model: a staged copy removed between
 * the request and the read must fail the transfer instead of quietly serving
 * whatever an already-open descriptor happens to hold.
 */
function lazyFileStream(
  path: string,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  let handle: number | null = null;
  let stopped = false;
  // highWaterMark 0 keeps every read on demand: nothing is touched until the
  // consumer asks for a byte, exactly like a guest HTTP response body.
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (stopped) return;
        if (signal?.aborted) {
          controller.error(new Error("Artifact transfer aborted"));
          return;
        }
        try {
          handle ??= openSync(
            path,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          );
          const buffer = Buffer.alloc(chunkSize);
          const read = readSync(handle, buffer, 0, chunkSize, null);
          if (read > 0)
            controller.enqueue(new Uint8Array(buffer.buffer, 0, read));
          else {
            closeSync(handle);
            handle = null;
            controller.close();
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        stopped = true;
        if (handle !== null) {
          closeSync(handle);
          handle = null;
        }
      },
    },
    { highWaterMark: 0 },
  );
}

export interface LocalWorkspace {
  vmId: string;
  /** The permitted artifact root, as configured inside the guest. */
  root: string;
  /** The private staging root, outside the artifact root. */
  staging: string;
  /** Guest-private tree that disappears with the VM. */
  base: string;
  host: LocalArtifactHost;
  transport: LocalArtifactTransport;
  stagingEntries(): string[];
  cleanup(): Promise<void>;
}

export async function localWorkspace(): Promise<LocalWorkspace> {
  const base = mkdtempSync(join(tmpdir(), "swarmforge-guest-"));
  const vmId = "vm-local";
  const workspace = join(base, "workspace");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const host = new LocalArtifactHost(base, vmId);
  const transport = new LocalArtifactTransport(host);
  // The staging root gets the same privacy it has in a real guest.
  mkdirSync(host.staging, { recursive: true, mode: 0o700 });
  return {
    vmId,
    root: workspace,
    staging: host.staging,
    base,
    host,
    transport,
    stagingEntries() {
      return existsSync(host.staging) ? readdirSync(host.staging) : [];
    },
    async cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * A `WorkerProvider` over the same local directory, so a whole coordinator flow
 * (spawn, preserve, destroy) runs without a VM. Destroying the VM removes the
 * guest tree, which is exactly what makes preservation worth doing.
 */
export class LocalWorkerProvider implements WorkerProvider {
  readonly artifactTransport: WorkerArtifactTransport;
  readonly vms = new Map<string, VmInfo>();
  readonly destroyed = new Set<string>();
  /** Set when the guest filesystem should fail like a deleted VM. */
  gone = false;
  constructor(
    readonly workspace: LocalWorkspace,
    readonly config: Config,
  ) {
    this.artifactTransport = workspace.transport;
  }
  private require(id: string) {
    if (!this.vms.has(id)) throw new Error("Worker VM not found");
  }
  async createWorker(w: Worker) {
    const vm = {
      id: `vm-${w.worker_id}`,
      slug: w.worker_id,
      state: "running",
      worker_id: w.worker_id,
    };
    this.vms.set(vm.id, vm);
    for (const directory of ["artifacts", "logs"])
      mkdirSync(join(this.workspace.root, ".swarmforge", directory), {
        recursive: true,
        mode: 0o700,
      });
    return vm;
  }
  async getWorker(id: string) {
    return this.vms.get(id) ?? null;
  }
  async listWorkers() {
    return [...this.vms.values()];
  }
  async prepare(w: Worker) {
    return `https://${w.worker_id}.local`;
  }
  async pushBranch(w: Worker) {
    return {
      branch: `swarmforge/${w.team_id}/${w.task_id}/${w.worker_id}`,
      commit: "c".repeat(40),
      base_commit: "b".repeat(40),
    };
  }
  async pauseWorker(id: string) {
    this.require(id);
    this.vms.get(id)!.state = "paused";
  }
  async resumeWorker(id: string) {
    this.require(id);
    this.vms.get(id)!.state = "running";
  }
  async destroyWorker(id: string) {
    this.require(id);
    this.destroyed.add(id);
    this.vms.delete(id);
    rmSync(this.workspace.base, { recursive: true, force: true });
    this.gone = true;
  }
  async exec(_id: string, command: string): Promise<ExecResult> {
    if (command.includes("SWARMFORGE_GIT_CHECK"))
      return {
        stdout: JSON.stringify({ safe: true, reason: "local fixture" }),
        stderr: "",
        code: 0,
      };
    if (command.includes("journalctl"))
      return { stdout: "local journal line\n", stderr: "", code: 0 };
    if (command.includes("systemctl"))
      return { stdout: "", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }
  async readFile(id: string, path: string, offset = 0, length = 65536) {
    this.require(id);
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error("missing file");
    return new Uint8Array(
      await file.slice(offset, offset + length).arrayBuffer(),
    );
  }
  async writeFile(id: string, path: string, content: string) {
    this.require(id);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
  }
  async listFiles(id: string, path: string): Promise<FileInfo[]> {
    this.require(id);
    const entries: FileInfo[] = [];
    try {
      for await (const entry of new Bun.Glob("**/*").scan({
        cwd: path,
        dot: true,
      })) {
        entries.push({ name: entry, kind: "file" });
      }
    } catch {
      return [];
    }
    return entries;
  }
  async stat(id: string, path: string) {
    this.require(id);
    const file = Bun.file(path);
    if (await file.exists())
      return { size: file.size, isFile: true, isSymlink: false };
    try {
      const stat = await lstat(path);
      return {
        size: stat.size,
        isFile: stat.isFile(),
        isSymlink: stat.isSymbolicLink(),
      };
    } catch {
      throw new Error("missing path");
    }
  }
}

/** A coding agent that does nothing, so a coordinator can be built and read. */
export class LocalAgent implements CodingAgent {
  async ensureSession(w: Worker) {
    return w.opencode_session_id ?? `ses-${w.worker_id}`;
  }
  async submit(_w: Worker, _d: Dispatch) {}
  async inspect(_w: Worker): Promise<AgentSnapshot> {
    return { status: "idle", messages: [], inference_active: 0 };
  }
  async abort(_w: Worker) {}
}

export interface LocalHarness {
  workspace: LocalWorkspace;
  provider: LocalWorkerProvider;
  config: Config;
  store: Store;
  artifacts: ArtifactService;
  /** A real coordinator over the local guest; never started by this fixture. */
  coordinator: Coordinator;
  /** Coordinator-private artifact storage, outside the guest tree. */
  storageDir: string;
  /** A worker record with a real local guest behind it. */
  spawn(input?: Partial<Spawn>): Worker;
  cleanup(): Promise<void>;
}

/**
 * A disposable harness with the real store, the real storage backend and a local
 * guest. `env` may carry the coordinator-side artifact limits under test.
 */
export async function localHarness(
  env: Record<string, string> = {},
): Promise<LocalHarness> {
  const workspace = await localWorkspace();
  // Coordinator storage must outlive the guest, so it lives outside its tree.
  const storageDir = mkdtempSync(join(tmpdir(), "swarmforge-storage-"));
  const config = loadConfig({
    FREESTYLE_API_TOKEN: "local-infra-secret",
    FREESTYLE_SNAPSHOT_ID: "snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "model-secret",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "none",
    SWARMFORGE_DB_PATH: ":memory:",
    SWARMFORGE_WORKSPACE: workspace.root,
    SWARMFORGE_HOST: "127.0.0.1",
    SWARMFORGE_ARTIFACT_DIR: storageDir,
    ...env,
  }) as Config & Record<string, unknown>;
  // The artifact configuration keys belong to the lifecycle package, which owns
  // the schema. Passing them through here keeps this package's limits testable
  // against a configuration that does not carry them yet.
  for (const [key, value] of Object.entries({
    SWARMFORGE_ARTIFACT_DIR: storageDir,
    ...env,
  })) {
    if (!key.startsWith("SWARMFORGE_")) continue;
    config[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  const store = new Store(":memory:");
  const provider = new LocalWorkerProvider(workspace, config);
  // Imported lazily so the transport fixture can be used on its own.
  const { ArtifactService } = await import("../src/artifacts");
  const artifacts = new ArtifactService(config, store, provider);
  const coordinator = new Coordinator(
    config,
    store,
    provider,
    new LocalAgent(),
  );
  return {
    workspace,
    provider,
    config,
    store,
    artifacts,
    coordinator,
    storageDir,
    spawn(input: Partial<Spawn> = {}) {
      const worker = store.create({
        team_id: "team",
        task_id: "task",
        role: "coder",
        prompt: "preserve my artifacts",
        timeout_seconds: 60,
        ...input,
      });
      return store.patch(worker.worker_id, {
        vm_id: `vm-${worker.worker_id}`,
        state: "ready",
      });
    },
    async cleanup() {
      store.close();
      await workspace.cleanup();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import type {
  AgentSnapshot,
  CodingAgent,
  Dispatch,
  Prepared,
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
export class FakeProvider implements WorkerProvider {
  vms = new Map<string, VmInfo>();
  files = new Map<string, string>();
  directories = new Set<string>();
  commands: string[] = [];
  workspace = "/workspace";
  // Recorded at prepare, like the control-plane baseline of a real workspace.
  digest: string | null = null;
  mtime = "2026-01-01T00:00:00Z";
  gitBase: string | null = "b".repeat(40);
  failure = false;
  // Reports one untracked file at the workspace root, as a working worker would leave.
  dirty = false;
  destroyFailure = false;
  pushFailure = false;
  created = 0;
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
  async prepare(w: Worker): Promise<Prepared> {
    if (this.failure) throw new Error("boot failure");
    return {
      endpoint: `https://${w.vm_id}.example`,
      git_base: this.gitBase,
      workspace_digest: this.digest,
    };
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
    this.commands.push(command);
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
    const prefix = `${id}:${path}/`;
    const entries = new Map<string, string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      entries.set(
        slash === -1 ? rest : rest.slice(0, slash),
        slash === -1 ? "file" : "directory",
      );
    }
    if (this.dirty && path === this.workspace) entries.set("dirty.txt", "file");
    return [...entries].map(([name, kind]) => ({ name, kind }));
  }
  async stat(id: string, path: string) {
    if (this.dirty && path === `${this.workspace}/dirty.txt`)
      return {
        size: 16,
        isFile: true,
        isSymlink: false,
        modified: this.mtime,
      };
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
        return { size: 0, isFile: false, isSymlink: false, modified: "" };
      if ([...this.files.keys()].some((k) => k.startsWith(`${id}:${path}/`)))
        return { size: 0, isFile: false, isSymlink: false, modified: "" };
      throw new Error("missing file");
    }
    if (this.directories.has(`${id}:${path}`))
      return { size: 0, isFile: false, isSymlink: false, modified: "" };
    return {
      size: Buffer.byteLength(data),
      isFile: true,
      isSymlink: false,
      modified: this.mtime,
    };
  }
}
export class FakeAgent implements CodingAgent {
  snapshots = new Map<string, AgentSnapshot>();
  submitted: { session: string | null; dispatch: Dispatch }[] = [];
  sessions = 0;
  broken = false;
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
export function harness() {
  const store = new Store(":memory:");
  const provider = new FakeProvider();
  provider.workspace = config.SWARMFORGE_WORKSPACE;
  const agent = new FakeAgent();
  const coordinator = new Coordinator({ ...config }, store, provider, agent);
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
// An SSH-mode deployment against a local tree and remote, for host-side Git checks.
export function loadTestConfig(input: {
  workspace: string;
  tree: string;
  push: string;
}) {
  return loadConfig({
    FREESTYLE_API_TOKEN: "secret",
    FREESTYLE_SNAPSHOT_ID: "snap",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "key",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: input.tree,
    SWARMFORGE_GIT_PUSH_MODE: "ssh",
    SWARMFORGE_GIT_PUSH_URL: input.push,
    SWARMFORGE_GIT_SSH_KEY_PATH: "/write-key",
    SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH: "/write-hosts",
    SWARMFORGE_WORKSPACE: input.workspace,
  });
}

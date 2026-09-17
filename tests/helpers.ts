import { loadConfig } from "../src/config";
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
export class FakeProvider implements WorkerProvider {
  vms = new Map<string, VmInfo>();
  files = new Map<string, string>();
  failure = false;
  dirty = false;
  destroyFailure = false;
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
  async prepare(w: Worker) {
    if (this.failure) throw new Error("boot failure");
    return `https://${w.vm_id}.example`;
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
  const agent = new FakeAgent();
  const coordinator = new Coordinator(config, store, provider, agent);
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

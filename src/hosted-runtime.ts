import { type ChildProcess, spawn } from "node:child_process";
import type {
  AgentSnapshot,
  CodingAgent,
  Dispatch,
  ExecResult,
  VmInfo,
  Worker,
  WorkerProvider,
} from "./domain";

/**
 * Controlled local process provider for hosted inert execution only.
 * No VM provisioning: a real local subprocess runs the server-defined fixed
 * inert probe/delay workload. Implements stopWorkerRuntime with verified exit
 * (waitpid-style wait + missing-process proof); never treats a Coordinator
 * cancelled/paused label or a network failure as proven stop.
 */
export class ControlledProcessProvider implements WorkerProvider {
  private children = new Map<string, ChildProcess>();
  readonly spawnedCommands: string[] = [];
  constructor(
    private readonly runtimeScript = new URL(
      "../scripts/hosted-controlled-runtime.ts",
      import.meta.url,
    ).pathname,
  ) {}
  private vmId(w: Worker): string {
    if (!w.vm_id) throw new Error("Controlled worker has no runtime handle.");
    return w.vm_id;
  }
  async createWorker(w: Worker): Promise<VmInfo> {
    const id = `controlled-${w.worker_id}`;
    return { id, slug: w.worker_id, state: "running", worker_id: w.worker_id };
  }
  async getWorker(id: string): Promise<VmInfo | null> {
    const child = this.children.get(id);
    if (!child) return null;
    if (child.exitCode !== null || child.signalCode !== null)
      return { id, slug: id, state: "stopped" };
    try {
      process.kill(child.pid!, 0);
      return { id, slug: id, state: "running" };
    } catch {
      return null;
    }
  }
  async listWorkers(): Promise<VmInfo[]> {
    const out: VmInfo[] = [];
    for (const [id] of this.children) {
      const vm = await this.getWorker(id);
      if (vm) out.push(vm);
    }
    return out;
  }
  async prepare(_w: Worker): Promise<string> {
    return "controlled-local";
  }
  /** Starts the fixed inert workload. Duration comes from the server lease math. */
  startControlled(
    w: Worker,
    durationMs: number,
    onExit: (code: number | null) => void,
  ): void {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new Error("Controlled duration is invalid.");
    const id = this.vmId(w);
    if (this.children.has(id))
      throw new Error(
        "Controlled runtime already started; refusing duplicate.",
      );
    this.spawnedCommands.push(`controlled-probe duration_ms=${durationMs}`);
    const child = spawn(
      process.execPath,
      [this.runtimeScript, String(durationMs)],
      {
        // No inherited process.env: strict allowlist without cloud bearer,
        // provider, repo or model credentials. stdio pipe (never inherit):
        // the child observes parent death as stdin EOF and stops itself.
        env: {
          PATH: "/usr/bin:/bin",
          TZ: "UTC",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    // Hold the parent end open: EOF reaches the child only when the
    // supervisor (and its stdio) is actually gone. Keep flowing so no
    // buffered pause wedges the pipe.
    child.stdin?.on("error", () => {});
    child.stdin?.write("");
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.stdout?.resume();
    child.stderr?.resume();
    this.children.set(id, child);
    child.on("exit", (code) => {
      this.children.delete(id);
      onExit(code);
    });
    child.on("error", () => {
      this.children.delete(id);
      onExit(null);
    });
  }
  /** Verified stop: SIGTERM, escalate to SIGKILL, then confirm exit/absence. */
  async stopWorkerRuntime(w: Worker): Promise<void> {
    const id = this.vmId(w);
    const child = this.children.get(id);
    if (!child) {
      // Independently confirm absence: only a confirmed-missing process counts.
      const vm = await this.getWorker(id);
      if (vm === null) return;
      throw new Error("Controlled runtime stop is uncertain; holding state.");
    }
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    try {
      child.kill("SIGTERM");
    } catch {
      throw new Error("Controlled runtime stop is uncertain; holding state.");
    }
    const grace = await Promise.race([
      exited.then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    if (!grace) {
      try {
        child.kill("SIGKILL");
      } catch {
        throw new Error("Controlled runtime stop is uncertain; holding state.");
      }
      const forced = await Promise.race([
        exited.then(() => true),
        Bun.sleep(2000).then(() => false),
      ]);
      if (!forced)
        throw new Error("Controlled runtime stop is uncertain; holding state.");
    }
    this.children.delete(id);
    // Confirm the pid is really gone (no zombie executing agent work).
    try {
      process.kill(child.pid!, 0);
      throw new Error("Controlled runtime stop is uncertain; holding state.");
    } catch (e) {
      if (e instanceof Error && /uncertain/.test(e.message)) throw e;
      return;
    }
  }
  async pushBranch(_w: Worker) {
    // Controlled inert work produces no branch: return a deterministic inert marker.
    return {
      branch: "hosted-controlled/inert",
      commit: "0".repeat(40),
      base_commit: "0".repeat(40),
    };
  }
  async pauseWorker(_id: string): Promise<void> {}
  async resumeWorker(_id: string): Promise<void> {}
  async destroyWorker(id: string): Promise<void> {
    const child = this.children.get(id);
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {}
      this.children.delete(id);
    }
  }
  async exec(_id: string, _command: string): Promise<ExecResult> {
    throw new Error("Controlled provider does not execute arbitrary commands.");
  }
  async readFile(
    _id: string,
    _path: string,
    _offset?: number,
    _length?: number,
  ): Promise<Uint8Array> {
    throw new Error("Controlled provider has no guest filesystem.");
  }
  async writeFile(_id: string, _path: string, _content: string): Promise<void> {
    throw new Error("Controlled provider has no guest filesystem.");
  }
  async listFiles() {
    return [];
  }
  async stat() {
    return { size: 0, isFile: false, isSymlink: false };
  }
}

/** Minimal agent for the fixed inert workload: no prompts leave the host. */
export class ControlledAgent implements CodingAgent {
  sessions = 0;
  private done = new Set<string>();
  async ensureSession(w: Worker): Promise<string> {
    if (w.opencode_session_id) return w.opencode_session_id;
    this.sessions++;
    return `controlled-${w.worker_id}`;
  }
  async submit(_w: Worker, _d: Dispatch): Promise<void> {}
  async inspect(w: Worker): Promise<AgentSnapshot> {
    if (this.done.has(w.worker_id))
      return { status: "idle", messages: [], inference_active: 0 };
    return { status: "busy", messages: [], inference_active: 1 };
  }
  async abort(w: Worker): Promise<void> {
    this.done.add(w.worker_id);
  }
  completeSession(w: Worker): void {
    this.done.add(w.worker_id);
  }
}

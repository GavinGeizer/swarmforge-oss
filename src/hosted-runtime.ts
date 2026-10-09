import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import type {
  AgentSnapshot,
  CodingAgent,
  Dispatch,
  ExecResult,
  VmInfo,
  Worker,
  WorkerProvider,
} from "./domain";
import { HOSTED_CHILD_DURATION_ENV, HOSTED_CHILD_ENV } from "./hosted-child";

export interface ControlledProcessRecord {
  pid: number;
  /** Linux process starttime (clock ticks since boot, /proc/<pid>/stat field 22). */
  starttime: string;
  /** Resolved /proc/<pid>/exe at spawn; must equal our own binary. */
  exe: string;
  /** Kernel boot identity prevents PID/starttime collisions across host reboot. */
  bootId?: string;
  durationMs: number;
  /** Monotonic (performance.now) start in the SPAWNING process only. */
  startedAtMonoMs: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error(
      "Controlled process liveness is uncertain; no OS absence proof.",
      { cause: error },
    );
  }
}

/** Read /proc/<pid>/stat starttime (field 22, ticks since boot). Null when unreadable. */
export function procStarttime(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
    const starttime = after[19];
    if (!starttime || !/^\d+$/.test(starttime)) return null;
    return starttime;
  } catch {
    return null;
  }
}

/** Resolved /proc/<pid>/exe. Null when unreadable (exited or permission). */
export function procExe(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

export function procBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

function processExited(pid: number, record?: ControlledProcessRecord): boolean {
  if (!pidAlive(pid)) return true;
  // An orphan can remain a zombie under PID 1; it cannot execute any work.
  // Require the same captured identity before treating that PID as stopped.
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = raw.slice(raw.lastIndexOf(") ") + 2).split(" ")[0];
    return (
      state === "Z" &&
      record !== undefined &&
      record.bootId === procBootId() &&
      procStarttime(pid) === record.starttime
    );
  } catch {
    return false;
  }
}

function ownExe(): string | null {
  return procExe(process.pid);
}

/**
 * OS start-identity match: same pid AND same /proc starttime AND exe lineage
 * (the live exe must equal our own binary path — a reused pid running another
 * binary, or an unreadable exe, never matches). Checked BEFORE any signal so
 * a stale/fabricated record can never signal an unrelated live process.
 */
export function identityMatches(record: ControlledProcessRecord): boolean {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  if (!/^\d+$/.test(record.starttime)) return false;
  if (record.bootId !== procBootId() || !record.bootId) return false;
  const live = procStarttime(record.pid);
  if (live === null || live !== record.starttime) return false;
  const liveExe = procExe(record.pid);
  const mine = ownExe();
  if (liveExe === null || mine === null) return false;
  return liveExe === mine && record.exe === mine;
}

/**
 * Controlled local process provider for hosted inert execution only.
 * No VM provisioning: a real local subprocess runs the server-defined fixed
 * inert probe/delay workload, spawned as the CURRENT binary
 * (`process.execPath` self-spawn with SWARMFORGE_HOSTED_CHILD=1 marker, which
 * enters the embedded src/hosted-child.ts runtime). Compiled-binary safe: no
 * external Bun, no repo .ts file, no $bunfs path.
 *
 * Stop proof is OS-level, never an in-memory map: the durable record carries
 * the child pid + monotonic start; stopWorkerRuntime signals the pid and
 * confirms OS exit/absence. A provider that never saw the child (fresh
 * restart) resolves the pid from the HostedStore record via
 * stopPidWithProof and refuses unknown runtimes instead of claiming a stop
 * from an empty map. Coordinator cancelled/paused labels and network results
 * are never stop proof.
 */
export class ControlledProcessProvider implements WorkerProvider {
  private children = new Map<string, ChildProcess>();
  private records = new Map<string, ControlledProcessRecord>();
  readonly spawnedCommands: string[] = [];
  private vmId(w: Worker): string {
    if (!w.vm_id) throw new Error("Controlled worker has no runtime handle.");
    return w.vm_id;
  }
  async createWorker(w: Worker): Promise<VmInfo> {
    const id = `controlled-${w.worker_id}`;
    return { id, slug: w.worker_id, state: "running", worker_id: w.worker_id };
  }
  /** Liveness from OS state + start-identity. Stopped pids report stopped (exit proof). */
  async getWorker(id: string): Promise<VmInfo | null> {
    const child = this.children.get(id);
    if (child) {
      if (child.exitCode !== null || child.signalCode !== null)
        return { id, slug: id, state: "stopped" };
      if (child.pid !== undefined && pidAlive(child.pid))
        return { id, slug: id, state: "running" };
      return { id, slug: id, state: "stopped" };
    }
    const record = this.records.get(id);
    if (record) {
      // Identity-gated: a reused pid running another binary (or an unreadable
      // /proc entry) never reports as our running worker.
      if (identityMatches(record)) return { id, slug: id, state: "running" };
      if (processExited(record.pid, record))
        return { id, slug: id, state: "stopped" };
      return null;
    }
    return null;
  }
  async listWorkers(): Promise<VmInfo[]> {
    const out: VmInfo[] = [];
    const ids = new Set([...this.children.keys(), ...this.records.keys()]);
    for (const id of ids) {
      const vm = await this.getWorker(id);
      if (vm) out.push(vm);
    }
    return out;
  }
  async prepare(_w: Worker): Promise<string> {
    return "controlled-local";
  }
  /** Record a pid observed out-of-band (restart recovery from durable journal). */
  trackExternal(vmId: string, record: ControlledProcessRecord): void {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0)
      throw new Error("Controlled pid record is invalid.");
    if (
      !/^\d+$/.test(record.starttime) ||
      !record.exe ||
      !record.bootId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        record.bootId,
      )
    )
      throw new Error("Controlled pid record lacks OS start-identity.");
    this.records.set(vmId, record);
  }
  forget(vmId: string): void {
    this.records.delete(vmId);
    this.children.delete(vmId);
  }
  recordFor(vmId: string): ControlledProcessRecord | null {
    return this.records.get(vmId) ?? null;
  }
  /** Starts the fixed inert workload. Duration comes from the server lease math. */
  async startControlled(
    w: Worker,
    durationMs: number,
    onExit: (code: number | null) => void,
    journalSpawn?: (record: ControlledProcessRecord) => void,
  ): Promise<void> {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
      throw new Error("Controlled duration is invalid.");
    const id = this.vmId(w);
    if (this.children.has(id))
      throw new Error(
        "Controlled runtime already started; refusing duplicate.",
      );
    this.spawnedCommands.push(`controlled-probe duration_ms=${durationMs}`);
    // Runtime-native launch choice: a compiled binary self-spawns
    // process.execPath (the child enters the embedded hosted-child runtime
    // via the env marker); source execution runs the dev/test script entry.
    // Bun's runtime-owned flag distinguishes this executable from source
    // execution. No ambient entry marker can select the launch path.
    const compiled = Bun.isStandaloneExecutable;
    const startedAtMonoMs = performance.now();
    const child = compiled
      ? spawn(process.execPath, [], {
          env: {
            PATH: "/usr/bin:/bin",
            TZ: "UTC",
            [HOSTED_CHILD_ENV]: "1",
            [HOSTED_CHILD_DURATION_ENV]: String(durationMs),
          },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(
          process.execPath,
          [
            "--no-env-file",
            "--config=/dev/null",
            new URL("./hosted-child-script.ts", import.meta.url).pathname,
          ],
          {
            env: {
              PATH: "/usr/bin:/bin",
              TZ: "UTC",
              [HOSTED_CHILD_DURATION_ENV]: String(durationMs),
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
    // OS start identity is read AFTER the stdio handshake above: a compiled
    // binary needs a scheduling beat before the grandchild's /proc/stat is
    // readable (immediate synchronous reads can race exec). Retry briefly;
    // a persistently unreadable identity still refuses unjournaled execution.
    let starttime: string | null = null;
    let exe: string | null = null;
    for (let i = 0; i < 40; i++) {
      starttime = procStarttime(child.pid!);
      exe = procExe(child.pid!);
      if (starttime !== null && exe === ownExe()) break;
      await Bun.sleep(25);
    }
    const record: ControlledProcessRecord = {
      pid: child.pid!,
      starttime: starttime ?? "unknown",
      exe: exe ?? "unknown",
      durationMs,
      startedAtMonoMs,
      bootId: procBootId() ?? undefined,
    };
    if (
      !/^\d+$/.test(record.starttime) ||
      record.exe !== ownExe() ||
      !record.bootId
    ) {
      // No OS start identity (non-/proc platform): stop the child at once —
      // never run an unjournaled, unidentifiable process.
      try {
        child.kill("SIGKILL");
      } catch {}
      this.children.delete(id);
      throw new Error(
        "Controlled runtime lacks OS start identity; refusing unjournaled execution.",
      );
    }
    this.children.set(id, child);
    this.records.set(id, record);
    try {
      // The durable journal belongs to this launch. Concurrent tasks must
      // never share a mutable hook that can write another child's identity.
      journalSpawn?.(record);
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {}
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      this.children.delete(id);
      throw error;
    }
    child.on("exit", (code) => {
      this.children.delete(id);
      onExit(code);
    });
    child.on("error", () => {
      this.children.delete(id);
      onExit(null);
    });
  }
  /**
   * Verified OS-level stop for a locally tracked child: SIGTERM, escalate to
   * SIGKILL, then confirm the pid is gone. Throws (holds) on any uncertainty.
   */
  async stopWorkerRuntime(w: Worker): Promise<void> {
    const id = this.vmId(w);
    const child = this.children.get(id);
    const record = this.records.get(id);
    const pid = child?.pid ?? record?.pid;
    if (pid === undefined) {
      // Unknown runtime to THIS provider: refuse to claim a stop from an
      // empty map. The caller (stopPidWithProof / supervisor) must resolve
      // the durable pid record first; only confirmed OS absence resolves.
      throw new Error(
        "Controlled runtime is unknown to this provider; refusing stop proof without a durable pid record.",
      );
    }
    if (processExited(pid, record)) {
      this.children.delete(id);
      return;
    }
    if (record && !identityMatches(record))
      throw new Error(
        "Controlled pid record fails OS start-identity; holding.",
      );
    if (child) {
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
        if (!record || !identityMatches(record))
          throw new Error(
            "Controlled pid changed before stop escalation; holding OS start-identity uncertainty.",
          );
        try {
          child.kill("SIGKILL");
        } catch {
          throw new Error(
            "Controlled runtime stop is uncertain; holding state.",
          );
        }
        const forced = await Promise.race([
          exited.then(() => true),
          Bun.sleep(2000).then(() => false),
        ]);
        if (!forced)
          throw new Error(
            "Controlled runtime stop is uncertain; holding state.",
          );
      }
      this.children.delete(id);
    } else {
      // Externally tracked pid (restart recovery): signal via OS and confirm.
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        if (!pidAlive(pid)) return;
        throw new Error("Controlled runtime stop is uncertain; holding state.");
      }
      const deadline = Date.now() + 2000;
      while (!processExited(pid, record) && Date.now() < deadline)
        await Bun.sleep(50);
      if (!processExited(pid, record)) {
        if (!record || !identityMatches(record))
          throw new Error(
            "Controlled pid changed before stop escalation; holding OS start-identity uncertainty.",
          );
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        const killDeadline = Date.now() + 2000;
        while (!processExited(pid, record) && Date.now() < killDeadline)
          await Bun.sleep(50);
      }
    }
    // Confirm the pid is really gone (no zombie executing agent work).
    if (!processExited(pid, record))
      throw new Error("Controlled runtime stop is uncertain; holding state.");
  }
  /**
   * Cross-provider/restart stop: identity-gated OS exit from the durable
   * record. The start-identity check runs BEFORE any signal: a stale or
   * fabricated record (pid reused by an unrelated binary, /proc unreadable)
   * rejects/holds instead of signalling a victim. Ghost records (pid absent)
   * resolve as already-stopped — absence is proven by /proc, not by map.
   */
  async stopPidWithProof(
    vmId: string,
    record: ControlledProcessRecord | null,
  ): Promise<void> {
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0)
      throw new Error(
        "Controlled runtime has no durable pid record; holding unknown runtime.",
      );
    // A live child handle in this provider takes the verified path; else the
    // durable pid is tracked and signalled via OS below. Either way the pid
    // record survives so getWorker keeps reporting stopped (exit proof).
    const child = this.children.get(vmId);
    if (child) {
      await this.stopWorkerRuntime({ vm_id: vmId } as Worker);
      this.trackExternal(vmId, record);
      return;
    }
    this.trackExternal(vmId, record);
    if (record.exe !== ownExe())
      throw new Error(
        "Controlled pid record fails OS start-identity: untrusted executable; holding.",
      );
    // Identity BEFORE signal: never touch an unrelated live process.
    if (!identityMatches(record)) {
      if (processExited(record.pid, record)) return; // trusted journal identity, proven OS exit.
      throw new Error(
        "Controlled pid record fails OS start-identity; holding instead of signalling an unrelated process.",
      );
    }
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {
      if (!pidAlive(record.pid)) return;
      throw new Error("Controlled runtime stop is uncertain; holding state.");
    }
    const deadline = Date.now() + 4000;
    while (!processExited(record.pid, record) && Date.now() < deadline)
      await Bun.sleep(50);
    if (!processExited(record.pid, record)) {
      if (!identityMatches(record))
        throw new Error(
          "Controlled pid changed before stop escalation; holding OS start-identity uncertainty.",
        );
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {}
      const killDeadline = Date.now() + 4000;
      while (!processExited(record.pid, record) && Date.now() < killDeadline)
        await Bun.sleep(50);
    }
    if (!processExited(record.pid, record))
      throw new Error("Controlled runtime stop is uncertain; holding state.");
    // Keep the pid record: getWorker reports stopped (exit proof) from it.
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

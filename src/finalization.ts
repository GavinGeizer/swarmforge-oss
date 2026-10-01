import type { ArtifactService } from "./artifacts";
import type { Config } from "./config";
import {
  type ArtifactDeclaration,
  artifactDeclarationsSchema,
  type Worker,
  type WorkerFinalization,
} from "./domain";
import type { Store } from "./store";
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
// Every artifact transfer takes a slot here, lifecycle finalization and direct API calls
// alike, so a salvage burst can never fan out into unbounded provider work.
export class ConcurrencyLimiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly limit: number) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }
  private acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
export interface ListFilesOptions {
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}
// The data plane service exposes these as the transferring operations. Everything else
// (list, metadata, read) answers from local storage and must keep its synchronous contract.
const transferring = new Set([
  "preserve",
  "snapshot",
  "diagnostics",
  "collectDirectory",
  "download",
  "listWorkerFiles",
  "safeRead",
]);
// Direct artifact API calls share the same bound as lifecycle collection, so an operator burst
// cannot fan out into unbounded provider work. A proxy keeps the exact service contract,
// including anything the data plane adds later.
export function boundedArtifacts(
  inner: ArtifactService,
  limiter: ConcurrencyLimiter,
): ArtifactService {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function")
        return value;
      const method = value as (...args: unknown[]) => unknown;
      // Bound to the service itself, so private state stays reachable through the facade.
      if (!transferring.has(property))
        return (...args: unknown[]) => method.apply(target, args);
      return (...args: unknown[]) =>
        limiter.run(async () => method.apply(target, args));
    },
  });
}
// Safe defaults: the worker's own output directory, its logs, the task result and its
// task metadata. All optional, so a worker that produced none still preserves successfully.
export const defaultTargets: ArtifactDeclaration[] =
  artifactDeclarationsSchema.parse([
    { path: ".swarmforge/artifacts/**" },
    { path: ".swarmforge/logs/**" },
    { path: ".swarmforge/result.json" },
    { path: ".swarmforge/task.json" },
    { path: ".swarmforge/metadata.json" },
  ]);
interface Claim {
  run_id: string | null;
  attempts: number;
}
interface LiveRun {
  abort: AbortController;
  promise: Promise<void>;
}
function describe(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message || "Unknown artifact error").slice(0, 500);
}
// A missing source and a failed transport are different outcomes: a declared optional path is
// skipped, a required one fails preservation, and any other transport error is always a failure.
const missingPattern =
  /no such file|not found|enoent|does not exist|no such directory/i;
const notDirectoryPattern =
  /not a directory|enotdir|illegal operation on a directory/i;
export class Finalizer {
  private runs = new Map<string, LiveRun>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly artifacts: ArtifactService,
    readonly limiter: ConcurrencyLimiter,
  ) {}
  collectable(w: Worker) {
    return Boolean(w.vm_id) && !w.vm_missing;
  }
  live(id: string) {
    return this.runs.get(id);
  }
  liveRuns() {
    return [...this.runs.values()].map((run) => run.promise);
  }
  // Cancellation and forced destruction stop a live transfer immediately. The collection holds
  // no worker lock, so this can never leave a control operation waiting on it.
  abort(id: string) {
    this.runs.get(id)?.abort.abort();
  }
  abortAll() {
    for (const run of this.runs.values()) run.abort.abort();
  }
  // One live attempt per worker: a second caller joins the running attempt instead of starting
  // a competing transfer for the same workspace.
  async run(id: string): Promise<void> {
    const existing = this.runs.get(id);
    if (existing) return existing.promise;
    const entry: LiveRun = {
      abort: new AbortController(),
      promise: Promise.resolve(),
    };
    entry.promise = this.execute(id, entry).finally(() => {
      if (this.runs.get(id) === entry) this.runs.delete(id);
    });
    this.runs.set(id, entry);
    return entry.promise;
  }
  private async execute(id: string, entry: LiveRun): Promise<void> {
    const claim = this.claim(id);
    if (!claim) return;
    const timer = setTimeout(
      () => entry.abort.abort(),
      this.config.SWARMFORGE_ARTIFACT_TIMEOUT_MS,
    );
    let failure: string | null = null;
    try {
      await this.limiter.run(() =>
        this.collect(id, claim.run_id, entry.abort.signal),
      );
    } catch (error) {
      failure = describe(error);
    } finally {
      clearTimeout(timer);
    }
    if (failure) this.recordFailure(id, claim, failure);
    else this.recordSuccess(id, claim);
  }
  // Attempts are claimed before any side effect. An exhausted record, a settled record, a
  // backoff window and an absent guest are all resolved here rather than retried.
  private claim(id: string): Claim | null {
    const w = this.store.get(id);
    if (w.state === "destroyed") return null;
    const f = w.finalization;
    if (!f) return null;
    if (!this.collectable(w)) {
      this.store.setFinalization(id, {
        state: "failed",
        error: "Worker VM is unavailable; there is no workspace to preserve",
        next_retry_at: null,
        completed_at: Date.now(),
      });
      return null;
    }
    if (f.attempts >= this.config.SWARMFORGE_FINALIZATION_MAX_ATTEMPTS) {
      this.store.setFinalization(id, {
        state: "failed",
        error:
          f.error ??
          "Artifact preservation exhausted its automatic attempts and retains the worker",
        next_retry_at: null,
        completed_at: Date.now(),
      });
      return null;
    }
    return this.store.claimFinalization(
      id,
      this.config.SWARMFORGE_FINALIZATION_MAX_ATTEMPTS,
    );
  }
  // Safe default collection plus everything the task declared. A full workspace snapshot is
  // opt-in: explicitly requested by an operator, or configured for failed tasks.
  private async collect(
    id: string,
    run_id: string | null,
    signal: AbortSignal,
  ) {
    const w = this.store.get(id);
    if (!this.collectable(w)) throw new Error("Worker VM is unavailable");
    for (const target of [...w.artifacts, ...defaultTargets]) {
      this.guard(signal);
      await this.target(id, run_id, target, signal);
    }
    if (w.snapshot_on_failure && w.state !== "completed") {
      this.guard(signal);
      await this.artifacts.snapshot(id, { signal, runId: run_id });
    }
    this.guard(signal);
    await this.artifacts.diagnostics(id, { signal, runId: run_id });
  }
  private guard(signal: AbortSignal) {
    if (signal.aborted) throw new Error("Artifact preservation was aborted");
  }
  private async target(
    id: string,
    run_id: string | null,
    target: ArtifactDeclaration,
    signal: AbortSignal,
  ) {
    const kind = await this.classify(id, target.path, signal);
    if (kind === "missing") {
      if (target.required)
        throw new Error(`Required artifact ${target.path} is missing`);
      return;
    }
    if (kind === "directory") {
      try {
        await this.artifacts.collectDirectory(id, target.path, {
          signal,
          runId: run_id,
        });
        return;
      } catch (error) {
        // A plain path may still name a file if the guest reported it as a directory.
        if (!notDirectoryPattern.test(describe(error))) throw error;
      }
    }
    await this.artifacts.preserve(id, target.path, {
      signal,
      runId: run_id,
      kind: "declared",
    });
  }
  private async classify(id: string, path: string, signal: AbortSignal) {
    try {
      await this.artifacts.listWorkerFiles(id, path, { signal });
      return "directory" as const;
    } catch (error) {
      const message = describe(error);
      if (missingPattern.test(message)) return "missing" as const;
      if (notDirectoryPattern.test(message)) return "file" as const;
      throw new Error(`Artifact ${path} could not be inspected: ${message}`);
    }
  }
  // Only the attempt that still owns the record may settle it, so an aborted, abandoned or
  // superseded collection can never mark a worker preserved.
  private current(f: WorkerFinalization | undefined, claim: Claim) {
    return (
      f !== undefined &&
      f.state === "collecting" &&
      f.run_id === claim.run_id &&
      f.attempts === claim.attempts
    );
  }
  private recordFailure(id: string, claim: Claim, reason: string) {
    if (!this.current(this.store.get(id).finalization, claim)) return;
    if (claim.attempts >= this.config.SWARMFORGE_FINALIZATION_MAX_ATTEMPTS) {
      // Retries are exhausted: the VM is retained, the record is terminal and visible, and a
      // deliberate retry remains available.
      this.store.setFinalization(id, {
        state: "failed",
        error: reason,
        next_retry_at: null,
        completed_at: Date.now(),
      });
      return;
    }
    const backoff =
      this.config.SWARMFORGE_FINALIZATION_RETRY_MS * 2 ** (claim.attempts - 1);
    this.store.setFinalization(
      id,
      {
        state: "pending",
        error: reason,
        next_retry_at: Date.now() + backoff,
        completed_at: null,
      },
      "finalization.attempt_failed",
    );
  }
  private recordSuccess(id: string, claim: Claim) {
    if (!this.current(this.store.get(id).finalization, claim)) return;
    this.store.setFinalization(id, {
      state: "preserved",
      error: null,
      next_retry_at: null,
      completed_at: Date.now(),
    });
  }
}

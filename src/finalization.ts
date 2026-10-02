import {
  type ArtifactEntry,
  type ArtifactListing,
  artifactErrorCode,
  artifactErrorCodes,
} from "./artifact-types";
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
// The data plane service bounds its own transfers, including direct API calls. What it cannot
// see is how many workers finalize at once, so this gate bounds concurrent finalizations. It
// cannot deadlock: a slot is only ever held by a finalization that waits on the service, and the
// service never waits on this gate.
export class FinalizationGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly limit: number) {}
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      if (signal.aborted) throw new Error("Artifact preservation was aborted");
      return await operation();
    } finally {
      // The slot is transferred, not recreated: the woken waiter already holds the reservation,
      // so counting it again here would inflate the gate and wedge it permanently.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
  private async acquire(signal: AbortSignal) {
    if (signal.aborted) throw new Error("Artifact preservation was aborted");
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // A queued finalization never waits on a worker that is being cancelled or destroyed, and an
    // aborted waiter leaves the queue by removing the very entry the releaser would hand to.
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== wake);
        reject(new Error("Artifact preservation was aborted"));
      };
      this.waiting.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
// The canonical result file the coordinator mirrors into the workspace, and the bound used both
// to capture it and to read it back for its run attribution.
const resultTarget = ".swarmforge/result.json";
const resultLimit = 65536;
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
// A persisted error is redacted against the project's full secret set and only then truncated:
// truncating first would leave a prefix of a long secret on disk, which the redactor can no longer
// recognise when the message is shown again.
const errorLimit = 500;
function makeDescribe(redact: (text: string) => string) {
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const safe = redact(message || "Unknown artifact error");
    return safe.length > errorLimit ? `${safe.slice(0, errorLimit)}...` : safe;
  };
}
// The data plane classifies captures with stable codes, so a path's kind never comes from English.
// A listing failure is still consulted once, because only an untyped transport cannot say whether
// an absent path and a non-directory leaf are the same thing.
const listingPage = 200;
// Backoff is capped so a long attempt schedule can never overflow the date budget or park a
// record beyond any sane horizon.
export const maxRetryDelay = 3600000;
export function retryDelay(config: Config, attempts: number) {
  const base = config.SWARMFORGE_FINALIZATION_RETRY_MS;
  const cap = Math.max(
    base,
    Math.min(config.SWARMFORGE_ARTIFACT_TIMEOUT_MS, maxRetryDelay),
  );
  // The exponent is clamped before the multiply, so the result is always a safe integer.
  const exponential = base * 2 ** Math.min(Math.max(attempts - 1, 0), 20);
  const delay = Math.min(exponential, cap);
  return Number.isSafeInteger(delay) && delay > 0 ? delay : base;
}

export class Finalizer {
  private runs = new Map<string, LiveRun>();
  // Listings are cached per attempt: the default targets share their parents, and one capture
  // run must not turn into a listing per declared path.
  private listings = new Map<
    string,
    { entries: ArtifactEntry[]; truncated: boolean }
  >();
  private readonly describe: (error: unknown) => string;
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly artifacts: ArtifactService,
    readonly gate: FinalizationGate,
    // The coordinator always supplies the project redactor; the identity default only keeps a
    // direct construction (a fixture, an integration probe) valid.
    redact: (text: string) => string = (text) => text,
  ) {
    this.describe = makeDescribe(redact);
  }
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
    // An attempt cancelled before it starts is not an attempt: nothing is persisted for it.
    if (entry.abort.signal.aborted) return;
    const claim = this.claim(id);
    if (!claim) return;
    const timer = setTimeout(
      () => entry.abort.abort(),
      this.config.SWARMFORGE_ARTIFACT_TIMEOUT_MS,
    );
    let failure: string | null = null;
    try {
      // The data plane service bounds its own transfers and applies its own timeout; the
      // attempt-level signal additionally bounds the listing that classifies a path.
      await this.gate.run(entry.abort.signal, () =>
        this.collect(id, claim.run_id, entry.abort.signal),
      );
    } catch (error) {
      failure = this.describe(error);
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
    // Listings never outlive an attempt: a retry must see the workspace as it is now.
    this.listings.clear();
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
        if (artifactErrorCode(error) !== artifactErrorCodes.notDirectory)
          throw error;
      }
    }
    // The kind is the data plane's own "file" for a regular file, deliberately: a declared path
    // and the automatic directory collection are then the same capture, so one worker, run,
    // path and content yields one record and one stored blob instead of a duplicate.
    const record = await this.artifacts.preserve(id, target.path, {
      signal,
      runId: run_id,
      kind: "file",
    });
    if (target.path === resultTarget) await this.checkResultRun(record, run_id);
  }
  // A preserved result file is only ever attributed to the run that produced it. A file naming a
  // different run is the previous run's bytes (a failed mirror, or a stale worker file), so the
  // attempt fails instead of reporting another run's answer as this run's.
  private async checkResultRun(
    record: { artifact_id: string },
    run_id: string | null,
  ) {
    // Streamed and bounded: the data plane keeps whole reads inside its safe window, and a
    // canonical result is well inside this one, so the attribution is read exactly.
    const bytes = await this.stored(record.artifact_id);
    let named: unknown;
    try {
      named = (
        JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as {
          run_id?: unknown;
        }
      ).run_id;
    } catch {
      // A result file that is not JSON, or one larger than the bounded window, is the worker's
      // own output rather than a stale canonical result.
      return;
    }
    if (typeof named === "string" && named !== run_id)
      throw new Error(
        `Result file ${resultTarget} belongs to run ${named}, not ${run_id ?? "an earlier run"}`,
      );
  }
  private async stored(artifact_id: string) {
    const stream = await this.artifacts.download(artifact_id);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > resultLimit) return null;
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  }
  private async listing(id: string, path: string, signal: AbortSignal) {
    const cached = this.listings.get(path);
    if (cached) return cached;
    const entries: ArtifactEntry[] = [];
    let truncated = false;
    for (let offset = 0; ; ) {
      const page: ArtifactListing = await this.artifacts.listWorkerFiles(
        id,
        path,
        {
          offset,
          limit: listingPage,
          signal,
        },
      );
      entries.push(...page.entries);
      truncated = truncated || page.truncated === true;
      if (page.next_offset === null) break;
      // A page cursor that does not advance, or more entries than the configured bound, is a
      // listing failure rather than a listing of this directory.
      if (
        page.next_offset <= offset ||
        entries.length > this.config.SWARMFORGE_ARTIFACT_MAX_ENTRIES
      )
        throw new Error(`Listing ${path} did not advance`);
      offset = page.next_offset;
    }
    const value = { entries, truncated };
    this.listings.set(path, value);
    return value;
  }
  private async classify(id: string, path: string, signal: AbortSignal) {
    try {
      await this.listing(id, path, signal);
      return "directory" as const;
    } catch (error) {
      // Only a type mismatch is ambiguous: some transports report an absent path and a
      // non-directory leaf identically, and one hop up decides that from a listing rather than
      // from English. Every other code is conclusive - an absence is an absence, and a symlink, a
      // permission refusal, a limit, a changed source or a transport failure is an error.
      const code = artifactErrorCode(error);
      if (code === artifactErrorCodes.notDirectory)
        return this.fromParent(id, path, signal);
      if (code === artifactErrorCodes.notFound) return "missing" as const;
      throw new Error(
        `Artifact path ${path} could not be inspected: ${this.describe(error)}`,
      );
    }
  }
  private async fromParent(id: string, path: string, signal: AbortSignal) {
    const parts = path.split("/");
    const name = parts.pop() ?? "";
    const parent = parts.join("/");
    let listing: { entries: ArtifactEntry[]; truncated: boolean };
    try {
      listing = await this.listing(id, parent, signal);
    } catch (error) {
      // The parent is absent, so the target is; anything else is a refusal worth reporting.
      if (artifactErrorCode(error) !== artifactErrorCodes.notFound) throw error;
      return "missing" as const;
    }
    if (listing.truncated)
      throw new Error(
        `Listing ${parent || "."} is truncated; absence of ${path} cannot be confirmed`,
      );
    const entry = listing.entries.find((item) => item.name === name);
    if (!entry) return "missing" as const;
    if (entry.kind === "directory") return "directory" as const;
    // A symlink or special file is never captured: it is treated as absent.
    return entry.kind === "file" ? ("file" as const) : ("missing" as const);
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
    const backoff = retryDelay(this.config, claim.attempts);
    // Not an outcome: the attempt already announced itself, and its error and retry time are
    // durable on the record, so only a settled collection emits an outcome event.
    this.store.setFinalization(id, {
      state: "pending",
      error: reason,
      next_retry_at: Date.now() + backoff,
      completed_at: null,
    });
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

import { createHash } from "node:crypto";
import { ArtifactService } from "./artifacts";
import type { Config } from "./config";
import {
  type AgentSnapshot,
  type CodingAgent,
  type Dispatch,
  finalizationSettled,
  lifecycleState,
  type ResponseExcerpt,
  resultSchema,
  type StateChange,
  type StateChangeFilter,
  type StateChangeResult,
  spawnSchema,
  terminal,
  type Worker,
  type WorkerProvider,
  type WorkerResult,
} from "./domain";
import {
  FinalizationGate,
  Finalizer,
  maxRetryDelay,
  sleep,
} from "./finalization";
import { GitHandoffError } from "./git-handoff";
import { inspectPersistence } from "./safety";
import { excerptText, redactorFor } from "./security";
import type { Store } from "./store";

const resultPath = ".swarmforge/result.json";
export class Coordinator {
  private readonly resultLimit = 65536;
  private locks = new Map<string, Promise<void>>();
  private steps = new Map<string, number>();
  private tearingDown = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  private lastReconcile = Date.now();
  private readonly finalizer: Finalizer;
  // The data plane service. It bounds its own transfers, so no second limit is layered here.
  readonly artifacts: ArtifactService;
  readonly inference = new Map<string, number>();
  readonly excerpts = new Map<string, ResponseExcerpt>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly provider: WorkerProvider,
    readonly agent: CodingAgent,
  ) {
    this.artifacts = new ArtifactService(config, store, provider);
    // Persisted artifact errors are redacted against the project's secrets before truncation.
    this.finalizer = new Finalizer(
      config,
      store,
      this.artifacts,
      new FinalizationGate(config.SWARMFORGE_ARTIFACT_CONCURRENCY),
      (text) => redactorFor(this).text(text),
    );
  }
  async bounded<T>(
    operation: Promise<T>,
    timeoutMs = this.config.SWARMFORGE_API_TIMEOUT_MS,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("External operation timed out")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  excerpt(id: string): ResponseExcerpt | null {
    return this.excerpts.get(id) ?? null;
  }
  // Waits on durable lifecycle events: no provider call, no polling and no worker lock,
  // so several callers and the coordinator tick can run at the same time.
  async waitForStateChange(
    filter: StateChangeFilter,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<StateChangeResult> {
    const wanted = filter.states?.length ? new Set(filter.states) : null;
    if (options.signal?.aborted)
      throw new Error("Wait aborted before it started");
    let cursor = filter.cursor ?? this.store.latestEventId();
    let notify: (() => void) | undefined;
    // Subscribe first, then scan: an event committed in between still reaches this waiter.
    const unsubscribe = this.store.subscribe(() => notify?.());
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      if (!options.signal) return;
      onAbort = () => resolve("aborted");
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = (change: StateChange | null): StateChangeResult => {
      if (!change) {
        return {
          changed: false,
          event_id: null,
          next_cursor: cursor,
          worker_id: null,
          team_id: null,
          task_id: null,
          vm_id: null,
          state: null,
          at: null,
        };
      }
      const w = this.store.get(change.worker_id);
      return {
        changed: true,
        event_id: change.event_id,
        next_cursor: change.event_id,
        worker_id: w.worker_id,
        team_id: w.team_id,
        task_id: w.task_id,
        vm_id: w.vm_id,
        state: change.state,
        at: change.at,
      };
    };
    // Non-matching events are consumed by moving the cursor past them, never returned.
    const next = (): StateChange | null => {
      while (true) {
        const events = this.store.lifecycleEvents(cursor, filter, 200);
        if (!events.length) return null;
        for (const event of events) {
          cursor = event.id;
          const state = lifecycleState(event.type);
          if (!state || (wanted && !wanted.has(state))) continue;
          return {
            event_id: event.id,
            worker_id: event.worker_id,
            state,
            at: event.at,
          };
        }
      }
    };
    const deadline = options.timeoutMs > 0 ? Date.now() + options.timeoutMs : 0;
    try {
      while (true) {
        const found = next();
        if (found) return result(found);
        if (deadline - Date.now() <= 0) return result(null);
        const wake = new Promise<"wake">((resolve) => {
          notify = () => resolve("wake");
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<"expired">((resolve) => {
          timer = setTimeout(() => resolve("expired"), deadline - Date.now());
        });
        let outcome: "expired" | "aborted" | "wake";
        try {
          outcome = await Promise.race([wake, expired, aborted]);
        } finally {
          clearTimeout(timer);
          notify = undefined;
        }
        // A timeout still reports the cursor reached, so the next wait resumes past it.
        if (outcome === "aborted") throw new Error("Wait aborted");
        if (outcome === "expired") {
          const last = next();
          return result(last);
        }
      }
    } finally {
      unsubscribe();
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  }
  spawn(input: unknown) {
    const parsed = spawnSchema.parse(input);
    const all = this.store.all();
    const retry =
      parsed.request_id &&
      all.some(
        (w) =>
          w.team_id === parsed.team_id && w.request_id === parsed.request_id,
      );
    if (
      !retry &&
      all.filter((w) => w.state === "queued").length >=
        this.config.SWARMFORGE_MAX_QUEUE
    )
      throw new Error("Creation queue full");
    return this.store.create({
      ...parsed,
      timeout_seconds:
        parsed.timeout_seconds ??
        this.config.SWARMFORGE_DEFAULT_TIMEOUT_SECONDS,
    });
  }
  message(id: string, message: string) {
    return this.store.db.transaction(() => this.queueMessage(id, message))();
  }
  private queueMessage(id: string, message: string) {
    const w = this.store.get(id);
    // Teardown cancels every dispatch it can see, so a message is refused both while one
    // runs and while its intent is already durable but not yet applied. This keeps
    // send_worker_message linearized: no run is ever acknowledged as "queued" and then
    // silently removed by a cancel, destroy or failure the caller did not order after it.
    if (
      this.tearingDown.has(id) ||
      w.intent === "cancel" ||
      w.intent === "destroy"
    )
      throw new Error(
        "Worker lifecycle operation in progress; retry the message",
      );
    if (w.state === "destroyed" || w.state === "cancelled" || w.vm_missing)
      throw new Error("Worker cannot receive messages in this state");
    if (!message.trim() || message.length > 32000)
      throw new Error("Message must contain 1–32000 characters");
    if (
      this.store
        .dispatches(id)
        .filter((d) => !["completed", "cancelled"].includes(d.state)).length >=
      100
    )
      throw new Error("Worker message queue full");
    if (w.state === "failed" || w.state === "recovery_required") {
      if (!w.vm_id || !w.opencode_session_id)
        throw new Error("Worker session unavailable");
      this.store.cancelDispatches(id);
    }
    const d = this.store.enqueue(id, message);
    if (
      w.state === "paused" &&
      w.previous_state &&
      terminal.has(w.previous_state)
    ) {
      if (w.previous_state === "cancelled")
        throw new Error("Cancelled worker cannot receive messages");
      this.store.patch(id, {
        previous_state: w.previous_state === "completed" ? "ready" : "booting",
        provision_started_at: Date.now(),
      });
    }
    if (["completed", "failed", "recovery_required"].includes(w.state))
      this.store.transition(id, w.state === "completed" ? "ready" : "booting", {
        completed_at: null,
        error: null,
        provision_started_at: Date.now(),
      });
    return {
      worker_id: id,
      run_id: d.run_id,
      state: this.store.get(id).state,
      delivery: "queued",
    };
  }
  private exclusive(id: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.locks.get(id);
    if (existing) return existing;
    this.steps.set(id, (this.steps.get(id) ?? 0) + 1);
    const running = fn().finally(() => this.locks.delete(id));
    this.locks.set(id, running);
    return running;
  }
  // A control intent is durable before this runs, so waiting on the worker lock can never lose
  // it: this loop re-steps until the step it awaits is the one that observed the intent. The
  // bound keeps a permanently busy worker from spinning, and the tick still applies the intent.
  private async applyIntent(id: string) {
    for (let guard = 0; guard < 8; guard++) {
      const before = this.steps.get(id) ?? 0;
      await this.exclusive(id, () => this.step(id));
      if ((this.steps.get(id) ?? 0) !== before) return;
      const w = this.store.get(id);
      if (!w.intent || w.state === "destroyed") return;
    }
  }
  async start() {
    await this.recover();
    this.timer = setInterval(
      () => void this.tick().catch(() => {}),
      this.config.SWARMFORGE_POLL_INTERVAL_MS,
    );
    await this.tick();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    // Bounded: an in-flight transfer is aborted and left retryable rather than waited on, and
    // it is awaited so it can never write to a closed store during shutdown.
    this.finalizer.abortAll();
    await Promise.allSettled([...this.locks.values()]);
    await Promise.allSettled(this.finalizer.liveRuns());
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastReconcile > 30000) {
        this.lastReconcile = Date.now();
        try {
          await this.recover();
        } catch {
          /* The next pass retries; existing workers retain their deadlines. */
        }
      }
      const all = this.store.all();
      let capacity = all.filter(
        (w) =>
          w.state !== "destroyed" &&
          ((w.vm_id && !w.vm_missing) ||
            ["provisioning", "booting"].includes(w.state)),
      ).length;
      let provisioning = all.filter((w) =>
        ["provisioning", "booting"].includes(w.state),
      ).length;
      for (const w of all) {
        if (
          w.state === "queued" &&
          !w.intent &&
          capacity < this.config.SWARMFORGE_MAX_WORKERS &&
          provisioning < this.config.SWARMFORGE_MAX_PROVISIONING
        ) {
          this.store.transition(w.worker_id, "provisioning", {
            provision_started_at: Date.now(),
          });
          capacity++;
          provisioning++;
        }
      }
      await Promise.allSettled(
        this.store
          .all()
          .filter(
            (w) =>
              w.intent ||
              (!terminal.has(w.state) &&
                w.state !== "paused" &&
                w.state !== "queued"),
          )
          .map((w) =>
            this.exclusive(w.worker_id, () => this.step(w.worker_id)),
          ),
      );
      // Preservation runs beside the lifecycle steps and holds no worker lock, so a slow or
      // failing collection can never delay provisioning, dispatch or another worker's step.
      for (const w of this.store.finalizing())
        void this.finalizer.run(w.worker_id).catch(() => {});
    } finally {
      this.ticking = false;
    }
  }
  async recover() {
    const vms = await this.bounded(this.provider.listWorkers());
    const all = this.store.all();
    const byId = new Map(all.map((w) => [w.worker_id, w]));
    for (const vm of vms) {
      const known =
        all.find((w) => w.vm_id === vm.id) ??
        (vm.worker_id ? byId.get(vm.worker_id) : undefined);
      if (known && (!known.vm_id || known.vm_id === vm.id)) {
        if (known.vm_missing)
          this.store.patch(known.worker_id, { vm_missing: false });
        if (!known.vm_id) {
          this.store.patch(known.worker_id, { vm_id: vm.id });
          if (["provisioning", "queued"].includes(known.state))
            this.store.transition(known.worker_id, "booting");
          else
            this.store.transition(known.worker_id, "recovery_required", {
              error: "Recovered VM after interrupted provisioning",
            });
        }
      } else {
        const orphan = this.store.create({
          team_id: "recovery",
          task_id: `orphan-${vm.id}`,
          role: "recovery",
          prompt: "Orphan retained for operator inspection",
          timeout_seconds: this.config.SWARMFORGE_DEFAULT_TIMEOUT_SECONDS,
          artifacts: [],
          snapshot_on_failure: false,
        });
        this.store.cancelDispatches(orphan.worker_id);
        this.store.transition(orphan.worker_id, "recovery_required", {
          vm_id: vm.id,
          error:
            "Untracked owned VM discovered; session credentials unavailable",
        });
      }
    }
    await Promise.all(
      this.store
        .all()
        .filter((w) => w.vm_id && w.state !== "destroyed")
        .map((record) =>
          this.exclusive(record.worker_id, async () => {
            let w = this.store.get(record.worker_id);
            if (!w.vm_id || w.state === "destroyed") return;
            const vm = await this.bounded(this.provider.getWorker(w.vm_id));
            w = this.store.get(record.worker_id);
            if (w.intent || w.state === "destroyed") return;
            if (!vm) {
              this.inference.delete(w.worker_id);
              this.excerpts.delete(w.worker_id);
              // Captured before the dispatches are cancelled: a cancelled dispatch no longer
              // resolves, and the preservation record must still name the run that was lost.
              const run = this.store.dispatch(w.worker_id)?.run_id ?? null;
              this.store.cancelDispatches(w.worker_id);
              // The lost VM is recorded as a preservation failure too, so an operator sees why
              // nothing could be salvaged instead of finding a silently absent workspace.
              this.store.settle(
                w.worker_id,
                "failed",
                {
                  error: "VM disappeared; local workspace is lost",
                  vm_missing: true,
                  deadline_at: null,
                  intent: null,
                },
                run,
              );
              return;
            }
            if (terminal.has(w.state)) return;
            if (
              ["paused", "pausing"].includes(vm.state) &&
              w.state !== "paused"
            )
              this.store.transition(w.worker_id, "paused", {
                previous_state: w.state,
                paused_at: Date.now(),
              });
            if (vm.state === "stopped" && !terminal.has(w.state))
              this.store.transition(w.worker_id, "recovery_required", {
                error: "VM stopped; inspect before resuming",
              });
          }),
        ),
    );
  }
  private async step(id: string) {
    let w = this.store.get(id);
    try {
      if (w.intent) {
        await this.applyControl(w);
        return;
      }
      if (
        ["provisioning", "booting"].includes(w.state) &&
        Date.now() - (w.provision_started_at ?? w.created_at) >
          this.config.SWARMFORGE_PROVISION_TIMEOUT_SECONDS * 1000
      ) {
        await this.fail(w, "Provisioning timed out");
        return;
      }
      if (w.deadline_at && Date.now() > w.deadline_at) {
        await this.fail(w, "Worker task timed out");
        return;
      }
      if (w.state === "provisioning") {
        const vm = await this.bounded(this.provider.createWorker(w));
        this.store.transition(id, "booting", { vm_id: vm.id, error: null });
        return;
      }
      if (w.state === "booting") {
        const endpoint = await this.bounded(
          this.provider.prepare(w),
          this.config.SWARMFORGE_GIT_PUSH_TIMEOUT_MS +
            this.config.SWARMFORGE_API_TIMEOUT_MS,
        );
        w = this.store.patch(id, { endpoint });
        const session = await this.bounded(this.agent.ensureSession(w));
        this.store.transition(id, "ready", {
          opencode_session_id: session,
          error: null,
        });
        return;
      }
      if (w.state === "ready") {
        // A new dispatch waits for the previous run's preservation to settle: collecting from a
        // workspace that is still being written would capture a torn snapshot.
        if (this.store.finalizationUnsettled(id)) return;
        const d = this.store.dispatch(id);
        if (d?.state === "pending") await this.deliver(w, d);
        else if (d) {
          w = this.store.transition(id, "running", {
            deadline_at: w.deadline_at ?? Date.now() + w.timeout_seconds * 1000,
          });
          await this.monitor(w);
        }
        return;
      }
      if (w.state === "running" || w.state === "waiting") {
        const vm = await this.bounded(this.provider.getWorker(w.vm_id!));
        if (!vm) {
          // The run is resolved before the dispatches are cancelled, for the same reason.
          const run = this.store.dispatch(id)?.run_id ?? null;
          this.store.settle(
            id,
            "failed",
            {
              error: "VM disappeared; local workspace is lost",
              vm_missing: true,
              deadline_at: null,
            },
            run,
          );
          this.store.cancelDispatches(id);
          return;
        }
        if (vm.state === "paused" || vm.state === "pausing") {
          this.store.transition(id, "paused", {
            previous_state: w.state,
            paused_at: Date.now(),
          });
          return;
        }
        if (vm.state === "stopped") {
          await this.fail(w, "Worker VM stopped");
          return;
        }
        await this.monitor(w);
      }
    } catch (error) {
      w = this.store.get(id);
      this.store.patch(id, {
        error:
          error instanceof GitHandoffError
            ? "Git branch push or verification failed; retrying within deadline"
            : "Provider or OpenCode operation failed; retrying within deadline",
      });
      if (error instanceof GitHandoffError) return;
      // A control operation owns this step: its failure must never be answered with a
      // completion or a result-file fallback for a turn the operator is cancelling or destroying.
      if (w.intent) return;
      if (w.state === "running" || w.state === "waiting") {
        const d = this.store.dispatch(id);
        if (d) {
          const fallback = await this.fallback(w, d);
          if (fallback) await this.complete(w, d, fallback);
        }
      }
    }
  }
  private async deliver(w: Worker, d: Dispatch) {
    // Persist dispatch intent first. Ambiguous submission after a crash is inspected, never blindly replayed.
    this.excerpts.delete(w.worker_id);
    this.store.claimDispatch(w, d);
    await this.bounded(this.agent.submit(this.store.get(w.worker_id), d));
    this.store.saveDispatch({ ...d, state: "sent", sent_at: Date.now() });
  }
  private async monitor(w: Worker) {
    const d = this.store.dispatch(w.worker_id);
    if (!d) {
      this.store.transition(w.worker_id, "waiting");
      return;
    }
    const snapshot = await this.bounded(this.agent.inspect(w));
    this.inference.set(w.worker_id, snapshot.inference_active);
    this.trackExcerpt(w, snapshot, d);
    for (const m of snapshot.messages)
      if (m.role === "assistant")
        this.store.usage(
          w.worker_id,
          m.id,
          m.model ?? this.config.SWARMFORGE_MODEL_NAME,
          m.input,
          m.output,
          m.reasoning,
          m.cache_read,
          m.cache_write,
        );
    // A turn settles only on a reported idle, which the adapter also produces for a session
    // /session/status no longer lists. A status it could not interpret stays unknown and
    // unsettled, and message history is an estimate, never a completion signal: a turn
    // interrupted by a restart, an OOM or an abort leaves a message with no completion.
    const settled = snapshot.status === "idle";
    if (d.state === "sending") {
      if (
        snapshot.messages.some(
          (m) => m.id === d.message_id || m.parent_id === d.message_id,
        )
      ) {
        this.store.saveDispatch({ ...d, state: "sent" });
      } else if (
        settled &&
        Date.now() - (d.sent_at ?? d.created_at) >
          this.config.SWARMFORGE_API_TIMEOUT_MS
      ) {
        this.store.transition(w.worker_id, "recovery_required", {
          error:
            "Prompt delivery ambiguous; inspect session before sending a follow-up",
          deadline_at: null,
        });
        return;
      }
    }
    const replies = snapshot.messages.filter(
      (m) =>
        m.role === "assistant" && m.parent_id === d.message_id && m.completed,
    );
    const reply =
      [...replies].reverse().find((m) => m.result !== undefined || m.error) ??
      replies.at(-1);
    if (settled && reply) {
      const parsed = resultSchema.safeParse(reply.result);
      const result = parsed.success
        ? this.identify(w, d, parsed.data)
        : await this.fallback(w, d);
      if (result) await this.complete(w, d, result);
      else
        await this.fail(
          w,
          reply.error
            ? `OpenCode session failed (${reply.error})`
            : "Missing or malformed structured result",
        );
      return;
    }
    if (settled) {
      const fallback = await this.fallback(w, d);
      if (fallback) {
        await this.complete(w, d, fallback);
        return;
      }
    }
    // Only a fresh inspect reaches this point, and only an unresolved dispatch.
    // A raised token total is the sole proven liveness signal; usage is max-upserted.
    const timeout = this.config.SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS;
    if (timeout > 0) {
      const current = this.store.recordProgress(
        w.worker_id,
        this.store.tokens({ worker_id: w.worker_id }).total,
      );
      const idle = Date.now() - (current.token_progress_at ?? Date.now());
      if (idle >= timeout * 1000) {
        await this.fail(
          current,
          `No token progress for ${Math.floor(idle / 1000)}s; worker quiesced`,
        );
        return;
      }
    }
    this.store.transition(
      w.worker_id,
      snapshot.status === "busy" ? "running" : "waiting",
      {
        error:
          snapshot.status === "retry" ? "OpenCode is retrying inference" : null,
      },
    );
  }
  // Live status only: reuse the polled snapshot, never re-query the provider, and keep nothing durable.
  private trackExcerpt(w: Worker, snapshot: AgentSnapshot, d: Dispatch) {
    const replies = snapshot.messages.filter(
      (m) => m.role === "assistant" && m.parent_id === d.message_id,
    );
    const latest = replies.at(-1);
    if (!latest) {
      this.excerpts.delete(w.worker_id);
      return;
    }
    if (!latest.text) {
      this.excerpts.delete(w.worker_id);
      return;
    }
    const redactor = redactorFor(this);
    const text = excerptText(latest.text, (value) => redactor.text(value));
    if (!text) {
      this.excerpts.delete(w.worker_id);
      return;
    }
    const partial = !latest.completed;
    const previous = this.excerpts.get(w.worker_id);
    if (previous?.text === text && previous.partial === partial) return;
    this.excerpts.set(w.worker_id, {
      text,
      at: Date.now(),
      partial,
    });
  }
  private identify(w: Worker, d: Dispatch, r: WorkerResult): WorkerResult {
    return {
      ...r,
      worker_id: w.worker_id,
      task_id: w.task_id,
      run_id: d.run_id,
    };
  }
  // Recovers a run's result file from the guest through the data plane capture, never through
  // a provider stat/read pair: the helper opens the path descriptor-relatively, the window is
  // bounded, and the staged bytes are verified against the digest it reported.
  private async fallback(w: Worker, d: Dispatch) {
    if (!w.vm_id || w.vm_missing) return null;
    try {
      const bytes = await this.bounded(
        this.readResultFile(w.worker_id, this.resultLimit + 1),
      );
      if (!bytes || bytes.byteLength > this.resultLimit) return null;
      const r = resultSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (r.run_id !== d.run_id || (r.worker_id && r.worker_id !== w.worker_id))
        return null;
      return this.identify(w, d, r);
    } catch {
      return null;
    }
  }
  private async readResultFile(workerId: string, limit: number) {
    const transfer = await this.artifacts.openLive(workerId, resultPath, {
      offset: 0,
      length: limit,
    });
    try {
      const reader = transfer.stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > limit) return null;
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      // A truncated or corrupted capture is not a result.
      if (createHash("sha256").update(bytes).digest("hex") !== transfer.sha256)
        return null;
      return bytes;
    } finally {
      await transfer.cleanup().catch(() => {});
    }
  }
  private async complete(w: Worker, d: Dispatch, r: WorkerResult) {
    this.inference.delete(w.worker_id);
    this.excerpts.delete(w.worker_id);
    r = resultSchema.parse(redactorFor(this).value(r));
    // Durable per run before the handoff can fail or time out: a worker that loses its branch
    // push still keeps the answer it produced, attributed to the run that produced it.
    this.store.recordResult(w.worker_id, d, r);
    if (this.config.SWARMFORGE_GIT_PUSH_MODE !== "none") {
      let pushed: Awaited<ReturnType<WorkerProvider["pushBranch"]>>;
      try {
        pushed = await this.bounded(
          this.provider.pushBranch(w),
          this.config.SWARMFORGE_GIT_PUSH_TIMEOUT_MS,
        );
      } catch {
        throw new GitHandoffError("Git branch push or verification failed");
      }
      r = { ...r, git: { ...r.git, ...pushed, persisted: true, dirty: false } };
      this.store.recordResult(w.worker_id, d, r);
    }
    // The mirror is written before the outcome settles, because finishing opens this run's
    // preservation: a collection that started first would otherwise capture the previous run's
    // result bytes and attribute them to this run. The canonical result is already durable in
    // SQLite, so a mirror failure still leaves the answer, and the collection then skips the
    // absent default instead of capturing a stale file.
    try {
      await this.bounded(
        this.provider.writeFile(
          w.vm_id!,
          `${this.config.SWARMFORGE_WORKSPACE}/.swarmforge/result.json`,
          JSON.stringify(r),
        ),
      );
    } catch {}
    this.store.finish(w.worker_id, d, r);
  }
  // "stopped": OpenCode generation is provably over (the service confirmed it down, or the
  // worker never had a guest). "paused": the guest is alive but not provably stopped, so it
  // is retained for inspection. "missing": the guest is confirmed absent, so nothing runs
  // and no local workspace survives; only a confirmed absence reaches this state, while a
  // probe that throws or still finds the VM stays "paused".
  private async quiesce(w: Worker): Promise<"stopped" | "paused" | "missing"> {
    if (!w.vm_id) return "stopped";
    try {
      await this.bounded(this.agent.abort(w));
    } catch {}
    try {
      const stopped = await this.bounded(
        this.provider.exec(
          w.vm_id,
          "systemctl stop swarmforge-opencode.service && ! systemctl is-active --quiet swarmforge-opencode.service",
        ),
      );
      if (stopped.code === 0) return "stopped";
    } catch {}
    try {
      // A successful VM pause also stops token generation, but Git inspection must not wake it.
      await this.bounded(this.provider.pauseWorker(w.vm_id));
      return "paused";
    } catch {}
    return (await this.vmMissing(w.vm_id)) ? "missing" : "paused";
  }
  // A guest can be deleted out of band between any two provider calls. Only the provider's
  // confirmed absence (getWorker answering null for a 404) is proof; a probe that throws or
  // that still finds the VM is ambiguous, so the VM is kept and the operation retried.
  private async vmMissing(id: string): Promise<boolean> {
    const probe = await this.bounded(this.provider.getWorker(id)).catch(
      () => undefined,
    );
    return probe === null;
  }
  // Teardown cancels every queued dispatch, so the worker is held for the whole window,
  // provider round-trips included, and send_worker_message rejects instead of racing it.
  private async teardown<T>(id: string, fn: () => Promise<T>): Promise<T> {
    this.tearingDown.set(id, (this.tearingDown.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const remaining = (this.tearingDown.get(id) ?? 1) - 1;
      if (remaining > 0) this.tearingDown.set(id, remaining);
      else this.tearingDown.delete(id);
    }
  }
  private async fail(w: Worker, reason: string) {
    await this.teardown(w.worker_id, async () => {
      this.inference.delete(w.worker_id);
      this.excerpts.delete(w.worker_id);
      // Captured before the dispatches are cancelled: the preservation record belongs to the run
      // that ended, and it is written in the same transaction as the outcome.
      const run = this.store.dispatch(w.worker_id)?.run_id ?? null;
      const outcome = await this.quiesce(w);
      if (outcome === "missing") {
        // The guest is gone, so retention protects nothing and reconciliation already owns
        // this outcome: fail the worker, record the lost VM and release its capacity.
        this.store.cancelDispatches(w.worker_id);
        this.store.settle(
          w.worker_id,
          "failed",
          {
            error: "VM disappeared; local workspace is lost",
            vm_missing: true,
            completed_at: Date.now(),
            deadline_at: null,
            intent: null,
          },
          run,
        );
        return;
      }
      const safety =
        outcome === "paused"
          ? { safe: false, reason: "VM paused after OpenCode stop failure" }
          : await this.bounded(
              inspectPersistence(
                this.provider,
                this.config,
                w,
                this.store.result(w.worker_id),
              ),
            ).catch(() => ({
              safe: false,
              reason: "Persistence check timed out",
            }));
      this.store.cancelDispatches(w.worker_id);
      this.store.settle(
        w.worker_id,
        w.vm_id && !safety.safe ? "recovery_required" : "failed",
        { error: reason, completed_at: Date.now(), deadline_at: null },
        run,
      );
    });
  }
  async control(
    id: string,
    intent: "pause" | "resume" | "cancel" | "destroy",
    force = false,
  ) {
    const w = this.store.get(id);
    if (w.state === "destroyed") {
      if (intent === "destroy") return w;
      throw new Error("Worker destroyed");
    }
    if (w.vm_missing && intent !== "destroy")
      throw new Error("Worker VM is missing");
    // Forced destruction is the escalation path: it supersedes a control that is stuck rather
    // than refusing, because an operator must always be able to reclaim a retained worker.
    const superseding = intent === "destroy" && force && Boolean(w.intent);
    if (w.intent && w.intent !== intent && !superseding)
      throw new Error("Another worker control operation is pending");
    if (intent === "resume" && w.state !== "paused")
      throw new Error("Worker is not paused");
    if (intent === "pause" && w.state === "paused") return w;
    if (superseding)
      this.store.event(id, "worker.control_superseded", {
        previous_intent: w.intent,
        intent,
      });
    // A force acknowledgement is sticky: a duplicate ordinary destroy that arrives while a forced
    // one is in flight may never downgrade it back to a checked destruction.
    const stick = w.intent === "destroy" && w.force_destroy;
    this.store.patch(id, {
      intent,
      force_destroy: force || stick,
    });
    await this.applyIntent(id);
    return this.store.get(id);
  }
  // Runs or joins preservation for a worker and resolves once its record has settled. Bounded by
  // the configured attempt, transfer and backoff budgets, so it never waits indefinitely.
  async finalize(id: string): Promise<Worker> {
    const { SWARMFORGE_ARTIFACT_TIMEOUT_MS: transfer } = this.config;
    const { SWARMFORGE_FINALIZATION_MAX_ATTEMPTS: attempts } = this.config;
    const { SWARMFORGE_FINALIZATION_RETRY_MS: retry } = this.config;
    // Bounded and always a safe integer: a long attempt schedule may not park a caller for days.
    const budget = Math.min(
      transfer * attempts + retry * attempts + 1000,
      maxRetryDelay,
    );
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      const w = this.store.get(id);
      const f = w.finalization;
      if (w.state === "destroyed" || !f || finalizationSettled.has(f.state))
        return w;
      const wait =
        f.state === "pending" && f.next_retry_at
          ? Math.min(
              Math.max(1, f.next_retry_at - Date.now()),
              deadline - Date.now(),
            )
          : 0;
      await this.finalizer.run(id);
      if (wait > 0) await sleep(wait);
    }
    return this.store.get(id);
  }
  private preservationSettled(w: Worker) {
    const f = w.finalization;
    if (!f) return false;
    if (f.state === "preserved" || f.state === "abandoned") return true;
    // A failed record with no collectable workspace has nothing left to lose, so it cannot
    // strand the worker. Any other failure retains the VM and blocks destruction.
    return f.state === "failed" && !this.finalizer.collectable(w);
  }
  // Normal destruction requires preservation to settle first. The wait is bounded; an unsettled
  // record keeps the VM and asks for inspection instead of deleting an unpreserved workspace.
  private async ensurePreserved(id: string) {
    // Destroying a worker that never settled still records what happened to its workspace:
    // an absent or confirmed-missing guest settles immediately as a recorded failure.
    if (!this.store.get(id).finalization)
      this.store.beginFinalization(id, this.store.dispatch(id)?.run_id ?? null);
    await this.finalize(id);
    return this.preservationSettled(this.store.get(id));
  }
  // Deliberate operator retry of an exhausted or interrupted preservation. The record is reset
  // only when it is safe to retry: a live collection, an explicit abandonment and a worker with
  // no workspace all refuse rather than reopening a settled decision.
  async retryFinalization(id: string): Promise<Worker> {
    const w = this.store.get(id);
    if (w.state === "destroyed") throw new Error("Worker destroyed");
    const f = w.finalization;
    if (!f) throw new Error("Worker has no artifact preservation to retry");
    if (f.state === "abandoned")
      throw new Error("Artifact preservation was explicitly abandoned");
    // Retrying preservation that already succeeded is a no-op, not a failure: the records it
    // produced are the answer, and a repeated retry must not duplicate them.
    if (f.state === "preserved") return w;
    if (!this.finalizer.collectable(w))
      throw new Error(
        "Worker VM is unavailable; there is no workspace to preserve",
      );
    if (this.finalizer.live(id))
      throw new Error("Artifact preservation is already running");
    // A deliberate retry supersedes a scheduled automatic one: attempts restart, the backoff is
    // cleared, and exactly one attempt runs now. Stacking is impossible because a worker has at
    // most one live collection.
    this.store.setFinalization(id, {
      state: "pending",
      attempts: 0,
      error: null,
      next_retry_at: null,
      completed_at: null,
    });
    // Exactly one deliberate attempt, bounded by the configured transfer timeout: the automatic
    // schedule keeps retrying in the background, so an operator call never blocks on a backoff.
    await this.finalizer.run(id);
    return this.store.get(id);
  }
  private async applyControl(w: Worker) {
    const id = w.worker_id;
    if (w.intent === "pause") {
      if (!w.vm_id) {
        this.store.transition(id, "paused", {
          previous_state: w.state,
          paused_at: Date.now(),
          intent: null,
        });
        return;
      }
      await this.bounded(this.provider.pauseWorker(w.vm_id));
      this.inference.delete(id);
      this.excerpts.delete(id);
      this.store.transition(id, "paused", {
        previous_state: w.state,
        paused_at: Date.now(),
        intent: null,
      });
      return;
    }
    if (w.intent === "resume") {
      if (w.vm_id) await this.bounded(this.provider.resumeWorker(w.vm_id));
      const elapsed = Date.now() - (w.paused_at ?? Date.now());
      this.store.transition(id, w.previous_state ?? "ready", {
        deadline_at: w.deadline_at ? w.deadline_at + elapsed : null,
        provision_started_at: w.provision_started_at
          ? w.provision_started_at + elapsed
          : null,
        token_progress_at: w.token_progress_at
          ? w.token_progress_at + elapsed
          : null,
        paused_at: null,
        intent: null,
      });
      this.store.event(id, "worker.resumed");
      return;
    }
    if (w.intent === "cancel") {
      await this.teardown(id, async () => {
        let missing = false;
        // Production stops first and never waits on preservation: a live collection is aborted so
        // it cannot keep pulling bytes from a guest that is being cancelled.
        this.finalizer.abort(id);
        const run = this.store.dispatch(id)?.run_id ?? null;
        if (w.vm_id) {
          // A paused guest has to run again before it can be stopped, and it may have been
          // deleted out of band. Only a confirmed absence settles the cancellation here; an
          // ambiguous resume keeps the VM and the intent for the next attempt.
          if (w.state === "paused") {
            try {
              await this.bounded(this.provider.resumeWorker(w.vm_id));
            } catch (error) {
              if (!(await this.vmMissing(w.vm_id))) throw error;
              missing = true;
            }
          }
          if (!missing && (await this.quiesce(w)) === "missing") missing = true;
        }
        this.inference.delete(id);
        this.excerpts.delete(id);
        this.store.cancelDispatches(id);
        this.store.settle(
          id,
          "cancelled",
          {
            deadline_at: null,
            completed_at: Date.now(),
            intent: null,
            ...(missing
              ? {
                  vm_missing: true,
                  error: "VM disappeared; local workspace is lost",
                }
              : {}),
          },
          run,
        );
      });
      return;
    }
    if (w.intent === "destroy") {
      await this.teardown(id, async () => {
        // Re-read after quiesce: a force acknowledgement may have arrived while this step ran,
        // and the destruction must act on the strongest request rather than a stale snapshot.
        const current = this.store.get(id);
        if (current.vm_id) {
          if (!current.force_destroy) {
            const vm = await this.bounded(
              this.provider.getWorker(current.vm_id),
            );
            if (vm) {
              if (["paused", "stopped"].includes(vm.state))
                await this.bounded(this.provider.resumeWorker(current.vm_id));
              const outcome = await this.quiesce(current);
              if (outcome === "missing")
                this.store.patch(id, { vm_missing: true });
              if (outcome === "paused") {
                this.store.transition(id, "recovery_required", {
                  intent: null,
                  deadline_at: null,
                  error:
                    "VM paused because OpenCode could not be stopped; inspect before destruction",
                });
                return;
              }
              // A guest confirmed gone leaves nothing to inspect or preserve, so the
              // retention checks below could only strand the worker; destruction is a no-op.
              if (outcome === "stopped") {
                // The handoff gate is about the run that is current, not an earlier run that
                // happened to succeed: the newest dispatch must itself have completed with a
                // verified handoff. A model-claimed "persisted" on an unfinished run never
                // satisfies it.
                const runs = this.store.dispatches(id);
                const latest = runs.at(-1);
                const verified =
                  latest !== undefined &&
                  latest.state === "completed" &&
                  this.store.result(id, latest.run_id)?.git?.persisted === true;
                if (
                  this.config.SWARMFORGE_GIT_PUSH_MODE !== "none" &&
                  (this.store.dispatch(id) || !verified)
                ) {
                  this.store.cancelDispatches(id);
                  this.store.transition(id, "recovery_required", {
                    intent: null,
                    deadline_at: null,
                    error:
                      "No verified branch handoff for this worker; inspect before destruction",
                  });
                  return;
                }
                const safety = await this.bounded(
                  inspectPersistence(
                    this.provider,
                    this.config,
                    w,
                    this.store.result(id),
                  ),
                );
                if (!safety.safe) {
                  this.store.cancelDispatches(id);
                  this.store.transition(id, "recovery_required", {
                    intent: null,
                    deadline_at: null,
                    error: safety.reason,
                  });
                  return;
                }
              }
              // Existing Git safety protections above stay in force; preservation is the
              // additional requirement that a settled workspace survives outside the guest. A
              // guest confirmed gone already recorded the lost workspace, so this settles
              // immediately as a recorded failure instead of retrying against nothing.
              if (!(await this.ensurePreserved(id))) {
                this.store.cancelDispatches(id);
                this.store.transition(id, "recovery_required", {
                  intent: null,
                  deadline_at: null,
                  error:
                    "Artifact preservation has not settled; retry it or destroy with force to abandon it",
                });
                return;
              }
            }
          } else {
            // Forced destruction: the live collection is aborted without waiting for the worker
            // lock, and the abandonment is durable before the provider deletes anything. A
            // record that already succeeded is never rewritten: preserved stays preserved.
            this.finalizer.abort(id);
            if (this.store.get(id).finalization?.state !== "preserved")
              this.store.setFinalization(id, {
                state: "abandoned",
                error: "Artifact preservation abandoned by forced destruction",
                next_retry_at: null,
                completed_at: Date.now(),
              });
          }
          await this.bounded(this.provider.destroyWorker(current.vm_id));
        }
        this.inference.delete(id);
        this.excerpts.delete(id);
        this.store.cancelDispatches(id);
        this.store.transition(id, "destroyed", {
          intent: null,
          deadline_at: null,
          completed_at: Date.now(),
          error: null,
        });
      });
    }
  }
}

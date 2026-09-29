import type { Config } from "./config";
import {
  type AgentSnapshot,
  type CodingAgent,
  type Dispatch,
  type ResponseExcerpt,
  resultSchema,
  spawnSchema,
  terminal,
  type Worker,
  type WorkerProvider,
  type WorkerResult,
} from "./domain";
import { GitHandoffError } from "./git-handoff";
import { inspectPersistence } from "./safety";
import { excerptText, redactorFor } from "./security";
import type { Store } from "./store";
export class Coordinator {
  private locks = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  private lastReconcile = Date.now();
  readonly inference = new Map<string, number>();
  readonly excerpts = new Map<string, ResponseExcerpt>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly provider: WorkerProvider,
    readonly agent: CodingAgent,
  ) {}
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
    if (
      w.state === "destroyed" ||
      w.intent === "destroy" ||
      w.state === "cancelled" ||
      w.vm_missing
    )
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
    const running = fn().finally(() => this.locks.delete(id));
    this.locks.set(id, running);
    return running;
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
    await Promise.allSettled([...this.locks.values()]);
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
              this.store.cancelDispatches(w.worker_id);
              this.store.transition(w.worker_id, "failed", {
                error: "VM disappeared; local workspace is lost",
                vm_missing: true,
                deadline_at: null,
                intent: null,
              });
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
          this.store.cancelDispatches(id);
          this.store.transition(id, "failed", {
            error: "VM disappeared; local workspace is lost",
            vm_missing: true,
            deadline_at: null,
          });
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
    if (d.state === "sending") {
      if (
        snapshot.messages.some(
          (m) => m.id === d.message_id || m.parent_id === d.message_id,
        )
      ) {
        this.store.saveDispatch({ ...d, state: "sent" });
      } else if (
        snapshot.status === "idle" &&
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
    if (snapshot.status === "idle" && reply) {
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
    if (snapshot.status === "idle") {
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
  private async fallback(w: Worker, d: Dispatch) {
    try {
      const bytes = await this.bounded(
        this.provider.readFile(
          w.vm_id!,
          `${this.config.SWARMFORGE_WORKSPACE}/.swarmforge/result.json`,
          0,
          65537,
        ),
      );
      if (bytes.length > 65536) return null;
      const r = resultSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (r.run_id !== d.run_id || (r.worker_id && r.worker_id !== w.worker_id))
        return null;
      return this.identify(w, d, r);
    } catch {
      return null;
    }
  }
  private async complete(w: Worker, d: Dispatch, r: WorkerResult) {
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
    }
    this.inference.delete(w.worker_id);
    this.excerpts.delete(w.worker_id);
    r = resultSchema.parse(redactorFor(this).value(r));
    this.store.finish(w.worker_id, d, r);
    // Canonical result is now durable in SQLite even if the best-effort mirror fails.
    try {
      await this.bounded(
        this.provider.writeFile(
          w.vm_id!,
          `${this.config.SWARMFORGE_WORKSPACE}/.swarmforge/result.json`,
          JSON.stringify(r),
        ),
      );
    } catch {}
  }
  private async quiesce(w: Worker): Promise<boolean> {
    if (!w.vm_id) return true;
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
      if (stopped.code === 0) return true;
    } catch {}
    // A successful VM pause also stops token generation, but Git inspection must not wake it.
    await this.bounded(this.provider.pauseWorker(w.vm_id));
    return false;
  }
  private async fail(w: Worker, reason: string) {
    this.inference.delete(w.worker_id);
    this.excerpts.delete(w.worker_id);
    const stopped = await this.quiesce(w);
    const safety = !stopped
      ? { safe: false, reason: "VM paused after OpenCode stop failure" }
      : await this.bounded(
          inspectPersistence(
            this.provider,
            this.config,
            w,
            this.store.result(w.worker_id),
          ),
        ).catch(() => ({ safe: false, reason: "Persistence check timed out" }));
    this.store.cancelDispatches(w.worker_id);
    this.store.transition(
      w.worker_id,
      w.vm_id && !safety.safe ? "recovery_required" : "failed",
      { error: reason, completed_at: Date.now(), deadline_at: null },
    );
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
    if (w.intent && w.intent !== intent)
      throw new Error("Another worker control operation is pending");
    if (intent === "resume" && w.state !== "paused")
      throw new Error("Worker is not paused");
    if (intent === "pause" && w.state === "paused") return w;
    this.store.patch(id, { intent, force_destroy: force });
    await this.exclusive(id, () => this.step(id));
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
      if (w.vm_id) {
        if (w.state === "paused")
          await this.bounded(this.provider.resumeWorker(w.vm_id));
        await this.quiesce(w);
      }
      this.inference.delete(id);
      this.excerpts.delete(id);
      this.store.cancelDispatches(id);
      this.store.transition(id, "cancelled", {
        deadline_at: null,
        completed_at: Date.now(),
        intent: null,
      });
      return;
    }
    if (w.intent === "destroy") {
      if (w.vm_id) {
        if (!w.force_destroy) {
          const vm = await this.bounded(this.provider.getWorker(w.vm_id));
          if (vm) {
            if (["paused", "stopped"].includes(vm.state))
              await this.bounded(this.provider.resumeWorker(w.vm_id));
            if (!(await this.quiesce(w))) {
              this.store.transition(id, "recovery_required", {
                intent: null,
                deadline_at: null,
                error:
                  "VM paused because OpenCode could not be stopped; inspect before destruction",
              });
              return;
            }
            if (
              this.config.SWARMFORGE_GIT_PUSH_MODE !== "none" &&
              (this.store.dispatch(id) ||
                !this.store.result(id)?.git?.persisted)
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
        }
        await this.bounded(this.provider.destroyWorker(w.vm_id));
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
    }
  }
}

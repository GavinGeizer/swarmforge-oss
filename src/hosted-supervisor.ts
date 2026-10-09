import { randomUUID } from "node:crypto";
import type { Config } from "./config";
import type { Coordinator } from "./coordinator";
import {
  HostedApiError,
  type HostedTask,
  type LeaseReply,
  remainingAuthorityMs,
  type SupervisorClient,
} from "./hosted-client";
import { hostedCredentialExpired } from "./hosted-credentials";
import type {
  ControlledAgent,
  ControlledProcessProvider,
} from "./hosted-runtime";
import {
  HOSTED_MONO_ORIGIN,
  type HostedMapping,
  type HostedStore,
} from "./hosted-store";
import type { Store } from "./store";

export interface SupervisorCredentialView {
  credential: string;
  supervisor_id: string;
  tenant_id: string;
  expires_at: number;
  authorization_expires_at: number;
}

export interface HostedSupervisorOptions {
  config: Config;
  store: Store;
  coordinator: Coordinator;
  provider: ControlledProcessProvider;
  agent: ControlledAgent;
  client: SupervisorClient;
  hostedStore: HostedStore;
  supervisorCredential: () => SupervisorCredentialView;
  safetyMarginMs?: number;
  minLifetimeMs?: number;
}

function taskIdSafe(task: { task_id: string }): string {
  return task.task_id;
}

export interface ActiveRun {
  mapping: HostedMapping;
  task: HostedTask;
  authorityMs: number;
  startedAt: number;
  completion: Promise<"completed" | "failed" | "cancelled">;
  leaseDeadlineMonoMs: number;
  absoluteDeadlineMonoMs: number;
}

/**
 * Real durable hosted supervisor adapter over the existing Coordinator+Store.
 * Claim -> persist SQLite mapping -> ack -> start. The worker cannot run
 * before cloud ACK: local state is staged paused/queued and the atomic
 * mapping precedes any execution. Restart inspects the same mapping/runtime;
 * ambiguous start remains held and never blindly calls spawn or re-exec.
 */
export class HostedSupervisor {
  private runs = new Map<string, ActiveRun>();
  private renewTimers = new Map<string, Timer>();
  private watchdogs = new Map<string, Timer>();
  private finishRuns = new Map<
    string,
    (outcome: "completed" | "failed" | "cancelled") => void
  >();
  private renewalOperations = new Set<Promise<unknown>>();
  private stopOperations = new Map<string, Promise<HostedMapping>>();
  constructor(private readonly options: HostedSupervisorOptions) {}

  private credential(): SupervisorCredentialView {
    const credential = this.options.supervisorCredential();
    if (hostedCredentialExpired(credential))
      throw new Error(
        "Supervisor credential is expired; refusing execution and renewal.",
      );
    return credential;
  }

  /** Single claim cycle: returns the claimed task or null when no work. */
  async claimOnce(idempotencyKey = randomUUID()): Promise<HostedTask | null> {
    this.credential();
    let reply: Awaited<ReturnType<SupervisorClient["claim"]>>;
    try {
      reply = await this.options.client.claim(idempotencyKey);
    } catch (e) {
      if (e instanceof HostedApiError && e.status === 401)
        throw new Error("Supervisor credential is invalid or revoked.");
      throw e;
    }
    if (!reply.task) return null;
    const task = reply.task;
    if (task.tenant_id !== this.options.client.tenantId)
      throw new Error("Cross-tenant claim response; refusing to execute.");
    if (task.execution_class !== "controlled")
      throw new Error(
        "Forbidden workload: only controlled execution is allowed.",
      );
    if (task.supervisor_id !== this.credential().supervisor_id) {
      // Assigned to another supervisor: hold capacity, do not execute.
      return null;
    }
    const preassigned = `pending-${task.task_id}`;
    const { mapping, created } = this.options.hostedStore.claimMapping({
      task_id: task.task_id,
      tenant_id: task.tenant_id,
      worker_id: task.worker_id,
      local_worker_id: preassigned,
      lease_id: task.lease_id ?? randomUUID(),
      fence: task.fence,
      supervisor_id: task.supervisor_id ?? this.credential().supervisor_id,
      reservation_id: task.reservation_id,
      stop_confirmed: false,
      consumed_runtime_ms: 0,
      idempotency_key: idempotencyKey,
      rotation_key: null,
      settlement_key: null,
      runtime_budget_ms: task.runtime_ms,
    });
    void created;
    // Bind the canonical Store worker id once the local worker exists so the
    // durable row always resolves to a real worker; until then the pending
    // placeholder keeps the task/lease/fence reservation without executing.
    if (mapping.local_worker_id === preassigned) {
      try {
        const canonical = this.options.store.queryWorkers({
          task_id: task.task_id,
        }).workers[0]?.worker_id;
        if (canonical && canonical !== preassigned) {
          this.options.hostedStore.rebindLocalWorker(task.task_id, canonical);
        }
      } catch {}
    }
    return task;
  }

  /** Ack a claimed task, compute monotonic authority, stage and start locally. */
  async ackAndStart(
    task: HostedTask,
    ackKey = randomUUID(),
  ): Promise<ActiveRun> {
    this.credential();
    // The claim-time row uses a pending placeholder (no local worker may run
    // before cloud ACK); resolve or stage the canonical worker here.
    let mapping = this.options.hostedStore.get(task.task_id);
    if (!mapping) {
      mapping = this.options.hostedStore.claimMapping({
        task_id: task.task_id,
        tenant_id: task.tenant_id,
        worker_id: task.worker_id,
        local_worker_id: `pending-${task.task_id}`,
        lease_id: task.lease_id ?? randomUUID(),
        fence: task.fence,
        supervisor_id: task.supervisor_id ?? this.credential().supervisor_id,
        reservation_id: task.reservation_id,
        stop_confirmed: false,
        consumed_runtime_ms: 0,
        idempotency_key: ackKey,
        rotation_key: null,
        settlement_key: null,
        runtime_budget_ms: task.runtime_ms,
      }).mapping;
    }
    if (!task.lease_id)
      throw new Error("Claim without lease; holding without execution.");
    if (
      mapping.tenant_id !== task.tenant_id ||
      mapping.worker_id !== task.worker_id ||
      mapping.supervisor_id !== task.supervisor_id ||
      mapping.reservation_id !== task.reservation_id ||
      mapping.lease_id !== task.lease_id ||
      mapping.fence !== task.fence
    )
      throw new Error(
        "Claim conflicts with the durable task binding; holding without execution.",
      );
    // Full actual ACK RTT measured AFTER the await with the monotonic clock:
    // clock jumps cannot extend authority, and a delayed response (server_time
    // captured before transport delay) shortens authority or rejects start.
    const ackStartMono = performance.now();
    let reply: LeaseReply;
    try {
      reply = await this.options.client.ack(
        task.task_id,
        { lease_id: task.lease_id, fence: task.fence },
        ackKey,
      );
    } catch (e) {
      if (e instanceof HostedApiError && [401, 409].includes(e.status)) {
        this.options.hostedStore.markStopIntended(task.task_id);
        throw new Error("Ack denied; durable stop intent recorded.");
      }
      // Network failure: ambiguous start remains held, never blindly re-exec.
      this.options.hostedStore.markHeld(task.task_id);
      throw e;
    }
    if (
      reply.task.task_id !== task.task_id ||
      reply.task.tenant_id !== task.tenant_id ||
      reply.task.lease_id !== task.lease_id ||
      reply.task.fence !== task.fence ||
      reply.task.worker_id !== task.worker_id ||
      reply.task.reservation_id !== task.reservation_id ||
      reply.task.supervisor_id !== this.credential().supervisor_id ||
      reply.task.execution_class !== "controlled" ||
      reply.task.state !== "running"
    )
      throw new Error(
        "Ack binds a different task/tenant/lease; refusing to execute.",
      );
    if (reply.task.lease_expires_at === null)
      throw new Error("Ack without lease expiry; holding without execution.");
    if (reply.directive === "stop") {
      this.options.hostedStore.markStopIntended(task.task_id);
      throw new Error(
        "Server orders stop before start; holding without execution.",
      );
    }
    const authorityObservedMonoMs = performance.now();
    const rtt = Math.max(0, Math.ceil(authorityObservedMonoMs - ackStartMono));
    const authority = remainingAuthorityMs({
      leaseExpiresAt: reply.task.lease_expires_at,
      deadlineAt: reply.task.deadline_at,
      serverTime: reply.server_time,
      requestRttMs: rtt,
      safetyMarginMs: this.options.safetyMarginMs ?? 2000,
    });
    const minimum = this.options.minLifetimeMs ?? 5000;
    if (!Number.isSafeInteger(authority) || authority < minimum)
      throw new Error("Too little remaining authority; refusing to start.");
    const duration = reply.task.controlled_duration_ms;
    const absoluteAuthority = remainingAuthorityMs({
      leaseExpiresAt: reply.task.deadline_at,
      deadlineAt: reply.task.deadline_at,
      serverTime: reply.server_time,
      requestRttMs: rtt,
      safetyMarginMs: this.options.safetyMarginMs ?? 2000,
    });
    const absoluteDeadlineMonoMs = authorityObservedMonoMs + absoluteAuthority;
    void mapping;
    // B duplicate-task fix: durable start-right-once CAS grant AFTER the
    // server ack but BEFORE any staging/spawn. Granted exactly once per
    // task/lease/fence via an atomic conditional UPDATE; duplicate acks —
    // even after child exit or restart, even with the same lease/fence —
    // are rejected here and never reach spawn. No exact-once promise beyond
    // this gate: only proven-never-started rows can ever hold the right.
    mapping = this.options.hostedStore.grantStartRight(task.task_id, {
      lease_id: task.lease_id,
      fence: task.fence,
    });
    // D4: anchor staging at the ACK authority observation. The durable grant
    // and all staging (Store create, pause verify, vm handle) consume authority; the final
    // budget subtracts the full elapsed staging immediately before start and
    // refuses when insufficient — a slow staging path cannot overrun the lease.
    const stagingStartMonoMs = authorityObservedMonoMs;

    // Stage local worker BEFORE execution: create via the real Store in a
    // paused intent so the Coordinator can never dispatch model work, then
    // record acknowledgement in the durable mapping. The Store assigns the
    // canonical worker id (w-...); the durable mapping binds it so restart
    // recovery resolves the same row.
    const store = this.options.store;
    // A placeholder row means the canonical worker is not staged yet: create
    // it now via the real Store (idempotent request_id) and bind the mapping.
    let localWorkerId = mapping.local_worker_id;
    if (localWorkerId === `pending-${task.task_id}`) {
      const created = store.create({
        team_id: "hosted",
        task_id: task.task_id,
        role: "hosted-controlled",
        prompt: "hosted controlled inert probe",
        timeout_seconds: Math.max(1, Math.ceil(authority / 1000)),
        request_id: `hosted-${task.task_id}`,
      });
      localWorkerId = created.worker_id;
      mapping = this.options.hostedStore.rebindLocalWorker(
        task.task_id,
        localWorkerId,
      );
    }
    const local: { worker_id: string } = { worker_id: localWorkerId };
    // Hold uncertain state: pause intent so no Coordinator step dispatches work
    // before the cloud ACK is durable. Verify the ACTUAL post-state is paused:
    // a swallowed pause failure must never allow an uncontrolled dispatch.
    // A queued worker that the Coordinator pauses without a VM is supported
    // (applyControl pauses VM-less workers directly); a worker that is not
    // paused afterwards blocks the start.
    await this.options.coordinator
      .control(local.worker_id, "pause")
      .catch((e) => {
        throw new Error(
          `Hosted staging pause failed; refusing start. ${(e as Error).message}`,
        );
      });
    const pausedState = this.options.store.get(local.worker_id);
    if (pausedState.state !== "paused" || pausedState.intent !== null) {
      throw new Error(
        `Hosted staging not paused (state=${pausedState.state}); refusing start.`,
      );
    }
    this.assertNoUncontrolledDispatch(local.worker_id);
    // The CAS grant above already transitioned mapped -> acknowledged
    // atomically; re-read the granted row instead of a second transition.
    const acknowledged = this.options.hostedStore.get(task.task_id);
    if (acknowledged?.state !== "acknowledged")
      throw new Error(
        "Hosted start right lost before staging; refusing start.",
      );
    // Actual runtime start (real inert subprocess) only after durable ACK.
    // The local worker must carry a vm handle: create the VM record first via
    // the real provider, then start the controlled subprocess.
    const worker = store.get(local.worker_id);
    if (!worker.vm_id) {
      const vm = await this.options.provider.createWorker(worker);
      store.patch(worker.worker_id, { vm_id: vm.id });
    }
    const staged = store.get(local.worker_id);
    // Re-check the gate immediately before process start: an injected
    // stopping/error/tick between staging and start must not dispatch or
    // start uncontrolled work.
    this.assertNoUncontrolledDispatch(local.worker_id);
    const pausedAgain = store.get(local.worker_id);
    if (pausedAgain.state !== "paused" || pausedAgain.intent !== null) {
      throw new Error(
        `Hosted worker left paused state before start (state=${pausedAgain.state}); refusing start.`,
      );
    }
    this.credential();
    // D4: re-budget immediately before start — subtract the staging that
    // already elapsed (monotonic) plus a final safety margin, and refuse when
    // the remainder cannot cover a minimal useful execution.
    const stagingElapsedMs = Math.max(
      0,
      performance.now() - stagingStartMonoMs,
    );
    const startBudgetMs = Math.floor(
      authority - stagingElapsedMs - (this.options.safetyMarginMs ?? 2000) / 2,
    );
    if (startBudgetMs < Math.min(1000, duration))
      throw new Error(
        "Hosted staging consumed the remaining authority; refusing start.",
      );
    // The requested workload remains whole across renewable leases. A short
    // first lease cannot shorten the workload and then claim completion.
    if (
      duration > reply.task.runtime_ms ||
      duration > absoluteDeadlineMonoMs - performance.now()
    )
      throw new Error(
        "Too little absolute task authority for the full controlled duration; refusing start.",
      );
    const launchDurationMs = duration;
    // Fail-closed journal: BOTH the on-spawn hook and the post-spawn persist
    // must succeed. A DB-write failure after process start stops the runtime
    // at once and holds — never a running unjournaled process.
    let journaled = false;
    const journalStart = (record: {
      startedAtMonoMs: number;
      durationMs: number;
      pid: number;
      starttime: string;
      exe: string;
      bootId?: string;
    }) => {
      this.options.hostedStore.markRuntimeStarted(task.task_id, {
        startedAtMonoMs: record.startedAtMonoMs,
        monoOrigin: HOSTED_MONO_ORIGIN,
        durationMs: record.durationMs,
        pid: record.pid,
        starttime: record.starttime,
        exe: record.exe,
        bootId: record.bootId,
      });
      journaled = true;
    };
    this.options.provider.onSpawn = (vmId, record) => {
      journalStart(record);
      void vmId;
    };
    const completion = new Promise<"completed" | "failed" | "cancelled">(
      (resolve) => {
        this.finishRuns.set(task.task_id, resolve);
      },
    );
    const spawnStartedMonoMs = performance.now();
    try {
      await this.options.provider.startControlled(
        staged,
        launchDurationMs,
        (code) => {
          this.options.agent.completeSession(staged);
          const finish = this.finishRuns.get(task.task_id);
          // A requested stop resolves cancelled before any signal. Only a
          // natural child exit may produce completed.
          finish?.(
            code === 0 && performance.now() - spawnStartedMonoMs >= duration
              ? "completed"
              : "failed",
          );
        },
      );
      const vmNow = store.get(local.worker_id).vm_id;
      const rec = vmNow ? this.options.provider.recordFor(vmNow) : null;
      if (rec && !journaled) journalStart(rec);
      if (!journaled)
        throw new Error("Hosted launch journal missing after start.");
    } catch (error) {
      try {
        await this.options.provider.stopWorkerRuntime(staged);
      } catch {}
      this.finishRuns.get(task.task_id)?.("failed");
      this.finishRuns.delete(task.task_id);
      this.options.hostedStore.markHeldUnknown(taskIdSafe(task));
      throw new Error(
        `Hosted launch journal failed; runtime stop attempted and held. ${(error as Error).message}`,
      );
    } finally {
      this.options.provider.onSpawn = null;
    }
    const running: ActiveRun = {
      mapping: this.options.hostedStore.updateLease(
        task.task_id,
        { lease_id: task.lease_id, fence: task.fence },
        "running",
      ),
      task: reply.task,
      authorityMs: launchDurationMs,
      startedAt: Date.now(),
      completion,
      leaseDeadlineMonoMs: spawnStartedMonoMs + startBudgetMs,
      absoluteDeadlineMonoMs: Math.min(
        absoluteDeadlineMonoMs,
        spawnStartedMonoMs + reply.task.runtime_ms,
      ),
    };
    void acknowledged;
    this.runs.set(task.task_id, running);
    // The child owns its workload duration. This independent authority
    // watchdog leaves room for natural exit while stopping at the lease
    // budget even when startup, renewal or IPC is delayed.
    this.armLeaseWatchdog(task.task_id, running.leaseDeadlineMonoMs);
    // Renew the current lease before its authority expires. The child's
    // absolute workload duration and task deadline never move.
    this.scheduleRenew(
      task.task_id,
      running.leaseDeadlineMonoMs - performance.now(),
    );
    return running;
  }

  private armLeaseWatchdog(taskId: string, deadlineMonoMs: number): void {
    const previous = this.watchdogs.get(taskId);
    if (previous) clearTimeout(previous);
    const watchdog = setTimeout(
      () => {
        void this.stopAndConfirm(taskId, "watchdog deadline").catch(() => {});
      },
      Math.max(0, deadlineMonoMs - performance.now()),
    );
    watchdog.unref?.();
    this.watchdogs.set(taskId, watchdog);
  }

  private scheduleRenew(taskId: string, authorityMs: number): void {
    const existing = this.renewTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(1, Math.floor(authorityMs / 2));
    const timer = setTimeout(() => {
      const operation = this.renewOnce(taskId).catch(() =>
        this.stopAndConfirm(taskId, "renewal failed").catch(() => {}),
      );
      this.renewalOperations.add(operation);
      void operation.finally(() => this.renewalOperations.delete(operation));
    }, delay);
    timer.unref?.();
    this.renewTimers.set(taskId, timer);
  }

  async renewOnce(
    taskId: string,
    renewKey = randomUUID(),
  ): Promise<LeaseReply> {
    this.credential();
    const mapping = this.options.hostedStore.get(taskId);
    if (!mapping) throw new Error("Unknown hosted task; refusing renewal.");
    let reply: LeaseReply;
    const startedMonoMs = performance.now();
    try {
      reply = await this.options.client.renew(
        taskId,
        { lease_id: mapping.lease_id, fence: mapping.fence },
        renewKey,
      );
    } catch (e) {
      // Failed heartbeat/network/401/409/stale fence: durable stop intent,
      // hold the uncertain reservation, retry settlement later with same key.
      const latest = this.options.hostedStore.get(taskId);
      if (latest && !latest.stop_confirmed)
        this.options.hostedStore.markStopIntended(taskId);
      throw e;
    }
    if (this.options.hostedStore.get(taskId)?.stop_confirmed)
      throw new Error(
        "Renewal arrived after independently confirmed stop; refusing to reopen task.",
      );
    if (
      reply.task.fence !== mapping.fence ||
      reply.task.lease_id !== mapping.lease_id ||
      reply.task.task_id !== mapping.task_id ||
      reply.task.tenant_id !== mapping.tenant_id ||
      reply.task.worker_id !== mapping.worker_id ||
      reply.task.supervisor_id !== mapping.supervisor_id ||
      reply.task.reservation_id !== mapping.reservation_id
    ) {
      this.options.hostedStore.markStopIntended(taskId);
      throw new Error("Stale fence on renew; recording stop intent.");
    }
    if (
      reply.directive === "stop" ||
      reply.task.state === "stop_requested" ||
      reply.task.state === "cancelled"
    ) {
      this.options.hostedStore.markStopIntended(taskId);
      await this.stopAndConfirm(taskId, "server stop directive");
      return reply;
    }
    const running = this.runs.get(taskId);
    if (
      !running ||
      this.options.hostedStore.get(taskId)?.state !== "running" ||
      performance.now() >= running.leaseDeadlineMonoMs
    )
      throw new Error(
        "Renewal arrived after local stop or authority expiry; refusing to restart.",
      );
    if (
      reply.task.state !== "running" ||
      reply.task.lease_expires_at === null ||
      reply.task.deadline_at !== running.task.deadline_at ||
      reply.task.runtime_ms !== running.task.runtime_ms ||
      reply.task.controlled_duration_ms !== running.task.controlled_duration_ms
    )
      throw new Error("Renewal changes the fixed task authority; refusing.");
    const remaining = remainingAuthorityMs({
      leaseExpiresAt: reply.task.lease_expires_at,
      deadlineAt: reply.task.deadline_at,
      serverTime: reply.server_time,
      requestRttMs: Math.ceil(performance.now() - startedMonoMs),
      safetyMarginMs: this.options.safetyMarginMs ?? 2000,
    });
    if (remaining <= 0)
      throw new Error("Renewal provides no remaining authority; refusing.");
    this.credential();
    this.options.hostedStore.updateLease(
      taskId,
      { lease_id: mapping.lease_id, fence: mapping.fence },
      "running",
    );
    running.leaseDeadlineMonoMs = Math.min(
      performance.now() + remaining,
      running.absoluteDeadlineMonoMs,
    );
    this.armLeaseWatchdog(taskId, running.leaseDeadlineMonoMs);
    this.scheduleRenew(taskId, running.leaseDeadlineMonoMs - performance.now());
    return reply;
  }

  /**
   * Independently confirmed stop: provider stopWorkerRuntime must verify exit.
   * A Coordinator cancelled/paused label alone is never accepted as proof.
   */
  stopAndConfirm(taskId: string, reason: string): Promise<HostedMapping> {
    const pending = this.stopOperations.get(taskId);
    if (pending) return pending;
    const operation = this.performStop(taskId, reason);
    this.stopOperations.set(taskId, operation);
    void operation.then(
      () => this.stopOperations.delete(taskId),
      () => this.stopOperations.delete(taskId),
    );
    return operation;
  }

  private async performStop(
    taskId: string,
    reason: string,
  ): Promise<HostedMapping> {
    const mapping = this.options.hostedStore.get(taskId);
    if (!mapping) throw new Error("Unknown hosted task; refusing stop.");
    if (mapping.stop_confirmed) {
      this.clearTaskTimers(taskId);
      return mapping;
    }
    this.finishRuns.get(taskId)?.("cancelled");
    this.options.hostedStore.markStopIntended(taskId);
    // Placeholder rows (never staged, no process ever started): there is no
    // runtime to stop, but without durable proof the row must stay HELD, not
    // be marked stopped/released. Only a row that provably never started
    // (no pid, no start time, still in mapped/held) may settle as zero-use.
    const staged = !mapping.local_worker_id.startsWith("pending-");
    if (!staged) {
      if (
        !mapping.start_right_granted &&
        mapping.child_pid === null &&
        mapping.runtime_started_at_mono_ms === null &&
        mapping.runtime_mono_origin === "unknown" &&
        (mapping.state === "mapped" || mapping.state === "held")
      ) {
        // Provably never started (no pid, no start, origin unknown): zero-use
        // stop is safe without a monotonic measurement.
        return this.options.hostedStore.markStoppedZeroUse(
          taskId,
          mapping.settlement_key ?? randomUUID(),
        );
      }
      this.options.hostedStore.markHeldUnknown(taskId);
      throw new Error(
        `Controlled stop uncertain (${reason}); no staged runtime, holding reservation.`,
      );
    }
    // Best-effort Coordinator cancel, then verified OS-level runtime stop.
    // The Coordinator label is never proof.
    try {
      await this.options.coordinator.control(mapping.local_worker_id, "cancel");
    } catch {}
    let local: { worker_id: string } | null = null;
    try {
      local = this.options.store.get(mapping.local_worker_id);
    } catch {
      local = null;
    }
    if (!local) {
      // Canonical local row missing: the runtime is UNKNOWN, not stopped.
      // Never release on map/row absence. If a durable pid exists, prove OS
      // exit via stopPidWithProof; otherwise hold with conservative budget.
      const record =
        mapping.child_pid !== null &&
        mapping.child_starttime !== null &&
        mapping.child_exe !== null &&
        mapping.runtime_duration_ms !== null
          ? {
              pid: mapping.child_pid,
              starttime: mapping.child_starttime,
              exe: mapping.child_exe,
              bootId: mapping.child_boot_id ?? undefined,
              startedAtMonoMs: mapping.runtime_started_at_mono_ms ?? 0,
              durationMs: mapping.runtime_duration_ms,
            }
          : null;
      if (record) {
        const vmId =
          mapping.local_worker_id.startsWith("w-") ||
          mapping.local_worker_id.startsWith("pending-")
            ? `controlled-${mapping.local_worker_id}`
            : mapping.local_worker_id;
        try {
          await this.options.provider.stopPidWithProof(vmId, record);
        } catch (e) {
          this.options.hostedStore.markHeldUnknown(taskId);
          throw new Error(
            `Controlled stop uncertain (${reason}); holding reservation. ${(e as Error).message}`,
          );
        }
        // D2: canonical row missing means this process never observed the
        // start — the persisted clock is foreign. Settle conservatively with
        // the reserved budget + unknown flag instead of a fake measurement.
        this.clearTaskTimers(taskId);
        return this.options.hostedStore.markStoppedConservative(
          taskId,
          mapping.settlement_key ?? randomUUID(),
        );
      }
      this.options.hostedStore.markHeldUnknown(taskId);
      throw new Error(
        `Controlled stop uncertain (${reason}); canonical row missing, holding reservation.`,
      );
    }
    // Resolve the durable pid record for cross-provider proof (D3: full
    // OS start identity required before any signal).
    const vmId =
      (local as { vm_id?: string | null }).vm_id ??
      `controlled-${mapping.local_worker_id}`;
    const record =
      mapping.child_pid !== null &&
      mapping.child_starttime !== null &&
      mapping.child_exe !== null &&
      mapping.runtime_duration_ms !== null
        ? {
            pid: mapping.child_pid,
            starttime: mapping.child_starttime,
            exe: mapping.child_exe,
            bootId: mapping.child_boot_id ?? undefined,
            startedAtMonoMs: mapping.runtime_started_at_mono_ms ?? 0,
            durationMs: mapping.runtime_duration_ms,
          }
        : this.options.provider.recordFor(vmId);
    if (!record) {
      this.options.hostedStore.markHeldUnknown(taskId);
      throw new Error(
        `Controlled stop uncertain (${reason}); no durable pid record, holding reservation.`,
      );
    }
    try {
      // Prefer the live-handle path when this provider owns the child, else
      // prove OS exit from the durable pid (restart / fresh provider).
      const live = this.options.provider.recordFor(vmId);
      if (live) {
        await this.options.provider.stopWorkerRuntime(
          local as Parameters<
            ControlledProcessProvider["stopWorkerRuntime"]
          >[0],
        );
      } else {
        await this.options.provider.stopPidWithProof(vmId, record);
      }
    } catch (e) {
      // Uncertain stop: hold the reservation with conservative budget, never settle.
      this.options.hostedStore.markHeldUnknown(taskId);
      throw new Error(
        `Controlled stop uncertain (${reason}); holding reservation. ${(e as Error).message}`,
      );
    }
    this.clearTaskTimers(taskId);
    // D2: measured ELAPSED EXECUTION only when the persisted start carries a
    // proven same-process monotonic origin. A foreign/persisted start from a
    // prior process (or unknown origin) can NEVER be subtracted from this
    // process clock — hold with the conservative reserved budget instead.
    if (
      mapping.runtime_mono_origin !== HOSTED_MONO_ORIGIN ||
      mapping.runtime_started_at_mono_ms === null
    ) {
      return this.options.hostedStore.markStoppedConservative(
        taskId,
        mapping.settlement_key ?? randomUUID(),
      );
    }
    const elapsed = Math.max(
      0,
      performance.now() - mapping.runtime_started_at_mono_ms,
    );
    return this.options.hostedStore.markStopped(
      taskId,
      { elapsedMs: elapsed, monoOrigin: HOSTED_MONO_ORIGIN },
      mapping.settlement_key ?? randomUUID(),
    );
  }

  private clearTaskTimers(taskId: string): void {
    for (const map of [this.renewTimers, this.watchdogs]) {
      const timer = map.get(taskId);
      if (timer) clearTimeout(timer);
      map.delete(taskId);
    }
    this.runs.delete(taskId);
    this.finishRuns.delete(taskId);
  }

  /**
   * Fail-closed gate: the staged worker must be paused with no live
   * in-flight dispatch before the controlled process may start. The
   * Store.create enqueue leaves one `pending` dispatch that the Coordinator
   * would deliver as model work — the hosted path never delivers it: cancel
   * it durably here so no uncontrolled dispatch can exist at start. Any other
   * live state (sending/sent) or a non-pause intent blocks the start.
   * Test hook: throws when an injected stopping/error/tick raced staging.
   */
  private assertNoUncontrolledDispatch(localWorkerId: string): void {
    const worker = this.options.store.get(localWorkerId);
    if (worker.intent && worker.intent !== "pause") {
      throw new Error(
        `Hosted worker has pending ${worker.intent} intent; refusing uncontrolled start.`,
      );
    }
    const live = this.options.store.dispatch(localWorkerId);
    if (live && live.state === "pending") {
      // The hosted controlled worker never takes the Coordinator dispatch
      // path: retire the queued model dispatch so step() can never deliver
      // uncontrolled work to this worker.
      this.options.store.saveDispatch({ ...live, state: "cancelled" });
    }
    const remaining = this.options.store.dispatch(localWorkerId);
    if (remaining && !["completed", "cancelled"].includes(remaining.state)) {
      throw new Error(
        `Hosted worker has live dispatch ${remaining.state}; refusing uncontrolled start.`,
      );
    }
  }

  /** Settle only after independently confirmed stop, with the same key. */
  async settle(
    taskId: string,
    outcome: "completed" | "failed" | "cancelled",
    settlementKey?: string,
  ): Promise<HostedTask> {
    this.credential();
    const mapping = this.options.hostedStore.get(taskId);
    if (!mapping) throw new Error("Unknown hosted task; refusing settlement.");
    if (!mapping.stop_confirmed)
      throw new Error("Settlement requires independently confirmed stop.");
    const previous = this.options.hostedStore.settlementIntent(taskId);
    const key =
      settlementKey ?? previous?.key ?? mapping.settlement_key ?? randomUUID();
    if (
      previous &&
      (previous.key !== key ||
        previous.outcome !== outcome ||
        previous.lease_id !== mapping.lease_id ||
        previous.fence !== mapping.fence ||
        previous.task_id !== mapping.task_id ||
        previous.tenant_id !== mapping.tenant_id ||
        previous.worker_id !== mapping.worker_id ||
        previous.reservation_id !== mapping.reservation_id ||
        previous.supervisor_id !== mapping.supervisor_id)
    )
      throw new Error(
        "Frozen settlement intent conflicts with a different payload or key.",
      );
    const intent =
      previous ??
      this.options.hostedStore.freezeSettlement(taskId, outcome, key);
    if (intent.supervisor_id !== this.credential().supervisor_id)
      throw new Error("Frozen settlement belongs to a different supervisor.");
    // Only a successful response to THIS exact-key request is a receipt.
    // A 409 followed by terminal status is insufficient consumption evidence.
    try {
      const settled = await this.options.client.settle(
        taskId,
        {
          lease_id: intent.lease_id,
          fence: intent.fence,
          outcome: intent.outcome,
          stop_confirmed: true,
          consumed_runtime_ms: intent.consumed_runtime_ms,
        },
        intent.key as `${string}-${string}-${string}-${string}-${string}`,
      );
      if (
        settled.task_id !== intent.task_id ||
        settled.tenant_id !== intent.tenant_id ||
        settled.worker_id !== intent.worker_id ||
        settled.reservation_id !== intent.reservation_id ||
        settled.supervisor_id !== intent.supervisor_id ||
        settled.lease_id !== intent.lease_id ||
        settled.fence !== intent.fence ||
        settled.state !== intent.outcome
      )
        throw new Error(
          "Settlement receipt does not bind the frozen request; holding.",
        );
      this.options.hostedStore.rememberIdempotentResponse(
        intent.key,
        {
          tenant_id: intent.tenant_id,
          principal: intent.supervisor_id,
          resource: intent.task_id,
          operation: "settle",
          fingerprint: intent.fingerprint,
        },
        settled,
      );
      this.options.hostedStore.markSettled(taskId);
      return settled;
    } catch (error) {
      this.options.hostedStore.markHeld(taskId);
      throw error;
    }
  }

  /**
   * Restart recovery: hold ambiguity (never blindly re-exec). Trusted
   * stop/settlement reconciliation runs explicitly via reconcile().
   * blindly re-exec), then rows with a durable pid record get a durable
   * verified stop attempt, and stopped rows are settled with the SAME
   * idempotency key. Returns held vs reconciled task ids — never
   * held-forever without attempting trusted stop/settlement.
   */
  recover(): { held: string[]; running: string[] } {
    const held: string[] = [];
    const running: string[] = [];
    for (const mapping of this.options.hostedStore.all()) {
      if (["settled"].includes(mapping.state)) continue;
      // Every non-settled mapping is held after a restart: a crash between
      // local mapping, runtime start, ack and completion can never be told
      // apart from here, so ambiguous starts remain held and never blindly
      // call spawn or re-exec. Trusted stop reconciliation happens explicitly.
      if (mapping.state !== "held") {
        try {
          this.options.hostedStore.markHeld(mapping.task_id);
        } catch {}
      }
      held.push(mapping.task_id);
      void running;
    }
    return { held, running };
  }

  /**
   * Restart reconciliation: retry durable verified stop + same-key settlement
   * for held/stopped rows instead of reporting held-forever. Rows whose
   * runtime cannot be proven stopped stay held with the conservative budget.
   */
  async reconcile(
    options: { settleOutcome?: "completed" | "failed" | "cancelled" } = {},
  ): Promise<{ stopped: string[]; settled: string[]; held: string[] }> {
    const outcome = options.settleOutcome ?? "cancelled";
    const stopped: string[] = [];
    const settled: string[] = [];
    const held: string[] = [];
    for (const mapping of this.options.hostedStore.all()) {
      if (["settled"].includes(mapping.state)) continue;
      if (
        mapping.state !== "held" &&
        mapping.state !== "stop_intended" &&
        mapping.state !== "stopped"
      ) {
        try {
          this.options.hostedStore.markHeld(mapping.task_id);
        } catch {}
      }
      if (mapping.stop_confirmed) {
        try {
          await this.settle(
            mapping.task_id,
            this.options.hostedStore.settlementIntent(mapping.task_id)
              ?.outcome ?? outcome,
          );
          settled.push(mapping.task_id);
        } catch {
          held.push(mapping.task_id);
        }
        continue;
      }
      try {
        await this.stopAndConfirm(mapping.task_id, "restart reconcile");
        stopped.push(mapping.task_id);
      } catch {
        held.push(mapping.task_id);
        continue;
      }
      try {
        await this.settle(
          mapping.task_id,
          this.options.hostedStore.settlementIntent(mapping.task_id)?.outcome ??
            outcome,
        );
        settled.push(mapping.task_id);
      } catch {
        held.push(mapping.task_id);
      }
    }
    return { stopped, settled, held };
  }

  /** Close owned journal after all timers and local child stop attempts finish. */
  async close(): Promise<void> {
    try {
      for (const taskId of [...this.runs.keys()])
        await this.stopAndConfirm(taskId, "shutdown").catch(() => {});
      await Promise.allSettled([...this.renewalOperations]);
    } finally {
      for (const taskId of new Set([
        ...this.renewTimers.keys(),
        ...this.watchdogs.keys(),
      ]))
        this.clearTaskTimers(taskId);
      this.options.hostedStore.close();
    }
  }

  get activeRuns(): ReadonlyMap<string, ActiveRun> {
    return this.runs;
  }
}

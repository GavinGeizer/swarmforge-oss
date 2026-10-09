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
import type { HostedMapping, HostedStore } from "./hosted-store";
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
      }).mapping;
    }
    if (!task.lease_id)
      throw new Error("Claim without lease; holding without execution.");
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
      reply.task.fence !== task.fence
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
    const rtt = Math.max(0, Math.ceil(performance.now() - ackStartMono));
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
    const duration = Math.min(authority, reply.task.controlled_duration_ms);
    void mapping;
    // D4: monotonic staging clock starts AFTER the ack await. All staging
    // (Store create, pause verify, vm handle) consumes authority; the final
    // budget subtracts the full elapsed staging immediately before start and
    // refuses when insufficient — a slow staging path cannot overrun the lease.
    const stagingStartMonoMs = performance.now();

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
    const acknowledged = this.options.hostedStore.updateLease(
      task.task_id,
      { lease_id: task.lease_id, fence: task.fence },
      "acknowledged",
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
    // D4: re-budget immediately before start — subtract the staging that
    // already elapsed (monotonic) plus a final safety margin, and refuse when
    // the remainder cannot cover a minimal useful execution.
    const stagingElapsedMs = Math.max(
      0,
      performance.now() - stagingStartMonoMs,
    );
    const startBudgetMs = Math.floor(
      duration - stagingElapsedMs - (this.options.safetyMarginMs ?? 2000) / 2,
    );
    if (startBudgetMs < Math.min(1000, duration))
      throw new Error(
        "Hosted staging consumed the remaining authority; refusing start.",
      );
    const launchDurationMs = Math.min(duration, Math.max(1, startBudgetMs));
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
    }) => {
      this.options.hostedStore.markRuntimeStarted(task.task_id, {
        startedAtMonoMs: record.startedAtMonoMs,
        monoOrigin: "spawn-process",
        durationMs: record.durationMs,
        pid: record.pid,
        starttime: record.starttime,
        exe: record.exe,
      });
      journaled = true;
    };
    this.options.provider.onSpawn = (vmId, record) => {
      journalStart(record);
      void vmId;
    };
    this.options.provider.startControlled(staged, launchDurationMs, () => {
      this.options.agent.completeSession(staged);
    });
    this.options.provider.onSpawn = null;
    // Persist actual start even if the hook raced: resolve from the provider.
    // Any DB-write failure here is fatal to the launch: stop the runtime
    // immediately and hold instead of running unjournaled.
    try {
      const vmNow = store.get(local.worker_id).vm_id;
      const rec = vmNow ? this.options.provider.recordFor(vmNow) : null;
      if (rec && !journaled) journalStart(rec);
      if (!journaled)
        throw new Error("Hosted launch journal missing after start.");
    } catch (e) {
      try {
        await this.options.provider.stopWorkerRuntime(staged);
      } catch {}
      this.options.hostedStore.markHeldUnknown(taskIdSafe(task));
      throw new Error(
        `Hosted launch journal failed; runtime stopped and held. ${(e as Error).message}`,
      );
    }
    const running: ActiveRun = {
      mapping: this.options.hostedStore.updateLease(
        task.task_id,
        { lease_id: task.lease_id, fence: task.fence },
        "running",
      ),
      task: reply.task,
      authorityMs: duration,
      startedAt: Date.now(),
    };
    void acknowledged;
    this.runs.set(task.task_id, running);
    // Independent watchdog: stops the child at the duration deadline even if
    // renewal/parent IPC fails.
    const watchdog = setTimeout(() => {
      void this.stopAndConfirm(task.task_id, "watchdog deadline").catch(
        () => {},
      );
    }, duration);
    watchdog.unref?.();
    this.watchdogs.set(task.task_id, watchdog);
    // Renewal only refreshes the same task/lease/fence; absolute runtime never extends.
    this.scheduleRenew(task.task_id, duration);
    return running;
  }

  private scheduleRenew(taskId: string, authorityMs: number): void {
    const existing = this.renewTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(1000, Math.floor(authorityMs / 2));
    const timer = setTimeout(() => {
      void this.renewOnce(taskId).catch((e) => {
        if (
          /stop intent|revoked|expired|denied|lease/i.test((e as Error).message)
        ) {
          void this.stopAndConfirm(taskId, "renewal failed").catch(() => {});
        }
      });
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
    try {
      reply = await this.options.client.renew(
        taskId,
        { lease_id: mapping.lease_id, fence: mapping.fence },
        renewKey,
      );
    } catch (e) {
      // Failed heartbeat/network/401/409/stale fence: durable stop intent,
      // hold the uncertain reservation, retry settlement later with same key.
      this.options.hostedStore.markStopIntended(taskId);
      throw e;
    }
    if (
      reply.task.fence !== mapping.fence ||
      reply.task.lease_id !== mapping.lease_id
    )
      throw new Error("Stale fence on renew; recording stop intent.");
    if (
      reply.directive === "stop" ||
      reply.task.state === "stop_requested" ||
      reply.task.state === "cancelled"
    ) {
      this.options.hostedStore.markStopIntended(taskId);
      await this.stopAndConfirm(taskId, "server stop directive");
      return reply;
    }
    this.options.hostedStore.updateLease(
      taskId,
      { lease_id: mapping.lease_id, fence: mapping.fence },
      "running",
    );
    return reply;
  }

  /**
   * Independently confirmed stop: provider stopWorkerRuntime must verify exit.
   * A Coordinator cancelled/paused label alone is never accepted as proof.
   */
  async stopAndConfirm(taskId: string, reason: string): Promise<HostedMapping> {
    const mapping = this.options.hostedStore.get(taskId);
    if (!mapping) throw new Error("Unknown hosted task; refusing stop.");
    this.options.hostedStore.markStopIntended(taskId);
    // Placeholder rows (never staged, no process ever started): there is no
    // runtime to stop, but without durable proof the row must stay HELD, not
    // be marked stopped/released. Only a row that provably never started
    // (no pid, no start time, still in mapped/held) may settle as zero-use.
    const staged = !mapping.local_worker_id.startsWith("pending-");
    if (!staged) {
      if (
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
        this.options.hostedStore.markHeldUnknown(taskId);
        throw new Error(
          `Controlled stop uncertain (${reason}); canonical row missing, stopped via pid proof but holding with reserved budget.`,
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
      mapping.runtime_mono_origin !== "spawn-process" ||
      mapping.runtime_started_at_mono_ms === null
    ) {
      this.options.hostedStore.markHeldUnknown(taskId);
      throw new Error(
        `Controlled stop uncertain (${reason}); foreign monotonic origin, holding with reserved budget.`,
      );
    }
    const elapsed = Math.max(
      0,
      performance.now() - mapping.runtime_started_at_mono_ms,
    );
    return this.options.hostedStore.markStopped(
      taskId,
      { elapsedMs: elapsed, monoOrigin: "spawn-process" },
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
    const key = (settlementKey ??
      mapping.settlement_key ??
      randomUUID()) as `${string}-${string}-${string}-${string}-${string}`;
    const settled = await this.options.client.settle(
      taskId,
      {
        lease_id: mapping.lease_id,
        fence: mapping.fence,
        outcome,
        stop_confirmed: true,
        consumed_runtime_ms: mapping.consumed_runtime_ms,
      },
      key,
    );
    this.options.hostedStore.rememberIdempotentResponse(
      key,
      {
        tenant_id: mapping.tenant_id,
        principal: this.credential().supervisor_id,
        resource: taskId,
        operation: "settle",
        fingerprint: `${mapping.lease_id}:${mapping.fence}:${outcome}`,
      },
      settled,
    );
    this.options.hostedStore.markSettled(taskId);
    return settled;
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
      if (mapping.state === "stopped") {
        try {
          await this.settle(mapping.task_id, outcome);
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
        await this.settle(mapping.task_id, outcome);
        settled.push(mapping.task_id);
      } catch {
        held.push(mapping.task_id);
      }
    }
    return { stopped, settled, held };
  }

  get activeRuns(): ReadonlyMap<string, ActiveRun> {
    return this.runs;
  }
}

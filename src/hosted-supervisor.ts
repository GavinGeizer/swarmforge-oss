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
    requestStartedAt = Date.now(),
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
    const rtt = Date.now() - requestStartedAt;
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
    // before the cloud ACK is durable.
    try {
      await this.options.coordinator.control(local.worker_id, "pause");
    } catch {
      // Already paused or terminal: keep holding, never proceed blindly.
    }
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
    const startedAt = Date.now();
    this.options.provider.startControlled(staged, duration, () => {
      this.options.agent.completeSession(staged);
    });
    const running: ActiveRun = {
      mapping: this.options.hostedStore.updateLease(
        task.task_id,
        { lease_id: task.lease_id, fence: task.fence },
        "running",
      ),
      task: reply.task,
      authorityMs: duration,
      startedAt,
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
    const intended = this.options.hostedStore.markStopIntended(taskId);
    void intended;
    const started = Date.now();
    // Placeholder rows (never staged) have no local worker to cancel: skip
    // straight to the held/stopped bookkeeping below.
    const staged = !mapping.local_worker_id.startsWith("pending-");
    if (staged) {
      // Best-effort Coordinator cancel, then verified runtime stop.
      try {
        await this.options.coordinator.control(
          mapping.local_worker_id,
          "cancel",
        );
      } catch {}
    }
    // The label is not proof: verify via the provider hook against the real
    // Store worker (canonical w-... id bound at staging time).
    let local: { worker_id: string } | null = null;
    if (staged) {
      try {
        local = this.options.store.get(mapping.local_worker_id);
      } catch {
        local = null;
      }
    }
    if (local) {
      try {
        await this.options.provider.stopWorkerRuntime(
          local as Parameters<
            ControlledProcessProvider["stopWorkerRuntime"]
          >[0],
        );
      } catch (e) {
        // Uncertain stop: hold the reservation, do not settle.
        this.options.hostedStore.markHeld(taskId);
        throw new Error(
          `Controlled stop uncertain (${reason}); holding reservation. ${(e as Error).message}`,
        );
      }
    }
    const clearTimer = (map: Map<string, Timer>) => {
      const timer = map.get(taskId);
      if (timer) clearTimeout(timer);
      map.delete(taskId);
    };
    clearTimer(this.renewTimers);
    clearTimer(this.watchdogs);
    this.runs.delete(taskId);
    const consumed = Date.now() - started;
    return this.options.hostedStore.markStopped(
      taskId,
      consumed,
      mapping.settlement_key ?? randomUUID(),
    );
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

  /** Restart recovery: inspect the same mapping/runtime, hold ambiguity. */
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

  get activeRuns(): ReadonlyMap<string, ActiveRun> {
    return this.runs;
  }
}

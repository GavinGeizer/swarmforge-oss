import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { type Config, loadConfig } from "../config";
import { Coordinator } from "../coordinator";
import { HostedTaskClient, SupervisorClient } from "../hosted-client";
import {
  hostedSupervisorCredentialPath,
  hostedTaskCredentialPath,
  readHostedSupervisorCredential,
  readHostedTaskCredential,
} from "../hosted-credentials";
import { ControlledAgent, ControlledProcessProvider } from "../hosted-runtime";
import { ensurePrivateHostedPath, HostedStore } from "../hosted-store";
import { HostedSupervisor } from "../hosted-supervisor";
import { Store } from "../store";
import { type HostedCommand, UsageError } from "./arguments";

export { type HostedCommand, parseHostedArgs } from "./arguments";

import { chmodSync } from "node:fs";

export interface HostedRuntimeDeps {
  config: Config;
  store: Store;
  coordinator: Coordinator;
  provider?: ControlledProcessProvider;
  agent?: ControlledAgent;
  hostedStore?: HostedStore;
  /** Test seam: inject clients instead of constructing from credentials. */
  taskClient?: HostedTaskClient;
  supervisorClient?: SupervisorClient;
}

/**
 * Stable non-memory default for the durable hosted mapping: beside the
 * supervisor credential file (`<credentials>.state.sqlite`), overridable via
 * --state-path or SWARMFORGE_HOSTED_STATE_PATH. Never :memory: in production
 * factory use — a restart must recover the same task/lease/fence mapping.
 */
export function hostedSupervisorStatePath(
  statePath: string | undefined,
  supervisorCredentialsPath: string,
): string {
  if (
    statePath !== undefined &&
    (statePath === ":memory:" || statePath.trim() === "")
  )
    throw new UsageError(
      "hosted --state-path must be a durable file path, never :memory:.",
    );
  const explicit =
    statePath ?? process.env.SWARMFORGE_HOSTED_STATE_PATH ?? null;
  if (explicit) {
    if (explicit === ":memory:")
      throw new UsageError(
        "hosted --state-path must be a durable file path, never :memory:.",
      );
    return resolve(explicit);
  }
  return resolve(`${supervisorCredentialsPath}.state.sqlite`);
}

/**
 * Factory: builds a working HostedSupervisor from private credential/state
 * paths. Reads credentials via the approved private helper, enforces tenant
 * binding and expiry, and wires real Coordinator+Store+provider clients.
 * No auto-contact on default startup: construction reads files only; network
 * happens in runHosted/runSupervisorLoop.
 */
export function createHostedSupervisor(
  options: {
    supervisorCredentialsPath?: string;
    statePath?: string;
    serverUrl?: string;
  },
  deps: HostedRuntimeDeps,
): HostedSupervisor {
  const credentialPath = hostedSupervisorCredentialPath(
    options.supervisorCredentialsPath,
  );
  const stored = readHostedSupervisorCredential(credentialPath);
  if (!stored)
    throw new Error(
      "Hosted supervisor is not enrolled. Provide --supervisor-credentials with a private sfsuper_ file.",
    );
  const origin = options.serverUrl ?? stored.server_url;
  if (origin !== stored.server_url)
    throw new Error(
      "Hosted server origin does not match the enrolled supervisor credential.",
    );
  const provider =
    deps.provider ??
    (deps.coordinator.provider instanceof ControlledProcessProvider
      ? deps.coordinator.provider
      : new ControlledProcessProvider());
  const agent =
    deps.agent ??
    (deps.coordinator.agent instanceof ControlledAgent
      ? deps.coordinator.agent
      : new ControlledAgent());
  const client =
    deps.supervisorClient ??
    new SupervisorClient(origin, stored.credential, stored.tenant_id);
  if (client.tenantId !== stored.tenant_id)
    throw new Error("Hosted supervisor client binds a different tenant.");
  // Durable mapping path: statePath is authoritative when given, else a
  // stable private default beside the supervisor credential file (never
  // :memory:, or a restart would lose the task/lease/fence mapping). An
  // explicitly injected deps.hostedStore still wins for tests.
  const resolvedStatePath =
    deps.hostedStore !== undefined
      ? null
      : hostedSupervisorStatePath(options.statePath, credentialPath);
  // Persist launch intent BEFORE opening the DB: a factory restart must find
  // the durable mapping path (and any prior rows). DB-write errors after a
  // process start are never swallowed — startControlled throws, and the ack
  // path holds instead of executing.
  return new HostedSupervisor({
    config: deps.config,
    store: deps.store,
    coordinator: deps.coordinator,
    provider,
    agent,
    client,
    hostedStore: deps.hostedStore ?? new HostedStore(resolvedStatePath!),
    supervisorCredential: () => {
      const current = readHostedSupervisorCredential(credentialPath);
      if (!current)
        throw new Error("Hosted supervisor credential was removed.");
      return {
        credential: current.credential,
        supervisor_id: current.supervisor_id,
        tenant_id: current.tenant_id,
        expires_at: current.expires_at,
        authorization_expires_at: current.authorization_expires_at,
      };
    },
  });
}

function createHostedTaskClient(
  options: { taskCredentialsPath?: string; serverUrl?: string },
  deps?: HostedRuntimeDeps,
): HostedTaskClient {
  if (deps?.taskClient) return deps.taskClient;
  const credentialPath = hostedTaskCredentialPath(options.taskCredentialsPath);
  const stored = readHostedTaskCredential(credentialPath);
  if (!stored)
    throw new Error(
      "Hosted task credential not found. Provide --task-credentials with a private sfexec_ file.",
    );
  const origin = options.serverUrl ?? stored.server_url;
  if (origin !== stored.server_url)
    throw new Error(
      "Hosted server origin does not match the enrolled task credential.",
    );
  return new HostedTaskClient(origin, stored.credential, stored.tenant_id);
}

export interface SupervisorLoopResult {
  claimed: number;
  completed: string[];
  cancelled: string[];
  failed: string[];
  held: string[];
  claim_failed: boolean;
}

/**
 * Controlled supervisor loop: claim (one durable key each) -> ack/start ->
 * watchdog/renew -> verified stop -> same-key settlement, with re-authorization
 * from private paths each cycle. Bounded: maxTasks claims per invocation, no
 * uncontrolled poll/retry — network failures hold state and return.
 */
export async function runSupervisorLoop(
  supervisor: HostedSupervisor,
  options: { maxTasks?: number } = {},
): Promise<SupervisorLoopResult> {
  const maxTasks = options.maxTasks ?? 1;
  const result: SupervisorLoopResult = {
    claimed: 0,
    completed: [],
    cancelled: [],
    failed: [],
    held: [],
    claim_failed: false,
  };
  for (let i = 0; i < maxTasks; i++) {
    let task: Awaited<ReturnType<HostedSupervisor["claimOnce"]>>;
    try {
      task = await supervisor.claimOnce(randomUUID());
    } catch {
      result.claim_failed = true;
      break;
    }
    if (!task) break;
    result.claimed++;
    try {
      const run = await supervisor.ackAndStart(task);
      // Child exit or a requested stop determines the outcome. Awaiting the
      // bounded runtime avoids completing long tasks after an arbitrary 30s.
      const outcome = await run.completion;
      const stopped = await supervisor
        .stopAndConfirm(task.task_id, "loop completion")
        .catch(() => null);
      if (!stopped) {
        result.held.push(task.task_id);
        continue;
      }
      await supervisor.settle(task.task_id, outcome).catch(() => {
        result.held.push(task.task_id);
      });
      if (supervisor.activeRuns.has(task.task_id)) {
        result.held.push(task.task_id);
      } else if (!result.held.includes(task.task_id)) {
        result[outcome].push(task.task_id);
      }
    } catch {
      result.held.push(task.task_id);
    }
  }
  return result;
}

/**
 * Working command handler using the real clients, durable intent/retry/stop,
 * completion, settlement and shutdown. Without injected test dependencies it
 * constructs fixed inert Config/Store/Coordinator without loading ambient settings. Never contacts hosted endpoints during parse — only here.
 */
export async function runHosted(
  command: HostedCommand,
  write: (text: string) => void,
  deps?: HostedRuntimeDeps,
): Promise<number> {
  const output = (value: Record<string, unknown>, text: string) =>
    write(command.json ? JSON.stringify(value) : text);
  if (command.action === "supervisor") {
    const credentialPath = hostedSupervisorCredentialPath(
      command.supervisorCredentials,
    );
    const statePath = hostedSupervisorStatePath(
      command.statePath,
      credentialPath,
    );
    // Validate enrollment before creating any local state.
    if (!readHostedSupervisorCredential(credentialPath))
      throw new Error(
        "Hosted supervisor is not enrolled. Provide --supervisor-credentials with a private sfsuper_ file.",
      );
    let ownedStore: Store | undefined;
    let ownedHostedStore: HostedStore | undefined;
    let ownedCoordinator: Coordinator | undefined;
    let live = deps;
    if (!live) {
      const config = loadConfig({
        FREESTYLE_API_TOKEN: "inert-unused",
        FREESTYLE_SNAPSHOT_ID: "inert-unused",
        SWARMFORGE_MODEL_BASE_URL: "https://inert.invalid",
        SWARMFORGE_MODEL_API_KEY: "inert-unused",
        SWARMFORGE_MODEL_NAME: "inert-unused",
        SWARMFORGE_GIT_TREE: "none",
        SWARMFORGE_GIT_PUSH_MODE: "none",
        SWARMFORGE_DB_PATH: `${statePath}.workers.sqlite`,
        SWARMFORGE_METRICS_ENABLED: "false",
        SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "0",
      });
      // Open the private mapping first so its parent exists before the core Store.
      const hostedStore = new HostedStore(statePath);
      ownedHostedStore = hostedStore;
      try {
        ensurePrivateHostedPath(config.SWARMFORGE_DB_PATH);
        ownedStore = new Store(config.SWARMFORGE_DB_PATH);
        chmodSync(config.SWARMFORGE_DB_PATH, 0o600);
        for (const suffix of ["-wal", "-shm"]) {
          try {
            chmodSync(`${config.SWARMFORGE_DB_PATH}${suffix}`, 0o600);
          } catch {}
        }
        const provider = new ControlledProcessProvider();
        const agent = new ControlledAgent();
        ownedCoordinator = new Coordinator(config, ownedStore, provider, agent);
        live = {
          config,
          store: ownedStore,
          coordinator: ownedCoordinator,
          provider,
          agent,
          hostedStore,
        };
      } catch (error) {
        hostedStore.close();
        ownedStore?.close();
        throw error;
      }
    }
    let supervisor: HostedSupervisor | undefined;
    try {
      supervisor = createHostedSupervisor(
        {
          supervisorCredentialsPath: command.supervisorCredentials,
          statePath: command.statePath,
          serverUrl: command.serverUrl,
        },
        live,
      );
      // Startup recovery FIRST: retry durable verified stop + same-key
      // settlement for held/stopped rows from prior runs BEFORE claiming any
      // new work. recover() alone only marks held + reports; reconcile()
      // actually recovers stop/settlement instead of held-forever.
      const recovered = supervisor.recover();
      const reconciled = await supervisor
        .reconcile({ settleOutcome: "cancelled" })
        .catch(() => ({ stopped: [], settled: [], held: recovered.held }));
      const looped = await runSupervisorLoop(supervisor, {
        maxTasks: command.maxTasks ?? 1,
      });
      const summary = {
        event: "supervisor",
        mode: "controlled",
        recovered_held: recovered.held.length,
        reconciled_stopped: reconciled.stopped,
        reconciled_settled: reconciled.settled,
        reconciled_held: reconciled.held,
        claimed: looped.claimed,
        claim_failed: looped.claim_failed,
        completed: looped.completed,
        cancelled: looped.cancelled,
        failed: looped.failed,
        held: [...new Set([...reconciled.held, ...looped.held])],
      };
      output(summary, `Hosted supervisor: ${JSON.stringify(summary)}`);
      return looped.claim_failed ||
        looped.held.length > 0 ||
        reconciled.held.length > 0
        ? 2
        : 0;
    } finally {
      try {
        await supervisor?.close();
      } finally {
        if (!supervisor) ownedHostedStore?.close();
        try {
          await ownedCoordinator?.stop();
        } finally {
          ownedStore?.close();
        }
      }
    }
  }
  const live = deps;
  const client = createHostedTaskClient(
    {
      taskCredentialsPath: command.taskCredentials,
      serverUrl: command.serverUrl,
    },
    live,
  );
  if (command.action === "submit") {
    const reply = await client.submitTask(
      command.workerId!,
      command.runtimeMs!,
      command.durationMs!,
    );
    output(
      { event: "submitted", task: reply.task },
      `Submitted hosted task ${reply.task.task_id}.`,
    );
    return 0;
  }
  if (command.action === "status") {
    const task = await client.readTask(command.taskId!);
    output(
      { event: "status", task },
      `Hosted task ${task.task_id}: ${task.state}.`,
    );
    return 0;
  }
  const task = await client.cancelTask(command.taskId!);
  output(
    { event: "cancelled", task },
    `Hosted task ${task.task_id}: ${task.state}.`,
  );
  return 0;
}

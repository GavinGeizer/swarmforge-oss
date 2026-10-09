import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Config } from "../config";
import type { Coordinator } from "../coordinator";
import { HostedTaskClient, SupervisorClient } from "../hosted-client";
import {
  hostedSupervisorCredentialPath,
  hostedTaskCredentialPath,
  readHostedSupervisorCredential,
  readHostedTaskCredential,
} from "../hosted-credentials";
import { ControlledAgent, ControlledProcessProvider } from "../hosted-runtime";
import { HostedStore } from "../hosted-store";
import { HostedSupervisor } from "../hosted-supervisor";
import type { Store } from "../store";
import { UsageError } from "./arguments";

/** Optional hosted command surface. NOT wired into the global CLI (lead wires after review). */
export type HostedCommand =
  | {
      kind: "hosted";
      action: "supervisor";
      supervisorCredentials?: string;
      statePath?: string;
      serverUrl?: string;
      maxTasks?: number;
      json: boolean;
    }
  | {
      kind: "hosted";
      action: "submit" | "status" | "cancel";
      taskCredentials?: string;
      taskId?: string;
      workerId?: string;
      runtimeMs?: number;
      durationMs?: number;
      serverUrl?: string;
      json: boolean;
    };

function value(iterator: Iterator<string>, flag: string, noun: string): string {
  const next = iterator.next();
  if (next.done || !next.value || next.value.startsWith("-"))
    throw new UsageError(`${flag} requires ${noun}.`);
  return next.value;
}

/** Parses hosted supervisor/submit/status/cancel args. Never accepts raw secrets in argv. */
export function parseHostedArgs(args: readonly string[]): HostedCommand {
  const [action, ...tail] = args;
  if (!action || !["supervisor", "submit", "status", "cancel"].includes(action))
    throw new UsageError(
      "hosted requires supervisor, submit, status or cancel",
    );
  if (tail.some((a) => /sfexec_|sfsuper_|sfcli_|sfworker_/.test(a)))
    throw new UsageError(
      "Hosted commands never accept raw credentials in argv; use private credential file paths.",
    );
  const base = { kind: "hosted" as const, json: false };
  if (action === "supervisor") {
    const command: HostedCommand = {
      ...base,
      action: "supervisor",
    };
    const iterator = tail[Symbol.iterator]();
    for (const arg of iterator) {
      if (arg === "--supervisor-credentials")
        command.supervisorCredentials = value(iterator, arg, "a path");
      else if (arg === "--state-path")
        command.statePath = value(iterator, arg, "a path");
      else if (arg === "--server-url")
        command.serverUrl = value(iterator, arg, "a server origin");
      else if (arg === "--max-tasks")
        command.maxTasks = Number(value(iterator, arg, "a task count"));
      else if (arg === "--json") command.json = true;
      else throw new UsageError("Unknown hosted supervisor option.");
    }
    if (
      command.maxTasks !== undefined &&
      (!Number.isSafeInteger(command.maxTasks) || command.maxTasks < 1)
    )
      throw new UsageError("hosted supervisor --max-tasks must be >= 1.");
    return command;
  }
  const command: HostedCommand = {
    ...base,
    action: action as "submit" | "status" | "cancel",
  };
  const iterator = tail[Symbol.iterator]();
  for (const arg of iterator) {
    if (arg === "--task-credentials")
      command.taskCredentials = value(iterator, arg, "a path");
    else if (arg === "--task")
      command.taskId = value(iterator, arg, "a task ID");
    else if (arg === "--worker")
      command.workerId = value(iterator, arg, "a worker ID");
    else if (arg === "--runtime-ms")
      command.runtimeMs = Number(value(iterator, arg, "milliseconds"));
    else if (arg === "--duration-ms")
      command.durationMs = Number(value(iterator, arg, "milliseconds"));
    else if (arg === "--server-url")
      command.serverUrl = value(iterator, arg, "a server origin");
    else if (arg === "--json") command.json = true;
    else throw new UsageError("Unknown hosted task option.");
  }
  if (action === "submit") {
    if (
      !command.workerId ||
      !Number.isSafeInteger(command.runtimeMs) ||
      !Number.isSafeInteger(command.durationMs) ||
      (command.durationMs ?? 0) <= 0 ||
      (command.durationMs ?? 0) > (command.runtimeMs ?? 0)
    )
      throw new UsageError(
        "hosted submit requires --worker ID with bounded --runtime-ms/--duration-ms (duration <= runtime).",
      );
  } else if (!command.taskId) {
    throw new UsageError(`hosted ${action} requires --task ID.`);
  }
  return command;
}

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
  const provider = deps.provider ?? new ControlledProcessProvider();
  const agent = deps.agent ?? new ControlledAgent();
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
  deps: HostedRuntimeDeps,
): HostedTaskClient {
  if (deps.taskClient) return deps.taskClient;
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
  held: string[];
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
  const result: SupervisorLoopResult = { claimed: 0, completed: [], held: [] };
  for (let i = 0; i < maxTasks; i++) {
    let task: Awaited<ReturnType<HostedSupervisor["claimOnce"]>>;
    try {
      task = await supervisor.claimOnce(randomUUID());
    } catch {
      break;
    }
    if (!task) break;
    result.claimed++;
    try {
      const run = await supervisor.ackAndStart(task);
      // Wait for the bounded execution, then verify stop and settle with the
      // same durable key. Renewal timers/watchdog run inside the supervisor.
      await Bun.sleep(Math.min(run.authorityMs + 500, 30000));
      const stopped = await supervisor
        .stopAndConfirm(task.task_id, "loop completion")
        .catch(() => null);
      if (!stopped) {
        result.held.push(task.task_id);
        continue;
      }
      await supervisor.settle(task.task_id, "completed").catch(() => {
        result.held.push(task.task_id);
      });
      if (supervisor.activeRuns.has(task.task_id)) {
        result.held.push(task.task_id);
      } else if (!result.held.includes(task.task_id)) {
        result.completed.push(task.task_id);
      }
    } catch {
      result.held.push(task.task_id);
    }
  }
  return result;
}

/**
 * Working command handler using the real clients, durable intent/retry/stop,
 * completion, settlement and shutdown. `deps` is required (lead passes the
 * live Config/Store/Coordinator); tests inject production fakes + fixture
 * clients. Never contacts hosted endpoints during parse — only here.
 */
export async function runHosted(
  command: HostedCommand,
  write: (text: string) => void,
  deps?: HostedRuntimeDeps,
): Promise<number> {
  const output = (value: Record<string, unknown>, text: string) =>
    write(command.json ? JSON.stringify(value) : text);
  const requireDeps = (): HostedRuntimeDeps => {
    if (!deps)
      throw new Error(
        "Hosted commands require runtime dependencies (lead wires the global entrypoint).",
      );
    return deps;
  };
  if (command.action === "supervisor") {
    const live = requireDeps();
    const supervisor = createHostedSupervisor(
      {
        supervisorCredentialsPath: command.supervisorCredentials,
        statePath: command.statePath,
        serverUrl: command.serverUrl,
      },
      live,
    );
    // Recover durable intent first: ambiguous rows stay held, never re-exec.
    const recovered = supervisor.recover();
    const looped = await runSupervisorLoop(supervisor, {
      maxTasks: command.maxTasks ?? 1,
    });
    // Shutdown: cancel timers so the process can exit; running children keep
    // their own absolute deadline + parent-death watchdog.
    for (const id of [...supervisor.activeRuns.keys()]) {
      await supervisor.stopAndConfirm(id, "shutdown").catch(() => {});
    }
    const summary = {
      event: "supervisor",
      mode: "controlled",
      recovered_held: recovered.held.length,
      claimed: looped.claimed,
      completed: looped.completed,
      held: [...new Set([...recovered.held, ...looped.held])],
    };
    output(summary, `Hosted supervisor: ${JSON.stringify(summary)}`);
    return looped.held.length > 0 || recovered.held.length > 0 ? 2 : 0;
  }
  const live = requireDeps();
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

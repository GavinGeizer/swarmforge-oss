import { UsageError } from "./arguments";

/** Optional hosted command surface. NOT wired into the global CLI (lead wires after review). */
export type HostedCommand =
  | {
      kind: "hosted";
      action: "supervisor";
      supervisorCredentials?: string;
      statePath?: string;
      serverUrl?: string;
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
      else if (arg === "--json") command.json = true;
      else throw new UsageError("Unknown hosted supervisor option.");
    }
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

export async function runHosted(
  command: HostedCommand,
  write: (text: string) => void,
): Promise<void> {
  // Wiring to Coordinator/Store happens in the lead integration pass; this
  // handler validates arguments and reports the planned operation without
  // contacting any hosted endpoint on default startup.
  const output = (value: Record<string, unknown>, text: string) =>
    write(command.json ? JSON.stringify(value) : text);
  if (command.action === "supervisor") {
    output(
      { event: "supervisor", mode: "controlled" },
      "Hosted supervisor (controlled) is not yet wired to the global CLI.",
    );
    return;
  }
  output(
    { event: command.action, task: command.taskId ?? null },
    `Hosted ${command.action} is not yet wired to the global CLI.`,
  );
}

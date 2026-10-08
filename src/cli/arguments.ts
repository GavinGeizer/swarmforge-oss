import { plain } from "../settings/inspect";

/** A command line the CLI refuses to run, reported before any setting is read. */
export class UsageError extends Error {
  constructor(message: string) {
    // A flag or a value can carry an escape sequence, so a diagnostic that reaches
    // the terminal is stripped at this boundary.
    super(plain(message));
    this.name = "UsageError";
  }
}

export type ConfigAction = "path" | "show" | "validate";

export type ParsedCommand =
  | {
      kind: "artifacts";
      action: "list" | "download" | "preview";
      query?: string;
      kindFilter?: string;
      state?: string;
      taskId?: string;
      length?: number;
      artifactId?: string;
      workerId?: string;
      output?: string;
      offset: number;
      limit: number;
      json: boolean;
      overrides?: { SWARMFORGE_URL: string };
      configPath?: string;
      envFiles: string[];
    }
  | {
      kind: "templates";
      action: "list" | "show";
      templateId?: string;
      prompt?: string;
      json: boolean;
    }
  | {
      kind: "notifications" | "retention" | "usage";
      action: "list" | "watch" | "preview";
      cursor: number;
      offset: number;
      limit: number;
      workerId?: string;
      teamId?: string;
      taskId?: string;
      json: boolean;
      overrides?: { SWARMFORGE_URL: string };
      configPath?: string;
      envFiles: string[];
    }
  | {
      kind: "github";
      action: "login" | "status" | "logout";
      clientId?: string;
      repository?: string;
      credentials?: string;
    }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init"; configPath?: string }
  | {
      kind: "doctor";
      json: boolean;
      live?: boolean;
      vmId?: string;
      configPath?: string;
      envFiles: string[];
    }
  | {
      kind: "status";
      /** Highest-precedence client values, so their source is reported as an override. */
      overrides?: { SWARMFORGE_URL: string };
      json: boolean;
      interactive: boolean;
      configPath?: string;
      envFiles: string[];
    }
  | {
      kind: "serve";
      checkConfig: boolean;
      configPath?: string;
      envFiles: string[];
    }
  | {
      kind: "config";
      action: ConfigAction;
      configPath?: string;
      envFiles: string[];
    }
  | {
      kind: "cloud";
      action: "login" | "status" | "logout" | "organizations" | "use";
      cloudUrl?: string;
      credentials?: string;
      clientName?: string;
      noBrowser?: boolean;
      json?: boolean;
      tenantId?: string;
    };

const configActions = ["path", "show", "validate"];
const isHelp = (arg: string) => arg === "--help" || arg === "-h";

/**
 * Reads the value that follows a flag. The flag is consumed from the same
 * iterator the command loop walks, so a missing value is a usage error instead of
 * a silently ignored remainder.
 */
function value(rest: Iterator<string>, flag: string, noun: string): string {
  const next = rest.next();
  if (next.done === true || next.value === undefined)
    throw new UsageError(`${flag} requires ${noun}`);
  return next.value;
}

function status(rest: readonly string[]): ParsedCommand {
  const iterator = rest[Symbol.iterator]();
  let url: string | undefined;
  let json = false;
  let interactive = true;
  let configPath: string | undefined;
  const envFiles: string[] = [];
  for (const arg of iterator) {
    if (isHelp(arg)) return { kind: "help" };
    if (arg === "--json") json = true;
    else if (arg === "--no-interactive") interactive = false;
    else if (arg === "--url") url = value(iterator, "--url", "an endpoint");
    else if (arg === "--config")
      configPath = value(iterator, "--config", "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, "--env-file", "a path"));
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return {
    kind: "status",
    // The endpoint is an override, not the process environment: the resolver then
    // reports the command line as the source of the value.
    ...(url === undefined ? {} : { overrides: { SWARMFORGE_URL: url } }),
    json,
    interactive,
    configPath,
    envFiles,
  };
}

function serve(rest: readonly string[]): ParsedCommand {
  const iterator = rest[Symbol.iterator]();
  let checkConfig = false;
  let configPath: string | undefined;
  const envFiles: string[] = [];
  for (const arg of iterator) {
    if (isHelp(arg)) return { kind: "help" };
    if (arg === "--check-config") checkConfig = true;
    else if (arg === "--config")
      configPath = value(iterator, "--config", "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, "--env-file", "a path"));
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return { kind: "serve", checkConfig, configPath, envFiles };
}

function configuration(rest: readonly string[]): ParsedCommand {
  const iterator = rest[Symbol.iterator]();
  const head = iterator.next();
  const required = `config requires one of: ${configActions.join(", ")}`;
  if (head.done === true || head.value === undefined)
    throw new UsageError(required);
  if (isHelp(head.value)) return { kind: "help" };
  // A flag in the action position is a missing action, not an unknown action.
  if (head.value.startsWith("-")) throw new UsageError(required);
  if (!configActions.includes(head.value))
    throw new UsageError(`Unknown config action: ${head.value}`);
  const action = head.value as ConfigAction;
  let configPath: string | undefined;
  const envFiles: string[] = [];
  for (const arg of iterator) {
    if (isHelp(arg)) return { kind: "help" };
    if (arg === "--config") configPath = value(iterator, "--config", "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, "--env-file", "a path"));
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return { kind: "config", action, configPath, envFiles };
}

function initialization(rest: readonly string[]): ParsedCommand {
  const iterator = rest[Symbol.iterator]();
  let configPath: string | undefined;
  for (const arg of iterator) {
    if (isHelp(arg)) return { kind: "help" };
    if (arg === "--config") configPath = value(iterator, "--config", "a path");
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return { kind: "init", configPath };
}

function doctor(rest: readonly string[]): ParsedCommand {
  const iterator = rest[Symbol.iterator]();
  let json = false;
  let live = false;
  let vmId: string | undefined;
  let configPath: string | undefined;
  const envFiles: string[] = [];
  for (const arg of iterator) {
    if (isHelp(arg)) return { kind: "help" };
    if (arg === "--live") live = true;
    else if (arg === "--vm") vmId = value(iterator, arg, "an existing VM ID");
    else if (arg === "--json") json = true;
    else if (arg === "--config")
      configPath = value(iterator, "--config", "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, "--env-file", "a path"));
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (vmId && !live) throw new UsageError("--vm requires --live");
  if (vmId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(vmId))
    throw new UsageError("Invalid VM ID");
  return { kind: "doctor", json, live, vmId, configPath, envFiles };
}

function artifactCommand(rest: readonly string[]): ParsedCommand {
  if (rest.some(isHelp)) return { kind: "help" };
  const [action, ...tail] = rest;
  if (action !== "list" && action !== "download" && action !== "preview")
    throw new UsageError("artifacts requires list, preview or download");
  let artifactId: string | undefined;
  let workerId: string | undefined;
  let output: string | undefined;
  let url: string | undefined;
  let configPath: string | undefined;
  let offset = 0;
  let limit = 20;
  let query: string | undefined;
  let kindFilter: string | undefined;
  let state: string | undefined;
  let taskId: string | undefined;
  let length = 4096;
  let json = false;
  const envFiles: string[] = [];
  const iterator = tail[Symbol.iterator]();
  for (const arg of iterator) {
    if (arg === "--url") url = value(iterator, arg, "an endpoint");
    else if (arg === "--config") configPath = value(iterator, arg, "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, arg, "a path"));
    else if (arg === "--json") json = true;
    else if (arg === "--query" && action === "list")
      query = value(iterator, arg, "a filename query");
    else if (arg === "--kind" && action === "list")
      kindFilter = value(iterator, arg, "an artifact kind");
    else if (arg === "--state" && action === "list")
      state = value(iterator, arg, "an artifact state");
    else if (arg === "--task" && action === "list")
      taskId = value(iterator, arg, "a task ID");
    else if (arg === "--length" && action === "preview") {
      const raw = value(iterator, arg, "a byte count");
      length = Number(raw);
      if (
        !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 32768
      )
        throw new UsageError("Invalid --length (1..32768)");
    } else if (arg === "--worker" && action === "list")
      workerId = value(iterator, arg, "a worker ID");
    else if (arg === "--output" && action === "download")
      output = value(iterator, arg, "a file path");
    else if (
      (arg === "--offset" || arg === "--limit") &&
      (action === "list" || (action === "preview" && arg === "--offset"))
    ) {
      const raw = value(iterator, arg, "an integer");
      const number = Number(raw);
      if (
        !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(number) ||
        number < (arg === "--limit" ? 1 : 0) ||
        (arg === "--limit" && number > 100)
      )
        throw new UsageError(`Invalid ${arg}`);
      if (arg === "--offset") offset = number;
      else limit = number;
    } else if (action !== "list" && !arg.startsWith("-") && !artifactId)
      artifactId = arg;
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (action === "download" && (!artifactId || !output))
    throw new UsageError(
      "artifacts download requires an artifact ID and --output PATH",
    );
  if (action === "preview" && !artifactId)
    throw new UsageError("artifacts preview requires an artifact ID");
  if (query && query.length > 128)
    throw new UsageError("Artifact query exceeds 128 characters");
  if (kindFilter && kindFilter.length > 64)
    throw new UsageError("Artifact kind exceeds 64 characters");
  if (state && !["preserving", "preserved", "failed"].includes(state))
    throw new UsageError("Invalid artifact state");
  if (taskId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(taskId))
    throw new UsageError("Invalid task ID");
  if (artifactId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(artifactId))
    throw new UsageError("Invalid artifact ID");
  if (workerId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(workerId))
    throw new UsageError("Invalid worker ID");
  return {
    kind: "artifacts",
    action,
    query,
    kindFilter,
    state,
    taskId,
    length,
    artifactId,
    workerId,
    output,
    offset,
    limit,
    json,
    ...(url ? { overrides: { SWARMFORGE_URL: url } } : {}),
    configPath,
    envFiles,
  };
}

/**
 * Parses a command line into one command.
 *
 * The parser is total and pure: it never reads a file, an environment variable or
 * a service, so an unknown command, an unknown flag and a missing value are all
 * refused before any infrastructure is touched.
 */
export function parseArguments(args: readonly string[]): ParsedCommand {
  const [head, ...rest] = args;
  // No command at all is the historical status invocation.
  if (head === undefined)
    return {
      kind: "status",
      json: false,
      interactive: true,
      configPath: undefined,
      envFiles: [],
    };
  if (isHelp(head)) return { kind: "help" };
  if (head === "--version" || head === "-V") return { kind: "version" };
  if (head === "status") return status(rest);
  if (head === "serve") return serve(rest);
  if (head === "github") return github(rest);
  if (head === "cloud") return cloud(rest);
  if (head === "init") return initialization(rest);
  if (head === "doctor") return doctor(rest);
  if (head === "config") return configuration(rest);
  if (head === "templates") return templates(rest);
  if (head === "notifications" || head === "retention" || head === "usage")
    return operatorCommand(head, rest);
  if (head === "artifacts") return artifactCommand(rest);
  // A leading flag keeps the implicit status invocation working.
  if (head.startsWith("-")) return status(args);
  throw new UsageError(`Unknown command: ${head}`);
}

function templates(rest: readonly string[]): ParsedCommand {
  if (rest.some(isHelp)) return { kind: "help" };
  const [action, ...tail] = rest;
  if (action !== "list" && action !== "show")
    throw new UsageError("templates requires list or show");
  let templateId: string | undefined;
  let prompt: string | undefined;
  let json = false;
  const iterator = tail[Symbol.iterator]();
  for (const arg of iterator) {
    if (arg === "--json") json = true;
    else if (arg === "--prompt" && action === "show")
      prompt = value(iterator, arg, "task instructions");
    else if (action === "show" && !arg.startsWith("-") && !templateId)
      templateId = arg;
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (
    action === "show" &&
    (!templateId ||
      !["code", "review", "research", "docs"].includes(templateId))
  )
    throw new UsageError(
      "templates show requires code, review, research or docs",
    );
  return { kind: "templates", action, templateId, prompt, json };
}
function operatorCommand(
  kind: "notifications" | "retention" | "usage",
  rest: readonly string[],
): ParsedCommand {
  if (rest.some(isHelp)) return { kind: "help" };
  const [first, ...tail] = rest;
  const action = kind === "usage" ? "list" : first;
  if (
    (kind === "notifications" && action !== "list" && action !== "watch") ||
    (kind === "retention" && action !== "preview")
  )
    throw new UsageError(
      `${kind} requires ${kind === "retention" ? "preview" : "list or watch"}`,
    );
  let cursor = 0;
  let offset = 0;
  let limit = 20;
  let workerId: string | undefined;
  let teamId: string | undefined;
  let taskId: string | undefined;
  let url: string | undefined;
  let configPath: string | undefined;
  let json = false;
  const envFiles: string[] = [];
  const iterator = (kind === "usage" ? rest : tail)[Symbol.iterator]();
  for (const arg of iterator) {
    if (arg === "--json") json = true;
    else if (arg === "--url") url = value(iterator, arg, "an endpoint");
    else if (arg === "--config") configPath = value(iterator, arg, "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, arg, "a path"));
    else if (arg === "--worker" && kind !== "retention")
      workerId = value(iterator, arg, "a worker ID");
    else if (arg === "--team" && kind === "notifications")
      teamId = value(iterator, arg, "a team ID");
    else if (arg === "--task" && kind === "notifications")
      taskId = value(iterator, arg, "a task ID");
    else if (
      (arg === "--cursor" && kind === "notifications") ||
      (arg === "--offset" && kind === "retention") ||
      (arg === "--limit" && kind !== "usage")
    ) {
      const raw = value(iterator, arg, "an integer");
      const n = Number(raw);
      if (
        !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(n) ||
        n < (arg === "--limit" ? 1 : 0) ||
        (arg === "--limit" && n > 100)
      )
        throw new UsageError(`Invalid ${arg}`);
      if (arg === "--cursor") cursor = n;
      else if (arg === "--offset") offset = n;
      else limit = n;
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  for (const id of [workerId, teamId, taskId])
    if (id && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))
      throw new UsageError("Invalid filter ID");
  return {
    kind,
    action: action as "list" | "watch" | "preview",
    cursor,
    offset,
    limit,
    workerId,
    teamId,
    taskId,
    json,
    configPath,
    envFiles,
    ...(url ? { overrides: { SWARMFORGE_URL: url } } : {}),
  };
}

function github(rest: readonly string[]): ParsedCommand {
  if (rest.some(isHelp)) return { kind: "help" };
  const [action, ...tail] = rest;
  if (action !== "login" && action !== "status" && action !== "logout")
    throw new UsageError("github requires login, status or logout");
  const command: Extract<ParsedCommand, { kind: "github" }> = {
    kind: "github",
    action,
  };
  const iterator = tail[Symbol.iterator]();
  const seen = new Set<string>();
  for (const arg of iterator) {
    if (seen.has(arg)) throw new UsageError("Duplicate GitHub option");
    seen.add(arg);
    if (arg === "--credentials")
      command.credentials = value(iterator, arg, "a path");
    else if (arg === "--client-id" && action === "login")
      command.clientId = value(iterator, arg, "a client ID");
    else if (arg === "--repository" && action === "login")
      command.repository = value(iterator, arg, "OWNER/REPO");
    else throw new UsageError("Unknown GitHub option; use --help");
  }
  if (
    action === "login" &&
    (!command.clientId ||
      !/^[A-Za-z0-9_.-]{1,256}$/.test(command.clientId) ||
      !command.repository ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(command.repository))
  )
    throw new UsageError(
      "github login requires --client-id ID and --repository OWNER/REPO",
    );
  return command;
}

function cloud(rest: readonly string[]): ParsedCommand {
  if (rest.some(isHelp)) return { kind: "help" };
  const [action, ...tail] = rest;
  if (
    action !== "login" &&
    action !== "status" &&
    action !== "logout" &&
    action !== "organizations" &&
    action !== "use"
  )
    throw new UsageError(
      "cloud requires login, status, logout, organizations, or use",
    );
  const command: Extract<ParsedCommand, { kind: "cloud" }> = {
    kind: "cloud",
    action,
  };
  const iterator = tail[Symbol.iterator]();
  for (const arg of iterator) {
    if (isHelp(arg)) return { kind: "help" };
    else if (arg === "--cloud-url")
      command.cloudUrl = value(iterator, arg, "an HTTPS URL");
    else if (arg === "--credentials")
      command.credentials = value(iterator, arg, "a path");
    else if (arg === "--name" && action === "login")
      command.clientName = value(iterator, arg, "a client name");
    else if (arg === "--no-browser") command.noBrowser = true;
    else if (arg === "--json") command.json = true;
    else if (arg === "--tenant-id" && action === "use")
      command.tenantId = value(iterator, arg, "a tenant UUID");
    else throw new UsageError(`Unknown cloud option: ${arg}`);
  }
  if (action === "use" && !command.tenantId)
    throw new UsageError("cloud use requires --tenant-id UUID");
  if (
    action === "login" &&
    command.clientName &&
    !/^[ -~]{1,100}$/.test(command.clientName)
  )
    throw new UsageError(
      "Client name must be 1-100 printable ASCII characters",
    );
  if (
    action === "use" &&
    command.tenantId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      command.tenantId,
    )
  )
    throw new UsageError("Tenant ID must be a valid UUID");
  return command;
}

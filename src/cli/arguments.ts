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
      action: "list" | "download";
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
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init"; configPath?: string }
  | { kind: "doctor"; json: boolean; configPath?: string; envFiles: string[] }
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
  let configPath: string | undefined;
  const envFiles: string[] = [];
  for (const arg of iterator) {
    if (isHelp(arg)) return { kind: "help" };
    if (arg === "--json") json = true;
    else if (arg === "--config")
      configPath = value(iterator, "--config", "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, "--env-file", "a path"));
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  return { kind: "doctor", json, configPath, envFiles };
}

function artifactCommand(rest: readonly string[]): ParsedCommand {
  if (rest.some(isHelp)) return { kind: "help" };
  const [action, ...tail] = rest;
  if (action !== "list" && action !== "download")
    throw new UsageError("artifacts requires list or download");
  let artifactId: string | undefined;
  let workerId: string | undefined;
  let output: string | undefined;
  let url: string | undefined;
  let configPath: string | undefined;
  let offset = 0;
  let limit = 20;
  let json = false;
  const envFiles: string[] = [];
  const iterator = tail[Symbol.iterator]();
  for (const arg of iterator) {
    if (arg === "--url") url = value(iterator, arg, "an endpoint");
    else if (arg === "--config") configPath = value(iterator, arg, "a path");
    else if (arg === "--env-file")
      envFiles.push(value(iterator, arg, "a path"));
    else if (arg === "--json") json = true;
    else if (arg === "--worker" && action === "list")
      workerId = value(iterator, arg, "a worker ID");
    else if (arg === "--output" && action === "download")
      output = value(iterator, arg, "a file path");
    else if ((arg === "--offset" || arg === "--limit") && action === "list") {
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
    } else if (action === "download" && !arg.startsWith("-") && !artifactId)
      artifactId = arg;
    else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (action === "download" && (!artifactId || !output))
    throw new UsageError(
      "artifacts download requires an artifact ID and --output PATH",
    );
  if (artifactId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(artifactId))
    throw new UsageError("Invalid artifact ID");
  if (workerId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(workerId))
    throw new UsageError("Invalid worker ID");
  return {
    kind: "artifacts",
    action,
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
  if (head === "init") return initialization(rest);
  if (head === "doctor") return doctor(rest);
  if (head === "config") return configuration(rest);
  if (head === "artifacts") return artifactCommand(rest);
  // A leading flag keeps the implicit status invocation working.
  if (head.startsWith("-")) return status(args);
  throw new UsageError(`Unknown command: ${head}`);
}

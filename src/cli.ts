#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { type ParsedCommand, parseArguments } from "./cli/arguments";
import { connectSwarmForge } from "./cli/client";
import { runDoctor } from "./cli/doctor";
import { renderOverview } from "./cli/overview";
import { runDashboard } from "./cli/tui";
import {
  plain,
  redact,
  redactedSettings,
  redactedText,
} from "./settings/inspect";
import {
  type ClientSettings,
  type ResolvedSettings,
  resolveClientSettings,
  resolveServerSettings,
  SettingsError,
  type SettingsOptions,
} from "./settings/load";
import {
  anchorPath,
  defaultConfigPath,
  homeDirectory,
  SQLITE_MEMORY,
} from "./settings/paths";
import { COMMIT, VERSION } from "./version";

const usage = `SwarmForge control plane

Usage:
  swarmforge init [--config PATH]
  swarmforge doctor [--config PATH] [--env-file PATH] [--json]
  swarmforge [status] [--url URL] [--json] [--no-interactive]
              [--config PATH] [--env-file PATH]
  swarmforge serve [--config PATH] [--env-file PATH] [--check-config]
  swarmforge config path|show|validate [--config PATH] [--env-file PATH]
  swarmforge --version
  swarmforge --help

Commands:
  init      Ask for required settings and create .env in the current directory.
  doctor    Check local setup without contacting any endpoint or creating VMs.
  status    Show the swarm overview from a running server. Used when no command
            is given.
  serve     Run the API, metrics listener, coordinator and event log.
  config    Inspect configuration: path, show or validate.

Options:
  --url URL          MCP endpoint for status, overriding SWARMFORGE_URL.
  --json             Print structured overview JSON and exit.
  --no-interactive   Print one snapshot and exit.
  --config PATH      Configuration file to use instead of discovery.
  --env-file PATH    Environment file applied after the config file. Repeatable.
  --check-config     Validate the server configuration, print it redacted and
                     exit without creating a database, lock file or listener.
  --version          Print the version and exit.
  --help             Print this help, also for a single command.

Configuration is resolved from defaults, the config file, its env_file, every
--env-file, the environment and the flags, in that order. Reading it creates
nothing, and every reported value, source and diagnostic is redacted.
Set SWARMFORGE_API_TOKEN when the server requires bearer authentication.

SwarmForge ${VERSION}, build ${COMMIT}.`;

// The server refuses an in-memory database because it owns durable state; the
// check is repeated here so `serve --check-config` reports the same refusal
// before anything is created. The wording matches startServer.
const persistentDatabase = "Use a persistent database path to start the server";

const write = (line: string) => process.stdout.write(`${line}\n`);

/**
 * Makes a line safe to print: credential material is replaced and control
 * characters are removed.
 *
 * A resolved setting, a source label or a path reported by `config path` is
 * rendered by the loader or scrubbed against the same credential names the
 * loader collects, and a remote error can echo a value the deployment supplied,
 * so every diagnostic passes through here before it reaches a terminal.
 */
function safeText(value: string): string {
  return plain(
    redact(
      value,
      [
        process.env.FREESTYLE_API_TOKEN,
        process.env.SWARMFORGE_MODEL_API_KEY,
        process.env.SWARMFORGE_API_TOKEN,
        process.env.SWARMFORGE_MCP_TOKEN,
      ].filter((secret): secret is string => Boolean(secret)),
    ),
  );
}

const report = (error: unknown) =>
  process.stderr.write(
    `SwarmForge: ${safeText(error instanceof Error ? error.message : "Unexpected error")}\n`,
  );

/** The shared resolver selection: an empty flag list means the loader default. */
function selection(command: {
  configPath?: string;
  envFiles: string[];
}): SettingsOptions {
  return {
    configPath: command.configPath,
    envFiles: command.envFiles.length > 0 ? command.envFiles : undefined,
  };
}

/**
 * Scrubs text with the credential context the loader recorded for a resolved
 * client result.
 *
 * That context is deliberately private to the settings module, and it is the only
 * place that knows credential material from every layer: the config file, each
 * environment file, the environment, the overrides, and values a later layer
 * superseded. `redactedText` is the supported way to reach it; the resolved
 * result is only read, so nothing here mutates it and nothing is rebuilt from
 * selected keys.
 */
function scrub(
  settings: ResolvedSettings<ClientSettings>,
  text: string,
): string {
  try {
    return redactedText(settings, text);
  } catch {
    // A failure while rendering the context must never become the reason a
    // credential is printed; the environment scrubber is the weaker floor.
    return safeText(text);
  }
}

/**
 * The resolver keeps the endpoint path as written, so a bare origin is still
 * pointed at the MCP surface.
 */
function mcpEndpoint(url: string): string {
  const endpoint = new URL(url);
  if (endpoint.pathname === "/") endpoint.pathname = "/mcp";
  return endpoint.toString();
}

async function showStatus(
  command: Extract<ParsedCommand, { kind: "status" }>,
): Promise<number> {
  // A client needs the endpoint and an optional bearer token only: no provider,
  // model, git or database setting is read, and none has to exist.
  const settings = await resolveClientSettings({
    ...selection(command),
    overrides: command.overrides,
  });
  const endpoint = mcpEndpoint(settings.value.url);
  try {
    const client = await connectSwarmForge(
      endpoint,
      settings.value.token,
      (text) => scrub(settings, text),
    );
    try {
      const data = await client.overview();
      if (command.json) write(JSON.stringify(data));
      else if (
        command.interactive &&
        process.stdin.isTTY &&
        process.stdout.isTTY
      )
        await runDashboard(client, data);
      else
        write(
          renderOverview(data, {
            color: false,
            width: process.stdout.columns || 100,
          }),
        );
    } finally {
      // Closing the client runs even when reading the overview failed, so a
      // refused connection cannot leave a transport or socket behind.
      await client.close();
    }
  } catch (error) {
    // A remote error can echo the bearer header it received, and a close failure
    // is raised from the same call, so both are reported through the credential
    // context the resolver collected rather than through the raw message.
    throw new Error(
      scrub(settings, error instanceof Error ? error.message : String(error)),
    );
  }
  return 0;
}

async function serveCommand(
  command: Extract<ParsedCommand, { kind: "serve" }>,
): Promise<number> {
  const settings = await resolveServerSettings(selection(command));
  if (command.checkConfig) {
    if (settings.value.SWARMFORGE_DB_PATH === SQLITE_MEMORY)
      throw new Error(persistentDatabase);
    write(JSON.stringify({ ok: true, ...redactedSettings(settings) }));
    return 0;
  }
  // The server modules are loaded only after every argument and every setting has
  // been accepted, so a rejected command never constructs a provider, opens a
  // database, takes a process lock or binds a listener.
  const { runServe } = await import("./serve-command");
  return runServe(settings.value);
}

/**
 * Reports the config file in effect, and the environment files layered on it.
 *
 * The default is reported whether or not it exists, and nothing is created: a
 * path is the one place a command cannot render a resolved value, so it is
 * scrubbed against the environment's own credentials instead.
 */
function configPath(command: Extract<ParsedCommand, { kind: "config" }>) {
  const cwd = process.cwd();
  const home = homeDirectory(process.env);
  const selected =
    command.configPath ??
    (process.env.SWARMFORGE_CONFIG ? process.env.SWARMFORGE_CONFIG : undefined);
  return selected === undefined
    ? defaultConfigPath(process.env)
    : anchorPath(selected, cwd, home);
}

function reportConfigPath(
  command: Extract<ParsedCommand, { kind: "config" }>,
): number {
  const path = configPath(command);
  const home = homeDirectory(process.env);
  write(
    JSON.stringify({
      config_path: safeText(path),
      exists: existsSync(path),
      env_files: command.envFiles.map((file) =>
        safeText(anchorPath(file, process.cwd(), home)),
      ),
    }),
  );
  return 0;
}

async function reportConfigShow(
  command: Extract<ParsedCommand, { kind: "config" }>,
): Promise<number> {
  const options = selection(command);
  const client = await resolveClientSettings(options);
  let server: Record<string, unknown>;
  try {
    server = {
      ok: true,
      ...redactedSettings(await resolveServerSettings(options)),
    };
  } catch (error) {
    // A half-configured deployment is exactly what an inspection command is for:
    // the failure is reported with its code and its already scrubbed message.
    if (!(error instanceof SettingsError)) throw error;
    server = {
      ok: false,
      code: error.code,
      message: error.message,
      hint: "server settings did not resolve, so `swarmforge serve` cannot start until they are complete",
    };
  }
  write(JSON.stringify({ client: redactedSettings(client), server }));
  return 0;
}

async function reportValidation(
  options: SettingsOptions,
  intent: "config" | "serve",
): Promise<number> {
  const settings = await resolveServerSettings(options);
  if (intent === "serve" && settings.value.SWARMFORGE_DB_PATH === SQLITE_MEMORY)
    throw new Error(persistentDatabase);
  // Every value and source is rendered redacted, so the report can be pasted
  // into a ticket without leaking a credential.
  write(JSON.stringify({ ok: true, ...redactedSettings(settings) }));
  return 0;
}

async function runConfig(
  command: Extract<ParsedCommand, { kind: "config" }>,
): Promise<number> {
  switch (command.action) {
    case "path":
      return reportConfigPath(command);
    case "show":
      return reportConfigShow(command);
    case "validate":
      return reportValidation(selection(command), "config");
  }
}

async function run(command: ParsedCommand): Promise<number> {
  switch (command.kind) {
    // Help and version answer before a setting, a credential or a server module
    // is read, so they work on a host that has no configuration at all.
    case "help":
      write(usage);
      return 0;
    case "version":
      write(VERSION);
      return 0;
    case "init": {
      const { initialize } = await import("./cli/init");
      const { terminalPrompt } = await import("./cli/prompt");
      const prompt = terminalPrompt();
      try {
        await initialize({
          configPath: command.configPath,
          ask: prompt.ask,
          write,
        });
        return 0;
      } finally {
        prompt.close();
      }
    }
    case "doctor":
      return runDoctor(selection(command), command.json);
    case "status":
      return showStatus(command);
    case "serve":
      return serveCommand(command);
    case "config":
      return runConfig(command);
  }
}

export async function runCli(args: readonly string[] = process.argv.slice(2)) {
  try {
    return await run(parseArguments(args));
  } catch (error) {
    report(error);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli();

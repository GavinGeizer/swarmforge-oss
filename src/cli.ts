#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { type ParsedCommand, parseArguments } from "./cli/arguments";
import { connectSwarmForge } from "./cli/client";
import { runDoctor } from "./cli/doctor";
import { emptyFilters } from "./cli/filters";
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
import {
  getTaskTemplate,
  taskTemplates,
  templatePrompt,
} from "./task-templates";
import { COMMIT, LICENSE_ID, LICENSE_URL, VERSION } from "./version";

const usage = `SwarmForge control plane

Usage:
  swarmforge github login --client-id ID --repository OWNER/REPO [--credentials PATH]
  swarmforge github status|logout [--credentials PATH]
  swarmforge cloud login [--cloud-url URL] [--credentials PATH] [--name NAME] [--no-browser] [--json]
  swarmforge cloud status|logout [--credentials PATH] [--json]
  swarmforge cloud organizations [--credentials PATH] [--json]
  swarmforge cloud use --tenant-id UUID [--cloud-url URL] [--credentials PATH] [--no-browser]
  swarmforge init [--config PATH]
  swarmforge doctor [--live] [--vm ID] [--config PATH] [--env-file PATH] [--json]
  swarmforge [status] [--url URL] [--json] [--no-interactive]
              [--config PATH] [--env-file PATH]
  swarmforge serve [--config PATH] [--env-file PATH] [--check-config]
  swarmforge artifacts list [--worker ID] [--offset N] [--limit N] [--json]
  swarmforge artifacts download ID --output PATH [--json]
  swarmforge artifacts preview ID [--offset N] [--length N] [--json]
  swarmforge artifacts list [--query TEXT] [--kind KIND] [--state STATE] [--task ID]
  swarmforge retention preview [--offset N] [--limit N] [--json]
  swarmforge usage [--worker ID] [--json]
  swarmforge notifications list|watch [--cursor N] [--worker ID] [--json]
  swarmforge templates list|show [NAME] [--prompt TEXT] [--json]
              [--url URL] [--config PATH] [--env-file PATH]
  swarmforge config path|show|validate [--config PATH] [--env-file PATH]
  swarmforge --version
  swarmforge --help

Commands:
  github    Authorize repository clone/push access through GitHub device login.
  cloud     Authenticate and interact with cloud server via device login.
  init      Ask for required settings, offer GitHub OAuth for GitHub repositories,
            and create .env in the current directory.
  doctor    Check local setup; --live explicitly probes remote readiness.
            --vm ID checks tools in an existing running VM, without provisioning.
  status    Show the swarm overview from a running server. Used when no command
            is given.
  serve     Run the API, metrics listener, coordinator and event log.
  config    Inspect configuration: path, show or validate.
  artifacts Search/preview saved files or stream a verified download to disk.
  retention Preview configured retained-VM expiry and cleanup eligibility.
  usage     Show measured tokens, retained VM hours and configured USD estimates.
  notifications Read or watch durable completion and operator alerts.
  templates List or render built-in task recipes locally; never spawns workers.

Options:
  --cloud-url URL    Cloud API endpoint, overriding SWARMFORGE_CLOUD_URL.
  --url URL          MCP endpoint for client commands, overriding SWARMFORGE_URL.
  --json             Print structured command output as JSON.
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

License: ${LICENSE_ID}
${LICENSE_URL}

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
      const interactive =
        command.interactive &&
        !command.json &&
        process.stdin.isTTY &&
        process.stdout.isTTY;
      const data = interactive
        ? await client.dashboard(emptyFilters(), "recent")
        : await client.overview();
      if (!data) throw new Error("Dashboard returned no initial snapshot");
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

async function runArtifacts(
  command: Extract<ParsedCommand, { kind: "artifacts" }>,
) {
  const settings = await resolveClientSettings({
    ...selection(command),
    overrides: command.overrides,
  });
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("Download cancelled"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const client = await connectSwarmForge(
      mcpEndpoint(settings.value.url),
      settings.value.token,
      (text) => scrub(settings, text),
    );
    try {
      if (command.action === "download") {
        const saved = await client.download(
          command.artifactId!,
          command.output!,
          abort.signal,
        );
        write(
          command.json
            ? JSON.stringify(saved)
            : `Saved ${scrub(settings, saved.path)} · ${saved.bytes} bytes · SHA256 ${saved.sha256}`,
        );
      } else if (command.action === "preview") {
        const preview = await client.preview(
          command.artifactId!,
          command.offset,
          command.length,
        );
        if (command.json) write(JSON.stringify(preview));
        else {
          write(
            preview.binary
              ? "Binary artifact; use artifacts download to save it."
              : (preview.text ?? ""),
          );
          if (preview.next_offset !== null)
            write(`More: repeat with --offset ${preview.next_offset}`);
        }
      } else {
        const page = await client.listArtifacts({
          ...command,
          kind: command.kindFilter,
        });
        if (command.json) write(JSON.stringify(page));
        else {
          for (const artifact of page.artifacts)
            write(
              scrub(
                settings,
                `${artifact.artifact_id}  ${artifact.state}  ${artifact.size ?? "?"} bytes  ${artifact.filename}  SHA256 ${artifact.sha256 ?? "unavailable"}`,
              ),
            );
          if (!page.artifacts.length) write("No artifacts on this page.");
          if (page.next_offset !== null)
            write(`More artifacts: repeat with --offset ${page.next_offset}`);
        }
      }
      return 0;
    } finally {
      await client.close();
    }
  } catch (error) {
    throw new Error(
      scrub(
        settings,
        error instanceof Error ? error.message : "Artifact command failed",
      ),
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function runOperatorCommand(
  command: Extract<
    ParsedCommand,
    { kind: "notifications" | "retention" | "usage" }
  >,
) {
  const settings = await resolveClientSettings({
    ...selection(command),
    overrides: command.overrides,
  });
  let stopped = false;
  const cancel = () => {
    stopped = true;
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const client = await connectSwarmForge(
      mcpEndpoint(settings.value.url),
      settings.value.token,
      (text) => scrub(settings, text),
    );
    try {
      if (command.kind === "retention")
        write(
          JSON.stringify(
            await client.retention(command.offset, command.limit),
            null,
            command.json ? undefined : 2,
          ),
        );
      else if (command.kind === "usage")
        write(
          JSON.stringify(
            await client.usage(command.workerId),
            null,
            command.json ? undefined : 2,
          ),
        );
      else {
        let cursor = command.cursor;
        do {
          const page = await client.notifications({ ...command, cursor });
          if (stopped) break;
          if (command.json) write(JSON.stringify(page));
          else {
            for (const n of page.notifications)
              write(
                `${n.id} ${new Date(n.at).toISOString()} ${n.team_id}/${n.task_id} ${n.worker_id} · ${n.title}`,
              );
            if (command.action === "list")
              write(`Next cursor: ${page.next_cursor}`);
          }
          cursor = page.next_cursor;
          if (command.action !== "watch") break;
          if (!page.has_more)
            for (let i = 0; i < 20 && !stopped; i++) await Bun.sleep(100);
        } while (!stopped);
      }
      return 0;
    } finally {
      await client.close();
    }
  } catch (error) {
    throw new Error(
      scrub(
        settings,
        error instanceof Error ? error.message : "Operator command failed",
      ),
    );
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
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
    case "github": {
      const { githubCommand } = await import("./cli/github");
      return githubCommand(command, write);
    }
    case "cloud": {
      const { cloudCommand } = await import("./cli/cloud");
      return cloudCommand(command, write);
    }
    case "init": {
      const { initialize } = await import("./cli/init");
      const { terminalPrompt } = await import("./cli/prompt");
      const prompt = terminalPrompt();
      try {
        await initialize({
          configPath: command.configPath,
          ask: prompt.ask,
          write,
          github: { ask: prompt.ask, signal: prompt.signal },
        });
        return 0;
      } finally {
        prompt.close();
      }
    }
    case "doctor":
      return runDoctor(selection(command), command.json, {
        live: command.live,
        vmId: command.vmId,
      });
    case "templates": {
      const result =
        command.action === "list"
          ? taskTemplates
          : {
              ...getTaskTemplate(command.templateId!),
              prompt: templatePrompt(
                command.templateId!,
                command.prompt ?? "Describe your task here.",
              ),
            };
      if (command.json) write(JSON.stringify(result));
      else if (Array.isArray(result))
        for (const recipe of result)
          write(`${recipe.id}  ${recipe.description}`);
      else write((result as { prompt: string }).prompt);
      return 0;
    }
    case "notifications":
    case "retention":
    case "usage":
      return runOperatorCommand(command);
    case "status":
      return showStatus(command);
    case "artifacts":
      return runArtifacts(command);
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

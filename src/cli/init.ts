import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Config, configFieldError, loadConfig } from "../config";
import { plain } from "../settings/inspect";
import {
  anchorPath,
  defaultConfigPath,
  type EnvView,
  homeDirectory,
} from "../settings/paths";

export interface InitField {
  name: keyof Config;
  label: string;
  hint: string;
  secret: boolean;
}

export const initFields: readonly InitField[] = [
  {
    name: "FREESTYLE_API_TOKEN",
    label: "Freestyle API token",
    hint: "Account API token used by the control plane to manage VMs.",
    secret: true,
  },
  {
    name: "FREESTYLE_SNAPSHOT_ID",
    label: "Freestyle snapshot ID or slug",
    hint: "An existing prepared snapshot with OpenCode, Python 3, Git, Bash, systemd and worker tools.",
    secret: false,
  },
  {
    name: "SWARMFORGE_MODEL_BASE_URL",
    label: "Model API base URL",
    hint: "OpenAI-compatible chat completions endpoint with tool calling, usually ending in /v1.",
    secret: false,
  },
  {
    name: "SWARMFORGE_MODEL_API_KEY",
    label: "Model API key",
    hint: "Worker-scoped inference credential; use a nonempty placeholder for an unauthenticated endpoint.",
    secret: true,
  },
  {
    name: "SWARMFORGE_MODEL_NAME",
    label: "Model name",
    hint: "Exact model ID accepted by that endpoint.",
    secret: false,
  },
  {
    name: "SWARMFORGE_GIT_TREE",
    label: "Git repository URL or prepared tree",
    hint: "A cloneable Git URL/path reachable from workers. Use none or none:/path for a prepared workspace.",
    secret: false,
  },
];

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createPrivateFile(path: string, text: string) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // link publishes a complete file and refuses an existing destination.
    await link(temporary, path);
  } finally {
    await unlink(temporary);
  }
}

export interface InitOptions {
  cwd?: string;
  env?: EnvView;
  configPath?: string;
  ask: (field: InitField) => Promise<string>;
  write: (message: string) => void;
}

/** Configuration creation only: installed init needs no checkout or compiler. */
export async function initialize(options: InitOptions) {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (/[\r\n\0]/.test(cwd))
    throw new Error("Initialize from a directory whose path is a single line.");
  const env = options.env ?? process.env;
  const envPath = join(cwd, ".env");
  if (await exists(envPath))
    throw new Error(
      `${plain(envPath)} already exists. Keep it and run doctor with --env-file, or move it before initializing again.`,
    );
  const selectedConfig = options.configPath ?? env.SWARMFORGE_CONFIG;
  const configPath = selectedConfig
    ? anchorPath(selectedConfig, cwd, homeDirectory(env))
    : defaultConfigPath(env);
  const values: Record<string, string> = {};
  options.write(
    "SwarmForge initialization — creates .env here. No services or VMs are started.",
  );
  for (const field of initFields) {
    options.write(`\n${field.hint}`);
    while (true) {
      const value = (await options.ask(field)).trim();
      const problem = /[\r\n\0]/.test(value)
        ? "Use a single-line value without null characters."
        : configFieldError(field.name, value);
      if (problem) {
        options.write(`Invalid ${field.label}: ${problem}`);
        continue;
      }
      values[field.name] = value;
      break;
    }
  }
  // Absolute paths keep a global executable on the same database in another CWD.
  values.SWARMFORGE_DB_PATH = join(cwd, "data", "swarmforge.sqlite");
  values.SWARMFORGE_INSTANCE_ID = randomBytes(6).toString("hex");
  loadConfig(values);
  // Single quotes are literal in our env-file parser, including $, # and quotes
  // within the body. The file is data and is never sourced by a shell.
  const text = [
    "# Created by swarmforge init. Keep this file private and out of Git.",
    "# Read with --env-file; do not source this file as a shell script.",
    "# Optional settings: docs/ENVIRONMENT.md or .env.example in the checkout.",
    ...Object.entries(values).map(([key, value]) => `${key}='${value}'`),
    "",
  ].join("\n");
  await createPrivateFile(envPath, text);
  options.write(`\nCreated ${plain(envPath)} (permissions 0600).`);
  let registered: string | null = null;
  if (await exists(configPath)) {
    options.write(`Kept existing global configuration: ${plain(configPath)}.`);
  } else {
    try {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      await createPrivateFile(
        configPath,
        `schema_version = 1\nenv_file = ${JSON.stringify(envPath)}\n`,
      );
      registered = configPath;
      options.write(
        `Created ${plain(configPath)} pointing to this .env. The global command works from any directory.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        options.write(
          "Could not register global configuration; use the explicit --env-file commands below.",
        );
    }
  }
  const configFlags = options.configPath
    ? ` --config ${shellQuote(configPath)}`
    : "";
  const flags = registered
    ? configFlags
    : `${configFlags} --env-file ${shellQuote(envPath)}`;
  options.write(
    `\nNext:\n  swarmforge doctor${flags}\n  swarmforge serve${flags}\n\nIn another terminal:\n  swarmforge status${flags}\n\nMCP endpoint: http://127.0.0.1:8787/mcp`,
  );
  return { envPath, configPath: registered };
}

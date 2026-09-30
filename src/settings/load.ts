import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { type Config, loadConfig } from "../config";
import { plain, redact, SECRET_KEYS } from "./inspect";
import {
  anchorPath,
  defaultConfigPath,
  defaultDatabasePath,
  type EnvView,
  homeDirectory,
} from "./paths";

export interface SettingsOptions {
  /** Config file to use; replaces discovery and anchors at `cwd`. */
  configPath?: string;
  /** Additional environment files applied after the config's own `env_file`. */
  envFiles?: string[];
  /** Replaces the process environment entirely for a deterministic call. */
  env?: Record<string, string | undefined>;
  /** Directory explicit paths anchor at, and the process default. */
  cwd?: string;
  /** Highest-precedence values, applied last. */
  overrides?: Record<string, string | undefined>;
}

export interface ResolvedSettings<T> {
  value: T;
  /** Config file that contributed values, or null when none was read. */
  configPath: string | null;
  /** Source label per resolved key: `default`, `config:…`, `env_file:…`, `env`, `override`. */
  provenance: Record<string, string>;
}

export interface ClientSettings {
  url: string;
  token?: string;
}

export type SettingsErrorCode =
  | "config_not_found"
  | "config_invalid"
  | "env_file_not_found"
  | "env_file_invalid"
  | "invalid_config"
  | "invalid_client";

/** Every resolution failure, with a code a command can branch on. */
export class SettingsError extends Error {
  readonly path?: string;
  constructor(
    readonly code: SettingsErrorCode,
    message: string,
    path?: string,
  ) {
    // Configuration values can hold terminal control characters; a diagnostic is
    // printed by a command, so remove them at this boundary.
    super(plain(message));
    this.name = "SettingsError";
    this.path = path === undefined ? undefined : plain(path);
  }
}

type Kind = "text" | "int" | "bool" | "host_path";

interface Field {
  /** Dotted path inside the config file. */
  path: string;
  kind: Kind;
  /** Resolved setting key. */
  key: string;
  /** Environment variables feeding this key, highest precedence first. */
  env: string[];
}

const clientFields: Field[] = [
  {
    path: "client.url",
    kind: "text",
    key: "url",
    env: ["SWARMFORGE_URL", "SWARMFORGE_MCP_URL"],
  },
  {
    path: "client.token",
    kind: "text",
    key: "token",
    env: ["SWARMFORGE_API_TOKEN", "SWARMFORGE_MCP_TOKEN"],
  },
];

const providerFields: Field[] = [
  {
    path: "provider.freestyle.api_url",
    kind: "text",
    key: "FREESTYLE_API_URL",
    env: ["FREESTYLE_API_URL"],
  },
  {
    path: "provider.freestyle.api_token",
    kind: "text",
    key: "FREESTYLE_API_TOKEN",
    env: ["FREESTYLE_API_TOKEN"],
  },
  {
    path: "provider.freestyle.snapshot_id",
    kind: "text",
    key: "FREESTYLE_SNAPSHOT_ID",
    env: ["FREESTYLE_SNAPSHOT_ID"],
  },
  {
    path: "provider.freestyle.vpc",
    kind: "text",
    key: "FREESTYLE_VPC",
    env: ["FREESTYLE_VPC"],
  },
];

const modelFields: Field[] = [
  {
    path: "model.base_url",
    kind: "text",
    key: "SWARMFORGE_MODEL_BASE_URL",
    env: ["SWARMFORGE_MODEL_BASE_URL"],
  },
  {
    path: "model.api_key",
    kind: "text",
    key: "SWARMFORGE_MODEL_API_KEY",
    env: ["SWARMFORGE_MODEL_API_KEY"],
  },
  {
    path: "model.name",
    kind: "text",
    key: "SWARMFORGE_MODEL_NAME",
    env: ["SWARMFORGE_MODEL_NAME"],
  },
];

const gitFields: Field[] = [
  {
    path: "git.tree",
    kind: "text",
    key: "SWARMFORGE_GIT_TREE",
    env: ["SWARMFORGE_GIT_TREE"],
  },
  {
    path: "git.push_mode",
    kind: "text",
    key: "SWARMFORGE_GIT_PUSH_MODE",
    env: ["SWARMFORGE_GIT_PUSH_MODE"],
  },
  {
    path: "git.push_timeout_ms",
    kind: "int",
    key: "SWARMFORGE_GIT_PUSH_TIMEOUT_MS",
    env: ["SWARMFORGE_GIT_PUSH_TIMEOUT_MS"],
  },
  {
    path: "git.author_name",
    kind: "text",
    key: "SWARMFORGE_GIT_AUTHOR_NAME",
    env: ["SWARMFORGE_GIT_AUTHOR_NAME"],
  },
  {
    path: "git.author_email",
    kind: "text",
    key: "SWARMFORGE_GIT_AUTHOR_EMAIL",
    env: ["SWARMFORGE_GIT_AUTHOR_EMAIL"],
  },
];

const githubAppFields: Field[] = [
  {
    path: "git.github_app.app_id",
    kind: "text",
    key: "SWARMFORGE_GITHUB_APP_ID",
    env: ["SWARMFORGE_GITHUB_APP_ID"],
  },
  {
    path: "git.github_app.installation_id",
    kind: "text",
    key: "SWARMFORGE_GITHUB_INSTALLATION_ID",
    env: ["SWARMFORGE_GITHUB_INSTALLATION_ID"],
  },
  {
    path: "git.github_app.private_key_path",
    kind: "host_path",
    key: "SWARMFORGE_GITHUB_PRIVATE_KEY_PATH",
    env: ["SWARMFORGE_GITHUB_PRIVATE_KEY_PATH"],
  },
  {
    path: "git.github_app.repository",
    kind: "text",
    key: "SWARMFORGE_GITHUB_REPOSITORY",
    env: ["SWARMFORGE_GITHUB_REPOSITORY"],
  },
];

const sshFields: Field[] = [
  {
    path: "git.ssh.push_url",
    kind: "text",
    key: "SWARMFORGE_GIT_PUSH_URL",
    env: ["SWARMFORGE_GIT_PUSH_URL"],
  },
  {
    path: "git.ssh.key_path",
    kind: "host_path",
    key: "SWARMFORGE_GIT_SSH_KEY_PATH",
    env: ["SWARMFORGE_GIT_SSH_KEY_PATH"],
  },
  {
    path: "git.ssh.known_hosts_path",
    kind: "host_path",
    key: "SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH",
    env: ["SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH"],
  },
];

const workspaceFields: Field[] = [
  {
    path: "workspace.guest_path",
    kind: "text",
    key: "SWARMFORGE_WORKSPACE",
    env: ["SWARMFORGE_WORKSPACE"],
  },
  {
    path: "workspace.instance_id",
    kind: "text",
    key: "SWARMFORGE_INSTANCE_ID",
    env: ["SWARMFORGE_INSTANCE_ID"],
  },
  {
    path: "workspace.opencode_port",
    kind: "int",
    key: "OPENCODE_PORT",
    env: ["OPENCODE_PORT"],
  },
  {
    path: "workspace.opencode_start_command",
    kind: "text",
    key: "OPENCODE_START_COMMAND",
    env: ["OPENCODE_START_COMMAND"],
  },
  {
    path: "workspace.worker_domain_suffix",
    kind: "text",
    key: "SWARMFORGE_WORKER_DOMAIN_SUFFIX",
    env: ["SWARMFORGE_WORKER_DOMAIN_SUFFIX"],
  },
];

const serverFields: Field[] = [
  {
    path: "server.host",
    kind: "text",
    key: "SWARMFORGE_HOST",
    env: ["SWARMFORGE_HOST"],
  },
  {
    path: "server.port",
    kind: "int",
    key: "SWARMFORGE_PORT",
    env: ["SWARMFORGE_PORT"],
  },
  {
    path: "server.db_path",
    kind: "host_path",
    key: "SWARMFORGE_DB_PATH",
    env: ["SWARMFORGE_DB_PATH"],
  },
  {
    path: "server.allowed_hosts",
    kind: "text",
    key: "SWARMFORGE_ALLOWED_HOSTS",
    env: ["SWARMFORGE_ALLOWED_HOSTS"],
  },
  {
    path: "server.api_token",
    kind: "text",
    key: "SWARMFORGE_API_TOKEN",
    env: ["SWARMFORGE_API_TOKEN"],
  },
  {
    path: "server.metrics_enabled",
    kind: "bool",
    key: "SWARMFORGE_METRICS_ENABLED",
    env: ["SWARMFORGE_METRICS_ENABLED"],
  },
  {
    path: "server.metrics_port",
    kind: "int",
    key: "SWARMFORGE_METRICS_PORT",
    env: ["SWARMFORGE_METRICS_PORT"],
  },
  {
    path: "server.metrics_teams",
    kind: "text",
    key: "SWARMFORGE_METRICS_TEAMS",
    env: ["SWARMFORGE_METRICS_TEAMS"],
  },
];

const limitFields: Field[] = [
  {
    path: "limits.max_workers",
    kind: "int",
    key: "SWARMFORGE_MAX_WORKERS",
    env: ["SWARMFORGE_MAX_WORKERS"],
  },
  {
    path: "limits.max_provisioning",
    kind: "int",
    key: "SWARMFORGE_MAX_PROVISIONING",
    env: ["SWARMFORGE_MAX_PROVISIONING"],
  },
  {
    path: "limits.max_queue",
    kind: "int",
    key: "SWARMFORGE_MAX_QUEUE",
    env: ["SWARMFORGE_MAX_QUEUE"],
  },
  {
    path: "limits.default_timeout_seconds",
    kind: "int",
    key: "SWARMFORGE_DEFAULT_TIMEOUT_SECONDS",
    env: ["SWARMFORGE_DEFAULT_TIMEOUT_SECONDS"],
  },
  {
    path: "limits.provision_timeout_seconds",
    kind: "int",
    key: "SWARMFORGE_PROVISION_TIMEOUT_SECONDS",
    env: ["SWARMFORGE_PROVISION_TIMEOUT_SECONDS"],
  },
  {
    path: "limits.token_idle_timeout_seconds",
    kind: "int",
    key: "SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS",
    env: ["SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS"],
  },
  {
    path: "limits.poll_interval_ms",
    kind: "int",
    key: "SWARMFORGE_POLL_INTERVAL_MS",
    env: ["SWARMFORGE_POLL_INTERVAL_MS"],
  },
  {
    path: "limits.api_timeout_ms",
    kind: "int",
    key: "SWARMFORGE_API_TIMEOUT_MS",
    env: ["SWARMFORGE_API_TIMEOUT_MS"],
  },
];

// Every control-plane setting except the client endpoint, in one ordered list.
const controlFields: Field[] = [
  ...providerFields,
  ...modelFields,
  ...gitFields,
  ...githubAppFields,
  ...sshFields,
  ...workspaceFields,
  ...serverFields,
  ...limitFields,
];

const text = z.string();
const kinds: Record<Kind, z.ZodType> = {
  text,
  int: z
    .union([z.number().int(), z.string().regex(/^-?\d+$/)])
    .transform((v) => String(v)),
  bool: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => String(v)),
  host_path: text,
};

const tableOf = (path: string) => path.slice(0, path.lastIndexOf("."));
const leafOf = (path: string) => path.slice(path.lastIndexOf(".") + 1);
const leaves = (fields: Field[]) =>
  Object.fromEntries(
    fields.map((field) => [leafOf(field.path), kinds[field.kind].optional()]),
  );
const table = (fields: Field[], path: string) =>
  z.strictObject(
    leaves(fields.filter((field) => tableOf(field.path) === path)),
  );

const documentSchema = z.strictObject({
  schema_version: z.literal(1),
  env_file: text.optional(),
  client: table(clientFields, "client").optional(),
  provider: z
    .strictObject({
      freestyle: table(providerFields, "provider.freestyle").optional(),
    })
    .optional(),
  model: table(modelFields, "model").optional(),
  git: z
    .strictObject({
      ...leaves(gitFields),
      github_app: table(githubAppFields, "git.github_app").optional(),
      ssh: table(sshFields, "git.ssh").optional(),
    })
    .optional(),
  workspace: table(workspaceFields, "workspace").optional(),
  server: table(serverFields, "server").optional(),
  limits: table(limitFields, "limits").optional(),
});

type Document = z.infer<typeof documentSchema>;

const DEFAULT_CLIENT_URL = "http://127.0.0.1:8787/mcp";
const CONFIG_SELECTOR = "SWARMFORGE_CONFIG";
const serverKeys = controlFields.map((field) => field.key);

interface Collector {
  values: Record<string, string>;
  provenance: Record<string, string>;
  secrets: Set<string>;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const errno = (error: unknown) =>
  (error as { code?: string } | null)?.code ?? "unknown error";

function readAt(document: unknown, path: string): unknown {
  let node: unknown = document;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * Collects credential material before parsing, so a parser diagnostic can never
 * echo a value out of a file that failed to parse.
 */
function collectSecrets(text: string, secrets: Set<string>) {
  for (const match of text.matchAll(
    /(^|\n)[^\S\n]*(?:export[^\S\n]+)?([A-Za-z_][A-Za-z0-9_]*)[^\S\n]*=([^\n]*)/g,
  )) {
    if (!/token|key|secret|password|credential/i.test(match[2] ?? "")) continue;
    const value = (match[3] ?? "")
      .replace(/\s#.*$/, "")
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (value) secrets.add(value);
  }
}

async function readDocument(
  path: string,
  required: boolean,
  secrets: Set<string>,
): Promise<Document | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // A file name can hold credential material, so it is scrubbed as well.
    const safe = redact(path, secrets);
    if (errno(error) === "ENOENT" && !required) return null;
    if (errno(error) === "ENOENT")
      throw new SettingsError(
        "config_not_found",
        `Config file not found: ${safe}`,
        safe,
      );
    throw new SettingsError(
      "config_invalid",
      `Cannot read ${safe}: ${errno(error)}`,
      safe,
    );
  }
  collectSecrets(raw, secrets);
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(raw);
  } catch (error) {
    throw new SettingsError(
      "config_invalid",
      `Invalid TOML in ${path}: ${redact(message(error), secrets)}`,
      path,
    );
  }
  const result = documentSchema.safeParse(parsed);
  if (!result.success)
    throw new SettingsError(
      "config_invalid",
      `Invalid configuration file ${path}: ${redact(
        result.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; "),
        secrets,
      )}`,
      path,
    );
  return result.data;
}

interface EnvFile {
  path: string;
  values: Record<string, string>;
}

/**
 * Parses one environment file. Supported syntax is `KEY=value` lines with an
 * optional `export`, single quotes for literal values, double quotes or bare
 * values for interpolation of `$NAME` and `${NAME}`, and `#` comments. No shell
 * runs, no command substitution, and a line that is not a valid assignment is an
 * error rather than a silent no-op.
 */
function parseEnvFile(
  raw: string,
  path: string,
  scope: EnvView,
): Record<string, string> {
  const values: Record<string, string> = {};
  let line = 0;
  for (const row of raw.split(/\r?\n/)) {
    line++;
    const entry = row.trim();
    if (!entry || entry.startsWith("#")) continue;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/.exec(
      entry,
    );
    if (!match)
      throw new SettingsError(
        "env_file_invalid",
        `Invalid environment file ${path} at line ${line}`,
        path,
      );
    const key = match[1] ?? "";
    const raw_value = match[2] ?? "";
    values[key] = envValue(raw_value, values, scope, path, line);
  }
  return values;
}

function envValue(
  raw: string,
  own: Record<string, string>,
  scope: EnvView,
  path: string,
  line: number,
): string {
  const fail = (why: string): never => {
    throw new SettingsError(
      "env_file_invalid",
      `Invalid environment file ${path} at line ${line}: ${why}`,
      path,
    );
  };
  const entry = raw.trim();
  const quote = entry[0];
  if (quote === '"' || quote === "'") {
    if (entry.length < 2 || !entry.endsWith(quote)) fail("unterminated quote");
    const body = entry.slice(1, -1);
    return quote === "'" ? body : unescapeDouble(expand(body, own, scope));
  }
  const comment = entry.search(/\s#/);
  const value = (comment >= 0 ? entry.slice(0, comment) : entry).trim();
  return expand(value, own, scope);
}

function expand(
  value: string,
  own: Record<string, string>,
  scope: EnvView,
): string {
  return value.replace(
    /(?<!\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      const key = `${braced ?? bare}`;
      if (own[key] !== undefined) return own[key];
      const fromEnv = scope[key];
      return fromEnv === undefined ? match : fromEnv;
    },
  );
}

function unescapeDouble(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[++i];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next !== undefined) out += next;
  }
  return out;
}

async function readEnvFile(
  path: string,
  scope: EnvView,
  secrets: Set<string>,
): Promise<EnvFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const safe = redact(path, secrets);
    if (errno(error) === "ENOENT")
      throw new SettingsError(
        "env_file_not_found",
        `Environment file not found: ${safe}`,
        safe,
      );
    throw new SettingsError(
      "env_file_invalid",
      `Cannot read environment file ${safe}: ${errno(error)}`,
      safe,
    );
  }
  collectSecrets(raw, secrets);
  return { path, values: parseEnvFile(raw, path, scope) };
}

/** An empty value means unset, exactly as the existing environment loader treats it. */
function setValue(
  collector: Collector,
  key: string,
  value: string,
  label: string,
) {
  if (value === "") return;
  collector.values[key] = value;
  collector.provenance[key] = label;
  if (key === "token" || SECRET_KEYS.includes(key))
    collector.secrets.add(value);
}

function applyDocument(
  collector: Collector,
  document: Document,
  fields: Field[],
  label: string,
  base: string,
  home: string,
) {
  for (const field of fields) {
    const raw = readAt(document, field.path);
    if (raw === undefined) continue;
    const value = String(raw);
    setValue(
      collector,
      field.key,
      field.kind === "host_path" ? anchorPath(value, base, home) : value,
      label,
    );
  }
}

function applyEnvironment(
  collector: Collector,
  source: EnvView,
  label: string,
  fields: Field[],
  base: string,
  home: string,
) {
  for (const field of fields) {
    for (const name of field.env) {
      const value = source[name];
      if (!value) continue;
      setValue(
        collector,
        field.key,
        field.kind === "host_path" ? anchorPath(value, base, home) : value,
        label,
      );
      break;
    }
  }
}

interface Prepared {
  document: Document | null;
  configPath: string | null;
  label: string;
  base: string;
  envFiles: EnvFile[];
  env: EnvView;
  cwd: string;
  home: string;
  collector: Collector;
}

async function prepare(options: SettingsOptions): Promise<Prepared> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const home = homeDirectory(env);
  const collector: Collector = {
    values: {},
    provenance: {},
    secrets: new Set(),
  };
  const selected = options.configPath ?? selector(options, env);
  const path =
    selected === undefined
      ? defaultConfigPath(env)
      : anchorPath(selected, cwd, home);
  const document = await readDocument(
    path,
    selected !== undefined,
    collector.secrets,
  );
  // Paths declared in a config file anchor at that file, never at the caller.
  const base = document === null ? cwd : dirname(path);
  const envFiles: EnvFile[] = [];
  if (document?.env_file !== undefined)
    envFiles.push(
      await readEnvFile(
        anchorPath(document.env_file, base, home),
        env,
        collector.secrets,
      ),
    );
  for (const entry of options.envFiles ?? [])
    envFiles.push(
      await readEnvFile(anchorPath(entry, cwd, home), env, collector.secrets),
    );
  return {
    document,
    configPath: document === null ? null : path,
    label: document === null ? "" : `config:${path}`,
    base,
    envFiles,
    env,
    cwd,
    home,
    collector,
  };
}

function selector(options: SettingsOptions, env: EnvView) {
  for (const value of [
    options.overrides?.[CONFIG_SELECTOR],
    env[CONFIG_SELECTOR],
  ])
    if (value !== undefined && value !== "") return value;
  return undefined;
}

function merged(prepared: Prepared, fields: Field[], options: SettingsOptions) {
  const { collector } = prepared;
  if (prepared.document !== null)
    applyDocument(
      collector,
      prepared.document,
      fields,
      prepared.label,
      prepared.base,
      prepared.home,
    );
  for (const file of prepared.envFiles)
    applyEnvironment(
      collector,
      file.values,
      `env_file:${file.path}`,
      fields,
      prepared.cwd,
      prepared.home,
    );
  applyEnvironment(
    collector,
    prepared.env,
    "env",
    fields,
    prepared.cwd,
    prepared.home,
  );
  applyEnvironment(
    collector,
    options.overrides ?? {},
    "override",
    fields,
    prepared.cwd,
    prepared.home,
  );
  return collector;
}

/**
 * Resolves server settings from defaults, the selected config file, its declared
 * `env_file`, explicit environment files, the environment, and explicit
 * overrides, in that order. Reading configuration never creates a directory,
 * database or lock file.
 */
export async function resolveServerSettings(
  options: SettingsOptions = {},
): Promise<ResolvedSettings<Config>> {
  const prepared = await prepare(options);
  const collector = merged(prepared, controlFields, options);
  if (collector.values.SWARMFORGE_DB_PATH === undefined)
    setValue(
      collector,
      "SWARMFORGE_DB_PATH",
      defaultDatabasePath(prepared.env),
      "default",
    );
  for (const key of serverKeys) collector.provenance[key] ??= "default";
  let value: Config;
  try {
    value = loadConfig(collector.values);
  } catch (error) {
    throw new SettingsError(
      "invalid_config",
      redact(message(error), collector.secrets),
    );
  }
  return {
    value,
    configPath: prepared.configPath,
    provenance: collector.provenance,
  };
}

/**
 * Resolves the MCP endpoint and optional bearer token. Provider, model and
 * server settings are never required, and the endpoint must be http or https.
 */
export async function resolveClientSettings(
  options: SettingsOptions = {},
): Promise<ResolvedSettings<ClientSettings>> {
  const prepared = await prepare(options);
  const collector = merged(prepared, clientFields, options);
  const url = collector.values.url ?? DEFAULT_CLIENT_URL;
  collector.provenance.url ??= "default";
  collector.provenance.token ??= "default";
  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = "";
  }
  if (scheme !== "http:" && scheme !== "https:")
    throw new SettingsError(
      "invalid_client",
      redact(
        `Client endpoint must use http or https: ${url}`,
        collector.secrets,
      ),
    );
  const token = collector.values.token;
  return {
    value: token === undefined ? { url } : { url, token },
    configPath: prepared.configPath,
    provenance: collector.provenance,
  };
}

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Config } from "../config";
import { redactedText } from "../settings/inspect";
import {
  type ResolvedSettings,
  resolveServerSettings,
  type SettingsOptions,
} from "../settings/load";

type CheckStatus = "pass" | "warn" | "fail";
interface Check {
  name: string;
  status: CheckStatus;
  message: string;
}

function hasPermission(path: string, mode: number) {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function pathIs(path: string, kind: "file" | "directory") {
  try {
    const info = statSync(path);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

function nearestExistingDirectory(path: string): string | null {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export async function doctorChecks(
  options: SettingsOptions = {},
  bunVersion = Bun.version,
): Promise<Check[]> {
  const checks: Check[] = [];
  const version = bunVersion.split("-")[0]!.split(".").slice(0, 3).map(Number);
  const supportedBun =
    version.length === 3 &&
    version.every(Number.isFinite) &&
    (version[0]! > 1 ||
      (version[0] === 1 &&
        (version[1]! > 4 || (version[1] === 4 && version[2]! >= 2))));
  checks.push({
    name: "Bun runtime",
    status: supportedBun ? "pass" : "fail",
    message: supportedBun
      ? `Bun ${bunVersion} meets the required version (1.4.2 or newer).`
      : `Bun ${bunVersion} is too old; install Bun 1.4.2 or newer.`,
  });

  let config: Config | undefined;
  let settings: ResolvedSettings<Config> | undefined;
  try {
    settings = await resolveServerSettings(options);
    config = settings.value;
    checks.push({
      name: "Configuration",
      status: "pass",
      message: "Required settings and configuration relationships are valid.",
    });
  } catch (error) {
    checks.push({
      name: "Configuration",
      status: "fail",
      message:
        error instanceof Error ? error.message : "Configuration is invalid.",
    });
  }

  if (config) {
    const dbDirectory = nearestExistingDirectory(
      dirname(resolve(config.SWARMFORGE_DB_PATH)),
    );
    const persistentDb = config.SWARMFORGE_DB_PATH !== ":memory:";
    const dbWritable =
      persistentDb &&
      !!dbDirectory &&
      pathIs(dbDirectory, "directory") &&
      hasPermission(dbDirectory, constants.W_OK | constants.X_OK) &&
      (!existsSync(config.SWARMFORGE_DB_PATH) ||
        (pathIs(config.SWARMFORGE_DB_PATH, "file") &&
          hasPermission(
            config.SWARMFORGE_DB_PATH,
            constants.R_OK | constants.W_OK,
          )));
    checks.push({
      name: "Database location",
      status: dbWritable ? "pass" : "fail",
      message: dbWritable
        ? `The database directory can be created or written (${resolve(config.SWARMFORGE_DB_PATH)}).`
        : persistentDb
          ? `The database file or its parent directory is not writable: ${resolve(config.SWARMFORGE_DB_PATH)}.`
          : "The server requires a persistent database file; :memory: is unsupported.",
    });

    for (const [name, path] of [
      [
        "GitHub App private key",
        config.SWARMFORGE_GIT_PUSH_MODE === "github-app"
          ? config.SWARMFORGE_GITHUB_PRIVATE_KEY_PATH
          : undefined,
      ],
      [
        "SSH private key",
        config.SWARMFORGE_GIT_PUSH_MODE === "ssh"
          ? config.SWARMFORGE_GIT_SSH_KEY_PATH
          : undefined,
      ],
      [
        "SSH known-hosts file",
        config.SWARMFORGE_GIT_PUSH_MODE === "ssh"
          ? config.SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH
          : undefined,
      ],
    ] as const) {
      if (!path) continue;
      const exists =
        existsSync(path) &&
        pathIs(path, "file") &&
        hasPermission(path, constants.R_OK);
      checks.push({
        name,
        status: exists ? "pass" : "fail",
        message: exists
          ? `Readable file: ${path}.`
          : `File is missing or unreadable: ${path}.`,
      });
    }

    checks.push({
      name: "Freestyle snapshot",
      status: "warn",
      message: `Snapshot ${config.FREESTYLE_SNAPSHOT_ID} is configured; its required guest tools (including Git) and workspace cannot be checked locally.`,
    });
    checks.push({
      name: "Model endpoint",
      status: "warn",
      message: `Model ${config.SWARMFORGE_MODEL_NAME} is configured; endpoint reachability and tool-call compatibility were not checked.`,
    });
    checks.push({
      name: "Git handoff",
      status: config.SWARMFORGE_GIT_PUSH_MODE === "none" ? "warn" : "pass",
      message:
        config.SWARMFORGE_GIT_PUSH_MODE === "none"
          ? "Automatic branch push is disabled; use the configured external Git workflow."
          : `Automatic ${config.SWARMFORGE_GIT_PUSH_MODE} branch handoff is configured.`,
    });
  }

  return settings
    ? checks.map((check) => ({
        ...check,
        message: redactedText(settings!, check.message),
      }))
    : checks;
}

export async function runDoctor(options: SettingsOptions = {}, json = false) {
  const checks = await doctorChecks(options);
  const failed = checks.some((check) => check.status === "fail");
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: !failed, checks }, null, 2)}\n`,
    );
  } else {
    process.stdout.write("SwarmForge local readiness check\n\n");
    for (const check of checks) {
      const label = check.status.toUpperCase().padEnd(4);
      const line = `${label} ${check.name}: ${check.message}\n`;
      process.stdout.write(line);
    }
    process.stdout.write(
      `\n${failed ? "Setup needs attention." : "Local checks passed; remote services and snapshot contents remain unverified."}\n`,
    );
  }
  return failed ? 1 : 0;
}

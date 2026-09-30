import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

export type EnvView = Record<string, string | undefined>;

/** SQLite in-memory selector; kept verbatim so it is never anchored to a directory. */
export const SQLITE_MEMORY = ":memory:";

/**
 * The home directory used for `~` expansion and the XDG fallbacks. Only an
 * absolute `HOME` is trusted so a relative value cannot move a database or a
 * key path somewhere else than the operator meant.
 */
export function homeDirectory(env: EnvView): string {
  for (const key of ["HOME", "USERPROFILE"]) {
    const value = env[key];
    if (value && isAbsolute(value)) return normalize(value);
  }
  return normalize(homedir());
}

/**
 * Expands a leading `~` to the home directory. Nothing else is substituted:
 * no shell expansion, no variables, no command substitution.
 */
export function expandTilde(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return normalize(join(home, value.slice(2)));
  return value;
}

/**
 * Resolves a host path declared in configuration to an absolute path.
 *
 * Paths in a config file anchor at that file's directory; paths passed on the
 * command line anchor at the invocation directory. A leading `~` expands to the
 * home directory.
 */
export function anchorPath(value: string, base: string, home: string): string {
  const trimmed = value.trim();
  if (trimmed === SQLITE_MEMORY) return trimmed;
  const expanded = expandTilde(trimmed, home);
  return normalize(isAbsolute(expanded) ? expanded : resolve(base, expanded));
}

/**
 * An XDG base directory is only used when absolute. A relative value is ignored
 * instead of being resolved against the working directory, which would silently
 * move configuration and databases.
 */
function xdgBase(env: EnvView, variable: string, fallback: string): string {
  const value = env[variable];
  if (value && isAbsolute(value)) return normalize(value);
  return join(homeDirectory(env), fallback);
}

/** `$XDG_CONFIG_HOME/swarmforge/config.toml`, else `~/.config/swarmforge/config.toml`. */
export function defaultConfigPath(env: EnvView): string {
  return join(
    xdgBase(env, "XDG_CONFIG_HOME", ".config"),
    "swarmforge",
    "config.toml",
  );
}

/** `$XDG_DATA_HOME/swarmforge/swarmforge.sqlite`, else `~/.local/share/swarmforge/swarmforge.sqlite`. */
export function defaultDatabasePath(env: EnvView): string {
  return join(
    xdgBase(env, "XDG_DATA_HOME", ".local/share"),
    "swarmforge",
    "swarmforge.sqlite",
  );
}

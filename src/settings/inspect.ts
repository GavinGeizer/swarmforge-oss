import type { Config } from "../config";
import { Redactor } from "../security";
import type { ClientSettings, ResolvedSettings } from "./load";

/** Configuration keys whose values are credentials and never leave the process. */
export const SECRET_KEYS = [
  "FREESTYLE_API_TOKEN",
  "SWARMFORGE_MODEL_API_KEY",
  "SWARMFORGE_API_TOKEN",
];

/**
 * Credential keys are always masked. A credential shorter than this is still
 * masked in its own field but is not removed from other text, where it would
 * match ordinary characters and destroy the diagnostic.
 */
const SCRUBBABLE = 8;

const scrubbable = (secrets: string[]) =>
  secrets.filter((secret) => secret.length >= SCRUBBABLE);

export interface RedactedSettings {
  /** Config file that contributed values, or null when none was read. */
  config_path: string | null;
  /** Every resolved setting, with credential values replaced by `[REDACTED]`. */
  values: Record<string, string>;
  /** Source label per setting, matching `ResolvedSettings.provenance`. */
  sources: Record<string, string>;
  /** Keys whose value is a credential. */
  secrets: string[];
}

const isServer = (value: object): value is Config => "SWARMFORGE_HOST" in value;

/**
 * Renders resolved settings as plain JSON-serializable data.
 *
 * Credential values are replaced outright and every remaining string is scanned
 * for resolved credential material, so a token that was written into an
 * unrelated setting or into a path is still removed.
 */
export function redactedSettings(
  settings: ResolvedSettings<Config> | ResolvedSettings<ClientSettings>,
): RedactedSettings {
  const value = settings.value as Record<string, unknown>;
  const secretKeys = new Set(isServer(value) ? SECRET_KEYS : ["token"]);
  const secrets = [...secretKeys].filter(
    (key) => value[key] !== undefined && String(value[key]) !== "",
  );
  const redactor = new Redactor(() =>
    scrubbable(secrets.map((key) => String(value[key]))),
  );
  const entries: [string, unknown][] = isServer(value)
    ? Object.entries(value)
    : (["url", "token"] as const).map((key) => [key, value[key]]);
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [key, entry] of entries) {
    sources[key] = settings.provenance[key] ?? "default";
    if (entry === undefined) continue;
    const text = String(entry);
    values[key] = secretKeys.has(key) ? "[REDACTED]" : redactor.text(text);
  }
  return {
    config_path: settings.configPath
      ? redactor.text(settings.configPath)
      : null,
    values,
    sources,
    secrets: secrets.sort(),
  };
}

/** Replaces resolved credential material anywhere in diagnostic text. */
export function redact(text: string, secrets: Iterable<string>): string {
  return new Redactor(() => scrubbable([...secrets])).text(text);
}

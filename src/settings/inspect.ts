import type { Config } from "../config";
import { Redactor } from "../security";
import type { ClientSettings, ResolvedSettings } from "./load";

/** Configuration keys whose values are credentials and never leave the process. */
export const SECRET_KEYS = [
  "FREESTYLE_API_TOKEN",
  "SWARMFORGE_MODEL_API_KEY",
  "SWARMFORGE_API_TOKEN",
];

export interface RedactedSettings {
  /** Config file that contributed values, or null when none was read. */
  config_path: string | null;
  /** Every resolved setting, with credential values replaced by `[REDACTED]`. */
  values: Record<string, string>;
  /** Source label per reported setting, matching `ResolvedSettings.provenance`. */
  sources: Record<string, string>;
  /** Reported keys whose value is a credential. */
  secrets: string[];
}

const isServer = (value: object): value is Config => "SWARMFORGE_HOST" in value;

/**
 * Removes C0 and C1 control characters so rendered diagnostics stay on one
 * printable line and cannot carry a terminal escape sequence.
 */
export function plain(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("");
}

/**
 * Renders resolved settings as plain JSON-serializable data.
 *
 * Credential values are replaced outright and every other string - value,
 * source label and config path - is scanned for resolved credential material,
 * so a token written into an unrelated setting, a path or a file name is still
 * removed. `values` and `sources` always report the same keys.
 */
export function redactedSettings(
  settings: ResolvedSettings<Config> | ResolvedSettings<ClientSettings>,
): RedactedSettings {
  const value = settings.value as Record<string, unknown>;
  const secretKeys = new Set(isServer(value) ? SECRET_KEYS : ["token"]);
  // Every nonempty value counts, including a short one: the loader accepts any
  // string, so a one-character credential is still a credential.
  const reported = [...secretKeys].filter(
    (key) => typeof value[key] === "string" && value[key] !== "",
  );
  const redactor = new Redactor(() =>
    reported.map((key) => String(value[key])),
  );
  const entries: [string, unknown][] = isServer(value)
    ? Object.entries(value)
    : (["url", "token"] as const).map((key) => [key, value[key]]);
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (entry === undefined) continue;
    values[key] = secretKeys.has(key)
      ? "[REDACTED]"
      : plain(redactor.text(String(entry)));
    sources[key] = plain(redactor.text(settings.provenance[key] ?? "default"));
  }
  return {
    config_path: settings.configPath
      ? plain(redactor.text(settings.configPath))
      : null,
    values,
    sources,
    secrets: reported.sort(),
  };
}

/**
 * Replaces resolved credential material anywhere in diagnostic text. Every
 * nonempty credential counts, so a short credential is removed too, at the cost
 * of a diagnostic that over-redacts ordinary text.
 */
export function redact(text: string, secrets: Iterable<string>): string {
  return new Redactor(() => [...secrets].filter(Boolean)).text(text);
}

import type { Config } from "../config";
import { Redactor } from "../security";
import type { ClientSettings, ResolvedSettings } from "./load";

/** Configuration keys whose values are credentials and never leave the process. */
export const SECRET_KEYS = [
  "FREESTYLE_API_TOKEN",
  "SWARMFORGE_MODEL_API_KEY",
  "SWARMFORGE_API_TOKEN",
];

// Keep credentials from every source layer and both settings surfaces private.
// They must never become an enumerable property of a resolved settings object.
const credentialContexts = new WeakMap<object, string[]>();

export function withRedactionContext<T>(
  settings: ResolvedSettings<T>,
  credentials: Iterable<string>,
): ResolvedSettings<T> {
  credentialContexts.set(settings, [...credentials].filter(Boolean));
  return settings;
}

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

/** Credential keys whose value is a credential on the given settings surface. */
function secretKeysFor(value: Record<string, unknown>): Set<string> {
  return new Set(isServer(value) ? SECRET_KEYS : ["token"]);
}

/**
 * The credential keys of a result that actually carry a value.
 *
 * Every nonempty value counts, including a short one: the loader accepts any
 * string, so a one-character credential is still a credential.
 */
function reportedCredentials(value: Record<string, unknown>): string[] {
  return [...secretKeysFor(value)].filter(
    (key) => typeof value[key] === "string" && value[key] !== "",
  );
}

/**
 * The redactor a resolved result carries: the credential material collected from
 * every source layer, including values a later layer superseded, plus the
 * credential values the result itself currently holds.
 */
function resultRedactor(
  settings: ResolvedSettings<Config> | ResolvedSettings<ClientSettings>,
  value: Record<string, unknown>,
): Redactor {
  return new Redactor(() => [
    ...(credentialContexts.get(settings) ?? []),
    ...reportedCredentials(value).map((key) => String(value[key])),
  ]);
}

/** Control removal must not assemble a credential after the final redaction. */
function plainRedacted(redactor: Redactor, text: string) {
  return redactor.text(plain(redactor.text(text)));
}

/**
 * Removes credential material and control characters from text, using the
 * credential context recorded for a resolved result.
 *
 * A command that reports something the loader produced - a remote error that
 * echoed a bearer header, a URL an operator typed - needs the same context
 * `redactedSettings` uses, without rebuilding it from selected fields and
 * without changing the result it was handed. The result is only read, so it is
 * never mutated and can be reported as often as needed.
 */
export function redactedText(
  settings: ResolvedSettings<Config> | ResolvedSettings<ClientSettings>,
  text: string,
): string {
  return plainRedacted(
    resultRedactor(settings, settings.value as Record<string, unknown>),
    text,
  );
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
  const secretKeys = secretKeysFor(value);
  const reported = reportedCredentials(value);
  const redactor = resultRedactor(settings, value);
  const entries: [string, unknown][] = isServer(value)
    ? Object.entries(value)
    : (["url", "token"] as const).map((key) => [key, value[key]]);
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (entry === undefined) continue;
    values[key] = secretKeys.has(key)
      ? "[REDACTED]"
      : plainRedacted(redactor, String(entry));
    sources[key] = plainRedacted(
      redactor,
      settings.provenance[key] ?? "default",
    );
  }
  return {
    config_path: settings.configPath
      ? plainRedacted(redactor, settings.configPath)
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
  const known = [...secrets].filter(Boolean);
  return plainRedacted(new Redactor(() => known), text);
}

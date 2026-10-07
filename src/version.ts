import packageJson from "../package.json" with { type: "json" };

// Packaging replaces these two identifiers at compile time. The `--define` flag
// takes a space separated pair, so a packaged build is produced with
// `bun build --compile --define SWARMFORGE_BUILD_VERSION='"1.2.3"'` and
// `--define SWARMFORGE_BUILD_COMMIT='"1a2b3c4"'`. They are declared rather than
// imported so a source run has no such global, and the typeof guard keeps the
// unguarded reference unreachable.
declare const SWARMFORGE_BUILD_VERSION: string | undefined;
declare const SWARMFORGE_BUILD_COMMIT: string | undefined;

/** Build identifier reported when packaging did not supply a commit. */
export const unknownCommit = "unknown";

export const LICENSE_ID = "PolyForm-Small-Business-1.0.0";
export const LICENSE_URL =
  "https://polyformproject.org/licenses/small-business/1.0.0";

function override(declared: string | undefined, fallback: string): string {
  return typeof declared === "string" && declared.trim() !== ""
    ? declared.trim()
    : fallback;
}

/**
 * The SwarmForge version.
 *
 * A packaged build reports the value baked in by `SWARMFORGE_BUILD_VERSION`; a
 * source run falls back to the version in `package.json`, so the two can never
 * disagree silently.
 */
export const VERSION: string = override(
  typeof SWARMFORGE_BUILD_VERSION === "undefined"
    ? undefined
    : SWARMFORGE_BUILD_VERSION,
  packageJson.version,
);

/**
 * The commit a packaged build was produced from, or {@link unknownCommit}.
 *
 * A source checkout has no baked-in commit, so this is `unknown` unless
 * `SWARMFORGE_BUILD_COMMIT` is defined. It is a display identifier only: nothing
 * in the runtime resolves it against a repository.
 */
export const COMMIT: string = override(
  typeof SWARMFORGE_BUILD_COMMIT === "undefined"
    ? undefined
    : SWARMFORGE_BUILD_COMMIT,
  unknownCommit,
);

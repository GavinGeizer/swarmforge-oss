import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The trusted guest helper, loaded from the file that is also shipped inside the
 * guest. Tests run these exact bytes as a subprocess, so the fixture exercises
 * production capture code rather than a reimplementation of it.
 */
export const helperPath = fileURLToPath(
  new URL("./artifact-helper.py", import.meta.url),
);

let cached: Uint8Array | null = null;

export function artifactHelperSource(): Uint8Array {
  cached ??= new Uint8Array(readFileSync(helperPath));
  return cached;
}

import { fileURLToPath } from "node:url";
import helperSource from "./artifact-helper.py" with { type: "text" };

/**
 * The trusted guest helper, embedded as text in standalone builds and shipped
 * inside the guest. Tests run these exact bytes as a subprocess, so the fixture exercises
 * production capture code rather than a reimplementation of it.
 */
export const helperPath = fileURLToPath(
  new URL("./artifact-helper.py", import.meta.url),
);

let cached: Uint8Array | null = null;

export function artifactHelperSource(): Uint8Array {
  cached ??= new TextEncoder().encode(helperSource);
  return cached;
}

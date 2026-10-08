import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { previewTarget } from "./preview-target.mjs";

const secretsFile = process.env.CF_PREVIEW_SECRETS_FILE;
if (!secretsFile || (statSync(secretsFile).mode & 0o077) !== 0) {
  throw new Error(
    "CF_PREVIEW_SECRETS_FILE must identify a private secrets file (mode 0600).",
  );
}
previewTarget();
// Metadata retrieval is read-only. Deployment never targets a production mode,
// custom domain, or an unverified database. The configuration contains no prod.
execFileSync(
  "cf",
  [
    "deploy",
    "--mode",
    "preview",
    "--provision=false",
    "--secrets-file",
    secretsFile,
  ],
  { stdio: "inherit" },
);

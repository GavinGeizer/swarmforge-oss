import { execFileSync } from "node:child_process";

const databaseId = process.env.CF_PREVIEW_D1_ID;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const origin = process.env.CF_PREVIEW_API_ORIGIN;
if (!databaseId || !accountId || !origin) {
  throw new Error(
    "Set CF_PREVIEW_D1_ID, CLOUDFLARE_ACCOUNT_ID and CF_PREVIEW_API_ORIGIN for an isolated preview.",
  );
}
const database = JSON.parse(
  execFileSync("cf", ["d1", "get", databaseId], { encoding: "utf8" }),
);
if (database.name !== "swarmforge-cloud-preview") {
  throw new Error(
    "Preview deployment requires a database named swarmforge-cloud-preview; other databases are refused.",
  );
}
// Metadata retrieval is read-only. Deployment never targets a production mode,
// custom domain, or an unverified database. The configuration contains no prod.
execFileSync("cf", ["deploy", "--mode", "preview"], { stdio: "inherit" });

import { execFileSync } from "node:child_process";

export function previewTarget() {
  const databaseId = process.env.CF_PREVIEW_D1_ID;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origin = process.env.CF_PREVIEW_API_ORIGIN;
  if (!databaseId || !accountId || !origin) {
    throw new Error(
      "Set CF_PREVIEW_D1_ID, CLOUDFLARE_ACCOUNT_ID and CF_PREVIEW_API_ORIGIN for an isolated preview.",
    );
  }
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      databaseId,
    ) ||
    databaseId === "00000000-0000-4000-8000-00000000002a"
  ) {
    throw new Error("Preview requires exact HTTPS origin and separate D1 UUID");
  }
  const database = JSON.parse(
    execFileSync("cf", ["d1", "get", databaseId], { encoding: "utf8" }),
  );
  if (database.name !== "swarmforge-cloud-preview") {
    throw new Error(
      "Preview requires a database named swarmforge-cloud-preview; other databases are refused.",
    );
  }
  return databaseId;
}

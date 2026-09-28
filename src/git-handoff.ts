import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "./config";

export class GitHandoffError extends Error {}

export function branchFor(w: {
  team_id: string;
  task_id: string;
  worker_id: string;
}) {
  const part = (value: string) =>
    value.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "id";
  return `swarmforge/${part(w.team_id)}/${part(w.task_id)}/${part(w.worker_id)}`;
}

export async function githubInstallationToken(
  c: Config,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (
    !c.SWARMFORGE_GITHUB_APP_ID ||
    !c.SWARMFORGE_GITHUB_INSTALLATION_ID ||
    !c.SWARMFORGE_GITHUB_PRIVATE_KEY_PATH ||
    !c.SWARMFORGE_GITHUB_REPOSITORY
  )
    throw new Error("GitHub App configuration is incomplete");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60,
      exp: now + 540,
      iss: c.SWARMFORGE_GITHUB_APP_ID,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer
    .sign(readFileSync(c.SWARMFORGE_GITHUB_PRIVATE_KEY_PATH))
    .toString("base64url");
  const response = await fetcher(
    `https://api.github.com/app/installations/${c.SWARMFORGE_GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${data}.${signature}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repositories: [c.SWARMFORGE_GITHUB_REPOSITORY.split("/")[1]],
        permissions: { contents: "write" },
      }),
      signal: AbortSignal.timeout(c.SWARMFORGE_API_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new Error(`GitHub App token request failed (${response.status})`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("token" in body) ||
    typeof body.token !== "string" ||
    !body.token
  )
    throw new Error("GitHub App token response is invalid");
  return body.token;
}

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defaultConfigPath } from "./settings/paths";

export const githubRepository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const credentialSchema = z.object({
  version: z.literal(1),
  clientId: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  repository: z.string().regex(githubRepository),
  login: z.string().regex(/^[A-Za-z0-9-]+$/),
  accessToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_]+$/),
  expiresAt: z.number().positive().optional(),
});
export type GithubCredential = z.infer<typeof credentialSchema>;
const knownSecrets = new Set<string>();
export function oauthSecrets(): string[] {
  return [...knownSecrets];
}
export function defaultOauthPath() {
  return join(dirname(defaultConfigPath(process.env)), "github-oauth.json");
}

export function readOauthCredential(path: string): GithubCredential {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > 16384 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new Error();
    const credential = credentialSchema.parse(
      JSON.parse(readFileSync(fd, "utf8")),
    );
    knownSecrets.add(credential.accessToken);
    return credential;
  } catch {
    throw new Error(
      "GitHub OAuth credentials are missing, invalid, or not privately owned (0600). Run swarmforge github login.",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function saveCredential(path: string, credential: GithubCredential) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(credential)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

export function githubOauthToken(path: string, repository: string): string {
  const credential = readOauthCredential(path);
  if (credential.repository.toLowerCase() !== repository.toLowerCase())
    throw new Error(
      "GitHub OAuth credential is bound to a different repository. Run swarmforge github login for this repository.",
    );
  if (credential.expiresAt && credential.expiresAt <= Date.now() + 60000)
    throw new Error(
      "GitHub OAuth credentials have expired or are about to expire. Run swarmforge github login again.",
    );
  return credential.accessToken;
}

async function request(
  url: string,
  signal: AbortSignal,
  body?: Record<string, string>,
  token?: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "User-Agent": "SwarmForge",
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok) throw new Error();
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 131072) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new Error(
      signal.aborted
        ? "GitHub authorization cancelled."
        : "GitHub authorization request failed. Check connectivity, OAuth App settings, and repository access.",
    );
  }
}

const deviceSchema = z.object({
  device_code: z.string().min(1).max(512),
  user_code: z.string().regex(/^[A-Z0-9-]+$/),
  verification_uri: z.literal("https://github.com/login/device"),
  expires_in: z.number().int().min(1).max(1800),
  interval: z.number().int().min(1).max(60),
});
export async function loginGithub(options: {
  showConfiguration?: boolean;
  clientId: string;
  repository: string;
  path: string;
  signal: AbortSignal;
  write: (message: string) => void;
}) {
  const { clientId, repository, path, signal, write } = options;
  const raw = await request("https://github.com/login/device/code", signal, {
    client_id: clientId,
    scope: "repo",
  });
  const parsed = deviceSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "GitHub device flow is unavailable. Enable device flow in your OAuth App settings.",
    );
  const device = parsed.data;
  write(
    `Open ${device.verification_uri} and enter code ${device.user_code}.\nGitHub's repo scope grants broad repository access; SwarmForge will use ${repository}.`,
  );
  const deadline = Date.now() + device.expires_in * 1000;
  const pollingSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(device.expires_in * 1000),
  ]);
  let interval = device.interval;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(new Error("GitHub authorization cancelled or expired."));
      };
      const timer = setTimeout(() => {
        pollingSignal.removeEventListener("abort", cancel);
        resolve();
      }, interval * 1000);
      if (pollingSignal.aborted) cancel();
      else pollingSignal.addEventListener("abort", cancel, { once: true });
    });
    const result = await request(
      "https://github.com/login/oauth/access_token",
      pollingSignal,
      {
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    );
    if (result.error === "authorization_pending") continue;
    if (result.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (result.error)
      throw new Error(
        "GitHub authorization was denied, expired, or rejected. Run login again and check your OAuth App settings.",
      );
    if (
      typeof result.access_token !== "string" ||
      !/^[A-Za-z0-9_]{1,4096}$/.test(result.access_token) ||
      result.token_type !== "bearer" ||
      typeof result.scope !== "string" ||
      !result.scope.split(/[ ,]+/).includes("repo")
    )
      throw new Error(
        "GitHub did not grant the required repository authorization.",
      );
    knownSecrets.add(result.access_token);
    if (typeof result.refresh_token === "string")
      knownSecrets.add(result.refresh_token);
    const user = await request(
      "https://api.github.com/user",
      signal,
      undefined,
      result.access_token,
    );
    const repo = await request(
      `https://api.github.com/repos/${repository}`,
      signal,
      undefined,
      result.access_token,
    );
    const permissions = repo.permissions as Record<string, unknown> | undefined;
    if (permissions?.push !== true)
      throw new Error(
        "GitHub account does not have push permission for this repository.",
      );
    const credential = credentialSchema.safeParse({
      version: 1,
      clientId,
      repository,
      login: user.login,
      accessToken: result.access_token,
      expiresAt:
        typeof result.expires_in === "number" &&
        Number.isFinite(result.expires_in) &&
        result.expires_in > 0
          ? Date.now() + result.expires_in * 1000
          : undefined,
    });
    if (!credential.success)
      throw new Error("GitHub returned invalid account or credential details.");
    signal.throwIfAborted();
    saveCredential(path, credential.data);
    if (options.showConfiguration === false) {
      write(
        `Connected GitHub account ${credential.data.login}. Credentials saved privately to ${path}.`,
      );
      return;
    }
    write(
      `Connected GitHub account ${credential.data.login}. Credentials saved privately to ${path}.\nAdd or merge this into your server configuration:\n\n[git]\ntree = ${JSON.stringify(`https://github.com/${repository}.git`)}\npush_mode = "github-oauth"\n\n[git.github_oauth]\nrepository = ${JSON.stringify(repository)}\ncredentials_path = ${JSON.stringify(path)}\n\nRestart swarmforge serve after updating configuration.`,
    );
    return;
  }
  throw new Error("GitHub device authorization expired. Run login again.");
}

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
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const credentialSchema = z.object({
  version: z.literal(1),
  credential: z.string().regex(/^sfcli_[A-Za-z0-9_-]{40,64}$/),
  credential_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  subject_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  scopes: z.array(z.string()),
  expires_at: z.number().positive(),
  authorization_expires_at: z.number().positive(),
  server_url: z.string().url(),
});

export type CloudCredential = z.infer<typeof credentialSchema>;

const MAX_SIZE = 16384;

export function defaultCloudPath(env: NodeJS.ProcessEnv): string {
  const xdgConfig = env.XDG_CONFIG_HOME;
  if (xdgConfig && require("node:path").isAbsolute(xdgConfig)) {
    return join(xdgConfig, "swarmforge", "cloud-credentials.json");
  }
  const home = homedir();
  return join(home, ".config", "swarmforge", "cloud-credentials.json");
}

export function resolveCloudPath(
  path: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (path && isAbsolute(path)) return path;
  return defaultCloudPath(env);
}

export function readCloudCredential(path: string): CloudCredential {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_SIZE) throw new Error("file");
    if (info.mode & 0o077) throw new Error("mode");
    if (info.uid !== process.getuid?.()) throw new Error("uid");
    const content = readFileSync(fd, "utf8");
    if (content.length > MAX_SIZE) throw new Error("size");
    const credential = credentialSchema.parse(JSON.parse(content));
    return credential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Cloud credentials are missing. Run swarmforge cloud login.",
      );
    }
    if ((error as NodeJS.ErrnoException).code === "EACCES") {
      throw new Error("Cloud credentials are not privately owned (0600).");
    }
    throw new Error("Cloud credentials are invalid or corrupted.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function saveCredential(path: string, credential: CloudCredential): void {
  const dir = dirname(path);
  try {
    const stat = fstatSync(openSync(dir, constants.O_RDONLY));
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("credential directory is not private");
    }
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(credential)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tempPath, path);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {}
  }
}

export function getCloudCredential(env: NodeJS.ProcessEnv): CloudCredential {
  const path = resolveCloudPath(env.SWARMFORGE_CLOUD_CREDENTIALS_PATH, env);
  return readCloudCredential(path);
}

export function getCloudCredentialOpt(
  env: NodeJS.ProcessEnv,
): CloudCredential | null {
  try {
    return getCloudCredential(env);
  } catch {
    return null;
  }
}

export function saveCloudCredential(
  path: string | undefined,
  credential: CloudCredential,
  env: NodeJS.ProcessEnv,
): void {
  const resolvedPath = resolveCloudPath(path, env);
  saveCredential(resolvedPath, credential);
}

export function deleteCloudCredential(
  path: string | undefined,
  env: NodeJS.ProcessEnv,
): void {
  try {
    const resolvedPath = resolveCloudPath(path, env);
    unlinkSync(resolvedPath);
  } catch {
    // Ignore errors when deleting
  }
}

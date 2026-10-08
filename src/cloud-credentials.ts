import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultConfigPath } from "./settings/paths";
export function cloudOrigin(value: string) {
  try {
    const u = new URL(value);
    if (
      u.origin !== value ||
      u.username ||
      u.password ||
      (u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname)
        ))
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "Cloud URL must be an exact HTTPS origin (HTTP is allowed only on loopback).",
    );
  }
}
export const cloudCredentialSchema = z
  .object({
    version: z.literal(1),
    server_url: z.string().refine((v) => {
      try {
        cloudOrigin(v);
        return true;
      } catch {
        return false;
      }
    }),
    credential: z.string().regex(/^sfcli_[A-Za-z0-9_-]{43}$/),
    credential_id: z.uuid(),
    installation_id: z.uuid(),
    subject_id: z.uuid(),
    tenant_id: z.uuid(),
    scopes: z.tuple([z.literal("identity:read"), z.literal("devices:self")]),
    expires_at: z.number().int().positive(),
    authorization_expires_at: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.expires_at <= v.authorization_expires_at);
export type CloudCredential = z.infer<typeof cloudCredentialSchema>;
export function cloudCredentialPath(path?: string, env = process.env) {
  return resolve(
    path ??
      env.SWARMFORGE_CLOUD_CREDENTIALS_PATH ??
      join(dirname(defaultConfigPath(env)), "cloud-credentials.json"),
  );
}
const storageError = () =>
  new Error(
    "Cloud credential storage must use a privately owned regular file (0600) in a private directory (0700), without symlinks.",
  );
function parent(path: string, create = false) {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error(
      "Cloud credential file storage requires POSIX permissions; use a supported Linux or macOS host.",
    );
  const directory = dirname(resolve(path)),
    chain: string[] = [];
  let at = directory;
  for (;;) {
    chain.unshift(at);
    const next = dirname(at);
    if (next === at) break;
    at = next;
  }
  for (const d of chain) {
    let s: ReturnType<typeof lstatSync>;
    try {
      s = lstatSync(d);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create)
        throw storageError();
      mkdirSync(d, { mode: 0o700 });
      s = lstatSync(d);
    }
    const writable = s.mode & 0o022;
    const stickyRootTemp = s.uid === 0 && Boolean(s.mode & 0o1000);
    if (
      s.isSymbolicLink() ||
      !s.isDirectory() ||
      (s.uid !== 0 && s.uid !== uid) ||
      (writable && !stickyRootTemp)
    )
      throw storageError();
    if (d === directory && (s.uid !== uid || (s.mode & 0o077) !== 0))
      throw storageError();
  }
}
function regular(path: string) {
  try {
    const s = lstatSync(path);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0 ||
      s.nlink !== 1
    )
      throw storageError();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw storageError();
  }
}
export function readCloudCredential(path: string): CloudCredential | null {
  let fd: number | undefined;
  try {
    // Missing file is a normal signed-out state. Existing unsafe paths are errors.
    try {
      lstatSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    parent(path);
    regular(path);
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0 ||
      s.nlink !== 1 ||
      s.size > 16384
    )
      throw storageError();
    return cloudCredentialSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    throw storageError();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function saveCloudCredential(path: string, value: CloudCredential) {
  const data = cloudCredentialSchema.safeParse(value);
  if (!data.success) throw new Error("Cloud credential response is invalid.");
  parent(path, true);
  regular(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(data.data)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    throw storageError();
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
export function deleteCloudCredential(path: string) {
  try {
    if (!readCloudCredential(path)) return;
    unlinkSync(path);
  } catch {
    throw storageError();
  }
}

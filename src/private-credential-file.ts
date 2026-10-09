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
import { dirname, resolve } from "node:path";
import type { z } from "zod";

export const privateCredentialLimit = 16384;

function supportedPlatform(platform = process.platform) {
  if (platform === "win32")
    throw new Error(
      "Private credential file storage requires POSIX permissions; use a supported Linux or macOS host.",
    );
}

export const privateCredentialStorageError = () =>
  new Error(
    "Cloud credential storage must use a privately owned regular file (0600) in a private directory (0700), without symlinks.",
  );

function parentDirectory(path: string, create: boolean) {
  supportedPlatform();
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error(
      "Private credential file storage requires POSIX permissions; use a supported Linux or macOS host.",
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
        throw privateCredentialStorageError();
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
      throw privateCredentialStorageError();
    if (d === directory && (s.uid !== uid || (s.mode & 0o077) !== 0))
      throw privateCredentialStorageError();
  }
}

function existingRegularFile(path: string) {
  try {
    const s = lstatSync(path);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0 ||
      s.nlink !== 1
    )
      throw privateCredentialStorageError();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw privateCredentialStorageError();
  }
}

export function readPrivateCredential<T>(
  path: string,
  schema: z.ZodType<T>,
): T | null {
  let fd: number | undefined;
  supportedPlatform();
  try {
    // Missing file is a normal signed-out state. Existing unsafe paths are errors.
    try {
      lstatSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    parentDirectory(path, false);
    existingRegularFile(path);
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
      s.size > privateCredentialLimit
    )
      throw privateCredentialStorageError();
    return schema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    throw privateCredentialStorageError();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function savePrivateCredential<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>,
): void {
  const data = schema.safeParse(value);
  if (!data.success) throw new Error("Cloud credential response is invalid.");
  supportedPlatform();
  parentDirectory(path, true);
  existingRegularFile(path);
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
    throw privateCredentialStorageError();
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

export function deletePrivateCredential<T>(
  path: string,
  schema: z.ZodType<T>,
): void {
  try {
    supportedPlatform();
    if (!readPrivateCredential(path, schema)) return;
    unlinkSync(path);
  } catch (e) {
    if (e instanceof Error && e.message.includes("requires POSIX permissions"))
      throw e;
    throw privateCredentialStorageError();
  }
}

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathGuidance } from "../src/cli/install-guidance";
import { homeDirectory } from "../src/settings/paths";
import { compileCli } from "./build";

/** Replace by rename so a running process retains its original executable. */
export async function installExecutable(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
  let copied = false;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    copied = true;
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    if (copied)
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

export async function installLocal(
  binDir = join(homeDirectory(process.env), ".local", "bin"),
) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      "The standalone executable currently supports Linux x64 with glibc only.",
    );
  process.stdout.write("Building the standalone SwarmForge executable…\n");
  const built = await compileCli();
  const path = join(resolve(binDir), "swarmforge");
  await installExecutable(built.path, path);
  process.stdout.write(
    `Installed ${path}\n\n${pathGuidance(dirname(path))}\n\nNext: swarmforge init\n`,
  );
  return path;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length) throw new Error("Usage: bun run install:local");
  await installLocal();
}

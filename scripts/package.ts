/**
 * Builds the versioned release archive around one compiled executable and
 * verifies it.
 *
 * The archive is what an operator installs: the executable, the metadata JSON
 * that says which commit and target it was built from, and `SHA256SUMS` in the
 * format `sha256sum -c` reads. One helper, {@link verifyArchive}, decides whether
 * an archive is installable, and it is used both when the archive is created and
 * when an archive that already exists is verified, so "package" and "verify"
 * cannot disagree about what a good archive is.
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LICENSE_ID, LICENSE_URL } from "../src/version";
import {
  type CompiledBinary,
  compileCli,
  compileTarget,
  distDirectory,
  executableName,
  fileDigest,
  packageVersion,
  repositoryCommit,
  repositoryRoot,
} from "./build";

/** Release file name prefix, which carries the version. */
export const archivePrefix = "swarmforge-v";

/** The only platform this milestone builds, verifies and advertises. */
export const advertisedPlatform = "linux-x64-glibc";

/** Name of the executable inside `dist/` and inside the archive. */
export const manifestName = "SHA256SUMS";

export interface PackagedRelease {
  version: string;
  commit: string;
  target: string;
  metadataPath: string;
  checksumsPath: string;
  archivePath: string;
  archiveSha256: string;
  files: string[];
}

export interface VerifiedArchive {
  archivePath: string;
  archiveSha256: string;
  version: string;
  commit: string;
  target: string;
  /** Files the archive is allowed to contain, in creation order. */
  files: string[];
}

export function archiveName(version: string) {
  return `${archivePrefix}${version}-${advertisedPlatform}.tar.gz`;
}

export function metadataName(version: string) {
  return `metadata-${version}.json`;
}

/** `SHA256SUMS` entry for the executable. */
export function checksums(executable: CompiledBinary) {
  return `${executable.sha256}  ${executableName}\n`;
}

/**
 * Writes the metadata JSON that ships beside the executable.
 *
 * The metadata repeats the definitions baked into the binary and the digest of
 * the file as it is shipped, so an operator can confirm what a binary was built
 * from without trusting the archive name, and packaging can prove the archive
 * was not edited after it was built.
 */
export function buildMetadata(options: {
  version: string;
  commit: string;
  executable: CompiledBinary;
}): Record<string, unknown> {
  return {
    name: "swarmforge",
    license: { spdx: LICENSE_ID, url: LICENSE_URL },
    version: options.version,
    commit: options.commit,
    target: compileTarget,
    platform: advertisedPlatform,
    executable: {
      name: executableName,
      bytes: options.executable.bytes,
      sha256: options.executable.sha256,
      mode: "0755",
    },
    runtime: {
      bun: Bun.version,
      autoload_dotenv: false,
      autoload_bunfig: false,
      autoload_tsconfig: false,
      autoload_package_json: false,
      bytecode: false,
    },
  };
}

async function run(command: string[], cwd: string) {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** Names of the regular files an archive is allowed to contain. */
async function archiveListing(archivePath: string): Promise<string[]> {
  const listed = await run(["tar", "-tzf", archivePath], tmpdir());
  if (listed.code !== 0)
    throw new Error(
      `archive is not a readable tar.gz: ${listed.stderr.trim() || listed.stdout.trim()}`,
    );
  const names = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\//, "").replace(/\/$/, ""));
  const duplicates = names.filter(
    (name, index) => names.indexOf(name) !== index,
  );
  if (duplicates.length > 0)
    throw new Error(
      `archive contains duplicate entries: ${duplicates.join(", ")}`,
    );
  return names.sort();
}

/**
 * Extracts an archive and proves it can actually be installed.
 *
 * This is the only definition of a good archive: the archive must contain
 * exactly the executable, its metadata and `SHA256SUMS`; the executable must
 * extract with mode 0755; the checksums must verify inside the extracted tree;
 * the metadata must agree with the file that ships beside it and with the
 * expected version and commit; and the extracted executable must run with no
 * Bun and no checkout and report the version and commit it was built from.
 * A truncated, edited or repacked archive fails one of those checks.
 */
export async function verifyArchive(options: {
  archivePath: string;
  expectedVersion: string;
  expectedCommit?: string;
}): Promise<VerifiedArchive> {
  const archivePath = options.archivePath;
  const listing = await archiveListing(archivePath);
  const expectedFiles = [
    executableName,
    manifestName,
    metadataName(options.expectedVersion),
  ].sort();
  if (listing.join(" ") !== expectedFiles.join(" "))
    throw new Error(
      `archive contains [${listing.join(", ")}] instead of [${expectedFiles.join(", ")}]`,
    );
  const extracted = await mkdtemp(join(tmpdir(), "swarmforge-verify-"));
  try {
    const untarred = await run(
      ["tar", "-xzf", archivePath, "-C", extracted],
      tmpdir(),
    );
    if (untarred.code !== 0)
      throw new Error(
        `archive did not extract: ${untarred.stderr.trim() || "unknown error"}`,
      );
    const binary = join(extracted, executableName);
    // The execute bit is the first thing an operator hits, and tar does not
    // guarantee it, so check the mode the archive actually carries.
    const mode = (await stat(binary)).mode & 0o777;
    if (mode !== 0o755)
      throw new Error(
        `extracted ${executableName} has mode 0${mode.toString(8)}, not 0755`,
      );
    const checksum = await run(["sha256sum", "-c", manifestName], extracted);
    if (checksum.code !== 0)
      throw new Error(
        `${manifestName} did not verify: ${(checksum.stdout + checksum.stderr).trim()}`,
      );
    const metadata = JSON.parse(
      await readFile(
        join(extracted, metadataName(options.expectedVersion)),
        "utf8",
      ),
    ) as {
      version?: string;
      commit?: string;
      target?: string;
      platform?: string;
      executable?: { sha256?: string; bytes?: number; mode?: string };
    };
    const problems: string[] = [];
    if (metadata.version !== options.expectedVersion)
      problems.push(`metadata version ${metadata.version}`);
    if (metadata.target !== compileTarget)
      problems.push(`metadata target ${metadata.target}`);
    if (metadata.platform !== advertisedPlatform)
      problems.push(`metadata platform ${metadata.platform}`);
    if (options.expectedCommit && metadata.commit !== options.expectedCommit)
      problems.push(`metadata commit ${metadata.commit}`);
    const digest = await fileDigest(binary);
    const bytes = (await stat(binary)).size;
    if (metadata.executable?.sha256 !== digest)
      problems.push(`metadata sha256 ${metadata.executable?.sha256}`);
    if (metadata.executable?.bytes !== bytes)
      problems.push(`metadata size ${metadata.executable?.bytes}`);
    if (metadata.executable?.mode !== "0755")
      problems.push(`metadata mode ${metadata.executable?.mode}`);
    if (problems.length > 0)
      throw new Error(
        `${archivePath} does not describe its own contents: ${problems.join(", ")}`,
      );
    const version = metadata.version as string;
    const commit = metadata.commit as string;
    const reported = await run([binary, "--version"], extracted);
    if (reported.code !== 0 || reported.stdout.trim() !== version)
      throw new Error(
        `extracted executable reported ${reported.stdout.trim() || "(nothing)"} instead of version ${version}`,
      );
    const help = await run([binary, "--help"], extracted);
    if (!help.stdout.includes(`build ${commit}`))
      throw new Error("extracted executable does not report its build commit");
    return {
      archivePath,
      archiveSha256: await fileDigest(archivePath),
      version,
      commit,
      target: compileTarget,
      files: expectedFiles,
    };
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

/**
 * Builds the executable, writes the metadata and checksums, packs them, and
 * verifies the archive it just produced with the same helper used to verify an
 * archive found on disk.
 *
 * `executable` reuses an already compiled and measured binary instead of
 * compiling a second one. The metadata digest and size are re-measured from the
 * staged file, so a reused binary still has to describe itself correctly, and
 * production packaging compiles its own binary.
 */
export async function packageCli(
  options: {
    outDir?: string;
    version?: string;
    commit?: string;
    root?: string;
    executable?: CompiledBinary;
  } = {},
): Promise<PackagedRelease> {
  const root = options.root ?? repositoryRoot;
  const outDir = options.outDir ?? distDirectory;
  const version = options.version ?? (await packageVersion(root));
  const commit = options.commit ?? (await repositoryCommit(root));
  // The output directory is created here as well as by the compiler, because a
  // reused binary is compiled somewhere else.
  await mkdir(outDir, { recursive: true });
  const executable =
    options.executable ??
    (await compileCli({
      outfile: join(outDir, executableName),
      version,
      commit,
      root,
    }));
  if (executable.version !== version || executable.commit !== commit)
    throw new Error(
      `executable was built from ${executable.version} ${executable.commit}, not ${version} ${commit}`,
    );
  const metadata = buildMetadata({ version, commit, executable });
  // A reused binary is compiled elsewhere, so the output directory gets the
  // executable it just packaged as well as the archive that carries it.
  if (executable.path !== join(outDir, executableName)) {
    await Bun.write(
      join(outDir, executableName),
      await readFile(executable.path),
    );
    await chmod(join(outDir, executableName), 0o755);
  }
  const metadataPath = join(outDir, metadataName(version));
  const checksumsPath = join(outDir, manifestName);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(checksumsPath, checksums(executable));
  const archivePath = join(outDir, archiveName(version));
  // The archive is created from a staging directory holding exactly the shipped
  // files, so it never picks up anything else in the output directory.
  const staged = join(outDir, "staging");
  await rm(staged, { recursive: true, force: true });
  await Bun.write(
    join(staged, executableName),
    await readFile(executable.path),
  );
  await chmod(join(staged, executableName), 0o755);
  await Bun.write(
    join(staged, metadataName(version)),
    await readFile(metadataPath),
  );
  await Bun.write(join(staged, manifestName), await readFile(checksumsPath));
  const files = [executableName, metadataName(version), manifestName];
  const packed = await run(
    [
      "tar",
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      archivePath,
      "-C",
      staged,
      ...files,
    ],
    outDir,
  );
  if (packed.code !== 0)
    throw new Error(`tar failed: ${packed.stderr.trim() || "unknown error"}`);
  await rm(staged, { recursive: true, force: true });
  await verifyArchive({
    archivePath,
    expectedVersion: version,
    expectedCommit: commit,
  });
  return {
    version,
    commit,
    target: compileTarget,
    metadataPath,
    checksumsPath,
    archivePath,
    archiveSha256: await fileDigest(archivePath),
    files,
  };
}

async function findFile(directory: string, name: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(directory, entry.name), name).catch(
      () => null,
    );
    if (found) return found;
  }
  throw new Error(`${name} is missing from ${directory}`);
}

/**
 * Verifies the release assets a draft release would publish.
 *
 * The draft job downloads exactly the assets the build job uploaded, so this
 * proves the archive a release would carry is the one that was verified, and it
 * refuses a tag that does not name the packaged version. It never builds
 * anything, so the published archive cannot differ from the tested one.
 */
export async function prepareReleaseAssets(options: {
  directory: string;
  tag: string;
  version?: string;
}): Promise<VerifiedArchive & { assets: string[]; metadataPath: string }> {
  const version = options.version ?? (await packageVersion());
  const mismatch = releaseTagMismatch(options.tag, version);
  if (mismatch) throw new Error(mismatch);
  const archivePath = await findFile(options.directory, archiveName(version));
  const checksumsPath = await findFile(options.directory, manifestName);
  const metadataPath = await findFile(options.directory, metadataName(version));
  const verified = await verifyArchive({
    archivePath,
    expectedVersion: version,
  });
  if (verified.commit !== (await repositoryCommit()).trim())
    throw new Error(
      `archive commit ${verified.commit} does not match the checked out commit`,
    );
  return {
    ...verified,
    metadataPath,
    assets: [archivePath, checksumsPath, metadataPath],
  };
}

/**
 * Compares a release tag with the packaged version.
 *
 * A release must only be cut when the tag names the same version that
 * `package.json` declares, so the archive a tag publishes is the archive that
 * version describes. Returns the reason it does not match, or `null` when it
 * does.
 */
export function releaseTagMismatch(
  tag: string,
  version: string,
): string | null {
  const normalized = tag.startsWith("refs/tags/") ? tag.slice(10) : tag;
  if (!/^v\d+\.\d+\.\d+$/.test(normalized))
    return `release tag ${normalized} is not a vMAJOR.MINOR.PATCH tag`;
  if (normalized.slice(1) !== version)
    return `release tag ${normalized} does not match package.json version ${version}`;
  return null;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "tag") {
    const version = await packageVersion();
    const mismatch = releaseTagMismatch(rest[0] ?? "", version);
    if (mismatch) {
      process.stderr.write(`${mismatch}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ tag: rest[0], version })}\n`);
    return 0;
  }
  if (command === "verify") {
    const outDir = rest[0] ?? distDirectory;
    const version = await packageVersion();
    // The commit is checked when the checkout still has one; a detached
    // archive-only copy can still be checked for version, mode and checksums.
    const commit = await repositoryCommit().catch(() => undefined);
    const verified = await verifyArchive({
      archivePath: join(outDir, archiveName(version)),
      expectedVersion: version,
      expectedCommit: commit,
    });
    process.stdout.write(`${JSON.stringify(verified)}\n`);
    return 0;
  }
  if (command === "release-assets") {
    // release-assets <directory> --tag <tag>
    const [directory, flag, tag] = rest;
    if (!directory || flag !== "--tag" || !tag)
      throw new Error("usage: package.ts release-assets <dir> --tag <tag>");
    const prepared = await prepareReleaseAssets({ directory, tag });
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
    return 0;
  }
  const packaged = await packageCli();
  process.stdout.write(`${JSON.stringify(packaged)}\n`);
  return 0;
}

if (import.meta.main)
  // A verification failure is an operator diagnostic, not a crash: it is
  // reported as one line and a nonzero exit, so a CI step fails readably.
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }

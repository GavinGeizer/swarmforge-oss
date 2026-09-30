/**
 * Builds the versioned release archive around one compiled executable.
 *
 * The archive is what an operator installs: the executable, the metadata JSON
 * that says which commit and target it was built from, and `SHA256SUMS` in the
 * format `sha256sum -c` reads. The archive is verified by extracting it again
 * and running the extracted binary before the build reports success, so an
 * archive that cannot be installed is never published.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
export const archivePrefix = `swarmforge-v`;

/** `SHA256SUMS` entry for the executable. */
export function checksums(executable: CompiledBinary) {
  return `${executable.sha256}  ${executableName}\n`;
}

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

/**
 * Writes the metadata JSON that ships beside the executable.
 *
 * The metadata repeats the definitions baked into the binary, so an operator can
 * confirm what a binary was built from without trusting the archive name.
 */
export function buildMetadata(options: {
  version: string;
  commit: string;
  executable: CompiledBinary;
}): Record<string, unknown> {
  return {
    name: "swarmforge",
    version: options.version,
    commit: options.commit,
    target: compileTarget,
    platform: "linux-x64-glibc",
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

/**
 * Builds the executable, writes the metadata and checksums, packs them, then
 * extracts the archive into a temporary directory and proves the extracted
 * binary runs and still reports the version and commit it was built from.
 */
export async function packageCli(
  options: {
    outDir?: string;
    version?: string;
    commit?: string;
    root?: string;
  } = {},
): Promise<PackagedRelease> {
  const root = options.root ?? repositoryRoot;
  const outDir = options.outDir ?? distDirectory;
  const version = options.version ?? (await packageVersion(root));
  const commit = options.commit ?? (await repositoryCommit(root));
  const executable = await compileCli({
    outfile: join(outDir, executableName),
    version,
    commit,
    root,
  });
  const metadata = buildMetadata({ version, commit, executable });
  const metadataPath = join(outDir, `metadata-${version}.json`);
  const checksumsPath = join(outDir, "SHA256SUMS");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(checksumsPath, checksums(executable));
  const archivePath = join(
    outDir,
    `${archivePrefix}${version}-linux-x64-glibc.tar.gz`,
  );
  // The archive is created from the staged files only, so it never picks up
  // anything else that happens to be in the output directory.
  const staged = join(outDir, "staging");
  await rm(staged, { recursive: true, force: true });
  await Bun.write(
    join(staged, executableName),
    await readFile(executable.path),
  );
  await chmod(join(staged, executableName), 0o755);
  await Bun.write(
    join(staged, basename(metadataPath)),
    await readFile(metadataPath),
  );
  await Bun.write(join(staged, "SHA256SUMS"), await readFile(checksumsPath));
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
      executableName,
      basename(metadataPath),
      "SHA256SUMS",
    ],
    outDir,
  );
  if (packed.code !== 0)
    throw new Error(`tar failed: ${packed.stderr.trim() || "unknown error"}`);
  await rm(staged, { recursive: true, force: true });
  const archiveSha256 = await fileDigest(archivePath);

  const extracted = await mkdtemp(join(tmpdir(), "swarmforge-package-"));
  try {
    const untarred = await run(
      ["tar", "-xzf", archivePath, "-C", extracted],
      outDir,
    );
    if (untarred.code !== 0)
      throw new Error(
        `archive did not extract: ${untarred.stderr.trim() || "unknown error"}`,
      );
    const extractedBinary = join(extracted, executableName);
    const listing = await run(["ls", "-l", extractedBinary], extracted);
    // A binary without the execute bit installs as a source file; check the
    // mode the archive actually carries rather than trusting tar's defaults.
    if (!/^-rwxr-xr-x/.test(listing.stdout))
      throw new Error(
        `extracted executable is not mode 0755: ${listing.stdout.trim()}`,
      );
    const checksum = await run(["sha256sum", "-c", "SHA256SUMS"], extracted);
    if (checksum.code !== 0)
      throw new Error(
        `SHA256SUMS did not verify: ${checksum.stdout.trim()}${checksum.stderr.trim()}`,
      );
    const reported = await run([extractedBinary, "--version"], extracted);
    if (reported.code !== 0 || reported.stdout.trim() !== version)
      throw new Error(
        `extracted executable reported version ${reported.stdout.trim() || "(none)"} instead of ${version}`,
      );
    const help = await run([extractedBinary, "--help"], extracted);
    if (!help.stdout.includes(`build ${commit}`))
      throw new Error("extracted executable does not report its build commit");
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }

  return {
    version,
    commit,
    target: compileTarget,
    metadataPath,
    checksumsPath,
    archivePath,
    archiveSha256,
    files: [executableName, basename(metadataPath), "SHA256SUMS"],
  };
}

/**
 * Reports the metadata and checksums already present in an output directory.
 *
 * The release workflow uploads whatever `package` produced; this reads the same
 * files back so a mismatch between the archive and its checksums is detected
 * before anything is published.
 */
export async function describePackage(
  options: { outDir?: string; version?: string } = {},
): Promise<{ version: string; archivePath: string; archiveSha256: string }> {
  const outDir = options.outDir ?? distDirectory;
  const version = options.version ?? (await packageVersion());
  const archivePath = join(
    outDir,
    `${archivePrefix}${version}-linux-x64-glibc.tar.gz`,
  );
  return { version, archivePath, archiveSha256: await fileDigest(archivePath) };
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

if (import.meta.main) {
  const [command] = process.argv.slice(2);
  if (command === "tag") {
    const tag = process.argv[3] ?? "";
    const version = await packageVersion();
    const mismatch = releaseTagMismatch(tag, version);
    if (mismatch) {
      process.stderr.write(`${mismatch}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({ tag, version })}\n`);
  } else if (command === "verify") {
    const described = await describePackage();
    const integrity = await run(
      ["sha256sum", "-c", "SHA256SUMS"],
      distDirectory,
    );
    if (integrity.code !== 0) {
      process.stderr.write(`${integrity.stdout}${integrity.stderr}`);
      process.exit(1);
    }
    const runtime = await run(
      [join(distDirectory, executableName), "--version"],
      repositoryRoot,
    );
    if (runtime.code !== 0) {
      process.stderr.write(`${runtime.stderr}`);
      process.exit(1);
    }
    process.stdout.write(
      `${JSON.stringify({ ...described, version: runtime.stdout.trim() })}\n`,
    );
  } else {
    const packaged = await packageCli();
    process.stdout.write(`${JSON.stringify(packaged)}\n`);
  }
}

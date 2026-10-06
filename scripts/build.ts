/**
 * Compiles `src/cli.ts` into one standalone executable.
 *
 * The settings in {@link compileSettings} are exported so the packaging tests
 * compile with exactly the settings this script uses: a test that compiles its
 * own binary with different flags would prove nothing about the shipped one.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Repository root, so every command works from any working directory. */
export const repositoryRoot = resolve(import.meta.dir, "..");

/**
 * Compile target: Linux x64, glibc, baseline instruction set.
 *
 * `baseline` avoids instructions that older CPUs fault on, so one advertised
 * binary runs on ordinary x64 servers. This is the only target this milestone
 * advertises, and it is the only target the release workflow builds.
 */
export const compileTarget = "bun-linux-x64-baseline";

/** The platform name reported in build metadata and the archive name. */
export const advertisedPlatform = "linux-x64-glibc";

/** Executable name inside `dist/` and inside the archive. */
export const executableName = "swarmforge";

/** Build output directory, ignored by Git. */
export const distDirectory = join(repositoryRoot, "dist");

/** Default compiled executable path. */
export const binaryPath = join(distDirectory, executableName);

/**
 * Compile settings shared with the packaging tests.
 *
 * All four `autoload*` flags are off: a standalone executable must not read the
 * `.env` file, `bunfig.toml`, `tsconfig.json` or `package.json` of whatever
 * directory it is started from, because a foreign directory must not be able to
 * change how a deployed service is configured. Bytecode caching is off, so the
 * shipped binary is plain transpiled JavaScript that the embedded runtime
 * transpiles at startup and no build cache is required.
 */
export const compileSettings = {
  target: "bun",
  bytecode: false,
  compile: {
    target: compileTarget,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
} as const satisfies Pick<Bun.BuildConfig, "target" | "bytecode" | "compile">;

/** Identifiers `src/version.ts` declares and packaging substitutes. */
export const versionDefine = "SWARMFORGE_BUILD_VERSION";
export const commitDefine = "SWARMFORGE_BUILD_COMMIT";

/**
 * Compile-time definitions for one build.
 *
 * Bun parses a `--define` value as JSON, so the value is serialized here rather
 * than quoted by hand: `SWARMFORGE_BUILD_VERSION` becomes the literal string
 * `"1.2.3"` in the binary and the source fallback in `src/version.ts` is never
 * reached. Only the space-separated `--define KEY=VALUE` form substitutes on
 * Bun 1.4.2, which is why the build API is used instead of a shell pipeline.
 */
export function buildDefines(version: string, commit: string) {
  return {
    [versionDefine]: JSON.stringify(version),
    [commitDefine]: JSON.stringify(commit),
  };
}

export function buildConfig(options: {
  version: string;
  commit: string;
  outfile: string;
}): Bun.BuildConfig {
  return {
    entrypoints: [join(repositoryRoot, "src", "cli.ts")],
    compile: { ...compileSettings.compile, outfile: options.outfile },
    define: buildDefines(options.version, options.commit),
    target: compileSettings.target,
    bytecode: compileSettings.bytecode,
  };
}

/** The version from `package.json`, read as data so the build has no import. */
export async function packageVersion(
  root: string = repositoryRoot,
): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { version?: string };
  if (!manifest.version) throw new Error("package.json has no version");
  return manifest.version;
}

/**
 * The commit this binary is built from.
 *
 * Packaging records the real commit so an operator can map a running binary
 * back to source; a source checkout still reports `unknown`.
 */
export async function repositoryCommit(
  root: string = repositoryRoot,
): Promise<string> {
  const git = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await git.exited;
  const commit = (await new Response(git.stdout).text()).trim();
  if (code !== 0 || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error(
      "could not resolve the git commit; package from a real checkout",
    );
  return commit;
}

/** Lowercase hex SHA-256 of a file. */
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export interface CompiledBinary {
  /** Absolute path of the executable. */
  path: string;
  version: string;
  commit: string;
  /** Target this executable was compiled for. */
  target: string;
  bytes: number;
  sha256: string;
}

/**
 * Compiles one executable and reports what it contains.
 *
 * The executable is made owner-executable explicitly: the archive and a plain
 * `cp` do not always carry the execute bit, and an extracted binary that cannot
 * be executed is the first thing an operator hits.
 */
export async function compileCli(
  options: {
    outfile?: string;
    version?: string;
    commit?: string;
    root?: string;
  } = {},
): Promise<CompiledBinary> {
  const version = options.version ?? (await packageVersion(options.root));
  // Source ZIP downloads have no .git metadata. Local builds still work; release
  // packaging separately requires a verified repositoryCommit.
  const commit =
    options.commit ??
    (existsSync(join(options.root ?? repositoryRoot, ".git"))
      ? await repositoryCommit(options.root)
      : "unknown");
  const outfile = resolve(options.outfile ?? binaryPath);
  await mkdir(dirname(outfile), { recursive: true });
  const result = await Bun.build(buildConfig({ version, commit, outfile }));
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    throw new Error("bun build --compile failed");
  }
  // Bun writes the executable beside the requested outfile; the reported path
  // is used so packaging never assumes a name Bun chose.
  const path = result.outputs[0]?.path ?? outfile;
  await chmod(path, 0o755);
  return {
    path,
    version,
    commit,
    target: compileSettings.compile.target,
    bytes: (await stat(path)).size,
    sha256: await fileDigest(path),
  };
}

if (import.meta.main) {
  const binary = await compileCli();
  process.stdout.write(
    `${JSON.stringify({
      executable: binary.path,
      version: binary.version,
      commit: binary.commit,
      target: binary.target,
      bytes: binary.bytes,
      sha256: binary.sha256,
    })}\n`,
  );
}

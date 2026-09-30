import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import {
  buildConfig,
  compileCli,
  compileSettings,
  compileTarget,
  executableName,
  fileDigest,
  repositoryCommit,
  repositoryRoot,
} from "../scripts/build";
import {
  archiveName,
  manifestName,
  packageCli,
  prepareReleaseAssets,
  releaseTagMismatch,
  verifyArchive,
} from "../scripts/package";
import { createHttpHandler } from "../src/http";
import { COMMIT, unknownCommit, VERSION } from "../src/version";
import { harness } from "./helpers";

const manifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
) as {
  version: string;
  engines: { bun: string };
  packageManager?: string;
  scripts: Record<string, string>;
};

// One compile per suite: every test below runs the binaries this suite built,
// so a second compile would only make the suite slower without testing more.
// The harness is compiled with the same exported settings as the CLI, so the
// lifecycle it runs is the packaged lifecycle, not a source-only path.
let binary = "";
let serveHarness = "";
let commit = "";
let workspace = "";
let foreign = "";
let home = "";
let packagedDist = "";

/** Copies the suite's packaged output into a fresh directory, compiling nothing. */
async function copyPackaged(name: string) {
  const target = join(workspace, name);
  await rm(target, { recursive: true, force: true });
  await Bun.$`mkdir -p ${target}`.quiet();
  for (const file of [
    executableName,
    manifestName,
    `metadata-${manifest.version}.json`,
    archiveName(manifest.version),
  ])
    await Bun.write(
      join(target, file),
      await readFile(join(packagedDist, file)),
    );
  return target;
}

async function run(
  command: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
) {
  const proc = Bun.spawn(command, {
    env: { PATH: "/usr/bin:/bin", ...options.env },
    cwd: options.cwd ?? foreign,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** A PATH with no Bun and no checkout `node_modules` on it. */
const minimalPath = "/usr/bin:/bin";

/** Output directory used by the test that executes the README install block. */
const readmeDist = () => join(workspace, "readme-dist");

/**
 * A complete, self-sufficient server environment for a packaged binary: no
 * environment file, no bunfig, and no `node_modules`, only variables.
 */
function serverEnvironment(db: string, listen: number) {
  return {
    HOME: home,
    PATH: minimalPath,
    FREESTYLE_API_TOKEN: "freestyle-token",
    FREESTYLE_SNAPSHOT_ID: "snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "model-token",
    SWARMFORGE_MODEL_NAME: "qwen",
    SWARMFORGE_GIT_TREE: "none",
    SWARMFORGE_DB_PATH: db,
    SWARMFORGE_HOST: "127.0.0.1",
    SWARMFORGE_PORT: String(listen),
    SWARMFORGE_METRICS_ENABLED: "false",
  };
}

beforeAll(async () => {
  commit = await repositoryCommit();
  workspace = await mkdtemp(join(tmpdir(), "swarmforge-packaging-"));
  foreign = join(workspace, "foreign");
  home = join(workspace, "home");
  await Bun.write(join(workspace, "placeholder"), "");
  for (const dir of [foreign, home]) {
    await Bun.$`mkdir -p ${dir}`.quiet();
  }
  // A foreign directory that contradicts every default: a `.env` that would
  // move the config file and redirect the client, and a `bunfig.toml` a source
  // run cannot even parse.
  await writeFile(
    join(foreign, ".env"),
    [
      `XDG_CONFIG_HOME=${join(foreign, "xdg")}`,
      "SWARMFORGE_URL=http://127.0.0.1:1/foreign-mcp",
      "SWARMFORGE_API_TOKEN=foreign-token-that-is-long-enough",
      "",
    ].join("\n"),
  );
  await writeFile(join(foreign, "bunfig.toml"), "broken = = 1\n");
  const compiled = await compileCli({
    outfile: join(workspace, executableName),
    version: manifest.version,
    commit,
  });
  binary = compiled.path;
  await chmod(binary, 0o755);
  serveHarness = await compileFixture(
    "compiled-serve.ts",
    join(workspace, "compiled-serve"),
  );
  // Packaged once for the whole suite from the binary already compiled above:
  // packaging re-measures that binary and its metadata is checked against it, so
  // the suite still compiles the CLI exactly once.
  packagedDist = join(workspace, "packaged");
  await packageCli({
    outDir: packagedDist,
    version: manifest.version,
    commit,
    executable: compiled,
  });
}, 300000);

/**
 * Compiles a test fixture with the same settings the CLI is compiled with, so
 * a harness difference can never be explained by a different build.
 */
async function compileFixture(fixture: string, outfile: string) {
  const result = await Bun.build({
    entrypoints: [join(repositoryRoot, "tests", "fixtures", fixture)],
    compile: {
      ...compileSettings.compile,
      target: compileTarget,
      outfile,
    },
    define: buildConfig({
      version: manifest.version,
      commit,
      outfile,
    }).define,
    target: compileSettings.target,
    bytecode: compileSettings.bytecode,
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
    throw new Error(`compiling ${fixture} failed`);
  }
  await chmod(outfile, 0o755);
  return outfile;
}

// Removing the compiled binaries and archive fixtures can exceed the default
// five-second hook timeout on disk; teardown has its own bounded budget.
afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
}, 60000);

describe("compiled CLI", () => {
  test("reports the version and commit the build defined, and the source falls back", async () => {
    const version = await run([binary, "--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(manifest.version);
    const help = await run([binary, "--help"]);
    expect(help.stdout).toContain(
      `SwarmForge ${manifest.version}, build ${commit}`,
    );
    // The defines are JSON encoded, so a version containing a quote cannot
    // become source, and the identifiers are absent from a source run.
    const defines = buildConfig({
      version: "1.2.3",
      commit: "abc",
      outfile: "/tmp/unused",
    }).define as Record<string, string>;
    expect(defines.SWARMFORGE_BUILD_VERSION).toBe('"1.2.3"');
    expect(defines.SWARMFORGE_BUILD_COMMIT).toBe('"abc"');
    expect(VERSION).toBe(manifest.version);
    expect(COMMIT).toBe(unknownCommit);
  });

  test("runs with no Bun and no checkout node_modules on PATH", async () => {
    for (const args of [
      ["--version"],
      ["--help"],
      ["config", "path"],
      ["config", "show"],
    ]) {
      const result = await run([binary, ...args], { env: { HOME: home } });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).not.toBe("");
    }
    // A complete server configuration is validated by the packaged binary
    // itself, still with no Bun and no node_modules on PATH.
    const checked = await run([binary, "serve", "--check-config"], {
      env: {
        ...serverEnvironment(join(workspace, "check.sqlite"), 18781),
        HOME: home,
      },
    });
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout).ok).toBe(true);
  });

  test("ignores a foreign .env and bunfig.toml that a source run cannot survive", async () => {
    const packaged = await run([binary, "config", "path"], {
      env: { HOME: home },
    });
    expect(packaged.code).toBe(0);
    expect(JSON.parse(packaged.stdout).config_path).toBe(
      join(home, ".config", "swarmforge", "config.toml"),
    );
    // The same directory fails a source run, which proves the foreign bunfig is
    // really there and really is loaded when it is not suppressed.
    const source = await run(
      [
        process.execPath,
        join(repositoryRoot, "src", "cli.ts"),
        "config",
        "path",
      ],
      { env: { HOME: home } },
    );
    expect(source.code).not.toBe(0);
    expect(source.stderr).toContain("bunfig");
  });

  test("reads a stable config path and an explicit env file", async () => {
    const config = join(foreign, "swarmforge.toml");
    const envFile = join(foreign, "operator.env");
    await writeFile(config, "schema_version = 1\n");
    await writeFile(
      envFile,
      [
        "FREESTYLE_API_TOKEN=freestyle-file-token",
        "FREESTYLE_SNAPSHOT_ID=snapshot",
        "SWARMFORGE_MODEL_BASE_URL=https://model.example/v1",
        "SWARMFORGE_MODEL_API_KEY=explicit-token-long-enough",
        "SWARMFORGE_MODEL_NAME=qwen",
        "SWARMFORGE_GIT_TREE=none",
        "SWARMFORGE_API_TOKEN=explicit-token-long-enough",
        "",
      ].join("\n"),
    );
    const selected = await run(
      [binary, "config", "show", "--config", config, "--env-file", envFile],
      { env: { HOME: home } },
    );
    expect(selected.code).toBe(0);
    const report = JSON.parse(selected.stdout);
    expect(report.server.ok).toBe(true);
    expect(report.server.values.SWARMFORGE_API_TOKEN).toBe("[REDACTED]");
    expect(report.server.values.FREESTYLE_API_TOKEN).toBe("[REDACTED]");
    expect(report.server.secrets).toContain("FREESTYLE_API_TOKEN");
    expect(report.server.sources.SWARMFORGE_MODEL_NAME).toContain("env_file");
    expect(JSON.stringify(report)).not.toContain("explicit-token-long-enough");
    expect(JSON.stringify(report)).not.toContain("freestyle-file-token");
  });

  test("status reports the endpoint it was given, not the one in the foreign .env", async () => {
    const h = harness();
    h.coordinator.config.SWARMFORGE_API_TOKEN = "server-token-long-enough";
    h.store.create({
      team_id: "team",
      task_id: "task",
      role: "coder",
      prompt: "Implement a feature",
      timeout_seconds: 60,
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createHttpHandler(h.coordinator),
    });
    const endpoint = `http://127.0.0.1:${server.port}/mcp`;
    try {
      const status = await run(
        [binary, "status", "--json", "--url", endpoint],
        {
          env: { HOME: home, SWARMFORGE_API_TOKEN: "server-token-long-enough" },
        },
      );
      expect(status.code).toBe(0);
      const overview = JSON.parse(status.stdout);
      expect(overview.url).toBe(endpoint);
      expect(overview.url).not.toContain("foreign-mcp");
      expect(overview.workers).toHaveLength(1);
      expect(overview.workers[0].task_id).toBe("task");
    } finally {
      await server.stop(true);
      h.store.close();
    }
  });

  test("refuses a status endpoint without reporting a credential", async () => {
    const refused = await run(
      [binary, "status", "--json", "--url", "http://127.0.0.1:1/mcp"],
      {
        env: {
          HOME: home,
          SWARMFORGE_API_TOKEN: "status-token-that-is-long-enough",
        },
      },
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).not.toContain("status-token-that-is-long-enough");
  });
});

describe("compiled serve lifecycle", () => {
  const servers: Subprocess[] = [];

  afterAll(() => {
    for (const proc of servers) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  });

  async function port(): Promise<number> {
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const value = probe.port ?? 0;
    await probe.stop(true);
    if (!value) throw new Error("could not reserve a port");
    return value;
  }

  function serve(
    db: string,
    listen: number,
    extra: Record<string, string> = {},
  ) {
    const proc = Bun.spawn([serveHarness], {
      env: { ...serverEnvironment(db, listen), ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    servers.push(proc);
    return proc;
  }

  async function healthy(listen: number, attempts = 100): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${listen}/health`);
        if (response.ok) {
          await response.text();
          return true;
        }
        await response.text();
      } catch {}
      await Bun.sleep(50);
    }
    return false;
  }

  async function instanceId(db: string): Promise<{ value: string } | null> {
    const store = new Database(db, { readonly: true });
    try {
      return store
        .query<{ value: string }, [string]>(
          "SELECT value FROM settings WHERE key = ?",
        )
        .get("instance_id") as { value: string } | null;
    } finally {
      store.close();
    }
  }

  /** The durable state of the queued worker the harness provisions. */
  async function provisioning(db: string, attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const store = new Database(db, { readonly: true });
      try {
        const row = store
          .query<{ state: string }, []>("SELECT state FROM workers LIMIT 1")
          .get() as { state: string } | null;
        if (row?.state === "provisioning") return row.state;
      } finally {
        store.close();
      }
      await Bun.sleep(50);
    }
    return undefined;
  }

  test("serves, holds the database lock, restarts and survives a signal", async () => {
    const db = join(workspace, "lifecycle.sqlite");
    const listen = await port();
    const first = await serve(db, listen);
    expect(await healthy(listen)).toBe(true);
    expect(await instanceId(db)).toEqual({ value: "default" });

    // The second process must be refused by the file lock, not by luck.
    const duplicate = await serve(db, await port());
    expect(await duplicate.exited).toBe(1);
    expect(await new Response(duplicate.stderr).text()).toContain(
      "Another SwarmForge process owns this database",
    );
    expect(await healthy(listen)).toBe(true);

    first.kill("SIGTERM");
    expect(await first.exited).toBe(0);

    // The lock is released, and the durable state the first process wrote is
    // still there for the restart.
    const next = await port();
    const afterRestart = await serve(db, next);
    expect(await healthy(next)).toBe(true);
    expect(await instanceId(db)).toEqual({ value: "default" });
    afterRestart.kill("SIGINT");
    expect(await afterRestart.exited).toBe(0);
  }, 60000);

  test("rolls a failed startup back so the lock is not left behind", async () => {
    const db = join(workspace, "rollback.sqlite");
    const listen = await port();
    const holder = await serve(db, listen);
    expect(await healthy(listen)).toBe(true);

    // A second database cannot take a port the first server already owns, so
    // startup fails after the lock was taken and must release it.
    const conflicted = await serve(join(workspace, "other.sqlite"), listen);
    expect(await conflicted.exited).toBe(1);

    holder.kill("SIGTERM");
    expect(await holder.exited).toBe(0);
    // The rolled-back startup released the lock of the database it failed on,
    // so that database can be served afterwards.
    const reuseDb = join(workspace, "other.sqlite");
    const next = await port();
    const reusing = await serve(reuseDb, next);
    expect(await healthy(next)).toBe(true);
    reusing.kill("SIGTERM");
    expect(await reusing.exited).toBe(0);
  }, 60000);

  test("exits 70 on the shutdown deadline with the database still readable", async () => {
    const db = join(workspace, "deadline.sqlite");
    const listen = await port();
    const proc = await serve(db, listen, {
      SWARMFORGE_SHUTDOWN_TIMEOUT_MS: "400",
      SWARMFORGE_HARNESS_WORKER: "1",
      SWARMFORGE_HARNESS_BLOCKED: "1",
    });
    expect(await healthy(listen)).toBe(true);
    // The worker's provisioning call is pending, so the drain cannot finish and
    // only the deadline ends the process.
    const state = await provisioning(db);
    expect(state).toBe("provisioning");
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(70);
    expect(await new Response(proc.stderr).text()).toContain(
      "Shutdown deadline exceeded",
    );
    // The deadline must not truncate durable state, and the stale lock the
    // process left behind must not stop the next start.
    expect(await instanceId(db)).toEqual({ value: "default" });
    expect(await provisioning(db)).toBe("provisioning");
    const next = await port();
    const restarted = await serve(db, next);
    expect(await healthy(next)).toBe(true);
    restarted.kill("SIGTERM");
    await restarted.exited;
  }, 60000);

  test("refuses an in-memory database before it creates anything", async () => {
    // The packaged CLI refuses it while checking configuration, so the check
    // needs no provider, no network and no database file.
    const refused = await run([binary, "serve", "--check-config"], {
      env: serverEnvironment(":memory:", await port()),
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("persistent database");
    const refusedProcess = await serve(":memory:", await port());
    expect(await refusedProcess.exited).toBe(1);
    expect(await new Response(refusedProcess.stderr).text()).toContain(
      "persistent database",
    );
  }, 60000);
});

describe("release archive", () => {
  test("packages a verified executable with metadata and checksums", async () => {
    const outDir = await copyPackaged("dist");
    const packaged = {
      archivePath: join(outDir, archiveName(manifest.version)),
      metadataPath: join(outDir, `metadata-${manifest.version}.json`),
      checksumsPath: join(outDir, manifestName),
    };
    expect(packaged.archivePath).toContain(manifest.version);
    const metadata = JSON.parse(await readFile(packaged.metadataPath, "utf8"));
    expect(metadata.version).toBe(manifest.version);
    expect(metadata.commit).toBe(commit);
    expect(metadata.target).toBe(compileTarget);
    expect(metadata.platform).toBe("linux-x64-glibc");
    const sums = await readFile(packaged.checksumsPath, "utf8");
    expect(sums.split("\n")[0]).toMatch(/^[0-9a-f]{64} {2}swarmforge$/);
    // The checksums file verifies against the packaged tree.
    const verify = Bun.spawn(["sha256sum", "-c", "SHA256SUMS"], {
      cwd: outDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await verify.exited).toBe(0);
  }, 180000);

  test("extracts with mode 0755 and reports its build metadata", async () => {
    const outDir = await copyPackaged("extract-dist");
    const packaged = {
      archivePath: join(outDir, archiveName(manifest.version)),
    };
    const target = join(workspace, "extracted");
    await rm(target, { recursive: true, force: true });
    await Bun.$`mkdir -p ${target}`.quiet();
    const untar = Bun.spawn(
      ["tar", "-xzf", packaged.archivePath, "-C", target],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await untar.exited).toBe(0);
    const extracted = join(target, executableName);
    const stat = await Bun.file(extracted).stat();
    expect(stat.mode & 0o777).toBe(0o755);
    const version = await run([extracted, "--version"], { cwd: target });
    expect(version.stdout.trim()).toBe(manifest.version);
    const help = await run([extracted, "--help"], { cwd: target });
    expect(help.stdout).toContain(`build ${commit}`);
    const checksums = Bun.spawn(["sha256sum", "-c", "SHA256SUMS"], {
      cwd: target,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await checksums.exited).toBe(0);
  }, 180000);

  test("only cuts a release when the tag matches the packaged version", () => {
    expect(releaseTagMismatch(`v${manifest.version}`, manifest.version)).toBe(
      null,
    );
    expect(
      releaseTagMismatch(`refs/tags/v${manifest.version}`, manifest.version),
    ).toBe(null);
    expect(
      releaseTagMismatch(`v${manifest.version}-rc1`, manifest.version),
    ).toContain("not a vMAJOR.MINOR.PATCH tag");
    expect(releaseTagMismatch("main", manifest.version)).toContain(
      "not a vMAJOR.MINOR.PATCH tag",
    );
    expect(releaseTagMismatch("v9.9.9", manifest.version)).toContain(
      "does not match package.json version",
    );
  });
});

describe("archive verification", () => {
  const outDir = () => join(workspace, "verify-dist");
  let packaged: {
    archivePath: string;
    metadataPath: string;
    checksumsPath: string;
    files: string[];
  };

  beforeAll(async () => {
    const copied = await copyPackaged("verify-dist");
    packaged = {
      archivePath: join(copied, archiveName(manifest.version)),
      metadataPath: join(copied, `metadata-${manifest.version}.json`),
      checksumsPath: join(copied, manifestName),
      files: [
        executableName,
        `metadata-${manifest.version}.json`,
        manifestName,
      ],
    };
  }, 120000);

  /** A copy of the archive that a later step can damage. */
  async function damaged(mutate: (path: string) => Promise<void>) {
    const copy = join(
      workspace,
      `damaged-${Math.random().toString(36).slice(2)}.tar.gz`,
    );
    await Bun.write(copy, await readFile(packaged.archivePath));
    await mutate(copy);
    return copy;
  }

  test("accepts the archive packaging produced", async () => {
    const verified = await verifyArchive({
      archivePath: packaged.archivePath,
      expectedVersion: manifest.version,
      expectedCommit: commit,
    });
    expect(verified.version).toBe(manifest.version);
    expect(verified.commit).toBe(commit);
    expect(verified.target).toBe(compileTarget);
    expect(verified.files).toContain(executableName);
  }, 120000);

  test("rejects a truncated archive", async () => {
    const archive = await damaged(async (path) => {
      const bytes = await readFile(path);
      await Bun.write(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
    });
    await expect(
      verifyArchive({
        archivePath: archive,
        expectedVersion: manifest.version,
      }),
    ).rejects.toThrow(/not a readable tar\.gz|did not extract/);
  }, 120000);

  test("rejects an archive whose payload was edited", async () => {
    // Recompressing an edited payload keeps the archive readable, so only the
    // checksum comparison can catch this one.
    const archive = await damaged(async (path) => {
      const staging = join(workspace, "tamper");
      await rm(staging, { recursive: true, force: true });
      await Bun.$`mkdir -p ${staging}`.quiet();
      await Bun.spawn(["tar", "-xzf", path, "-C", staging]).exited;
      const binary = join(staging, executableName);
      const tampered = Buffer.concat([
        await readFile(binary),
        Buffer.from("\0tampered"),
      ]);
      await Bun.write(binary, tampered);
      await chmod(binary, 0o755);
      await Bun.spawn(["tar", "-czf", path, "-C", staging, ...packaged.files])
        .exited;
    });
    await expect(
      verifyArchive({
        archivePath: archive,
        expectedVersion: manifest.version,
      }),
    ).rejects.toThrow(/SHA256SUMS did not verify/);
  }, 120000);

  test("rejects an archive whose metadata was edited to match", async () => {
    const archive = await damaged(async (path) => {
      const staging = join(workspace, "tamper-metadata");
      await rm(staging, { recursive: true, force: true });
      await Bun.$`mkdir -p ${staging}`.quiet();
      await Bun.spawn(["tar", "-xzf", path, "-C", staging]).exited;
      const metadataPath = join(staging, `metadata-${manifest.version}.json`);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.executable.sha256 = "0".repeat(64);
      await Bun.write(metadataPath, JSON.stringify(metadata));
      await Bun.spawn(["tar", "-czf", path, "-C", staging, ...packaged.files])
        .exited;
    });
    await expect(
      verifyArchive({
        archivePath: archive,
        expectedVersion: manifest.version,
      }),
    ).rejects.toThrow(/does not describe its own contents/);
  }, 120000);

  test("rejects an archive whose executable lost its mode", async () => {
    const archive = await damaged(async (path) => {
      const staging = join(workspace, "tamper-mode");
      await rm(staging, { recursive: true, force: true });
      await Bun.$`mkdir -p ${staging}`.quiet();
      await Bun.spawn(["tar", "-xzf", path, "-C", staging]).exited;
      await chmod(join(staging, executableName), 0o644);
      await Bun.spawn(["tar", "-czf", path, "-C", staging, ...packaged.files])
        .exited;
    });
    await expect(
      verifyArchive({
        archivePath: archive,
        expectedVersion: manifest.version,
      }),
    ).rejects.toThrow(/mode 0644, not 0755/);
  }, 120000);

  test("rejects an archive built from another commit", async () => {
    await expect(
      verifyArchive({
        archivePath: packaged.archivePath,
        expectedVersion: manifest.version,
        expectedCommit: "0".repeat(40),
      }),
    ).rejects.toThrow(/metadata commit/);
  }, 120000);

  test("package:verify passes for the built archive and fails for a tampered one", async () => {
    const passing = await run(
      [process.execPath, "scripts/package.ts", "verify", outDir()],
      {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? "", HOME: home },
      },
    );
    expect(passing.code).toBe(0);
    expect(JSON.parse(passing.stdout).version).toBe(manifest.version);
    // A tampered copy in the same directory is what a supply-chain edit looks
    // like, and it must not verify.
    const tampered = join(outDir(), archiveName(manifest.version));
    const original = await readFile(tampered);
    await Bun.write(tampered, original.subarray(0, 1024));
    const failing = await run(
      [process.execPath, "scripts/package.ts", "verify", outDir()],
      {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? "", HOME: home },
      },
    );
    expect(failing.code).toBe(1);
    expect(failing.stderr).toMatch(/archive|extract/i);
    await Bun.write(tampered, original);
  }, 180000);
});

describe("release assets", () => {
  /** The layout `actions/download-artifact` produces from the build job. */
  async function downloadAssets(overrides: Record<string, string> = {}) {
    const directory = join(
      workspace,
      `release-assets-${Math.random().toString(36).slice(2)}`,
    );
    await Bun.$`mkdir -p ${directory}`.quiet();
    const uploaded = await copyPackaged(`uploaded-${Date.now()}`);
    for (const [name, source] of Object.entries({
      [archiveName(manifest.version)]: join(
        uploaded,
        archiveName(manifest.version),
      ),
      [manifestName]: join(uploaded, manifestName),
      [`metadata-${manifest.version}.json`]: join(
        uploaded,
        `metadata-${manifest.version}.json`,
      ),
      ...overrides,
    })) {
      await Bun.write(join(directory, name), await readFile(source));
    }
    return directory;
  }

  test("accepts the assets the build job uploaded for a matching tag", async () => {
    const directory = await downloadAssets();
    const prepared = await prepareReleaseAssets({
      directory,
      tag: `v${manifest.version}`,
      version: manifest.version,
    });
    expect(prepared.assets.map((asset) => basename(asset))).toEqual([
      archiveName(manifest.version),
      "SHA256SUMS",
      `metadata-${manifest.version}.json`,
    ]);
  }, 180000);

  test("refuses assets whose tag does not match the version", async () => {
    const directory = await downloadAssets();
    await expect(
      prepareReleaseAssets({
        directory,
        tag: "v9.9.9",
        version: manifest.version,
      }),
    ).rejects.toThrow(/does not match package.json version/);
  }, 180000);

  test("refuses a release directory that is missing the archive", async () => {
    const directory = await downloadAssets();
    await rm(join(directory, archiveName(manifest.version)));
    await expect(
      prepareReleaseAssets({
        directory,
        tag: `v${manifest.version}`,
        version: manifest.version,
      }),
    ).rejects.toThrow(new RegExp(archiveName(manifest.version)));
  }, 180000);

  test("refuses assets whose archive is not the verified one", async () => {
    const junk = join(workspace, "not-an-archive.txt");
    await Bun.write(junk, "not a tar archive\n");
    const directory = await downloadAssets({
      [archiveName(manifest.version)]: junk,
    });
    await expect(
      prepareReleaseAssets({
        directory,
        tag: `v${manifest.version}`,
        version: manifest.version,
      }),
    ).rejects.toThrow(/not a readable tar|did not extract/);
  }, 180000);
});

describe("packaging declarations", () => {
  test("package scripts, engine floor and the pinned toolchain", () => {
    expect(manifest.scripts.build).toContain("scripts/build.ts");
    expect(manifest.scripts.package).toContain("scripts/package.ts");
    expect(manifest.engines.bun).toBe(">=1.4.2");
    expect(manifest.packageManager).toBe("bun@1.4.2");
  });

  test("start, dev and status disable ambient .env and bunfig", () => {
    for (const name of ["start", "dev", "status"]) {
      const script = manifest.scripts[name];
      expect(script).toContain("--no-env-file");
      expect(script).toContain("--config=");
    }
    // start and dev must run the CLI, which parses argv, so the flags a
    // deployment passes to the script actually reach the serve command.
    for (const name of ["start", "dev"]) {
      expect(manifest.scripts[name]).toContain("src/cli.ts serve");
      expect(manifest.scripts[name]).not.toContain("src/main.ts");
    }
    expect(compileSettings.compile.autoloadDotenv).toBe(false);
    expect(compileSettings.compile.autoloadBunfig).toBe(false);
    expect(compileSettings.compile.autoloadTsconfig).toBe(false);
    expect(compileSettings.compile.autoloadPackageJson).toBe(false);
    expect(compileSettings.bytecode).toBe(false);
    expect(compileSettings.compile.target).toBe("bun-linux-x64-baseline");
  });

  test("the documented `bun run start -- --env-file .env` reads that file", async () => {
    // The invocation is run exactly as the README prints it. The fixture server
    // configuration is complete but names an in-memory database, so the command
    // gets all the way to the server and refuses it: a configuration that never
    // resolved, or a provider call to an unroutable Freestyle endpoint, would
    // report something else entirely.
    const envFile = join(workspace, "operator.env");
    await writeFile(
      envFile,
      [
        "FREESTYLE_API_TOKEN=freestyle-fixture-token",
        "FREESTYLE_SNAPSHOT_ID=snapshot",
        "FREESTYLE_API_URL=http://127.0.0.1:1",
        "SWARMFORGE_MODEL_BASE_URL=https://model.example/v1",
        "SWARMFORGE_MODEL_API_KEY=model-fixture-key",
        "SWARMFORGE_MODEL_NAME=qwen",
        "SWARMFORGE_GIT_TREE=none",
        "SWARMFORGE_DB_PATH=:memory:",
        "",
      ].join("\n"),
    );
    const proc = Bun.spawn(
      [process.execPath, "run", "start", "--", "--env-file", envFile],
      {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? "", HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toContain("persistent database");
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).not.toContain("freestyle-fixture-token");
    expect(code).toBe(1);
  }, 120000);

  test("a release tag is never evaluated by a shell", async () => {
    // A tag name is attacker-influenced text: a tag that only has to be
    // compared must never reach a command line unquoted.
    const malicious = `v${manifest.version}"; touch ${join(workspace, "injected")}; #`;
    expect(releaseTagMismatch(malicious, manifest.version)).toContain(
      "not a vMAJOR.MINOR.PATCH tag",
    );
    const proc = Bun.spawn(
      [process.execPath, "scripts/package.ts", "tag", malicious],
      {
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? "", HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("not a vMAJOR.MINOR.PATCH tag");
    // Nothing the tag contained ran.
    expect(await Bun.file(join(workspace, "injected")).exists()).toBe(false);
  }, 120000);

  test("the workflow grants write access only to the draft job", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(workflow).toContain("permissions:\n  contents: read");
    const draft = workflow.slice(workflow.indexOf("draft-release:"));
    expect(draft).toContain("permissions:\n      contents: write");
    const build = workflow.slice(
      workflow.indexOf("  build:"),
      workflow.indexOf("draft-release:"),
    );
    expect(build).not.toContain("contents: write");
    expect(build).not.toContain("github.token");
    // No tag value is ever interpolated into a run script.
    for (const match of workflow.matchAll(/^.*github\.ref_name.*$/gm))
      expect((match[0] ?? "").trim()).toMatch(
        /^RELEASE_TAG: \$\{\{ github\.ref_name \}\}$/,
      );
    expect(workflow).toContain(
      'run: bun scripts/package.ts tag "$RELEASE_TAG"',
    );
  });

  test("the suite compiles the CLI once and packages that binary", async () => {
    // Packaging is given the binary the suite already compiled; the archive
    // still has to describe it correctly, so nothing here is a bypass.
    const reused = await packageCli({
      outDir: join(workspace, "reused"),
      version: manifest.version,
      commit,
      executable: {
        path: binary,
        version: manifest.version,
        commit,
        target: compileTarget,
        bytes: (await Bun.file(binary).stat()).size,
        sha256: await fileDigest(binary),
      },
    });
    expect(reused.version).toBe(manifest.version);
    // The reused binary is measured again, so its metadata is its own.
    const metadata = JSON.parse(await readFile(reused.metadataPath, "utf8"));
    expect(metadata.executable.sha256).toBe(await fileDigest(binary));
    // A binary whose recorded version does not match the release is refused
    // rather than packaged under the wrong name.
    await expect(
      packageCli({
        outDir: join(workspace, "mismatched"),
        version: manifest.version,
        commit,
        executable: {
          path: binary,
          version: "9.9.9",
          commit,
          target: compileTarget,
          bytes: 1,
          sha256: "",
        },
      }),
    ).rejects.toThrow(/was built from/);
  }, 120000);

  test("dist output is ignored and the lockfile keeps its format", async () => {
    const ignored = await readFile(join(repositoryRoot, ".gitignore"), "utf8");
    expect(ignored.split("\n")).toContain("dist/");
    const lockfile = await readFile(join(repositoryRoot, "bun.lock"), "utf8");
    expect(lockfile).toContain('"lockfileVersion": 2');
  });

  test("the release workflow pins Bun 1.4.2, verifies, and only drafts", async () => {
    const workflow = await readFile(
      join(repositoryRoot, ".github", "workflows", "release.yml"),
      "utf8",
    );
    expect(workflow).toContain('bun-version: "1.4.2"');
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("run: bun test");
    expect(workflow).toContain("run: bun run check");
    expect(workflow).toContain("run: bun run build");
    expect(workflow).toContain("run: bun run package");
    expect(workflow).toContain("bun run package:verify");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("uses: actions/upload-artifact@v4");
    // The draft is cut from the artifacts the build job uploaded and verified,
    // so it can never carry a second, unreviewed build.
    const draft = workflow.slice(workflow.indexOf("draft-release:"));
    expect(draft).toContain("uses: actions/download-artifact@v4");
    expect(draft).not.toContain("run: bun run build");
    expect(draft).not.toContain("run: bun run package");
    expect(draft).toContain(
      "bun scripts/package.ts release-assets release-assets --tag",
    );
    // A release is a draft for a human to publish, and only for a matching tag.
    expect(workflow).toContain("--draft");
    expect(workflow).not.toContain("--publish");
    expect(workflow).toContain("bun scripts/package.ts tag");
    expect(workflow).toContain("github.ref_name");
    // Nothing is installed system-wide: every packaged probe runs from a
    // temporary directory by absolute path with a PATH that cannot find it.
    expect(workflow).not.toContain("/usr/local/bin");
    expect(workflow).toContain("env -i PATH=/usr/bin:/bin HOME=");
    expect(workflow).toContain("$RUNNER_TEMP/swarmforge-install");
  });

  test("the README install flow works in a plain shell", async () => {
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
    const block = readme
      .split("\n```sh\n")
      .find((section) => section.includes("mktemp -d"));
    expect(block).toBeDefined();
    // The documented block must be copy-pasteable: the version is assigned,
    // never left as an unquoted placeholder, the archive is extracted with its
    // manifest, the checksum runs inside the extracted tree, and the binary is
    // installed with an explicit mode.
    expect(block).toContain("VERSION=0.1.0");
    expect(block).not.toContain("<version>");
    expect(block).toContain('tar -xzf "dist/swarmforge-v$');
    expect(block).toContain('(cd "$tmp" && sha256sum -c SHA256SUMS)');
    expect(block).toContain('install -m 755 "$tmp/swarmforge"');
    expect(block).toContain('"$HOME/.local/bin/swarmforge" --version');
    expect(block).toContain('install -d "$HOME/.local/bin"');
    expect(readme).toContain("~/.local/bin");
    expect(readme).toContain("PATH");
    expect(readme).toContain("swarmforge serve");
    expect(readme).toContain("swarmforge status");
    expect(readme).toContain("swarmforge config");
    expect(readme).toContain("--env-file .env");
    // The legacy database keeps its absolute path and is never relocated.
    expect(readme).toContain("SWARMFORGE_DB_PATH=/absolute/path");
    expect(readme).toContain("Type=exec");
    expect(readme).toContain("TimeoutStopSec=90s");
  });

  test("the documented install block installs a working executable", async () => {
    // The README block is executed here with a fake home, so a broken block is
    // a failing test rather than a surprise for an operator.
    await copyPackaged(basename(readmeDist()));
    const { block } = await installBlock(readmeDist());
    const readmeHome = join(workspace, "readme-home");
    await Bun.$`mkdir -p ${readmeHome}`.quiet();
    const shell = await runBlock(block, readmeHome);
    expect(shell.code).toBe(0);
    expect(shell.stderr).toBe("");
    const installed = join(readmeHome, ".local", "bin", executableName);
    const mode = (await Bun.file(installed).stat()).mode & 0o777;
    expect(mode).toBe(0o755);
    const reported = await run([installed, "--version"], { cwd: readmeHome });
    expect(reported.stdout.trim()).toBe(manifest.version);
    expect(
      await Bun.file(
        join(readmeDist(), archiveName(manifest.version)),
      ).exists(),
    ).toBe(true);
  }, 180000);

  test("the documented install block refuses an archive with a bad checksum", async () => {
    // A controlled archive: the same packaged binary, with a manifest whose
    // digest does not match it. The block must fail, and must not install.
    const tampered = await copyPackaged("tampered-install");
    const badManifest = join(tampered, manifestName);
    await Bun.write(badManifest, `${"0".repeat(64)}  ${executableName}\n`);
    const staging = join(tampered, "restage");
    await rm(staging, { recursive: true, force: true });
    await Bun.$`mkdir -p ${staging}`.quiet();
    for (const file of [
      executableName,
      manifestName,
      `metadata-${manifest.version}.json`,
    ])
      await Bun.write(
        join(staging, file),
        await readFile(join(tampered, file)),
      );
    const archive = join(tampered, archiveName(manifest.version));
    await Bun.spawn([
      "tar",
      "-czf",
      archive,
      "-C",
      staging,
      executableName,
      manifestName,
      `metadata-${manifest.version}.json`,
    ]).exited;

    const { block } = await installBlock(tampered);
    const readmeHome = join(workspace, "bad-checksum-home");
    await Bun.$`mkdir -p ${readmeHome}`.quiet();
    const shell = await runBlock(block, readmeHome);
    // A checksum that does not verify is reported and stops the block.
    expect(shell.code).not.toBe(0);
    // `sha256sum -c` names the file that failed, on stdout and on stderr.
    expect(shell.stdout).toContain(`${executableName}: FAILED`);
    expect(shell.stderr).toContain("did NOT match");
    // And nothing is installed: no copy follows a rejected checksum.
    const installed = join(readmeHome, ".local", "bin", executableName);
    expect(await Bun.file(installed).exists()).toBe(false);
    // The version probe at the end of the block never ran.
    expect(shell.stdout).not.toContain(manifest.version);
    // The temporary directory is cleaned up even though the block failed.
    const leftovers = await readdir("/tmp").then((entries) =>
      entries.filter((entry) => entry.startsWith("tmp.")),
    );
    expect(leftovers).toEqual([]);
  }, 180000);
});

/**
 * The install block exactly as the README prints it, with `dist/` pointed at a
 * specific directory so a test can supply its own archive.
 */
async function installBlock(dist: string) {
  const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
  const block = readme
    .split("\n```sh\n")
    .find((section) => section.includes("mktemp -d"))!
    .split("\n```")[0]!;
  return { block: block.replace(/"dist\//g, `"${dist}/`) };
}

/** Runs a block in a clean shell with only HOME and PATH set. */
async function runBlock(block: string, home: string) {
  const shell = Bun.spawn(["bash", "-c", block], {
    cwd: repositoryRoot,
    env: { HOME: home, PATH: minimalPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    shell.exited,
    new Response(shell.stdout).text(),
    new Response(shell.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  buildConfig,
  compileCli,
  compileSettings,
  compileTarget,
  executableName,
  repositoryCommit,
  repositoryRoot,
} from "../scripts/build";
import { packageCli, releaseTagMismatch } from "../scripts/package";
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
});

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

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

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
    const outDir = join(workspace, "dist");
    const packaged = await packageCli({
      outDir,
      version: manifest.version,
      commit,
    });
    expect(packaged.archivePath).toContain(manifest.version);
    expect(packaged.files).toEqual([
      executableName,
      `metadata-${manifest.version}.json`,
      "SHA256SUMS",
    ]);
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
    const outDir = join(workspace, "extract-dist");
    const packaged = await packageCli({
      outDir,
      version: manifest.version,
      commit,
    });
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
    expect(compileSettings.compile.autoloadDotenv).toBe(false);
    expect(compileSettings.compile.autoloadBunfig).toBe(false);
    expect(compileSettings.compile.autoloadTsconfig).toBe(false);
    expect(compileSettings.compile.autoloadPackageJson).toBe(false);
    expect(compileSettings.bytecode).toBe(false);
    expect(compileSettings.compile.target).toBe("bun-linux-x64-baseline");
  });

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
    // A manual run uploads what it built; a tag run uploads the release assets.
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("uses: actions/upload-artifact@v4");
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
    // A release is a draft for a human to publish, and only for a matching tag.
    expect(workflow).toContain("--draft");
    expect(workflow).not.toContain("--publish");
    expect(workflow).toContain("bun run release:tag --");
    expect(workflow).toContain("github.ref_name");
  });

  test("the README documents the manual install and the diagnostics", async () => {
    const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
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
});

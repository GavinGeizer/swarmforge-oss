import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, UsageError } from "../src/cli/arguments";
import { createHttpHandler } from "../src/http";
import { COMMIT, VERSION } from "../src/version";
import { harness, task } from "./helpers";

const root = join(import.meta.dir, "..");
const cliEntry = join(root, "src", "cli.ts");
const mainEntry = join(root, "src", "main.ts");
const packageVersion = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** A command fixture root: an isolated home, a work directory and a bunfig. */
function fixtureRoot() {
  const base = mkdtempSync(join(tmpdir(), "sf-commands-"));
  const home = join(base, "home");
  const work = join(base, "work");
  const xdg = join(base, "xdg");
  mkdirSync(home);
  mkdirSync(work);
  mkdirSync(xdg);
  // An empty bunfig keeps a foreign configuration file from changing how the
  // launcher itself starts; the child still runs with this directory as its cwd.
  const bunfig = join(base, "empty.bunfig");
  writeFileSync(bunfig, "");
  // Hostile files in the working directory: a command must take its settings from
  // the process environment, --config and --env-file only. The launcher runs with
  // .env autoloading disabled and an empty bunfig of its own, so what the test
  // measures is the command and not the launcher that starts it.
  writeFileSync(
    join(work, ".env"),
    [
      "SWARMFORGE_URL=http://dotenv.invalid/mcp",
      "SWARMFORGE_API_TOKEN=dotenv-token",
      "SWARMFORGE_DB_PATH=./dotenv.sqlite",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(work, "bunfig.toml"),
    '[install]\nregistry = "https://registry.invalid"\n',
  );
  return {
    base,
    home,
    work,
    xdg,
    bunfig,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

type Environment = Record<string, string | undefined>;

// The launcher transpilation cache lives outside every fixture root, so a
// "created nothing" assertion measures the command rather than the runtime.
const cache = join(tmpdir(), "sf-commands-bun-cache");

/** The child sees no ambient SwarmForge configuration unless a test asks for it. */
function childEnv(
  fixture: ReturnType<typeof fixtureRoot>,
  extra: Environment = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: fixture.home,
    NO_COLOR: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache,
  };
  for (const [key, value] of Object.entries(extra))
    if (value !== undefined) env[key] = value;
  return env;
}

interface Outcome {
  stdout: string;
  stderr: string;
  exitCode: number | number | null;
}

async function run(
  args: string[],
  options: {
    fixture: ReturnType<typeof fixtureRoot>;
    env?: Environment;
    entry?: string;
    cwd?: string;
  },
): Promise<Outcome> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      // The launcher must not inherit configuration from its working directory.
      "--no-env-file",
      `--config=${options.fixture.bunfig}`,
      options.entry ?? cliEntry,
      ...args,
    ],
    cwd: options.cwd ?? options.fixture.work,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(options.fixture, options.env),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    Promise.race([
      child.exited,
      Bun.sleep(30000).then(() => child.kill(9) as never),
    ]),
  ]);
  return { stdout, stderr, exitCode: exitCode as number };
}

function tree(at: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      found.push(`${full.slice(at.length)}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(at);
  return found.sort();
}

const json = (outcome: Outcome) => JSON.parse(outcome.stdout);

test("the argument parser is pure and reports usage errors before any work", () => {
  expect(parseArguments([])).toEqual({
    kind: "status",
    json: false,
    interactive: true,
    configPath: undefined,
    envFiles: [],
  });
  // No command word keeps the historical implicit status invocation.
  expect(parseArguments(["--json", "--no-interactive"])).toMatchObject({
    kind: "status",
    json: true,
    interactive: false,
  });
  expect(
    parseArguments(["status", "--url", "http://host:8787/mcp", "--json"]),
  ).toEqual({
    kind: "status",
    // The endpoint is an override, so the resolver reports it as the source.
    overrides: { SWARMFORGE_URL: "http://host:8787/mcp" },
    json: true,
    interactive: true,
    configPath: undefined,
    envFiles: [],
  });
  expect(
    parseArguments([
      "status",
      "--config",
      "a.toml",
      "--env-file",
      "one.env",
      "--env-file",
      "two.env",
    ]),
  ).toMatchObject({ configPath: "a.toml", envFiles: ["one.env", "two.env"] });
  expect(
    parseArguments([
      "serve",
      "--config",
      "a.toml",
      "--env-file",
      "one.env",
      "--check-config",
    ]),
  ).toEqual({
    kind: "serve",
    checkConfig: true,
    configPath: "a.toml",
    envFiles: ["one.env"],
  });
  expect(parseArguments(["serve"])).toEqual({
    kind: "serve",
    checkConfig: false,
    configPath: undefined,
    envFiles: [],
  });
  for (const action of ["path", "show", "validate"] as const)
    expect(parseArguments(["config", action])).toEqual({
      kind: "config",
      action,
      configPath: undefined,
      envFiles: [],
    });
  expect(parseArguments(["config", "show", "--config", "c.toml"])).toEqual({
    kind: "config",
    action: "show",
    configPath: "c.toml",
    envFiles: [],
  });
  expect(parseArguments(["--version"])).toEqual({ kind: "version" });
  expect(parseArguments(["-V"])).toEqual({ kind: "version" });
  for (const help of [
    parseArguments(["--help"]),
    parseArguments(["-h"]),
    parseArguments(["status", "--help"]),
    parseArguments(["serve", "--help"]),
    parseArguments(["config", "--help"]),
    parseArguments(["config", "show", "--help"]),
  ])
    expect(help.kind).toBe("help");
  for (const bad of [
    ["nonsense"],
    ["status", "--nonsense"],
    ["status", "--url"],
    ["status", "stray"],
    ["serve", "--config"],
    ["serve", "--env-file"],
    ["serve", "--nonsense"],
    ["serve", "--check-config=yes"],
    ["config"],
    ["config", "nonsense"],
    ["config", "path", "extra"],
  ])
    expect(() => parseArguments(bad)).toThrow(UsageError);
});

test("help and version answer before settings, credentials or the server exist", async () => {
  const fixture = fixtureRoot();
  try {
    // A selected configuration that cannot even be read must not affect either flag.
    const hostile = {
      SWARMFORGE_CONFIG: join(fixture.base, "absent.toml"),
      FREESTYLE_API_TOKEN: "unreachable-provider-credential",
      SWARMFORGE_MODEL_API_KEY: "unreachable-model-credential",
      SWARMFORGE_DB_PATH: join(fixture.work, "never.sqlite"),
    };
    const before = tree(fixture.base);
    for (const args of [
      ["--help"],
      ["-h"],
      ["--version"],
      ["-V"],
      ["status", "--help"],
      ["serve", "--help"],
      ["config", "--help"],
    ]) {
      const outcome = await run(args, { fixture, env: hostile });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stderr).toBe("");
      expect(outcome.stdout).not.toContain("absent.toml");
    }
    const help = await run(["--help"], { fixture, env: hostile });
    for (const fragment of [
      "status",
      "serve",
      "config",
      "--version",
      "--check-config",
    ])
      expect(help.stdout).toContain(fragment);
    const version = await run(["--version"], { fixture, env: hostile });
    expect(version.stdout.trim()).toBe(VERSION);
    // No database, lock, listener or credential was needed to answer.
    expect(tree(fixture.base)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

test("the packaged version reports the source package version", () => {
  expect(VERSION).toBe(packageVersion);
  expect(VERSION.length).toBeGreaterThan(0);
  expect(typeof COMMIT).toBe("string");
  expect(COMMIT.length).toBeGreaterThan(0);
});

test("an unknown command, flag or missing value fails before any read", async () => {
  const fixture = fixtureRoot();
  try {
    const before = tree(fixture.base);
    for (const [args, fragment] of [
      [["nonsense"], "Unknown command: nonsense"],
      [["status", "--nonsense"], "Unknown argument: --nonsense"],
      [["status", "--url"], "--url requires an endpoint"],
      [["status", "stray"], "Unknown argument: stray"],
      [["serve", "--config"], "--config requires a path"],
      [["serve", "--env-file"], "--env-file requires a path"],
      [["serve", "--nonsense"], "Unknown argument: --nonsense"],
      [["config"], "config requires"],
      [["config", "nonsense"], "Unknown config action: nonsense"],
      [["config", "path", "extra"], "Unknown argument: extra"],
    ] as const) {
      const outcome = await run([...args], {
        fixture,
        // A configuration that cannot be read must not change a usage error.
        env: { SWARMFORGE_CONFIG: join(fixture.base, "absent.toml") },
      });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout).toBe("");
      expect(outcome.stderr).toContain(fragment);
    }
    expect(tree(fixture.base)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

test("status reads client settings only and reports a real swarm", async () => {
  const fixture = fixtureRoot();
  const h = harness();
  h.store.create({ ...task, timeout_seconds: 60 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const url = `http://127.0.0.1:${server.port}/mcp`;
  try {
    // No provider, model, database or git setting is present: a client needs none.
    for (const args of [
      ["status", "--url", url, "--json"],
      ["--url", url, "--json"],
    ]) {
      const outcome = await run(args, { fixture });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stderr).toBe("");
      expect(JSON.parse(outcome.stdout)).toMatchObject({
        states: { queued: 1 },
        workers: [{ state: "queued", task_id: task.task_id }],
      });
    }
    // A bare origin keeps the historical normalisation to the MCP surface.
    const origin = await run(
      ["status", `--url`, `http://127.0.0.1:${server.port}/`, "--json"],
      { fixture },
    );
    expect(origin.exitCode).toBe(0);
    expect(JSON.parse(origin.stdout).url).toBe(url);
    const snapshot = await run(["status", "--url", url, "--no-interactive"], {
      fixture,
    });
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).toContain("QUEUED");
    expect(snapshot.stdout).not.toContain("\u001b[");
    // A client flag outranks the environment, and it reaches the resolver as an
    // override rather than as a second, silently ignored environment variable.
    const override = await run(["status", "--json"], {
      fixture,
      env: { SWARMFORGE_URL: "http://127.0.0.1:1/mcp" },
    });
    expect(override.exitCode).toBe(1);
    const overridden = await run(["status", "--url", url, "--json"], {
      fixture,
      env: { SWARMFORGE_URL: "http://127.0.0.1:1/mcp" },
    });
    expect(overridden.exitCode).toBe(0);
    // The scheme is validated by the resolver, which reports a scrubbed failure.
    const invalid = await run(["status", "--url", "ftp://host/mcp"], {
      fixture,
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("http or https");
    expect(invalid.stdout).toBe("");
  } finally {
    await server.stop(true);
    h.store.close();
    fixture.cleanup();
  }
});

test("config path reports the selected or default file and creates nothing", async () => {
  const fixture = fixtureRoot();
  try {
    const selected = join(fixture.base, "selected.toml");
    writeFileSync(selected, "schema_version = 1\n");
    const elsewhere = join(fixture.base, "elsewhere");
    mkdirSync(elsewhere);
    const before = tree(fixture.base);
    const absent = join(fixture.base, "absent.toml");

    const discovered = await run(["config", "path"], {
      fixture,
      env: { XDG_CONFIG_HOME: fixture.xdg },
    });
    expect(discovered.exitCode).toBe(0);
    expect(json(discovered)).toEqual({
      config_path: join(fixture.xdg, "swarmforge", "config.toml"),
      exists: false,
      env_files: [],
    });

    const fromEnvironment = await run(["config", "path"], {
      fixture,
      env: { SWARMFORGE_CONFIG: absent },
    });
    expect(fromEnvironment.exitCode).toBe(0);
    expect(json(fromEnvironment)).toEqual({
      config_path: absent,
      exists: false,
      env_files: [],
    });

    const existing = await run(["config", "path"], {
      fixture,
      env: { SWARMFORGE_CONFIG: selected },
    });
    expect(json(existing)).toEqual({
      config_path: selected,
      exists: true,
      env_files: [],
    });

    // A relative command line path anchors at the invocation directory.
    const relative = await run(
      [
        "config",
        "path",
        "--config",
        "nested/relative.toml",
        "--env-file",
        "secrets.env",
      ],
      { fixture },
    );
    expect(json(relative)).toEqual({
      config_path: join(fixture.work, "nested", "relative.toml"),
      exists: false,
      env_files: [join(fixture.work, "secrets.env")],
    });

    // The default never follows the working directory.
    const moved = await run(["config", "path"], {
      fixture,
      cwd: elsewhere,
      env: { XDG_CONFIG_HOME: fixture.xdg },
    });
    expect(json(moved).config_path).toBe(json(discovered).config_path);
    // Nothing was created, including the missing default and relative selections.
    expect(tree(fixture.base)).toEqual(before);
    expect(existsSync(join(fixture.xdg, "swarmforge"))).toBe(false);
    expect(existsSync(join(fixture.work, "nested"))).toBe(false);
    expect(existsSync(join(fixture.work, "secrets.env"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test("an explicit environment file keeps the database path a deployment already uses", async () => {
  const fixture = fixtureRoot();
  try {
    const envFile = join(fixture.base, "legacy.env");
    // A relative path in an environment file anchors at the invocation directory,
    // so an existing deployment keeps the file it has been writing to.
    writeFileSync(
      envFile,
      [
        "FREESTYLE_API_TOKEN=legacy-provider-credential",
        "FREESTYLE_SNAPSHOT_ID=legacy-snapshot",
        "SWARMFORGE_MODEL_BASE_URL=https://model.invalid/v1",
        "SWARMFORGE_MODEL_API_KEY=legacy-model-credential",
        "SWARMFORGE_MODEL_NAME=legacy-model",
        "SWARMFORGE_GIT_TREE=legacy-tree",
        "SWARMFORGE_DB_PATH=data/legacy.sqlite",
        "",
      ].join("\n"),
    );
    const shown = await run(["config", "show", "--env-file", envFile], {
      fixture,
    });
    expect(shown.exitCode).toBe(0);
    const report = json(shown);
    expect(report.server.ok).toBe(true);
    expect(report.server.values.SWARMFORGE_DB_PATH).toBe(
      join(fixture.work, "data", "legacy.sqlite"),
    );
    expect(report.server.sources.SWARMFORGE_DB_PATH).toBe(
      `env_file:${envFile}`,
    );
    // A different invocation directory anchors the same declaration elsewhere, and
    // the discovered configuration file does not move with it.
    const elsewhere = join(fixture.base, "elsewhere");
    mkdirSync(elsewhere);
    const moved = await run(["config", "show", "--env-file", envFile], {
      fixture,
      cwd: elsewhere,
      env: { XDG_CONFIG_HOME: fixture.xdg },
    });
    expect(json(moved).server.values.SWARMFORGE_DB_PATH).toBe(
      join(elsewhere, "data", "legacy.sqlite"),
    );
    expect(json(moved).client.config_path).toBe(null);
    expect(existsSync(join(elsewhere, "data"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test("config show reports redacted provenance and creates nothing", async () => {
  const fixture = fixtureRoot();
  try {
    const configFile = join(fixture.base, "config.toml");
    writeFileSync(
      configFile,
      [
        "schema_version = 1",
        "",
        "[client]",
        'url = "http://127.0.0.1:8787/mcp"',
        'token = "client-bearer-credential"',
        "",
        "[server]",
        'api_token = "server-bearer-credential"',
        // A credential repeated inside a path is still a credential in that path.
        'db_path = "data/server-bearer-credential.sqlite"',
        "",
        "[provider.freestyle]",
        'api_token = "provider-control-credential"',
        'snapshot_id = "snapshot"',
        "",
        "[model]",
        'base_url = "https://model.invalid/v1"',
        'api_key = "model-credential"',
        'name = "model"',
        "",
        "[git]",
        'tree = "opaque-tree"',
        "",
      ].join("\n"),
    );
    const before = tree(fixture.base);
    const outcome = await run(["config", "show", "--config", configFile], {
      fixture,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe("");
    // No credential material reaches the terminal, in any layer.
    for (const credential of [
      "client-bearer-credential",
      "server-bearer-credential",
      "provider-control-credential",
      "model-credential",
    ])
      expect(outcome.stdout).not.toContain(credential);
    const report = json(outcome);
    expect(report.client.config_path).toBe(configFile);
    expect(report.client.values.token).toBe("[REDACTED]");
    expect(report.client.sources.url).toBe(`config:${configFile}`);
    expect(report.client.secrets).toEqual(["token"]);
    expect(report.server.ok).toBe(true);
    expect(report.server.config_path).toBe(configFile);
    expect(report.server.values.FREESTYLE_API_TOKEN).toBe("[REDACTED]");
    expect(report.server.values.SWARMFORGE_API_TOKEN).toBe("[REDACTED]");
    expect(report.server.values.SWARMFORGE_DB_PATH).toContain("[REDACTED]");
    expect(report.server.values.SWARMFORGE_DB_PATH).not.toContain(
      "server-bearer-credential",
    );
    expect(report.server.secrets).toEqual([
      "FREESTYLE_API_TOKEN",
      "SWARMFORGE_API_TOKEN",
      "SWARMFORGE_MODEL_API_KEY",
    ]);
    expect(Object.keys(report.server.values)).toEqual(
      Object.keys(report.server.sources),
    );
    // Reading configuration is read-only: no directory, database or lock file.
    expect(tree(fixture.base)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

test("config show explains an incomplete server configuration safely", async () => {
  const fixture = fixtureRoot();
  try {
    const configFile = join(fixture.base, "partial.toml");
    writeFileSync(
      configFile,
      [
        "schema_version = 1",
        "",
        "[client]",
        'url = "http://127.0.0.1:8787/mcp"',
        'token = "client-bearer-credential"',
        "",
      ].join("\n"),
    );
    const before = tree(fixture.base);
    const outcome = await run(["config", "show", "--config", configFile], {
      fixture,
    });
    // An inspection command reports an incomplete server instead of failing.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe("");
    expect(outcome.stdout).not.toContain("client-bearer-credential");
    const report = json(outcome);
    expect(report.client.values.url).toBe("http://127.0.0.1:8787/mcp");
    expect(report.server.ok).toBe(false);
    expect(report.server.code).toBe("invalid_config");
    expect(report.server.message.length).toBeGreaterThan(0);
    expect(report.server.hint).toContain("swarmforge serve");
    // A missing default configuration file is not an error for a client either.
    const defaults = await run(["config", "show"], {
      fixture,
      env: { XDG_CONFIG_HOME: fixture.xdg },
    });
    expect(defaults.exitCode).toBe(0);
    expect(json(defaults).client.config_path).toBe(null);
    expect(json(defaults).client.values.url).toBe("http://127.0.0.1:8787/mcp");
    expect(tree(fixture.base)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

test("config validate checks every server setting without touching the system", async () => {
  const fixture = fixtureRoot();
  try {
    const configFile = join(fixture.base, "config.toml");
    writeFileSync(
      configFile,
      [
        "schema_version = 1",
        "",
        "[server]",
        'api_token = "server-bearer-credential"',
        "port = 8787",
        "",
        "[provider.freestyle]",
        'api_token = "provider-control-credential"',
        'snapshot_id = "snapshot"',
        "",
        "[model]",
        'base_url = "https://model.invalid/v1"',
        'api_key = "model-credential"',
        'name = "model"',
        "",
        "[git]",
        'tree = "opaque-tree"',
        "",
      ].join("\n"),
    );
    const before = tree(fixture.base);
    const valid = await run(["config", "validate", "--config", configFile], {
      fixture,
    });
    expect(valid.exitCode).toBe(0);
    expect(valid.stderr).toBe("");
    const report = json(valid);
    expect(report.ok).toBe(true);
    expect(report.config_path).toBe(configFile);
    expect(report.values.SWARMFORGE_PORT).toBe("8787");
    expect(report.values.SWARMFORGE_API_TOKEN).toBe("[REDACTED]");
    expect(report.sources.SWARMFORGE_PORT).toBe(`config:${configFile}`);
    expect(valid.stdout).not.toContain("server-bearer-credential");
    // No database, lock, provider or listener was created.
    expect(tree(fixture.base)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

test("a rejected configuration fails with a scrubbed diagnostic", async () => {
  const fixture = fixtureRoot();
  try {
    const before = tree(fixture.base);
    const missing = await run(["config", "validate"], {
      fixture,
      env: { SWARMFORGE_CONFIG: join(fixture.base, "absent.toml") },
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("SwarmForge:");
    expect(missing.stderr).toContain("absent.toml");

    const invalid = await run(
      ["config", "validate", "--config", "unreadable.toml"],
      {
        fixture,
      },
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("unreadable.toml");

    // A credential supplied in the environment is removed from a diagnostic that
    // echoes an unrelated value.
    const leaked = await run(["config", "validate"], {
      fixture,
      env: {
        SWARMFORGE_API_TOKEN: "environment-bearer-credential",
        SWARMFORGE_PORT: "70000",
        FREESTYLE_API_TOKEN: "environment-provider-credential",
        FREESTYLE_SNAPSHOT_ID: "snapshot",
        SWARMFORGE_MODEL_BASE_URL: "https://model.invalid/v1",
        SWARMFORGE_MODEL_API_KEY: "environment-model-credential",
        SWARMFORGE_MODEL_NAME: "model",
        SWARMFORGE_GIT_TREE: "opaque-tree",
      },
    });
    expect(leaked.exitCode).toBe(1);
    expect(leaked.stdout).toBe("");
    expect(leaked.stderr).not.toContain("environment-provider-credential");
    expect(leaked.stderr).not.toContain("environment-model-credential");
    expect(leaked.stderr).not.toContain("environment-bearer-credential");
    expect(tree(fixture.base)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

test("serve --check-config validates the server intent and starts nothing", async () => {
  const fixture = fixtureRoot();
  try {
    const configFile = join(fixture.base, "config.toml");
    writeFileSync(
      configFile,
      [
        "schema_version = 1",
        "",
        "[server]",
        "db_path = ':memory:'",
        "",
        "[provider.freestyle]",
        'api_token = "provider-control-credential"',
        'snapshot_id = "snapshot"',
        "",
        "[model]",
        'base_url = "https://model.invalid/v1"',
        'api_key = "model-credential"',
        'name = "model"',
        "",
        "[git]",
        'tree = "opaque-tree"',
        "",
      ].join("\n"),
    );
    // An in-memory database is a valid setting for a client and an invalid
    // deployment for a server, so a serve check refuses it.
    const memory = await run(
      ["serve", "--check-config", "--config", configFile],
      {
        fixture,
      },
    );
    expect(memory.exitCode).toBe(1);
    expect(memory.stdout).toBe("");
    expect(memory.stderr).toContain("persistent database");
    // The same declaration is accepted as general configuration.
    const accepted = await run(["config", "validate", "--config", configFile], {
      fixture,
    });
    expect(accepted.exitCode).toBe(0);
    expect(json(accepted).values.SWARMFORGE_DB_PATH).toBe(":memory:");

    const valid = await run(
      [
        "serve",
        "--check-config",
        "--config",
        configFile,
        "--env-file",
        "override.env",
      ],
      { fixture },
    );
    expect(valid.exitCode).toBe(1);
    expect(valid.stderr).toContain("override.env");

    writeFileSync(
      join(fixture.base, "override.env"),
      ["SWARMFORGE_DB_PATH=./checked.sqlite", ""].join("\n"),
    );
    const before = tree(fixture.base);
    const checked = await run(
      [
        "serve",
        "--check-config",
        "--config",
        configFile,
        "--env-file",
        join(fixture.base, "override.env"),
      ],
      { fixture },
    );
    expect(checked.exitCode).toBe(0);
    expect(checked.stderr).toBe("");
    const report = json(checked);
    expect(report.ok).toBe(true);
    expect(report.values.SWARMFORGE_DB_PATH).toBe(
      join(fixture.work, "checked.sqlite"),
    );
    expect(report.sources.SWARMFORGE_DB_PATH).toBe(
      `env_file:${join(fixture.base, "override.env")}`,
    );
    // No listener, database, lock file or provider request: the declared database
    // path is reported but nothing is created for it.
    expect(checked.stdout).not.toContain("listening");
    expect(tree(fixture.base)).toEqual(before);
    expect(existsSync(join(fixture.work, "checked.sqlite"))).toBe(false);
    expect(existsSync(`${join(fixture.work, "checked.sqlite")}.lock`)).toBe(
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test("main resolves server settings and still refuses an in-memory database", async () => {
  const fixture = fixtureRoot();
  try {
    const configFile = join(fixture.base, "config.toml");
    writeFileSync(
      configFile,
      [
        "schema_version = 1",
        "",
        "[server]",
        "db_path = ':memory:'",
        "",
        "[provider.freestyle]",
        'api_token = "provider-control-credential"',
        'snapshot_id = "snapshot"',
        "",
        "[model]",
        'base_url = "https://model.invalid/v1"',
        'api_key = "model-credential"',
        'name = "model"',
        "",
        "[git]",
        'tree = "opaque-tree"',
        "",
      ].join("\n"),
    );
    const before = tree(fixture.base);
    const memory = await run([], {
      fixture,
      entry: mainEntry,
      env: { SWARMFORGE_CONFIG: configFile },
    });
    expect(memory.exitCode).toBe(1);
    expect(memory.stderr + memory.stdout).toContain("persistent database");
    expect(memory.stderr + memory.stdout).not.toContain("model-credential");
    // A configuration that cannot be read is reported by the entry point too.
    const absent = await run([], {
      fixture,
      entry: mainEntry,
      env: { SWARMFORGE_CONFIG: join(fixture.base, "absent.toml") },
    });
    expect(absent.exitCode).toBe(1);
    expect(absent.stderr + absent.stdout).toContain("absent.toml");
    expect(tree(fixture.base)).toEqual(before);
  } finally {
    fixture.cleanup();
  }
});

/** A client credential that exists only in configuration, never in the environment. */
const configToken = "config-only-credential";
const environmentFileToken = "environment-file-credential";

const denial = (request: Request) =>
  new Response(`Denied ${request.headers.get("authorization") ?? "none"}`, {
    status: 401,
  });

/** A server that refuses every request and echoes the bearer header it received. */
function denyingServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => denial(request),
  });
}

/**
 * A real MCP surface that answers the handshake and then refuses every tool call,
 * which is where an error arrives after the client is already connected.
 */
function denyingAfterConnect(h: ReturnType<typeof harness>) {
  const swarm = createHttpHandler(h.coordinator);
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.clone().text();
      calls.push(body);
      if (body.includes('"initialize"') || body.includes('"notifications/'))
        return swarm(request);
      return denial(request);
    },
  });
  return { server, calls };
}

test("a remote error that echoes a resolved credential never prints it", async () => {
  const fixture = fixtureRoot();
  // Nothing credential-shaped is in the process environment, so only the loader's
  // own resolution context can remove the value the server echoed back.
  const server = denyingServer();
  try {
    const configFile = join(fixture.base, "client.toml");
    writeFileSync(
      configFile,
      [
        "schema_version = 1",
        "",
        "[client]",
        `url = "http://127.0.0.1:${server.port}/mcp"`,
        `token = "${configToken}"`,
        "",
      ].join("\n"),
    );
    const refused = await run(["status", "--config", configFile, "--json"], {
      fixture,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("Denied");
    expect(refused.stderr).toContain("[REDACTED]");
    expect(refused.stderr).not.toContain(configToken);

    // The same refusal once the client is connected, while reading the overview.
    const h = harness();
    const { server: swarm, calls } = denyingAfterConnect(h);
    const midwayConfig = join(fixture.base, "midway.toml");
    writeFileSync(
      midwayConfig,
      [
        "schema_version = 1",
        "",
        "[client]",
        `url = "http://127.0.0.1:${swarm.port}/mcp"`,
        `token = "${configToken}"`,
        "",
      ].join("\n"),
    );
    try {
      const midway = await run(
        ["status", "--config", midwayConfig, "--no-interactive"],
        { fixture },
      );
      expect(midway.exitCode).toBe(1);
      expect(midway.stdout).toBe("");
      expect(midway.stderr).toContain("Denied");
      expect(midway.stderr).not.toContain(configToken);
      // The refusal arrived at a tool call, so the failure was raised after the
      // handshake and not while connecting.
      expect(calls.some((body) => body.includes('"tools/call"'))).toBe(true);
    } finally {
      await swarm.stop(true);
      h.store.close();
    }

    // A credential layered over the first one is removed as well, and so is the
    // value it superseded.
    const envFile = join(fixture.base, "client.env");
    writeFileSync(envFile, `SWARMFORGE_API_TOKEN=${environmentFileToken}\n`);
    const superseded = await run(
      ["status", "--config", configFile, "--env-file", envFile, "--json"],
      { fixture },
    );
    expect(superseded.exitCode).toBe(1);
    expect(superseded.stderr).not.toContain(environmentFileToken);
    expect(superseded.stderr).not.toContain(configToken);
  } finally {
    await server.stop(true);
    fixture.cleanup();
  }
});

test("the printed endpoint carries no credential from any layer", async () => {
  const fixture = fixtureRoot();
  const h = harness();
  h.store.create({ ...task, timeout_seconds: 60 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(h.coordinator),
  });
  const endpoint = `http://127.0.0.1:${server.port}/mcp`;
  try {
    const configFile = join(fixture.base, "client.toml");
    writeFileSync(
      configFile,
      [
        "schema_version = 1",
        "",
        "[client]",
        `token = "${configToken}"`,
        "",
      ].join("\n"),
    );
    // The endpoint the operator typed repeats the credential the resolver knows.
    const query = await run(
      [
        "status",
        "--config",
        configFile,
        "--url",
        `${endpoint}?token=${configToken}`,
        "--json",
      ],
      { fixture },
    );
    expect(query.exitCode).toBe(0);
    expect(query.stderr).toBe("");
    const reported = JSON.parse(query.stdout).url as string;
    expect(reported).not.toContain(configToken);
    expect(reported).toContain("token=[REDACTED]");
    // The connection still used the endpoint exactly as it was written.
    expect(reported.startsWith(`${endpoint}?`)).toBe(true);

    // User information in the endpoint is a credential too.
    const userinfo = await run(
      [
        "status",
        "--url",
        `http://operator:${configToken}@127.0.0.1:${server.port}/mcp`,
        "--json",
      ],
      { fixture },
    );
    expect(userinfo.exitCode).toBe(0);
    expect(JSON.parse(userinfo.stdout).url).not.toContain(configToken);

    // The rendered snapshot prints the endpoint as well.
    const snapshot = await run(
      [
        "status",
        "--config",
        configFile,
        "--url",
        `${endpoint}?token=${configToken}`,
        "--no-interactive",
      ],
      { fixture },
    );
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).not.toContain(configToken);
    expect(snapshot.stdout).toContain("MCP");
  } finally {
    await server.stop(true);
    h.store.close();
    fixture.cleanup();
  }
});

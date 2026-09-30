import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redactedSettings } from "../src/settings/inspect";
import {
  resolveClientSettings,
  resolveServerSettings,
  SettingsError,
} from "../src/settings/load";

const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { force: true, recursive: true });
});

// Every fixture is private to this suite; nothing is shared with other test files.
function sandbox(files: Record<string, string> = {}, prefix = "sf-settings-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected settings resolution to fail");
}

function tree(dir: string): string[] {
  const rows: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      const label = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, label);
      else {
        const stat = statSync(path);
        rows.push(
          `${label} ${stat.mode} ${stat.size} ${stat.mtimeMs.toFixed(3)}`,
        );
      }
    }
  };
  walk(dir, "");
  return rows;
}

function validEnv(): Record<string, string> {
  return {
    FREESTYLE_API_TOKEN: "process-freestyle-token",
    FREESTYLE_SNAPSHOT_ID: "process-snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://process.example/v1",
    SWARMFORGE_MODEL_API_KEY: "process-model-key",
    SWARMFORGE_MODEL_NAME: "process-model",
    SWARMFORGE_GIT_TREE: "none",
  };
}

const serverToml = `schema_version = 1
env_file = "secrets.env"

[provider.freestyle]
api_token = "toml-freestyle-token"
snapshot_id = "toml-snapshot"

[model]
base_url = "https://model.example/v1"
api_key = "toml-model-key"
name = "toml-model"

[git]
tree = "https://github.com/owner/repo.git"
push_mode = "none"

[server]
host = "127.0.0.1"
port = 8787

[limits]
max_workers = 50
`;

const secretsEnv = `FREESTYLE_API_TOKEN=env-file-freestyle-token
SWARMFORGE_MODEL_API_KEY=env-file-model-key
SWARMFORGE_MAX_WORKERS=7
`;

// A sandbox whose home holds the default config location and its env file.
function defaultHome() {
  const dir = sandbox({
    "home/.config/swarmforge/config.toml": serverToml,
    "home/.config/swarmforge/secrets.env": secretsEnv,
  });
  const home = join(dir, "home");
  const config = join(home, ".config/swarmforge/config.toml");
  return {
    dir,
    home,
    config,
    secrets: join(home, ".config/swarmforge/secrets.env"),
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  };
}

describe("configuration discovery", () => {
  test("uses an absolute XDG config home and reports the file it read", async () => {
    const dir = sandbox({
      "xdg/swarmforge/config.toml": serverToml,
      "xdg/swarmforge/secrets.env": secretsEnv,
    });
    const file = join(dir, "xdg/swarmforge/config.toml");
    const s = await resolveServerSettings({
      cwd: dir,
      env: { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg") },
    });
    expect(s.configPath).toBe(file);
    expect(s.value.FREESTYLE_SNAPSHOT_ID).toBe("toml-snapshot");
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(7);
    expect(s.provenance.FREESTYLE_SNAPSHOT_ID).toBe(`config:${file}`);
    expect(s.provenance.SWARMFORGE_MAX_WORKERS).toBe(
      `env_file:${join(dir, "xdg/swarmforge/secrets.env")}`,
    );
    expect(s.provenance.SWARMFORGE_MAX_PROVISIONING).toBe("default");
  });

  test("ignores a relative XDG config home and falls back to the home default", async () => {
    const dir = sandbox({
      "home/.config/swarmforge/config.toml": serverToml,
      "home/.config/swarmforge/secrets.env": secretsEnv,
      "relative-xdg/swarmforge/config.toml": "schema_version = 2\n",
    });
    const home = join(dir, "home");
    const s = await resolveServerSettings({
      cwd: dir,
      env: { HOME: home, XDG_CONFIG_HOME: "relative-xdg" },
    });
    expect(s.configPath).toBe(join(home, ".config/swarmforge/config.toml"));
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(7);
  });

  test("ignores a relative XDG data home when defaulting the database", async () => {
    const dir = sandbox();
    const home = join(dir, "home");
    const s = await resolveServerSettings({
      cwd: dir,
      env: { HOME: home, XDG_DATA_HOME: "relative-data", ...validEnv() },
    });
    expect(s.configPath).toBeNull();
    expect(s.value.SWARMFORGE_DB_PATH).toBe(
      join(home, ".local/share/swarmforge/swarmforge.sqlite"),
    );
  });

  test("defaults the database under an absolute XDG data home", async () => {
    const dir = sandbox();
    const data = join(dir, "xdg-data");
    const s = await resolveServerSettings({
      cwd: dir,
      env: { HOME: join(dir, "home"), XDG_DATA_HOME: data, ...validEnv() },
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(
      join(data, "swarmforge/swarmforge.sqlite"),
    );
    expect(s.provenance.SWARMFORGE_DB_PATH).toBe("default");
  });

  test("never searches the working directory or its parents", async () => {
    const dir = sandbox({
      "config.toml": serverToml,
      "config.toml.env": secretsEnv,
      "nested/child/.config/swarmforge/config.toml": serverToml,
      "nested/child/.config/swarmforge/secrets.env": secretsEnv,
    });
    const s = await resolveServerSettings({
      cwd: join(dir, "nested/child"),
      env: { HOME: join(dir, "home"), ...validEnv() },
    });
    expect(s.configPath).toBeNull();
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(50);
    expect(s.provenance.SWARMFORGE_MAX_WORKERS).toBe("default");
  });

  test("an explicit config path replaces discovery and anchors at the cwd", async () => {
    const dir = sandbox({
      "alt/swarmforge.toml": serverToml,
      "alt/secrets.env": secretsEnv,
      "home/.config/swarmforge/config.toml": "schema_version = 1\nnope = 1\n",
    });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "alt/swarmforge.toml",
      env: {
        HOME: join(dir, "home"),
        XDG_CONFIG_HOME: join(dir, "home/.config"),
        SWARMFORGE_CONFIG: join(dir, "home/.config/swarmforge/config.toml"),
      },
    });
    expect(s.configPath).toBe(join(dir, "alt/swarmforge.toml"));
    expect(s.value.FREESTYLE_SNAPSHOT_ID).toBe("toml-snapshot");
  });

  test("SWARMFORGE_CONFIG selects a file only without an explicit path", async () => {
    const dir = sandbox({
      "alt/env-selected.toml": serverToml,
      "alt/secrets.env": secretsEnv,
    });
    const viaEnv = await resolveServerSettings({
      cwd: dir,
      env: {
        HOME: join(dir, "home"),
        SWARMFORGE_CONFIG: "alt/env-selected.toml",
      },
    });
    expect(viaEnv.configPath).toBe(join(dir, "alt/env-selected.toml"));
    const viaOption = await resolveServerSettings({
      cwd: dir,
      configPath: join(dir, "alt/env-selected.toml"),
      env: {
        HOME: join(dir, "home"),
        SWARMFORGE_CONFIG: join(dir, "absent.toml"),
      },
    });
    expect(viaOption.configPath).toBe(join(dir, "alt/env-selected.toml"));
  });

  test("a missing default config is allowed but a selected one fails", async () => {
    const dir = sandbox();
    const missing = await resolveServerSettings({
      cwd: dir,
      env: { HOME: join(dir, "home"), ...validEnv() },
    });
    expect(missing.configPath).toBeNull();
    expect(missing.value.FREESTYLE_API_TOKEN).toBe("process-freestyle-token");
    await expect(
      resolveServerSettings({
        cwd: dir,
        configPath: "absent.toml",
        env: { HOME: join(dir, "home") },
      }),
    ).rejects.toThrow(/absent\.toml/);
    await expect(
      resolveServerSettings({
        cwd: dir,
        env: { HOME: join(dir, "home"), SWARMFORGE_CONFIG: "gone.toml" },
      }),
    ).rejects.toThrow(/gone\.toml/);
  });

  test("reports a machine-readable settings error", async () => {
    const dir = sandbox();
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        configPath: "absent.toml",
        env: { HOME: dir },
      }),
    );
    expect(error).toBeInstanceOf(SettingsError);
    expect((error as SettingsError).code).toBe("config_not_found");
    expect((error as SettingsError).path).toBe(join(dir, "absent.toml"));
  });
});

const hostPathsToml = `schema_version = 1

[provider.freestyle]
api_token = "t"
snapshot_id = "s"

[model]
base_url = "https://model.example/v1"
api_key = "k"
name = "m"

[git]
tree = "https://github.com/owner/repo.git"
push_mode = "ssh"

[git.ssh]
push_url = "git@github.com:owner/repo.git"
key_path = "keys/id_ed25519"
known_hosts_path = "keys/known_hosts"

[server]
db_path = "data/swarmforge.sqlite"
`;

describe("path anchoring", () => {
  test("anchors paths declared in the config file at its own directory", async () => {
    const dir = sandbox({ "conf/swarmforge.toml": hostPathsToml });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(
      join(dir, "conf/data/swarmforge.sqlite"),
    );
    expect(s.value.SWARMFORGE_GIT_SSH_KEY_PATH).toBe(
      join(dir, "conf/keys/id_ed25519"),
    );
    expect(s.value.SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH).toBe(
      join(dir, "conf/keys/known_hosts"),
    );
    expect(s.provenance.SWARMFORGE_GIT_SSH_KEY_PATH).toBe(
      `config:${join(dir, "conf/swarmforge.toml")}`,
    );
  });

  test("expands a leading tilde to the home directory without a shell", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": hostPathsToml
        .replace(
          'db_path = "data/swarmforge.sqlite"',
          'db_path = "~/db/swarmforge.sqlite"',
        )
        .replace(
          'key_path = "keys/id_ed25519"',
          'key_path = "~/keys/id_ed25519"',
        ),
    });
    const home = join(dir, "home");
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: home },
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(join(home, "db/swarmforge.sqlite"));
    expect(s.value.SWARMFORGE_GIT_SSH_KEY_PATH).toBe(
      join(home, "keys/id_ed25519"),
    );
  });

  test("leaves the in-memory selector and guest paths exactly as written", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": `schema_version = 1
[provider.freestyle]
api_token = "t"
snapshot_id = "s"
[model]
base_url = "https://model.example/v1"
api_key = "k"
name = "m"
[git]
tree = "none"
[workspace]
guest_path = "/srv/guest"
[server]
db_path = ":memory:"
`,
    });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(":memory:");
    expect(s.value.SWARMFORGE_WORKSPACE).toBe("/srv/guest");
  });

  test("anchors a legacy relative database path from an env file at the cwd", async () => {
    const dir = sandbox({
      "env/legacy.env": "SWARMFORGE_DB_PATH=./data/swarmforge.sqlite\n",
    });
    const file = join(dir, "env/legacy.env");
    const s = await resolveServerSettings({
      cwd: dir,
      env: validEnv(),
      envFiles: ["env/legacy.env"],
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(
      join(dir, "data/swarmforge.sqlite"),
    );
    expect(s.provenance.SWARMFORGE_DB_PATH).toBe(`env_file:${file}`);
  });

  test("anchors a legacy relative database path from the environment at the cwd", async () => {
    const dir = sandbox();
    const s = await resolveServerSettings({
      cwd: dir,
      env: { ...validEnv(), SWARMFORGE_DB_PATH: "data/old.sqlite" },
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(join(dir, "data/old.sqlite"));
    expect(s.provenance.SWARMFORGE_DB_PATH).toBe("env");
  });

  test("never relocates an explicitly configured database to the XDG default", async () => {
    const dir = sandbox();
    const s = await resolveServerSettings({
      cwd: dir,
      env: {
        ...validEnv(),
        XDG_DATA_HOME: join(dir, "xdg-data"),
        SWARMFORGE_DB_PATH: "./data/swarmforge.sqlite",
      },
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(
      join(dir, "data/swarmforge.sqlite"),
    );
  });

  test("anchors a declared env_file at the config directory", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": `schema_version = 1
env_file = "../shared.env"
[provider.freestyle]
api_token = "t"
snapshot_id = "s"
[model]
base_url = "https://model.example/v1"
api_key = "k"
name = "m"
[git]
tree = "none"
`,
      "shared.env": "SWARMFORGE_MAX_WORKERS=9\n",
    });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
    });
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(9);
    expect(s.provenance.SWARMFORGE_MAX_WORKERS).toBe(
      `env_file:${join(dir, "shared.env")}`,
    );
  });
});

const precedenceToml = `schema_version = 1
env_file = "a.env"

[provider.freestyle]
api_token = "toml-freestyle-token"
snapshot_id = "toml-snapshot"

[model]
base_url = "https://model.example/v1"
api_key = "toml-model-key"
name = "toml-model"

[git]
tree = "none"

[server]
allowed_hosts = "localhost,127.0.0.1"

[limits]
max_workers = 1
max_provisioning = 1
`;

describe("strict schema", () => {
  test("rejects an unknown key", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": serverToml.replace(
        'push_mode = "none"',
        'push_mode = "none"\npush_mod = "typo"',
      ),
    });
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        configPath: "conf/swarmforge.toml",
        env: { HOME: join(dir, "home") },
      }),
    );
    expect(error).toBeInstanceOf(SettingsError);
    expect(error.message).toMatch(/push_mod/);
    expect((error as SettingsError).code).toBe("config_invalid");
  });

  test("rejects an unknown table and any other schema version", async () => {
    const dir = sandbox({
      "conf/table.toml": `${serverToml}\n[database]\npath = "x.sqlite"\n`,
      "conf/v2.toml": serverToml.replace(
        "schema_version = 1",
        "schema_version = 2",
      ),
      "conf/text.toml": serverToml.replace(
        "schema_version = 1",
        'schema_version = "1"',
      ),
    });
    for (const name of ["table.toml", "v2.toml", "text.toml"]) {
      const error = await failure(
        resolveServerSettings({
          cwd: dir,
          configPath: `conf/${name}`,
          env: { HOME: join(dir, "home") },
        }),
      );
      expect(error).toBeInstanceOf(SettingsError);
      expect(error.message).toMatch(/schema_version|database/);
    }
  });

  test("reports a TOML syntax error without echoing file values", async () => {
    const dir = sandbox({
      "conf/broken.toml": `schema_version = 1
[provider.freestyle]
api_token = "leaked-token-value-1"
snapshot_id = "s"
model = { broken
`,
    });
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        configPath: "conf/broken.toml",
        env: { HOME: join(dir, "home") },
      }),
    );
    expect(error).toBeInstanceOf(SettingsError);
    expect(error.message).not.toContain("leaked-token-value-1");
    expect(error.message).toContain("conf/broken.toml");
  });

  test("a client-only file cannot satisfy server requirements", async () => {
    const dir = sandbox({
      "client.toml": `schema_version = 1
[client]
url = "https://mcp.example/mcp"
`,
    });
    await expect(
      resolveServerSettings({
        cwd: dir,
        configPath: "client.toml",
        env: { HOME: dir },
      }),
    ).rejects.toThrow(/FREESTYLE_API_TOKEN/);
  });
});

describe("layer precedence", () => {
  const files = {
    "conf/swarmforge.toml": precedenceToml,
    "conf/a.env": "SWARMFORGE_MAX_WORKERS=2\nSWARMFORGE_MAX_PROVISIONING=2\n",
    "extra/b.env": "SWARMFORGE_MAX_WORKERS=3\n",
  };

  test("the config env_file overrides the config file", async () => {
    const dir = sandbox(files);
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
    });
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(2);
    expect(s.provenance.SWARMFORGE_MAX_WORKERS).toBe(
      `env_file:${join(dir, "conf/a.env")}`,
    );
  });

  test("explicit env files are applied in order after the config env_file", async () => {
    const dir = sandbox(files);
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
      envFiles: ["extra/b.env"],
    });
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(3);
    expect(s.provenance.SWARMFORGE_MAX_WORKERS).toBe(
      `env_file:${join(dir, "extra/b.env")}`,
    );
    expect(s.value.SWARMFORGE_MAX_PROVISIONING).toBe(2);
  });

  test("the environment wins over env files and overrides win over both", async () => {
    const dir = sandbox(files);
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home"), SWARMFORGE_MAX_WORKERS: "4" },
      envFiles: ["extra/b.env"],
      overrides: { SWARMFORGE_MAX_WORKERS: "5" },
    });
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(5);
    expect(s.provenance.SWARMFORGE_MAX_WORKERS).toBe("override");
    const fromEnv = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home"), SWARMFORGE_MAX_WORKERS: "4" },
      envFiles: ["extra/b.env"],
    });
    expect(fromEnv.value.SWARMFORGE_MAX_WORKERS).toBe(4);
    expect(fromEnv.provenance.SWARMFORGE_MAX_WORKERS).toBe("env");
  });

  test("comma-separated lists are replaced, not merged", async () => {
    const dir = sandbox(files);
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home"), SWARMFORGE_ALLOWED_HOSTS: "::1" },
    });
    expect(s.value.SWARMFORGE_ALLOWED_HOSTS).toBe("::1");
    expect(s.provenance.SWARMFORGE_ALLOWED_HOSTS).toBe("env");
  });

  test("an empty value is unset and leaves the lower layer intact", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": serverToml,
      "conf/secrets.env": `SWARMFORGE_MAX_WORKERS=
FREESTYLE_API_TOKEN=
`,
    });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
      overrides: {
        SWARMFORGE_ALLOWED_HOSTS: "",
        SWARMFORGE_MAX_PROVISIONING: "",
      },
    });
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(50);
    expect(s.provenance.SWARMFORGE_MAX_WORKERS).toBe(
      `config:${join(dir, "conf/swarmforge.toml")}`,
    );
    expect(s.value.FREESTYLE_API_TOKEN).toBe("toml-freestyle-token");
    expect(s.provenance.FREESTYLE_API_TOKEN).toBe(
      `config:${join(dir, "conf/swarmforge.toml")}`,
    );
    expect(s.value.SWARMFORGE_ALLOWED_HOSTS).toBe("");
    expect(s.provenance.SWARMFORGE_ALLOWED_HOSTS).toBe("default");
    expect(s.value.SWARMFORGE_MAX_PROVISIONING).toBe(4);
    expect(s.provenance.SWARMFORGE_MAX_PROVISIONING).toBe("default");
  });

  test("ignores unrelated environment keys and keeps the OpenCode aliases", async () => {
    const dir = sandbox();
    const s = await resolveServerSettings({
      cwd: dir,
      env: {
        ...validEnv(),
        PATH: "/usr/local/bin",
        SWARMFORGE_RUN_SMOKE: "true",
        SWARMFORGE_UNKNOWN_KEY: "1",
        OPENCODE_PORT: "5001",
        SWARMFORGE_MAX_WORKERS: "8",
      },
    });
    expect(s.value.OPENCODE_PORT).toBe(5001);
    expect(s.value.SWARMFORGE_MAX_WORKERS).toBe(8);
    expect(s.provenance.PATH).toBeUndefined();
    expect(s.provenance.SWARMFORGE_RUN_SMOKE).toBeUndefined();
    expect(Object.keys(s.value)).not.toContain("SWARMFORGE_RUN_SMOKE");
    expect(Object.keys(s.provenance)).toContain("OPENCODE_PORT");
  });
});

describe("env file parsing", () => {
  test("supports quoting and interpolation without evaluating commands", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": `schema_version = 1
env_file = "vars.env"
[provider.freestyle]
api_token = "t"
[model]
base_url = "https://model.example/v1"
api_key = "k"
[git]
tree = "none"
`,
      "conf/vars.env": `# a comment
export FREESTYLE_SNAPSHOT_ID=snapshot-from-file
FREESTYLE_API_TOKEN="quoted \\"token\\""
SWARMFORGE_MODEL_API_KEY='literal $HOME stays'
SWARMFORGE_MODEL_NAME=plain-\${FREESTYLE_SNAPSHOT_ID}-model  # trailing comment
SWARMFORGE_GIT_AUTHOR_NAME=$(echo pwned) \`id\`
SWARMFORGE_METRICS_TEAMS=
`,
    });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
    });
    expect(s.value.FREESTYLE_API_TOKEN).toBe('quoted "token"');
    expect(s.value.FREESTYLE_SNAPSHOT_ID).toBe("snapshot-from-file");
    expect(s.value.SWARMFORGE_MODEL_API_KEY).toBe("literal $HOME stays");
    expect(s.value.SWARMFORGE_MODEL_NAME).toBe(
      "plain-snapshot-from-file-model",
    );
    expect(s.value.SWARMFORGE_GIT_AUTHOR_NAME).toBe("$(echo pwned) `id`");
    expect(s.value.SWARMFORGE_METRICS_TEAMS).toBe("default");
  });

  test("interpolates from the environment when the file does not define it", async () => {
    const dir = sandbox({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: env-file interpolation under test
      "vars.env": "SWARMFORGE_METRICS_TEAMS=${SWARMFORGE_INSTANCE_ID}-team\n",
    });
    const s = await resolveServerSettings({
      cwd: dir,
      env: { ...validEnv(), SWARMFORGE_INSTANCE_ID: "teamone" },
      envFiles: ["vars.env"],
    });
    expect(s.value.SWARMFORGE_METRICS_TEAMS).toBe("teamone-team");
  });

  test("rejects a malformed line instead of ignoring it", async () => {
    const dir = sandbox({
      "broken.env": "SWARMFORGE_MAX_WORKERS=3\nnot an assignment\n",
      "quoted.env": 'FREESTYLE_API_TOKEN="echoed-secret-value\n',
    });
    const missing = await failure(
      resolveServerSettings({
        cwd: dir,
        env: validEnv(),
        envFiles: ["broken.env"],
      }),
    );
    expect(missing).toBeInstanceOf(SettingsError);
    expect((missing as SettingsError).code).toBe("env_file_invalid");
    expect(missing.message).toContain("line 2");
    expect(missing.message).not.toContain("not an assignment");
    const quoted = await failure(
      resolveServerSettings({
        cwd: dir,
        env: validEnv(),
        envFiles: ["quoted.env"],
      }),
    );
    expect((quoted as SettingsError).code).toBe("env_file_invalid");
    expect(quoted.message).toContain("unterminated quote");
    expect(quoted.message).not.toContain("echoed-secret-value");
  });

  test("fails when a selected env file is absent", async () => {
    const dir = sandbox();
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        env: validEnv(),
        envFiles: ["absent.env"],
      }),
    );
    expect(error).toBeInstanceOf(SettingsError);
    expect((error as SettingsError).code).toBe("env_file_not_found");
  });
});

describe("redaction", () => {
  test("reports values and sources without secrets", async () => {
    const home = defaultHome();
    const s = await resolveServerSettings({ cwd: home.dir, env: home.env });
    const redacted = redactedSettings(s);
    expect(redacted.config_path).toBe(home.config);
    expect(redacted.values.FREESTYLE_API_TOKEN).toBe("[REDACTED]");
    expect(redacted.values.SWARMFORGE_MODEL_API_KEY).toBe("[REDACTED]");
    expect(redacted.values.FREESTYLE_SNAPSHOT_ID).toBe("toml-snapshot");
    expect(redacted.sources.FREESTYLE_SNAPSHOT_ID).toBe(
      `config:${home.config}`,
    );
    expect(redacted.sources.SWARMFORGE_MAX_WORKERS).toBe(
      `env_file:${home.secrets}`,
    );
    expect(redacted.secrets).toContain("FREESTYLE_API_TOKEN");
    expect(redacted.secrets).toContain("SWARMFORGE_MODEL_API_KEY");
    const json = JSON.stringify(redacted);
    expect(json).not.toContain("env-file-freestyle-token");
    expect(json).not.toContain("toml-freestyle-token");
    expect(json).not.toContain("env-file-model-key");
    expect(json).not.toContain("toml-model-key");
    expect(JSON.parse(json)).toEqual(redacted);
  });

  test("redacts a secret reused in an unrelated setting", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": serverToml
        .replace('env_file = "secrets.env"\n', "")
        .replace(
          'host = "127.0.0.1"',
          'host = "127.0.0.1"\nmetrics_teams = "unusual-secret-token"',
        )
        .replace(
          'api_token = "toml-freestyle-token"',
          'api_token = "unusual-secret-token"',
        ),
    });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
    });
    const redacted = redactedSettings(s);
    expect(s.value.SWARMFORGE_METRICS_TEAMS).toBe("unusual-secret-token");
    expect(redacted.values.SWARMFORGE_METRICS_TEAMS).toBe("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("unusual-secret-token");
  });

  test("redacts credential material embedded in another endpoint", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": serverToml
        .replace('env_file = "secrets.env"\n', "")
        .replace(
          'base_url = "https://model.example/v1"',
          'base_url = "https://user:toml-model-key@model.example/v1"',
        ),
    });
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: join(dir, "home") },
    });
    expect(s.value.SWARMFORGE_MODEL_BASE_URL).toBe(
      "https://user:toml-model-key@model.example/v1",
    );
    const redacted = redactedSettings(s);
    expect(redacted.values.SWARMFORGE_MODEL_BASE_URL).toBe(
      "https://[REDACTED]@model.example/v1",
    );
    expect(JSON.stringify(redacted)).not.toContain("toml-model-key");
  });

  test("never leaks a secret through a validation error", async () => {
    const dir = sandbox({
      "conf/leak.toml": serverToml
        .replace(
          'api_token = "toml-freestyle-token"',
          'api_token = "leak-token-value-1"',
        )
        .replace(
          'host = "127.0.0.1"',
          'host = "127.0.0.1"\nallowed_hosts = "leak-token-value-1"',
        ),
      "conf/secrets.env": secretsEnv,
    });
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        configPath: "conf/leak.toml",
        env: { HOME: join(dir, "home") },
      }),
    );
    expect(error).toBeInstanceOf(SettingsError);
    expect(error.message).not.toContain("leak-token-value-1");
    expect(error.message).toContain("[REDACTED]");
    expect((error as SettingsError).code).toBe("invalid_config");
  });
});

// Credentials of every length must be removed wherever they appear: the loader
// accepts any nonempty string, so a short credential is still a credential.
const lengths = ["Q", "Q7z", "Q7z4m2p", "Q7z4m2pK", "Q7z4m2pK9w1t5r8x0z3n6v"];

/** Everything a command would render, so a credential cannot hide in a key name. */
function rendered(redacted: ReturnType<typeof redactedSettings>): string {
  return [
    redacted.config_path ?? "",
    ...Object.values(redacted.values),
    ...Object.values(redacted.sources),
    ...redacted.secrets,
  ].join("\n");
}

// A sandbox name is random, so it is removed before looking for a credential
// that can be a single character.
const withoutRoot = (text: string, dir: string) =>
  text.split(dir).join("<sandbox>");

function credentialConfig(secret: string, host = "") {
  return `schema_version = 1
[provider.freestyle]
api_token = "${secret}"
snapshot_id = "s"

[model]
base_url = "https://model.example/v1"
api_key = "${secret}"
name = "m"

[git]
tree = "none"

[server]
metrics_teams = "${secret}"
db_path = "data/${secret}.sqlite"${host}
`;
}

describe("credential redaction regressions", () => {
  test("removes short credentials from unrelated values", async () => {
    for (const secret of lengths) {
      const dir = sandbox(
        { "conf/c.toml": credentialConfig(secret) },
        `sf-settings-${secret}-`,
      );
      const resolved = await resolveServerSettings({
        cwd: dir,
        configPath: "conf/c.toml",
        env: { HOME: join(dir, "home") },
      });
      expect(resolved.value.FREESTYLE_API_TOKEN).toBe(secret);
      expect(resolved.value.SWARMFORGE_METRICS_TEAMS).toBe(secret);
      const redacted = redactedSettings(resolved);
      expect(redacted.values.FREESTYLE_API_TOKEN).toBe("[REDACTED]");
      expect(redacted.values.SWARMFORGE_MODEL_API_KEY).toBe("[REDACTED]");
      expect(redacted.values.SWARMFORGE_METRICS_TEAMS).toBe("[REDACTED]");
      expect(
        redacted.values.SWARMFORGE_DB_PATH?.endsWith(
          join("conf", "data", "[REDACTED].sqlite"),
        ),
      ).toBe(true);
      expect(withoutRoot(rendered(redacted), dir)).not.toContain(secret);
    }
  });

  test("removes short credentials from a client endpoint", async () => {
    for (const secret of lengths) {
      const dir = sandbox({
        "client.toml": `schema_version = 1
[client]
url = "https://mcp.example/${secret}/mcp"
token = "${secret}"
`,
      });
      const resolved = await resolveClientSettings({
        cwd: dir,
        configPath: "client.toml",
        env: { HOME: dir },
      });
      const redacted = redactedSettings(resolved);
      expect(redacted.values.token).toBe("[REDACTED]");
      expect(redacted.values.url).toBe("https://mcp.example/[REDACTED]/mcp");
      expect(withoutRoot(rendered(redacted), dir)).not.toContain(secret);
    }
  });

  test("removes short credentials from a validation error", async () => {
    for (const secret of lengths) {
      const dir = sandbox({
        "conf/c.toml": credentialConfig(
          secret,
          `\nallowed_hosts = "${secret}"`,
        ),
      });
      const error = await failure(
        resolveServerSettings({
          cwd: dir,
          configPath: "conf/c.toml",
          env: { HOME: join(dir, "home") },
        }),
      );
      expect((error as SettingsError).code).toBe("invalid_config");
      expect(error.message).toContain("[REDACTED]");
      expect(withoutRoot(error.message, dir)).not.toContain(secret);
    }
  });

  test("removes encoded and base64 copies of a credential", async () => {
    for (const secret of ["Q7z4m2p", "Q7z4m2pK9w1t5r8x0z3n6v"]) {
      const dir = sandbox({
        "conf/c.toml": `schema_version = 1
[provider.freestyle]
api_token = "${secret}"
snapshot_id = "s"

[model]
base_url = "https://model.example/v1"
api_key = "${secret}"
name = "m"

[git]
tree = "none"

[server]
metrics_teams = "${encodeURIComponent(secret)} ${Buffer.from(secret).toString("base64")}"
`,
      });
      const resolved = await resolveServerSettings({
        cwd: dir,
        configPath: "conf/c.toml",
        env: { HOME: join(dir, "home") },
      });
      const redacted = redactedSettings(resolved);
      expect(redacted.values.SWARMFORGE_METRICS_TEAMS).not.toContain(secret);
      expect(redacted.values.SWARMFORGE_METRICS_TEAMS).not.toContain(
        encodeURIComponent(secret),
      );
      expect(redacted.values.SWARMFORGE_METRICS_TEAMS).not.toContain(
        Buffer.from(secret).toString("base64"),
      );
    }
  });

  test("removes a superseded credential from a later error", async () => {
    const first = "superseded-value-11";
    const second = "replacement-value-22";
    const dir = sandbox({
      "conf/c.toml": `schema_version = 1
env_file = "later.env"
[provider.freestyle]
api_token = "${first}"
snapshot_id = "s"

[model]
base_url = "https://model.example/v1"
api_key = "k"
name = "m"

[git]
tree = "none"

[server]
allowed_hosts = "${first}"
`,
      "conf/later.env": `FREESTYLE_API_TOKEN=${second}
SWARMFORGE_ALLOWED_HOSTS=${first}
`,
    });
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        configPath: "conf/c.toml",
        env: { HOME: join(dir, "home") },
      }),
    );
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(first);
    expect(error.message).not.toContain(second);
  });

  test("removes an overridden credential from a later error", async () => {
    const configured = "override-value-33";
    const dir = sandbox({
      "conf/c.toml": `schema_version = 1
[provider.freestyle]
api_token = "${configured}"
snapshot_id = "s"

[model]
base_url = "https://model.example/v1"
api_key = "k"
name = "m"

[git]
tree = "none"
`,
    });
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        configPath: "conf/c.toml",
        env: { HOME: join(dir, "home") },
        overrides: { SWARMFORGE_ALLOWED_HOSTS: configured },
      }),
    );
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(configured);
  });

  test("removes a credential repeated in a source label", async () => {
    const secret = "env-file-name-value-44";
    const dir = sandbox({
      [`env/${secret}.env`]: "SWARMFORGE_MAX_WORKERS=6\n",
    });
    const resolved = await resolveServerSettings({
      cwd: dir,
      env: {
        HOME: join(dir, "home"),
        ...validEnv(),
        FREESTYLE_API_TOKEN: secret,
      },
      envFiles: [`env/${secret}.env`],
    });
    const redacted = redactedSettings(resolved);
    expect(redacted.sources.SWARMFORGE_MAX_WORKERS).not.toContain(secret);
    expect(redacted.sources.SWARMFORGE_MAX_WORKERS).toContain("env_file:");
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  test("strips control characters from diagnostics", async () => {
    const dir = sandbox();
    const injected = "mcp.example.com\u001b[31m\u0007\nsecond-line.example";
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        env: {
          HOME: join(dir, "home"),
          ...validEnv(),
          SWARMFORGE_ALLOWED_HOSTS: injected,
        },
      }),
    );
    expect((error as SettingsError).code).toBe("invalid_config");
    for (const character of ["\u001b", "\u0007", "\n"]) {
      expect(error.message).not.toContain(character);
    }
    expect(error.message.split("\n")).toHaveLength(1);
    expect(error.message).toContain("mcp.example.com[31msecond-line.example");
    expect((error as SettingsError).path).toBeUndefined();
  });

  test("strips control characters from rendered settings", async () => {
    const dir = sandbox({
      "conf/c.toml": `schema_version = 1
[provider.freestyle]
api_token = "token"
snapshot_id = "s"

[model]
base_url = "https://model.example/v1"
api_key = "key"
name = "m"

[git]
tree = "none"

[server]
metrics_teams = "team\\u001b[31m\\u0007"
`,
    });
    const resolved = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/c.toml",
      env: { HOME: join(dir, "home") },
    });
    expect(resolved.value.SWARMFORGE_METRICS_TEAMS).toContain("\u001b");
    const redacted = redactedSettings(resolved);
    expect(redacted.values.SWARMFORGE_METRICS_TEAMS).toBe("team[31m");
    for (const line of rendered(redacted).split("\n")) {
      for (const character of ["\u001b", "\u0007"]) {
        expect(line).not.toContain(character);
      }
    }
  });

  test("scrubs a credential repeated in a selected config path", async () => {
    const token = "path-credential-value-55";
    const shapes = [
      { env: { ...validEnv(), FREESTYLE_API_TOKEN: token } },
      { env: { ...validEnv(), SWARMFORGE_API_TOKEN: token } },
      { env: { ...validEnv(), SWARMFORGE_MODEL_API_KEY: token } },
      { env: validEnv(), overrides: { FREESTYLE_API_TOKEN: token } },
    ];
    for (const shape of shapes) {
      const dir = sandbox();
      const error = await failure(
        resolveServerSettings({
          ...shape,
          cwd: dir,
          configPath: join(dir, `${token}-missing.toml`),
        }),
      );
      expect((error as SettingsError).code).toBe("config_not_found");
      expect(error.message).toContain("[REDACTED]");
      expect(`${error.message} ${(error as SettingsError).path}`).not.toContain(
        token,
      );
    }
  });

  test("scrubs a client alias credential from a selected config path", async () => {
    const token = "client-path-credential-66";
    const dir = sandbox();
    const error = await failure(
      resolveClientSettings({
        cwd: dir,
        configPath: join(dir, `${token}-missing.toml`),
        env: { HOME: dir, SWARMFORGE_MCP_TOKEN: token },
      }),
    );
    expect((error as SettingsError).code).toBe("config_not_found");
    expect(`${error.message} ${(error as SettingsError).path}`).not.toContain(
      token,
    );
  });

  test("scrubs a credential repeated in a rejected config file name", async () => {
    const token = "file-name-credential-77";
    const dir = sandbox({
      [`${token}-broken.toml`]: `schema_version = 1
[client]
url = "http://127.0.0.1:8787/mcp"
token = "${token}"
model = { broken
`,
      [`${token}-unknown.toml`]: `schema_version = 1
[client]
token = "${token}"
[surprise]
value = 1
`,
    });
    for (const name of [`${token}-broken.toml`, `${token}-unknown.toml`]) {
      const error = await failure(
        resolveServerSettings({
          cwd: dir,
          configPath: join(dir, name),
          env: { HOME: join(dir, "home") },
        }),
      );
      expect((error as SettingsError).code).toBe("config_invalid");
      expect(error.message).toContain("[REDACTED]");
      expect(`${error.message} ${(error as SettingsError).path}`).not.toContain(
        token,
      );
    }
  });

  test("scrubs a credential repeated in a rejected environment file name", async () => {
    const token = "env-file-credential-88";
    const dir = sandbox({
      [`${token}.env`]: `FREESTYLE_API_TOKEN=${token}
not an assignment
`,
    });
    const error = await failure(
      resolveServerSettings({
        cwd: dir,
        env: validEnv(),
        envFiles: [`${token}.env`],
      }),
    );
    expect((error as SettingsError).code).toBe("env_file_invalid");
    expect(`${error.message} ${(error as SettingsError).path}`).not.toContain(
      token,
    );
  });

  test("reports values and sources for exactly the same keys", async () => {
    const dir = sandbox();
    const client = redactedSettings(
      await resolveClientSettings({ cwd: dir, env: { HOME: dir } }),
    );
    expect(client.values.token).toBeUndefined();
    expect(client.sources.token).toBeUndefined();
    expect(Object.keys(client.sources).sort()).toEqual(
      Object.keys(client.values).sort(),
    );
    const server = redactedSettings(
      await resolveServerSettings({
        cwd: dir,
        env: { HOME: dir, ...validEnv() },
      }),
    );
    expect(server.values.SWARMFORGE_API_TOKEN).toBeUndefined();
    expect(server.sources.SWARMFORGE_API_TOKEN).toBeUndefined();
    expect(Object.keys(server.sources).sort()).toEqual(
      Object.keys(server.values).sort(),
    );
  });
});

describe("client settings", () => {
  test("resolves a client endpoint and bearer token without provider settings", async () => {
    const dir = sandbox({
      "client.toml": `schema_version = 1
[client]
url = "https://mcp.example/mcp"
token = "client-bearer-token"
`,
    });
    const file = join(dir, "client.toml");
    const s = await resolveClientSettings({
      cwd: dir,
      configPath: "client.toml",
      env: { HOME: dir },
    });
    expect(s.value).toEqual({
      url: "https://mcp.example/mcp",
      token: "client-bearer-token",
    });
    expect(s.configPath).toBe(file);
    expect(s.provenance.url).toBe(`config:${file}`);
    const redacted = redactedSettings(s);
    expect(redacted.values.url).toBe("https://mcp.example/mcp");
    expect(redacted.values.token).toBe("[REDACTED]");
    expect(JSON.stringify(redacted)).not.toContain("client-bearer-token");
  });

  test("reads the endpoint and bearer token from the environment", async () => {
    const dir = sandbox();
    const s = await resolveClientSettings({
      cwd: dir,
      env: {
        HOME: dir,
        SWARMFORGE_URL: "http://127.0.0.1:9999/mcp",
        SWARMFORGE_API_TOKEN: "bearer-token-value",
      },
    });
    expect(s.value.url).toBe("http://127.0.0.1:9999/mcp");
    expect(s.value.token).toBe("bearer-token-value");
    expect(s.provenance.url).toBe("env");
    expect(s.configPath).toBeNull();
  });

  test("defaults to the loopback endpoint without a token", async () => {
    const dir = sandbox();
    const s = await resolveClientSettings({ cwd: dir, env: { HOME: dir } });
    expect(s.value.url).toBe("http://127.0.0.1:8787/mcp");
    expect(s.value.token).toBeUndefined();
    expect(s.provenance.url).toBe("default");
    expect(s.provenance.token).toBe("default");
  });

  test("applies overrides above the config file", async () => {
    const dir = sandbox({
      "client.toml": `schema_version = 1
[client]
url = "https://mcp.example/mcp"
token = "config-bearer-token"
`,
    });
    const s = await resolveClientSettings({
      cwd: dir,
      configPath: "client.toml",
      env: { HOME: dir },
      overrides: { SWARMFORGE_URL: "https://other.example/mcp" },
    });
    expect(s.value.url).toBe("https://other.example/mcp");
    expect(s.value.token).toBe("config-bearer-token");
    expect(s.provenance.url).toBe("override");
  });

  test("rejects an endpoint that is not http or https", async () => {
    const dir = sandbox();
    for (const url of ["file:///etc/passwd", "not-a-url", "ftp://host/mcp"]) {
      const error = await failure(
        resolveClientSettings({
          cwd: dir,
          env: { HOME: dir, SWARMFORGE_URL: url },
        }),
      );
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).code).toBe("invalid_client");
      expect(error.message).not.toContain("client-bearer-token");
    }
  });
});

describe("read-only diagnostics", () => {
  test("creates no directories, databases or locks", async () => {
    const dir = sandbox({
      "conf/swarmforge.toml": serverToml,
      "conf/secrets.env": secretsEnv,
    });
    const home = join(dir, "home");
    const before = tree(dir);
    const s = await resolveServerSettings({
      cwd: dir,
      configPath: "conf/swarmforge.toml",
      env: { HOME: home },
    });
    expect(s.value.SWARMFORGE_DB_PATH).toBe(
      join(home, ".local/share/swarmforge/swarmforge.sqlite"),
    );
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(home, ".local/share"))).toBe(false);
    expect(existsSync(join(dir, "conf/swarmforge.sqlite"))).toBe(false);
  });

  test("a rejected configuration leaves the filesystem unchanged", async () => {
    const dir = sandbox({
      "conf/broken.toml": "schema_version = 7\n",
      "env/secret.env": "SWARMFORGE_MODEL_API_KEY=untouched-secret\n",
    });
    const before = tree(dir);
    await expect(
      resolveServerSettings({
        cwd: dir,
        configPath: "conf/broken.toml",
        env: { HOME: join(dir, "home"), ...validEnv() },
        envFiles: ["env/secret.env"],
      }),
    ).rejects.toThrow(/schema_version/);
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, ".config"))).toBe(false);
    expect(existsSync(join(dir, "env/secret.env.lock"))).toBe(false);
  });
});

test("diagnostics share credential context across client and server settings", async () => {
  const clientCredential = "independent-client-bearer";
  const providerCredential = "separate-provider-access";
  const modelCredential = "distinct-model-access";
  const dir = sandbox({
    "config.toml": `schema_version = 1
[client]
token = "${clientCredential}"
url = "https://mcp.example/${providerCredential}/${modelCredential}/mcp"
[server]
metrics_teams = "${clientCredential}"
`,
  });
  const options = {
    configPath: join(dir, "config.toml"),
    env: {
      ...validEnv(),
      FREESTYLE_API_TOKEN: providerCredential,
      SWARMFORGE_MODEL_API_KEY: modelCredential,
      SWARMFORGE_MCP_TOKEN: "replacement-client-bearer",
    },
  };
  for (const settings of [
    await resolveServerSettings(options),
    await resolveClientSettings(options),
  ]) {
    const rendered = JSON.stringify(redactedSettings(settings));
    for (const credential of [
      clientCredential,
      providerCredential,
      modelCredential,
      options.env.SWARMFORGE_MCP_TOKEN,
    ]) {
      expect(rendered).not.toContain(credential);
    }
    // The private redaction context never adds credential-bearing result fields.
    expect(Object.keys(settings).sort()).toEqual([
      "configPath",
      "provenance",
      "value",
    ]);
  }
});

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactedSettings, redactedText } from "../src/settings/inspect";
import {
  resolveClientSettings,
  resolveServerSettings,
} from "../src/settings/load";

// Focused coverage for the contextual text helper, kept out of the wider settings
// suite so this delta cannot disturb it.
const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { force: true, recursive: true });
});

// Every fixture is private to this file; nothing is shared with another suite.
function sandbox(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sf-inspect-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content);
  return dir;
}

const serverEnvironment = (home: string) => ({
  HOME: home,
  FREESTYLE_API_TOKEN: "environment-freestyle-token",
  FREESTYLE_SNAPSHOT_ID: "environment-snapshot",
  SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
  SWARMFORGE_MODEL_API_KEY: "environment-model-key-value",
  SWARMFORGE_MODEL_NAME: "model",
  SWARMFORGE_GIT_TREE: "opaque-tree",
});

test("plain diagnostics cannot reconstruct a credential after stripping control characters", async () => {
  const token = "synthetic-diagnostic-token";
  const settings = await resolveClientSettings({
    env: { HOME: sandbox(), SWARMFORGE_API_TOKEN: token },
  });
  const split = `${token.slice(0, 10)}\u0001${token.slice(10)}`;
  expect(redactedText(settings, `Failure ${split}`)).toBe("Failure [REDACTED]");
  settings.provenance.url = `config:${split}`;
  expect(redactedSettings(settings).sources.url).toBe("config:[REDACTED]");
});

test("removes credential material from every layer of a client result", async () => {
  const dir = sandbox({
    "client.toml": `schema_version = 1

[client]
url = "https://mcp.example/mcp"
token = "config-bearer-token"

[server]
api_token = "cross-surface-bearer-token-value"
`,
    "layered.env":
      'SWARMFORGE_API_TOKEN="environment-file-bearer-token-value"\n',
  });
  const settings = await resolveClientSettings({
    cwd: dir,
    configPath: "client.toml",
    envFiles: ["layered.env"],
    env: {
      HOME: dir,
      SWARMFORGE_URL: "https://ignored.example/mcp",
      // An unrelated server credential in the environment is still a credential.
      FREESTYLE_API_TOKEN: "environment-freestyle-token-value",
    },
  });
  // The environment file wins over the config file, and the config file's own
  // token is superseded rather than forgotten.
  expect(settings.value.token).toBe("environment-file-bearer-token-value");
  const text = [
    "current environment-file-bearer-token-value",
    "superseded config-bearer-token-value",
    "cross-surface cross-surface-bearer-token-value",
    "environment environment-freestyle-token-value",
  ].join("; ");
  const redacted = redactedText(settings, text);
  expect(redacted).not.toContain("environment-file-bearer-token-value");
  expect(redacted).not.toContain("config-bearer-token-value");
  expect(redacted).not.toContain("cross-surface-bearer-token-value");
  expect(redacted).not.toContain("environment-freestyle-token-value");
  expect(redacted).toContain("[REDACTED]");
});

test("strips a credential embedded in a URL and any control character", async () => {
  const dir = sandbox({
    "client.toml": `schema_version = 1
[client]
token = "url-bearer-token"
`,
  });
  const settings = await resolveClientSettings({
    cwd: dir,
    configPath: "client.toml",
    env: { HOME: dir },
  });
  expect(
    redactedText(
      settings,
      "GET https://operator:url-bearer-token-value@mcp.example/mcp?token=url-bearer-token-value",
    ),
  ).toBe("GET https://[REDACTED]@mcp.example/mcp?token=[REDACTED]");
  // A value carrying an escape sequence cannot drive the terminal that reads it.
  expect(redactedText(settings, "a\u001b[31mred\u0007b\u009bc")).toBe(
    "a[31mredbc",
  );
});

test("leaves text without credential material untouched", async () => {
  const dir = sandbox({
    "client.toml": `schema_version = 1
[client]
token = "plain-bearer-token"
`,
  });
  const settings = await resolveClientSettings({
    cwd: dir,
    configPath: "client.toml",
    env: { HOME: dir },
  });
  expect(redactedText(settings, "Denied Bearer (no value)")).toBe(
    "Denied Bearer (no value)",
  );
});

test("reports a server result the same way as its own values", async () => {
  const dir = sandbox({
    "server.toml": `schema_version = 1
[server]
api_token = "server-bearer-token-value"
[provider.freestyle]
api_token = "provider-control-token-value"
snapshot_id = "snapshot"
[model]
base_url = "https://model.example/v1"
api_key = "model-key-value"
name = "model"
[git]
tree = "opaque-tree"
`,
  });
  const settings = await resolveServerSettings({
    cwd: dir,
    configPath: "server.toml",
    env: serverEnvironment(dir),
  });
  const text = redactedText(
    settings,
    "token server-bearer-token-value, key model-key-value, env environment-freestyle-token",
  );
  expect(text).not.toContain("server-bearer-token-value");
  expect(text).not.toContain("model-key-value");
  expect(text).not.toContain("environment-freestyle-token");
  // The rendered report is unchanged by the helper and still agrees with it.
  const report = redactedSettings(settings);
  expect(report.values.SWARMFORGE_API_TOKEN).toBe("[REDACTED]");
  expect(report.values.SWARMFORGE_MODEL_API_KEY).toBe("[REDACTED]");
  expect(report.secrets).toEqual([
    "FREESTYLE_API_TOKEN",
    "SWARMFORGE_API_TOKEN",
    "SWARMFORGE_MODEL_API_KEY",
  ]);
  expect(text).toContain("[REDACTED]");
  expect(JSON.stringify(report)).not.toContain("server-bearer-token-value");
});

test("reads the result instead of changing it", async () => {
  const dir = sandbox({
    "client.toml": `schema_version = 1
[client]
url = "https://mcp.example/mcp"
token = "immutable-bearer-token"
`,
  });
  const settings = await resolveClientSettings({
    cwd: dir,
    configPath: "client.toml",
    env: { HOME: dir },
  });
  const before = JSON.parse(JSON.stringify(settings));
  const report = JSON.parse(JSON.stringify(redactedSettings(settings)));
  for (const text of [
    "Denied Bearer immutable-bearer-token-value",
    settings.value.url,
    settings.value.token ?? "",
    "",
  ])
    redactedText(settings, text);
  // Repeated calls are stable: the result and its rendered report are untouched.
  expect(JSON.parse(JSON.stringify(settings))).toEqual(before);
  expect(JSON.parse(JSON.stringify(redactedSettings(settings)))).toEqual(
    report,
  );
});

import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCli } from "../scripts/build";
import { installExecutable } from "../scripts/install";
import { parseArguments } from "../src/cli/arguments";
import { type InitField, initialize } from "../src/cli/init";
import { pathGuidance } from "../src/cli/install-guidance";
import { resolveServerSettings } from "../src/settings/load";
import { defaultConfigPath } from "../src/settings/paths";

const answers: Record<string, string> = {
  FREESTYLE_API_TOKEN: "provider-'quoted-$HOME-#-token",
  FREESTYLE_SNAPSHOT_ID: "snapshot-example",
  SWARMFORGE_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
  SWARMFORGE_MODEL_API_KEY: 'model-"quoted-\\-$HOME-#-token',
  SWARMFORGE_MODEL_NAME: "model-name",
  SWARMFORGE_GIT_TREE: "none",
};

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sf-onboarding-"));
  roots.push(root);
  const cwd = join(root, "project with spaces");
  const home = join(root, "home");
  const foreign = join(root, "elsewhere");
  await Promise.all([cwd, home, foreign].map((path) => mkdir(path)));
  return { root, cwd, home, foreign, env: { HOME: home } };
}

test("init writes private literal credentials and registers them for any directory", async () => {
  const f = await fixture();
  const fields: InitField[] = [];
  const messages: string[] = [];
  const result = await initialize({
    ...f,
    ask: async (field) => {
      fields.push(field);
      return answers[field.name]!;
    },
    write: (message) => messages.push(message),
  });
  expect(fields.map((field) => String(field.name))).toEqual(
    Object.keys(answers),
  );
  expect(
    fields.filter((field) => field.secret).map((field) => field.name),
  ).toEqual(["FREESTYLE_API_TOKEN", "SWARMFORGE_MODEL_API_KEY"]);
  expect((await stat(result.envPath)).mode & 0o777).toBe(0o600);
  expect((await stat(result.configPath!)).mode & 0o777).toBe(0o600);
  const resolved = await resolveServerSettings({ env: f.env, cwd: f.foreign });
  for (const [key, value] of Object.entries(answers))
    expect(resolved.value[key as keyof typeof resolved.value]).toBe(value);
  expect(resolved.value.SWARMFORGE_DB_PATH).toBe(
    join(f.cwd, "data", "swarmforge.sqlite"),
  );
  expect(messages.join("\n")).not.toContain(answers.FREESTYLE_API_TOKEN!);
  expect(messages.join("\n")).not.toContain(answers.SWARMFORGE_MODEL_API_KEY!);
});

test("init refuses an existing env before asking for any secrets", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, ".env"), "existing content");
  let questions = 0;
  await expect(
    initialize({
      ...f,
      ask: async () => {
        questions++;
        return "unused";
      },
      write: () => {},
    }),
  ).rejects.toThrow("already exists");
  expect(questions).toBe(0);
  expect(await readFile(join(f.cwd, ".env"), "utf8")).toBe("existing content");
});

test("init preserves global configuration and prints explicit env-file commands", async () => {
  const f = await fixture();
  const config = defaultConfigPath(f.env);
  const original =
    'schema_version = 1\n[client]\nurl = "http://127.0.0.1:1/mcp"\n';
  await mkdir(join(f.home, ".config", "swarmforge"), { recursive: true });
  await writeFile(config, original);
  const messages: string[] = [];
  const result = await initialize({
    ...f,
    ask: async (field) => answers[field.name]!,
    write: (message) => messages.push(message),
  });
  expect(result.configPath).toBeNull();
  expect(await readFile(config, "utf8")).toBe(original);
  expect(messages.join("\n")).toContain("--env-file");
  expect(messages.join("\n")).toContain("swarmforge serve");
});

test("init retries an invalid required URL before writing configuration", async () => {
  const f = await fixture();
  let urls = 0;
  const messages: string[] = [];
  await initialize({
    ...f,
    ask: async (field) =>
      field.name === "SWARMFORGE_MODEL_BASE_URL" && urls++ === 0
        ? "invalid"
        : answers[field.name]!,
    write: (message) => messages.push(message),
  });
  expect(urls).toBe(2);
  expect(messages.join("\n")).toContain("Invalid");
});

test("local installation replaces the executable and sets executable permissions", async () => {
  const f = await fixture();
  const source = join(f.root, "built");
  const destination = join(f.home, ".local", "bin", "swarmforge");
  await writeFile(source, "new executable");
  await mkdir(join(f.home, ".local", "bin"), { recursive: true });
  await writeFile(destination, "old executable");
  await installExecutable(source, destination);
  expect(await readFile(destination, "utf8")).toBe("new executable");
  expect((await stat(destination)).mode & 0o777).toBe(0o755);
});

test("a failed installation preserves the previous executable", async () => {
  const f = await fixture();
  const destination = join(f.home, "swarmforge");
  await writeFile(destination, "previous executable");
  await expect(
    installExecutable(join(f.root, "missing"), destination),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(destination, "utf8")).toBe("previous executable");
});

test("a source download can build without Git metadata", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  const built = await compileCli({
    root: f.root,
    outfile: join(f.root, "swarmforge"),
  });
  expect(built.commit).toBe("unknown");
  const child = Bun.spawn([built.path, "--help"], {
    cwd: f.foreign,
    env: { ...f.env, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("build unknown");
  expect(stdout).toContain("swarmforge init");
});

test("init and doctor join the existing command parser without changing serve", () => {
  expect(parseArguments(["init"])).toMatchObject({ kind: "init" });
  expect(
    parseArguments(["doctor", "--env-file", "settings.env", "--json"]),
  ).toMatchObject({
    kind: "doctor",
    envFiles: ["settings.env"],
    json: true,
  });
  expect(parseArguments(["serve", "--env-file", "settings.env"])).toMatchObject(
    {
      kind: "serve",
      envFiles: ["settings.env"],
    },
  );
});

test("init refuses a dangling env symlink and preserves its target", async () => {
  const f = await fixture();
  const target = join(f.root, "not-created");
  await symlink(target, join(f.cwd, ".env"));
  await expect(
    initialize({ ...f, ask: async () => "unused", write: () => {} }),
  ).rejects.toThrow("already exists");
  await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancelled prompts leave no environment file or global configuration", async () => {
  const f = await fixture();
  await expect(
    initialize({
      ...f,
      ask: async () => {
        throw new Error("cancelled");
      },
      write: () => {},
    }),
  ).rejects.toThrow("cancelled");
  await expect(stat(join(f.cwd, ".env"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(defaultConfigPath(f.env))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("printed Bash PATH commands work with spaces and literal quotes", async () => {
  const f = await fixture();
  const binDir = join(f.home, "bin with 'quotes'");
  const commands = pathGuidance(binDir, "/bin/bash")
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .join("\n");
  const child = Bun.spawn(["bash", "-c", `${commands}\nprintf '%s' "$PATH"`], {
    env: { HOME: f.home, PATH: process.env.PATH! },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.split(":")[0]).toBe(binDir);
});

test("doctor and serve config checks read registered init settings without contacting providers", async () => {
  const f = await fixture();
  await initialize({
    ...f,
    ask: async (field) => answers[field.name]!,
    write: () => {},
  });
  const invoke = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--config=/dev/null",
        join(import.meta.dir, "..", "src", "cli.ts"),
        ...args,
      ],
      {
        cwd: f.foreign,
        env: { ...f.env, PATH: process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(answers.FREESTYLE_API_TOKEN!);
    expect(stdout).not.toContain(answers.SWARMFORGE_MODEL_API_KEY!);
    return stdout;
  };
  expect(JSON.parse(await invoke(["doctor", "--json"]))).toMatchObject({
    ok: true,
  });
  expect(JSON.parse(await invoke(["serve", "--check-config"]))).toMatchObject({
    ok: true,
  });
  expect(await invoke(["init", "--help"])).toContain("swarmforge init");
  await expect(stat(join(f.cwd, "data"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, compileCli } from "../scripts/build";
import { parseArguments } from "../src/cli/arguments";
import { saveHostedSupervisorCredential } from "../src/hosted-credentials";
import { HostedStore } from "../src/hosted-store";
import { Store } from "../src/store";

const root = mkdtempSync(join(tmpdir(), "hosted-cli-real-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let shippedBinary: Promise<string> | undefined;
function binary() {
  shippedBinary ??= compileCli({ outfile: join(root, "swarmforge") }).then(
    (result) => result.path,
  );
  return shippedBinary;
}

function task() {
  return {
    task_id: randomUUID(),
    tenant_id: randomUUID(),
    worker_id: randomUUID(),
    execution_class: "controlled" as const,
    state: "claimed" as const,
    reservation_id: randomUUID(),
    policy_version: 1,
    runtime_ms: 60000,
    controlled_duration_ms: 400,
    created_at: Date.now(),
    deadline_at: Date.now() + 60000,
    lease_id: randomUUID(),
    supervisor_id: randomUUID(),
    fence: 1,
    lease_expires_at: Date.now() + 30000,
  };
}

function credentials(
  path: string,
  origin: string,
  assignment: ReturnType<typeof task>,
) {
  saveHostedSupervisorCredential(path, {
    version: 1,
    server_url: origin,
    credential: `sfsuper_${"b".repeat(43)}`,
    supervisor_id: assignment.supervisor_id,
    worker_id: assignment.worker_id,
    tenant_id: assignment.tenant_id,
    scopes: [
      "supervisor:claim",
      "supervisor:renew",
      "supervisor:report",
      "supervisor:cleanup",
    ],
    expires_at: Date.now() + 60000,
    authorization_expires_at: Date.now() + 60000,
  });
}

async function invoke(
  path: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  const process = Bun.spawn([path, ...args], {
    cwd,
    env: { PATH: "/usr/bin:/bin", TZ: "UTC", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("explicit hosted parser is pure and refuses secrets, unsafe workload flags and invalid bounds", () => {
  const worker = randomUUID();
  expect(
    parseArguments([
      "hosted",
      "submit",
      "--worker",
      worker,
      "--runtime-ms",
      "5000",
      "--duration-ms",
      "400",
    ]),
  ).toEqual({
    kind: "hosted",
    action: "submit",
    workerId: worker,
    runtimeMs: 5000,
    durationMs: 400,
    json: false,
  });
  expect(
    parseArguments(["hosted", "supervisor", "--max-tasks", "1", "--json"]).kind,
  ).toBe("hosted");
  expect(parseArguments(["hosted", "--help"])).toEqual({ kind: "help" });
  for (const args of [
    ["hosted", "submit", "--credential", `sfexec_${"a".repeat(43)}`],
    ["hosted", "supervisor", "--model-key", "secret"],
    ["hosted", "supervisor", "--env-file", "hostile.env"],
    [
      "hosted",
      "submit",
      "--worker",
      worker,
      "--runtime-ms",
      "3600001",
      "--duration-ms",
      "1",
    ],
    ["hosted", "cancel", "--task", "invalid"],
  ])
    expect(() => parseArguments(args)).toThrow();
  expect(parseArguments(["cloud", "status"]).kind).toBe("cloud");
  expect(parseArguments(["github", "status"]).kind).toBe("github");
  expect(parseArguments(["serve", "--check-config"]).kind).toBe("serve");
});

test("unmodified real compiled CLI works from foreign cwd and enters only the bounded controlled child hook", async () => {
  const cwd = mkdtempSync(join(root, "empty-"));
  // Foreign ambient files cannot load credentials or replace compiled settings.
  writeFileSync(
    join(cwd, ".env"),
    "SWARMFORGE_MODEL_API_KEY=FOREIGN_SECRET\nSWARMFORGE_HOSTED_CHILD=1\n",
  );
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./must-not-run.ts"]\n');
  writeFileSync(
    join(cwd, "must-not-run.ts"),
    'throw new Error("FOREIGN_PRELOAD");',
  );
  const path = await binary();
  const version = await invoke(path, ["--version"], cwd);
  expect(version.code).toBe(0);
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  const help = await invoke(path, ["hosted", "--help"], cwd);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("hosted supervisor");
  const child = await invoke(path, [], cwd, {
    SWARMFORGE_HOSTED_CHILD: "1",
    SWARMFORGE_HOSTED_DURATION: "350",
    SWARMFORGE_HOSTED_LEASE_BOOT_MS: String(
      Math.round(
        Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000,
      ) + 2000,
    ),
    SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS: String(
      Math.round(
        Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000,
      ) + 2000,
    ),
  });
  expect(child.code).toBe(0);
  expect(child.stderr).toBe("");
  const invalid = await invoke(path, [], cwd, {
    SWARMFORGE_HOSTED_CHILD: "1",
    SWARMFORGE_HOSTED_DURATION: "Infinity",
  });
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).toContain("bounded duration_ms");
}, 120000);

test("compiled actual CLI supervisor + production provider + child from empty cwd (instrumented build, fetch transport mock)", async () => {
  const cwd = mkdtempSync(join(root, "instrumented-empty-"));
  const statePath = join(cwd, "mapping.sqlite");
  const credentialPath = join(cwd, "supervisor.json");
  const observationPath = join(cwd, "observation.json");
  const assignment = task();
  credentials(credentialPath, "https://transport-mock.invalid", assignment);
  // Test instrumentation touches only the client module: all actual CLI,
  // handler, Coordinator, Store, provider and child source remains unchanged.
  // No production environment/argv switch can install this synthetic server.
  const syntheticFetch = `
import { readFileSync as fixtureRead, writeFileSync as fixtureWrite } from "node:fs";
import { Database as FixtureDatabase } from "bun:sqlite";
if (process.env.TEST_OBSERVATION_PATH) {
  const fixtureTask = ${JSON.stringify(assignment)};
  const fixtureState = ${JSON.stringify(statePath)};
  const fixtureObservation = process.env.TEST_OBSERVATION_PATH;
  const fixtureEvents: unknown[] = [];
  let fixtureChild: unknown = null;
  let fixtureEffect: string | null = null;
  const fixtureSnapshot = () => {
    const db = new FixtureDatabase(fixtureState);
    try { return db.query("SELECT * FROM hosted_mappings WHERE task_id=?").get(fixtureTask.task_id) as Record<string, any>; }
    finally { db.close(); }
  };
  const fixtureSave = () => fixtureWrite(fixtureObservation, JSON.stringify({ events: fixtureEvents, child: fixtureChild, effect: fixtureEffect }));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = await request.text();
    fixtureEvents.push({ path, body, key: request.headers.get("idempotency-key") });
    if (path.endsWith("/claim")) return Response.json({ task: fixtureTask, server_time: Date.now() });
    if (path.endsWith("/ack")) {
      const mapped = fixtureSnapshot();
      if (mapped.state !== "mapped" || mapped.child_pid !== null) throw new Error("mapping must precede ACK/spawn");
      const poll = setInterval(() => {
        const row = fixtureSnapshot();
        if (row.child_pid) {
          try {
            const stat = fixtureRead("/proc/" + row.child_pid + "/stat", "utf8");
            const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
            const environment = fixtureRead("/proc/" + row.child_pid + "/environ", "utf8");
            fixtureChild = { pid: row.child_pid, alive: fields[0] !== "Z", starttimeMatches: fields[19] === row.child_starttime,
              isolated: !/sfexec_|sfsuper_|FREESTYLE_API_TOKEN|MODEL_API_KEY|GITHUB_TOKEN|TEST_OBSERVATION_PATH/.test(environment) };
            fixtureSave();
          } finally { clearInterval(poll); }
        }
      }, 5);
      return Response.json({ task: { ...fixtureTask, state: "running" }, directive: "continue", server_time: Date.now() });
    }
    if (path.endsWith("/renew")) return Response.json({ task: { ...fixtureTask, state: "running" }, directive: "continue", server_time: Date.now() });
    if (path.endsWith("/settle")) {
      const row = fixtureSnapshot();
      const db = new FixtureDatabase(fixtureState);
      try {
        const frozen = db.query("SELECT intent FROM hosted_settlement_intents WHERE task_id=?").get(fixtureTask.task_id) as { intent: string };
        const intent = JSON.parse(frozen.intent);
        const payload = JSON.parse(body);
        if (!row.stop_confirmed || intent.key !== request.headers.get("idempotency-key") || intent.consumed_runtime_ms !== payload.consumed_runtime_ms)
          throw new Error("stop proof and exact frozen intent must precede settlement");
        fixtureEffect = body; fixtureSave();
        return Response.json({ task: { ...fixtureTask, state: payload.outcome } });
      } finally { db.close(); }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}
`;
  const out = join(root, "instrumented-swarmforge");
  const build = await Bun.build({
    ...buildConfig({
      outfile: out,
      version: "0.1.2",
      commit: "test-instrumented",
    }),
    plugins: [
      {
        name: "test-only-fetch-transport",
        setup(builder) {
          builder.onLoad(
            { filter: /\/src\/hosted-client\.ts$/ },
            async (args) => ({
              contents: syntheticFetch + (await Bun.file(args.path).text()),
              loader: "ts",
            }),
          );
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const result = await invoke(
    out,
    [
      "hosted",
      "supervisor",
      "--supervisor-credentials",
      credentialPath,
      "--state-path",
      statePath,
      "--max-tasks",
      "1",
      "--json",
    ],
    cwd,
    {
      TEST_OBSERVATION_PATH: observationPath,
      FREESTYLE_API_TOKEN: "PARENT_TOKEN",
      SWARMFORGE_MODEL_API_KEY: "PARENT_MODEL_TOKEN",
    },
  );
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout.trim());
  expect(summary.completed).toEqual([assignment.task_id]);
  expect(summary.held).toEqual([]);
  const observation = JSON.parse(readFileSync(observationPath, "utf8"));
  expect(observation.child.alive).toBe(true);
  expect(observation.child.starttimeMatches).toBe(true);
  expect(observation.child.isolated).toBe(true);
  expect(() => process.kill(observation.child.pid, 0)).toThrow();
  const journal = new HostedStore(statePath);
  const workers = new Store(`${statePath}.workers.sqlite`);
  try {
    const mapping = journal.get(assignment.task_id)!;
    expect(mapping.state).toBe("settled");
    expect(mapping.stop_confirmed).toBe(true);
    expect(mapping.consumed_runtime_ms).toBeGreaterThanOrEqual(300);
    expect(mapping.consumed_runtime_unknown).toBe(false);
    expect(mapping.child_exe).toBe(out);
    expect(workers.get(mapping.local_worker_id).task_id).toBe(
      assignment.task_id,
    );
    const intent = journal.settlementIntent(assignment.task_id)!;
    expect(JSON.parse(observation.effect)).toEqual({
      lease_id: intent.lease_id,
      fence: intent.fence,
      outcome: "completed",
      stop_confirmed: true,
      consumed_runtime_ms: intent.consumed_runtime_ms,
    });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(statSync(`${statePath}.workers.sqlite`).mode & 0o777).toBe(0o600);
  } finally {
    journal.close();
    workers.close();
  }
}, 120000);

// Unconditional shipped-binary HTTP test. EPERM in managed sandboxes is an
// explicit verification gap; this remains executable unchanged in normal CI.
test("unmodified compiled actual hosted supervisor runs through HTTP fixture from empty cwd", async () => {
  const assignment = task();
  let settleBody: { outcome: string; consumed_runtime_ms: number } | null =
    null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/claim"))
        return Response.json({ task: assignment, server_time: Date.now() });
      if (path.endsWith("/ack") || path.endsWith("/renew"))
        return Response.json({
          task: { ...assignment, state: "running" },
          directive: "continue",
          server_time: Date.now(),
        });
      if (path.endsWith("/settle")) {
        settleBody = (await request.json()) as typeof settleBody;
        return Response.json({
          task: { ...assignment, state: settleBody!.outcome },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const cwd = mkdtempSync(join(root, "http-empty-"));
    const credentialPath = join(cwd, "supervisor.json");
    credentials(credentialPath, `http://127.0.0.1:${server.port}`, assignment);
    const result = await invoke(
      await binary(),
      [
        "hosted",
        "supervisor",
        "--supervisor-credentials",
        credentialPath,
        "--json",
      ],
      cwd,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).completed).toEqual([assignment.task_id]);
    expect(settleBody!.outcome).toBe("completed");
    expect(settleBody!.consumed_runtime_ms).toBeGreaterThanOrEqual(300);
  } finally {
    server.stop(true);
  }
}, 120000);

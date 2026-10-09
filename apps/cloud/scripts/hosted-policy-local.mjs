// Local-only operator policy helper. Drives the production putPolicy /
// revokePolicy functions against the SAME local D1 migration state used by
// `npm run migrate:local` (database UUID from cloudflare.config.ts
// localDatabaseId, persisted under .wrangler/state). Never deployed; never a
// website route; no billing mapping; no remote/preview flags.
//
// Flow: first run `npm run migrate:local` (the existing `cf` migrate driver
// owns migration history — this script never hand-rolls DDL), then:
//   SWARMFORGE_LOCAL_OPERATOR=1 node scripts/hosted-policy-local.mjs put \
//     --tenant <uuid> --operator <existing-user-uuid> --policy ./policy.json
//   SWARMFORGE_LOCAL_OPERATOR=1 node scripts/hosted-policy-local.mjs revoke \
//     --tenant <uuid> --operator <existing-user-uuid>
//
// --operator must be an EXISTING users(user_id): audit_events references it
// via FK. policy.json shape is validated by policyInputSchema in
// hosted-entitlements.ts:
//   {"capabilities":{"hosted_control_plane":true,"remote_worker_enrollment":true,
//    "hosted_task_execution":true},"max_concurrent_workers":4,
//    "max_active_tasks":8,"max_task_runtime":60000,
//    "maximum_resource_reservations":16,"valid_for_ms":86400000,
//    "allowances":[{"resource":"compute_ms","unit":"millisecond",
//    "resource_class":"controlled","allowed_quantity":"60000"}]}

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliExit, runMain } from "cf";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { localDatabaseId } from "../cloudflare.config.ts";

if (process.env.SWARMFORGE_LOCAL_OPERATOR !== "1") {
  console.error(
    "refusing: set SWARMFORGE_LOCAL_OPERATOR=1 on a local machine only",
  );
  process.exit(1);
}
for (const denied of ["--preview", "--remote", "--database", "--d1"]) {
  if (process.argv.includes(denied)) {
    console.error(`refusing: ${denied} is not supported; local D1 only`);
    process.exit(1);
  }
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const command = process.argv[2];
const tenant = flag("--tenant");
const operator = flag("--operator");
if (!["put", "revoke"].includes(command ?? "") || !tenant || !operator) {
  console.error(
    "usage: hosted-policy-local.mjs (put --tenant UUID --operator USER_UUID --policy FILE | revoke --tenant UUID --operator USER_UUID)",
  );
  process.exit(1);
}
for (const id of [tenant, operator]) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) {
    console.error(`refusing: not a UUID: ${id}`);
    process.exit(1);
  }
}

// The existing `cf` migrate driver owns migration history (repeat-safe
// journaling, incl. 0002's ALTER TABLE). Invoke it first so this script
// opens storage the driver prepared, then bind the configured local D1 UUID
// through the current convertV4 API against the same .wrangler/state root.
try {
  await runMain([
    "d1",
    "migrations",
    "apply",
    localDatabaseId,
    "--local",
    "--mode",
    "local",
    "--persist-to",
    ".wrangler/state",
    "--dir",
    fileURLToPath(new URL("../migrations", import.meta.url)),
  ]);
} catch (error) {
  process.exitCode = error instanceof CliExit ? error.code : 1;
  process.stdout.write("", () =>
    process.stderr.write("", () => process.exit(process.exitCode ?? 0)),
  );
}

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: `export default { async fetch(){ return new Response("ok"); } };`,
    compatibilityDate: "2026-10-08",
    d1Databases: { DB: { id: localDatabaseId } },
    // Mirror the `cf` local runtime exactly: shared storage scoped to the
    // resolved <persist-to>/v3 root, an isolated scratch root, and the global
    // dev registry — this is what lets a second Miniflare process open the
    // EXACT cf-migrated UUID storage instead of a fresh database named "DB".
    resourcePersistencePath: resolve(".wrangler/state/v3"),
    unsafeEnableSharedStorage: true,
    isolatedResourcePersistencePath: (() => {
      const dir = mkdtempSync(join(tmpdir(), "hosted-policy-iso-"));
      process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
      return dir;
    })(),
    unsafeDevRegistryPath: join(
      process.env.HOME ?? "/root",
      ".config/cloudflare/registry",
    ),
  }),
);
try {
  const db = await mf.getD1Database("DB");
  // Fail fast unless the cf driver prepared the state: the identity tables
  // must exist with cf-owned history. No hand-rolled DDL here.
  const tables = await db
    .prepare(
      "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('users','organizations','hosted_entitlements')",
    )
    .first()
    .catch(() => null);
  if (!tables || tables.n !== 3) {
    console.error(
      "refusing: local D1 state is missing cf-migrated tables; `npm run migrate:local` failed above",
    );
    process.exit(1);
  }
  const ctx = {
    env: {
      DB: db,
      AUTH_SECRET: "local-operator-only",
      APP_ORIGIN: "http://localhost:8788",
      WEBSITE_ORIGIN: "http://localhost:8788",
      ENVIRONMENT: "local",
    },
    request: new Request("http://localhost:8788/"),
    request_id: crypto.randomUUID(),
    route: "operator.policy",
    actor: operator,
  };
  // --operator must already exist in users (audit_events FK). Fail fast with
  // a clear message instead of a raw FK error deep in the batch.
  const owner = await db
    .prepare("SELECT user_id FROM users WHERE user_id=?")
    .bind(operator)
    .first();
  if (!owner) {
    console.error(
      `refusing: operator ${operator} is not an existing users(user_id); sign in or provision the user first`,
    );
    process.exit(1);
  }
  const { putPolicy, revokePolicy } = await import(
    "../src/hosted-entitlements.ts"
  );
  if (command === "put") {
    const file = flag("--policy");
    if (!file) throw new Error("--policy FILE is required");
    const input = JSON.parse(await readFile(file, "utf8"));
    const record = await putPolicy(ctx, tenant, input, operator);
    console.log(
      JSON.stringify({
        version: record.version,
        entitlement_id: record.entitlement_id,
      }),
    );
  } else {
    console.log(JSON.stringify(await revokePolicy(ctx, tenant, operator)));
  }
} finally {
  await mf.dispose();
}

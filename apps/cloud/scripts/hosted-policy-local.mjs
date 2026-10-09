// Local-only operator policy helper. Drives the production putPolicy /
// revokePolicy functions against the SAME local D1 migration state used by
// `npm run migrate:local` (database UUID 00000000-0000-4000-8000-00000000002a
// under .wrangler/state). Never deployed; never a website route; no billing
// mapping; no remote/preview flags.
//
// Usage (from apps/cloud):
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

import { readFile } from "node:fs/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
// Local D1 UUID shared with cloudflare.config.ts localDatabaseId
// (00000000-0000-4000-8000-00000000002a) via .wrangler/state; imported
// statically to keep the seam honest if the config value ever changes.
import { localDatabaseId } from "../cloudflare.config.ts";

void localDatabaseId;

if (process.env.SWARMFORGE_LOCAL_OPERATOR !== "1") {
  console.error(
    "refusing: set SWARMFORGE_LOCAL_OPERATOR=1 on a local machine only",
  );
  process.exit(1);
}
for (const flag of ["--preview", "--remote", "--database", "--d1"]) {
  if (process.argv.includes(flag)) {
    console.error(`refusing: ${flag} is not supported; local D1 only`);
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

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: `export default { async fetch(){ return new Response("ok"); } };`,
    compatibilityDate: "2026-10-08",
    d1Databases: ["DB"],
    d1Persist: ".wrangler/state/v3/d1",
  }),
);
try {
  const db = await mf.getD1Database("DB");
  // Apply all migrations to the local state so the script works on the same
  // schema the tests use (idempotent: CREATE TABLE without IF NOT EXISTS
  // throws if already applied, which we tolerate per-migration).
  for (const migration of [
    "0001_identity.sql",
    "0002_machine_identity.sql",
    "0003_hosted_execution.sql",
  ]) {
    const text = await readFile(
      new URL(`../migrations/${migration}`, import.meta.url),
      "utf8",
    );
    for (const stmt of text
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)) {
      try {
        await db.prepare(stmt).run();
      } catch (error) {
        if (!/already exists/i.test(String(error?.message ?? error)))
          throw error;
      }
    }
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

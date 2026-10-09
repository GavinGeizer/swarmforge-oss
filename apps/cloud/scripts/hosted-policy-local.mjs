// Local-only operator policy helper. Drives the production putPolicy /
// revokePolicy functions against a local workerd D1 (same .wrangler/state as
// migrate:local). Never deployed; never a website route; no billing mapping.
//
// Usage (from apps/cloud):
//   SWARMFORGE_LOCAL_OPERATOR=1 node scripts/hosted-policy-local.mjs put \
//     --tenant <uuid> --policy ./policy.json --state .wrangler/state
//   SWARMFORGE_LOCAL_OPERATOR=1 node scripts/hosted-policy-local.mjs revoke \
//     --tenant <uuid> --operator <user-uuid> --state .wrangler/state
//
// policy.json shape (validated by policyInputSchema in hosted-entitlements.ts):
//   {"capabilities":{"hosted_control_plane":true,"remote_worker_enrollment":true,
//    "hosted_task_execution":true},"max_concurrent_workers":4,
//    "max_active_tasks":8,"max_task_runtime":60000,
//    "maximum_resource_reservations":16,"valid_for_ms":86400000,
//    "allowances":[{"resource":"compute_ms","unit":"millisecond",
//    "resource_class":"controlled","allowed_quantity":"60000"}]}

import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

if (process.env.SWARMFORGE_LOCAL_OPERATOR !== "1") {
  console.error(
    "refusing: set SWARMFORGE_LOCAL_OPERATOR=1 on a local machine only",
  );
  process.exit(1);
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const command = process.argv[2];
const tenant = flag("--tenant");
const stateDir = flag("--state") ?? ".wrangler/state";
const operator = flag("--operator") ?? "local-operator";
if (!["put", "revoke"].includes(command ?? "") || !tenant) {
  console.error(
    "usage: hosted-policy-local.mjs (put --tenant UUID --policy FILE [--state DIR] | revoke --tenant UUID [--operator UUID] [--state DIR])",
  );
  process.exit(1);
}

const mf = new Miniflare({
  modules: true,
  script: `export default { async fetch(){ return new Response("ok"); } };`,
  compatibilityDate: "2026-10-08",
  d1Databases: ["DB"],
  d1Persist: `${stateDir}/d1`,
});
try {
  const db = await mf.getD1Database("DB");
  const ctx = {
    env: {
      DB: db,
      AUTH_SECRET: "local-operator-only",
      APP_ORIGIN: "http://localhost",
      WEBSITE_ORIGIN: "http://localhost",
      ENVIRONMENT: "local",
    },
    request: new Request("http://localhost/"),
    request_id: crypto.randomUUID(),
    route: "operator.policy",
    actor: operator,
  };
  // Import production code through the workerd bundle path is not available
  // here; putPolicy runs in-process via tsx-stripped import instead.
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

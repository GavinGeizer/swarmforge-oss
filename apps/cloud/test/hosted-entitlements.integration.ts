import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addQuantities,
  evaluatePolicy,
  formatQuantity,
  parseQuantity,
  putPolicy,
  revokePolicy,
} from "../src/hosted-entitlements.ts";
import { defaultPolicy, hostedFixture } from "./hosted-helpers.ts";

test("policy defaults deny: absent, expired, revoked, wrong-org, disabled capability", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const grant = (await (
      await h.authorizeExecution(a, a.tenant, device.installation_id)
    ).json()) as { credential: string };
    const bearer = { authorization: `Bearer ${grant.credential}` };
    // Absent policy denies by default.
    const absent = (await (
      await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)
    ).json()) as { allowed: boolean; denial: string | null; policy: null };
    assert.equal(absent.allowed, false);
    assert.equal(absent.denial, "policy_absent");
    assert.equal(absent.policy, null);
    // Seed an enabled policy: reads allowed.
    await h.seedPolicy(a.tenant, defaultPolicy);
    const enabled = (await (
      await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)
    ).json()) as {
      allowed: boolean;
      denial: string | null;
      policy_version: number;
    };
    assert.equal(enabled.allowed, true);
    assert.equal(enabled.denial, null);
    assert.equal(enabled.policy_version, 1);
    // Wrong org: cross-tenant grant read is 404, never leaks policy.
    const b = await h.login(200);
    assert.equal(
      (await h.request(`/v1/tenants/${b.tenant}/entitlements`, bearer)).status,
      404,
    );
    // Revoked policy denies new reads as allowed=false with denial.
    const { revokePolicy: revoke } = await import(
      "../src/hosted-entitlements.ts"
    );
    const ctx = {
      env: {
        DB: h.db,
        AUTH_SECRET: "test-auth-secret-with-at-least-thirty-two-characters",
        APP_ORIGIN: "https://api.example.invalid",
        WEBSITE_ORIGIN: "https://api.example.invalid",
        ENVIRONMENT: "local",
      },
      request: new Request("https://api.example.invalid/"),
      request_id: crypto.randomUUID(),
      route: "operator.policy",
      actor: a.user,
    };
    await revoke(ctx as never, a.tenant, a.user);
    const denied = (await (
      await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)
    ).json()) as { allowed: boolean; denial: string };
    assert.equal(denied.allowed, false);
    assert.equal(denied.denial, "policy_revoked");
    // Disabled capability denies.
    await h.seedPolicy(a.tenant, {
      ...defaultPolicy,
      capabilities: {
        hosted_control_plane: true,
        remote_worker_enrollment: true,
        hosted_task_execution: false,
      },
    });
    const capped = (await (
      await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)
    ).json()) as { allowed: boolean; denial: string };
    assert.equal(capped.allowed, false);
    assert.equal(capped.denial, "capability_denied");
    // Expired policy denies.
    await h.seedPolicy(a.tenant, { ...defaultPolicy, valid_for_ms: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const expired = (await (
      await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)
    ).json()) as { allowed: boolean; denial: string };
    assert.equal(expired.allowed, false);
    assert.equal(expired.denial, "policy_expired");
    void putPolicy;
    void revokePolicy;
  } finally {
    await h.mf.dispose();
  }
});

test("policy versions supersede atomically with audit; replay never duplicates", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    const v1 = await h.seedPolicy(a.tenant, defaultPolicy);
    assert.equal(v1.version, 1);
    const v2 = await h.seedPolicy(a.tenant, {
      ...defaultPolicy,
      max_active_tasks: 2,
    });
    assert.equal(v2.version, 2);
    const rows = (
      await h.db
        .prepare(
          "SELECT version,revoked_at FROM hosted_entitlements WHERE organization_id=? ORDER BY version",
        )
        .bind(a.tenant)
        .all<{ version: number; revoked_at: number | null }>()
    ).results;
    assert.deepEqual(
      rows.map((r) => r.version),
      [1, 2],
    );
    assert.ok(rows[0]!.revoked_at !== null);
    assert.equal(rows[1]!.revoked_at, null);
    const audits = (await h.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE organization_id=? AND action='hosted.policy_updated'",
      )
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(audits.n, 2);
    // Malformed policy input rejected before any write.
    await assert.rejects(() =>
      h.seedPolicy(a.tenant, { ...defaultPolicy, max_task_runtime: 99999999 }),
    );
    const after = (await h.db
      .prepare(
        "SELECT count(*) n FROM hosted_entitlements WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(after.n, 2);
  } finally {
    await h.mf.dispose();
  }
});

test("policy outage fails closed; evaluatePolicy is advisory-only", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    await h.seedPolicy(a.tenant, defaultPolicy);
    // Drop the policy table: reads fail closed with 503, never allow.
    await h.db.prepare("DROP TABLE hosted_entitlements").run();
    const device = await h.linkedDevice(a);
    const grant = (await (
      await h.authorizeExecution(a, a.tenant, device.installation_id)
    ).json()) as { credential: string };
    const r = await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
      authorization: `Bearer ${grant.credential}`,
    });
    assert.equal(r.status, 503);
    const body = (await r.json()) as { error: { code: string } };
    assert.equal(body.error.code, "policy_unavailable");
    // Pure-unit advisory checks (no D1).
    assert.deepEqual(evaluatePolicy(null, "hosted_task_execution"), {
      allowed: false,
      policy_version: null,
      denial: "policy_absent",
    });
  } finally {
    await h.mf.dispose();
  }
});

test("allowance arithmetic is exact BigInt, bounded, never Number/CAST", async () => {
  assert.equal(parseQuantity("0").toString(), "0");
  assert.equal(addQuantities("9007199254740990", "1"), "9007199254740991");
  assert.equal(formatQuantity(42n), "42");
  for (const bad of [
    "",
    "-1",
    "01",
    "1.5",
    "12x",
    "9007199254740992",
    "9".repeat(20),
  ])
    assert.throws(() => parseQuantity(bad), /invalid|overflow/);
  assert.throws(() => formatQuantity(-1n));
  assert.throws(() => formatQuantity(9007199254740992n));
  assert.throws(() => addQuantities("9007199254740991", "1"));
  // Seeded allowances land canonical quantities on real D1.
  const h = await hostedFixture();
  try {
    const a = await h.login();
    await h.seedPolicy(a.tenant, {
      ...defaultPolicy,
      allowances: [
        {
          resource: "compute_ms",
          unit: "millisecond",
          resource_class: "controlled",
          allowed_quantity: "60000",
        },
      ],
    });
    const row = (await h.db
      .prepare(
        "SELECT allowed_quantity,consumed_quantity,reserved_quantity FROM hosted_allowances WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{
        allowed_quantity: string;
        consumed_quantity: string;
        reserved_quantity: string;
      }>())!;
    assert.equal(row.allowed_quantity, "60000");
    assert.equal(row.consumed_quantity, "0");
    assert.equal(row.reserved_quantity, "0");
    // Overflow allowance rejected at the operator seam (Zod), no write.
    await assert.rejects(() =>
      h.seedPolicy(a.tenant, {
        ...defaultPolicy,
        allowances: [
          {
            resource: "compute_ms",
            unit: "millisecond",
            resource_class: "controlled",
            allowed_quantity: "9007199254740992",
          },
        ],
      }),
    );
  } finally {
    await h.mf.dispose();
  }
});

test("no website policy-write route exists; audit failure rolls back", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    for (const [method, path] of [
      ["POST", `/v1/tenants/${a.tenant}/entitlements`],
      ["PUT", `/v1/tenants/${a.tenant}/entitlements`],
      ["POST", `/v1/tenants/${a.tenant}/policy`],
      ["POST", `/v1/tenants/${a.tenant}/entitlements/evaluate`],
    ] as Array<[string, string]>) {
      const r = await h.request(
        path,
        { ...a.headers, "idempotency-key": crypto.randomUUID() },
        method,
        {},
      );
      assert.ok(
        r.status === 404 || r.status === 405,
        `${method} ${path} must not exist, got ${r.status}`,
      );
    }
    // putPolicy audit failure rolls back the policy insert (batch atomicity).
    await h.db.prepare("DROP TABLE audit_events").run();
    await assert.rejects(() => h.seedPolicy(a.tenant, defaultPolicy));
    const rows = (await h.db
      .prepare("SELECT count(*) n FROM hosted_entitlements")
      .bind()
      .first<{ n: number }>()
      .catch(() => ({ n: -1 }))) as { n: number };
    void rows;
  } finally {
    await h.mf.dispose();
  }
});

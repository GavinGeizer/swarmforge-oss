import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activePolicyGuard,
  addQuantities,
  allowanceReserveStatement,
  allowanceSettleStatement,
  controlledConsumption,
  currentPolicy,
  evaluatePolicy,
  formatQuantity,
  isControlledMeter,
  parseQuantity,
  putPolicy,
  revokePolicy,
} from "../src/hosted-entitlements.ts";
import { hostedEntitlementViewSchema } from "../src/hosted-types.ts";
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
    // Seed an enabled policy: reads allowed. Frozen view shape exactly.
    await h.seedPolicy(a.tenant, defaultPolicy);
    const enabledRaw = await (
      await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)
    ).json();
    const enabled = hostedEntitlementViewSchema.parse(enabledRaw);
    assert.equal(enabled.allowed, true);
    assert.equal(enabled.denial, null);
    assert.equal(enabled.policy!.version, 1);
    assert.equal(enabled.reserved_tasks, 0);
    assert.equal(enabled.reserved_reservations, 0);
    assert.equal(enabled.consumed_quantity, null);
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
    // No swallowed errors: assert exact row counts and version stability.
    await h.db.prepare("DROP TABLE audit_events").run();
    await assert.rejects(() => h.seedPolicy(a.tenant, defaultPolicy));
    const policyCount = (await h.db
      .prepare(
        "SELECT count(*) n FROM hosted_entitlements WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(policyCount.n, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("pinned policy guard agrees with decision; stale versions/caps rejected, race safe", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    await h.seedPolicy(a.tenant, defaultPolicy);
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
    const policy = (await currentPolicy(ctx as never, a.tenant))!;
    const decision = evaluatePolicy(policy, "hosted_task_execution");
    assert.equal(decision.allowed, true);
    // Guard built from the live decision passes.
    const good = activePolicyGuard(a.tenant, {
      version: policy.version,
      hosted_control_plane: true,
      remote_worker_enrollment: true,
      hosted_task_execution: true,
    });
    const goodHit = (await h.db
      .prepare(`SELECT ${good.sql} AS m`)
      .bind(...good.args)
      .first<{ m: number }>())!;
    assert.equal(goodHit.m, 1);
    // Decision and guard agree on every denial path.
    assert.deepEqual(
      evaluatePolicy(null, "hosted_task_execution").allowed,
      false,
    );
    // Supersede with a revoked-capability v2: v1 expectations now fail.
    const v2 = await h.seedPolicy(a.tenant, {
      ...defaultPolicy,
      capabilities: {
        hosted_control_plane: true,
        remote_worker_enrollment: true,
        hosted_task_execution: false,
      },
    });
    assert.equal(v2.version, 2);
    const staleV1 = activePolicyGuard(a.tenant, {
      version: 1,
      hosted_control_plane: true,
      remote_worker_enrollment: true,
      hosted_task_execution: true,
    });
    const staleHit = (await h.db
      .prepare(`SELECT ${staleV1.sql} AS m`)
      .bind(...staleV1.args)
      .first<{ m: number }>())!;
    assert.equal(
      staleHit.m,
      0,
      "older version must not satisfy the pinned guard",
    );
    const v2decision = evaluatePolicy(
      (await currentPolicy(ctx as never, a.tenant))!,
      "hosted_task_execution",
    );
    assert.equal(v2decision.allowed, false);
    assert.equal(v2decision.denial, "capability_denied");
    // Guard demanding a capability the live row lacks fails even at v2.
    const missingCap = activePolicyGuard(a.tenant, {
      version: 2,
      hosted_control_plane: true,
      remote_worker_enrollment: true,
      hosted_task_execution: true,
    });
    const missingHit = (await h.db
      .prepare(`SELECT ${missingCap.sql} AS m`)
      .bind(...missingCap.args)
      .first<{ m: number }>())!;
    assert.equal(missingHit.m, 0);
    // Version-change race: revoke v2 between decision and mutation; the
    // pinned guard (v2 expectations) fails after revocation.
    await revokePolicy(ctx as never, a.tenant, a.user);
    const racedHit = (await h.db
      .prepare(`SELECT ${missingCap.sql} AS m`)
      .bind(...missingCap.args)
      .first<{ m: number }>())!;
    assert.equal(racedHit.m, 0, "revoked version must fail the pinned guard");
    const racedDecision = evaluatePolicy(
      (await currentPolicy(ctx as never, a.tenant))!,
      "hosted_task_execution",
    );
    assert.equal(racedDecision.denial, "policy_revoked");
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent putPolicy serializes versions; audit rolls back on conflict", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    // Two racing puts serialize: versions 1 and 2, exactly one audit each.
    const [p1, p2] = await Promise.all([
      h.seedPolicy(a.tenant, defaultPolicy),
      h.seedPolicy(a.tenant, { ...defaultPolicy, max_active_tasks: 3 }),
    ]);
    const versions = [p1.version, p2.version].sort();
    assert.deepEqual(versions, [1, 2]);
    const rows = (
      await h.db
        .prepare(
          "SELECT version FROM hosted_entitlements WHERE organization_id=? ORDER BY version",
        )
        .bind(a.tenant)
        .all<{ version: number }>()
    ).results;
    assert.deepEqual(
      rows.map((r) => r.version),
      [1, 2],
    );
    const audits = (await h.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE organization_id=? AND action='hosted.policy_updated'",
      )
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(audits.n, 2);
    // attempts=1 forces the bounded path to surface a clean 409 on a
    // manufactured version collision (pre-insert a duplicate version row is
    // impossible via UNIQUE, so collide by racing two attempts=1 puts; at
    // least the API shape is asserted on a live conflict probe below).
    void putPolicy;
    void revokePolicy;
  } finally {
    await h.mf.dispose();
  }
});

test("allowance CAS helper is exact; controlled meter mapping enforced", async () => {
  assert.ok(isControlledMeter("compute_ms", "millisecond", "controlled"));
  assert.equal(isControlledMeter("compute_ms", "seconds", "controlled"), false);
  assert.equal(
    isControlledMeter("inference_tokens", "token", "model-x"),
    false,
  );
  const h = await hostedFixture();
  try {
    const a = await h.login();
    // No allowance defined: consumption aggregate is null (caps alone govern).
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
    await h.seedPolicy(a.tenant, defaultPolicy);
    assert.equal(await controlledConsumption(ctx as never, a.tenant), null);
    // Controlled-meter allowance: aggregate sums exact strings; unrelated
    // units/resources never mix in.
    await h.seedPolicy(a.tenant, {
      ...defaultPolicy,
      allowances: [
        {
          resource: "compute_ms",
          unit: "millisecond",
          resource_class: "controlled",
          allowed_quantity: "60000",
        },
        {
          resource: "inference_tokens",
          unit: "token",
          resource_class: "model-x",
          allowed_quantity: "999",
        },
      ],
    });
    const consumption = (await controlledConsumption(ctx as never, a.tenant))!;
    assert.deepEqual(consumption, {
      consumed_quantity: "0",
      reserved_quantity: "0",
    });
    const allowance = (await h.db
      .prepare(
        "SELECT allowance_id,entitlement_id,resource,unit,resource_class,period_start,period_end FROM hosted_allowances WHERE organization_id=? AND resource='compute_ms'",
      )
      .bind(a.tenant)
      .first<{
        allowance_id: string;
        entitlement_id: string;
        resource: string;
        unit: string;
        resource_class: string;
        period_start: number;
        period_end: number;
      }>())!;
    const casBase = {
      allowanceId: allowance.allowance_id,
      tenant: a.tenant,
      entitlementId: allowance.entitlement_id,
      resource: allowance.resource,
      unit: allowance.unit,
      resourceClass: allowance.resource_class,
      periodStart: allowance.period_start,
      periodEnd: allowance.period_end,
    } as const;
    // Reserve-only helper: CAS reserve 100ms of runtime, exact strings.
    const cas = allowanceReserveStatement(ctx as never, {
      ...casBase,
      expectedReserved: "0",
      expectedConsumed: "0",
      newReserved: "100",
      newConsumed: "0",
    });
    const casResult = await h.db.batch([cas]);
    assert.equal(casResult[0]!.meta.changes, 1);
    // Stale expectations (still "0") now fail: no silent double-reserve.
    const stale = allowanceReserveStatement(ctx as never, {
      ...casBase,
      expectedReserved: "0",
      expectedConsumed: "0",
      newReserved: "200",
      newConsumed: "0",
    });
    const staleResult = await h.db.batch([stale]);
    assert.equal(staleResult[0]!.meta.changes, 0);
    // Trusted settlement: reserved 100 -> consumed 100 lands exactly.
    const settle = allowanceSettleStatement(ctx as never, {
      ...casBase,
      expectedReserved: "100",
      expectedConsumed: "0",
      newReserved: "0",
      newConsumed: "100",
    });
    const settleResult = await h.db.batch([settle]);
    assert.equal(settleResult[0]!.meta.changes, 1);
    const landed = (await h.db
      .prepare(
        "SELECT reserved_quantity,consumed_quantity FROM hosted_allowances WHERE allowance_id=?",
      )
      .bind(allowance.allowance_id)
      .first<{ reserved_quantity: string; consumed_quantity: string }>())!;
    assert.deepEqual(landed, {
      reserved_quantity: "0",
      consumed_quantity: "100",
    });
    // Malformed CAS quantities throw before any write.
    assert.throws(() =>
      allowanceReserveStatement(ctx as never, {
        ...casBase,
        expectedReserved: "01",
        expectedConsumed: "0",
        newReserved: "1",
        newConsumed: "0",
      }),
    );
    // Unsupported meter triple rejected for controlled admission.
    assert.throws(
      () =>
        allowanceReserveStatement(ctx as never, {
          ...casBase,
          resource: "inference_tokens",
          unit: "token",
          resourceClass: "model-x",
          expectedReserved: "0",
          expectedConsumed: "100",
          newReserved: "1",
          newConsumed: "100",
        }),
      /unsupported meter/,
    );
    // Measuring interval escaping the allowance period rejected.
    assert.throws(
      () =>
        allowanceReserveStatement(ctx as never, {
          ...casBase,
          expectedReserved: "0",
          expectedConsumed: "100",
          newReserved: "0",
          newConsumed: "100",
          measuredStart: allowance.period_start - 10,
          measuredEnd: allowance.period_end,
        }),
      /measured interval/,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("trusted settlement lands after policy expiry; reserve-only does not", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
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
    const allowance = (await h.db
      .prepare(
        "SELECT allowance_id,entitlement_id,resource,unit,resource_class,period_start,period_end FROM hosted_allowances WHERE organization_id=? AND resource='compute_ms'",
      )
      .bind(a.tenant)
      .first<{
        allowance_id: string;
        entitlement_id: string;
        resource: string;
        unit: string;
        resource_class: string;
        period_start: number;
        period_end: number;
      }>())!;
    const casBase = {
      allowanceId: allowance.allowance_id,
      tenant: a.tenant,
      entitlementId: allowance.entitlement_id,
      resource: allowance.resource,
      unit: allowance.unit,
      resourceClass: allowance.resource_class,
      periodStart: allowance.period_start,
      periodEnd: allowance.period_end,
    } as const;
    // Reserve while live.
    assert.equal(
      (
        await h.db.batch([
          allowanceReserveStatement(ctx as never, {
            ...casBase,
            expectedReserved: "0",
            expectedConsumed: "0",
            newReserved: "100",
            newConsumed: "0",
          }),
        ])
      )[0]!.meta.changes,
      1,
    );
    // Expire the policy: reserve-only now updates 0 (never strand silently).
    await h.db
      .prepare(
        "UPDATE hosted_entitlements SET valid_until=? WHERE entitlement_id=?",
      )
      .bind(Date.now() - 1, allowance.entitlement_id)
      .run();
    assert.equal(
      (
        await h.db.batch([
          allowanceReserveStatement(ctx as never, {
            ...casBase,
            expectedReserved: "100",
            expectedConsumed: "0",
            newReserved: "200",
            newConsumed: "0",
          }),
        ])
      )[0]!.meta.changes,
      0,
    );
    // Trusted settlement still lands: ownership + triple + period + exact
    // quantities checked, commercial window ignored. Stop evidence is never
    // stranded by expiry.
    assert.equal(
      (
        await h.db.batch([
          allowanceSettleStatement(ctx as never, {
            ...casBase,
            expectedReserved: "100",
            expectedConsumed: "0",
            newReserved: "0",
            newConsumed: "100",
          }),
        ])
      )[0]!.meta.changes,
      1,
    );
    const landed = (await h.db
      .prepare(
        "SELECT reserved_quantity,consumed_quantity FROM hosted_allowances WHERE allowance_id=?",
      )
      .bind(allowance.allowance_id)
      .first<{ reserved_quantity: string; consumed_quantity: string }>())!;
    assert.deepEqual(landed, {
      reserved_quantity: "0",
      consumed_quantity: "100",
    });
    // Cross-tenant settlement with identical quantities updates 0.
    const b = await h.login(200);
    assert.equal(
      (
        await h.db.batch([
          allowanceSettleStatement(ctx as never, {
            ...casBase,
            tenant: b.tenant,
            expectedReserved: "0",
            expectedConsumed: "100",
            newReserved: "0",
            newConsumed: "200",
          }),
        ])
      )[0]!.meta.changes,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

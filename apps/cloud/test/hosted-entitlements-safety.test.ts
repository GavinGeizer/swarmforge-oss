import { describe, expect, spyOn, test } from "bun:test";
import type { Context } from "../src/common.ts";
import {
  type AllowanceCasOptions,
  allowanceCasStatement,
  allowanceReserveStatement,
  allowanceSettleStatement,
  putPolicy,
} from "../src/hosted-entitlements.ts";
import { localFixture } from "./local-fixture.ts";

const ctx = {
  env: { DB: { prepare: () => ({ bind: () => ({}) }) } },
} as unknown as Context;
const valid: AllowanceCasOptions = {
  allowanceId: "10000000-0000-4000-8000-000000000001",
  tenant: "10000000-0000-4000-8000-000000000002",
  entitlementId: "10000000-0000-4000-8000-000000000003",
  resource: "compute_ms",
  unit: "millisecond",
  resourceClass: "controlled",
  periodStart: 100,
  periodEnd: 200,
  expectedReserved: "100",
  expectedConsumed: "0",
  newReserved: "0",
  newConsumed: "100",
  now: 150,
};

describe("controlled allowance boundary validation", () => {
  for (const [field, value] of [
    ["periodStart", -Infinity],
    ["periodEnd", Infinity],
    ["periodStart", 100.5],
    ["periodEnd", Number.MAX_SAFE_INTEGER + 1],
    ["measuredStart", -Infinity],
    ["measuredEnd", Infinity],
    ["measuredStart", 100.5],
    ["now", NaN],
  ] as const) {
    test(`rejects ${field}=${value} before preparing a mutation`, () => {
      expect(() =>
        allowanceReserveStatement(ctx, { ...valid, [field]: value }),
      ).toThrow();
      if (field !== "now")
        expect(() =>
          allowanceSettleStatement(ctx, { ...valid, [field]: value }),
        ).toThrow();
    });
  }
  test("accepts exact safe integer boundaries", () => {
    expect(() => allowanceReserveStatement(ctx, valid)).not.toThrow();
    expect(() => allowanceSettleStatement(ctx, valid)).not.toThrow();
  });
});

const policy = {
  capabilities: {
    hosted_control_plane: true,
    remote_worker_enrollment: true,
    hosted_task_execution: true,
  },
  max_concurrent_workers: 4,
  max_active_tasks: 8,
  max_task_runtime: 10000,
  maximum_resource_reservations: 8,
  valid_for_ms: 3600000,
  allowances: [
    {
      resource: "compute_ms",
      unit: "millisecond",
      resource_class: "controlled",
      allowed_quantity: "10000",
    },
  ],
};

test("same-millisecond policy allowance collision retries with coherent real clock dates and preserves history", async () => {
  const h = await localFixture();
  const a = await h.login();
  const previous = await h.seedPolicy(a.tenant, policy);
  h.db.sqlite
    .query(
      "UPDATE hosted_allowances SET consumed_quantity='123',reserved_quantity='50'",
    )
    .run();
  const clock = spyOn(Date, "now")
    .mockReturnValueOnce(previous.valid_from)
    .mockReturnValue(previous.valid_from + 1);
  try {
    const next = await putPolicy(h.context("/"), a.tenant, policy, a.user);
    expect(next.version).toBe(2);
    expect(next.valid_from).toBe(previous.valid_from + 1);
    expect(next.created_at).toBe(next.valid_from);
    expect(next.valid_until).toBe(next.valid_from + 3600000);
    expect(
      h.db.sqlite
        .query(
          "SELECT version,revoked_at FROM hosted_entitlements ORDER BY version",
        )
        .all(),
    ).toEqual([
      { version: 1, revoked_at: next.valid_from },
      { version: 2, revoked_at: null },
    ]);
    expect(
      h.db.sqlite
        .query(
          "SELECT consumed_quantity,reserved_quantity,period_start,period_end,created_at FROM hosted_allowances WHERE entitlement_id=?",
        )
        .get(previous.entitlement_id),
    ).toEqual({
      consumed_quantity: "123",
      reserved_quantity: "50",
      period_start: previous.valid_from,
      period_end: previous.valid_until,
      created_at: previous.created_at,
    });
    expect(
      h.db.sqlite
        .query(
          "SELECT period_start,period_end,created_at FROM hosted_allowances WHERE entitlement_id=?",
        )
        .get(next.entitlement_id),
    ).toEqual({
      period_start: next.valid_from,
      period_end: next.valid_until,
      created_at: next.created_at,
    });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.policy_updated'",
        )
        .get(),
    ).toEqual({ n: 2 });
  } finally {
    clock.mockRestore();
    h.close();
  }
});

test("exhausted policy allowance collision retries roll back revocation allowance policy and audit together", async () => {
  const h = await localFixture();
  const a = await h.login();
  const previous = await h.seedPolicy(a.tenant, policy);
  h.db.sqlite
    .query(
      "UPDATE hosted_allowances SET consumed_quantity='123',reserved_quantity='50'",
    )
    .run();
  const clock = spyOn(Date, "now").mockReturnValue(previous.valid_from);
  try {
    await expect(
      putPolicy(h.context("/"), a.tenant, policy, a.user),
    ).rejects.toMatchObject({ status: 409, code: "policy_conflict" });
    expect(
      h.db.sqlite
        .query("SELECT version,revoked_at FROM hosted_entitlements")
        .all(),
    ).toEqual([{ version: 1, revoked_at: null }]);
    expect(
      h.db.sqlite
        .query(
          "SELECT consumed_quantity,reserved_quantity FROM hosted_allowances",
        )
        .all(),
    ).toEqual([{ consumed_quantity: "123", reserved_quantity: "50" }]);
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.policy_updated'",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    clock.mockRestore();
    h.close();
  }
});

test("legacy allowance alias refuses fractional unsafe or expired period boundaries", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const p = await h.seedPolicy(a.tenant, policy);
    const row = h.db.sqlite
      .query("SELECT allowance_id FROM hosted_allowances")
      .get() as { allowance_id: string };
    for (const [start, end] of [
      [p.valid_from - 0.5, p.valid_until],
      [p.valid_from, Number.MAX_SAFE_INTEGER + 1],
      [p.valid_from - 100, p.valid_from],
    ] as const) {
      h.db.sqlite
        .query("UPDATE hosted_allowances SET period_start=?,period_end=?")
        .run(start, end);
      const result = await allowanceCasStatement(
        h.context("/"),
        row.allowance_id,
        a.tenant,
        p.entitlement_id,
        "0",
        "0",
        "1",
        "0",
        p.valid_from,
      ).run();
      expect(result.meta.changes).toBe(0);
      expect(
        h.db.sqlite
          .query("SELECT reserved_quantity FROM hosted_allowances")
          .get(),
      ).toEqual({ reserved_quantity: "0" });
    }
    expect(() =>
      allowanceCasStatement(
        h.context("/"),
        row.allowance_id,
        a.tenant,
        p.entitlement_id,
        "0",
        "0",
        "1",
        "0",
        NaN,
      ),
    ).toThrow("invalid authority time");
  } finally {
    h.close();
  }
});

test("legacy allowance alias checks period expiry at SQL execution rather than only the supplied clock", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const p = await h.seedPolicy(a.tenant, policy);
    const row = h.db.sqlite
      .query("SELECT allowance_id FROM hosted_allowances")
      .get() as { allowance_id: string };
    h.db.sqlite
      .query("UPDATE hosted_allowances SET period_start=?,period_end=?")
      .run(p.valid_from - 100, p.valid_from - 1);
    const result = await allowanceCasStatement(
      h.context("/"),
      row.allowance_id,
      a.tenant,
      p.entitlement_id,
      "0",
      "0",
      "1",
      "0",
      p.valid_from - 50,
    ).run();
    expect(result.meta.changes).toBe(0);
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "0" });
  } finally {
    h.close();
  }
});

test("explicit reserve helper rejects expired or future allowance periods at SQL execution time", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const p = await h.seedPolicy(a.tenant, policy);
    const row = h.db.sqlite
      .query("SELECT allowance_id FROM hosted_allowances")
      .get() as { allowance_id: string };
    const now = Date.now();
    for (const [start, end, suppliedNow] of [
      [now - 2000, now - 1000, now - 1500],
      [now + 10000, now + 20000, now],
    ] as const) {
      h.db.sqlite
        .query("UPDATE hosted_allowances SET period_start=?,period_end=?")
        .run(start, end);
      const result = await allowanceReserveStatement(h.context("/"), {
        ...valid,
        allowanceId: row.allowance_id,
        tenant: a.tenant,
        entitlementId: p.entitlement_id,
        periodStart: start,
        periodEnd: end,
        expectedReserved: "0",
        newReserved: "1000",
        newConsumed: "0",
        now: suppliedNow,
      }).run();
      expect(result.meta.changes).toBe(0);
      expect(
        h.db.sqlite
          .query("SELECT reserved_quantity FROM hosted_allowances")
          .get(),
      ).toEqual({ reserved_quantity: "0" });
    }
  } finally {
    h.close();
  }
});

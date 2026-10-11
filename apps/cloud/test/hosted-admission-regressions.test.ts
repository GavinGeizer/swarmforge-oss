import { expect, test } from "bun:test";
import { hostedAdmissionRoute } from "../src/hosted-admission.ts";
import { hostedAuthorityRoute } from "../src/hosted-authority.ts";
import { allowanceCasStatement } from "../src/hosted-entitlements.ts";
import type { AdmissionReply } from "../src/hosted-types.ts";
import { localFixture } from "./local-fixture.ts";

const policy = {
  capabilities: {
    hosted_control_plane: true,
    remote_worker_enrollment: true,
    hosted_task_execution: true,
  },
  max_concurrent_workers: 8,
  max_active_tasks: 8,
  max_task_runtime: 10000,
  maximum_resource_reservations: 8,
  valid_for_ms: 3600000,
};
const meter = (allowed_quantity: string) => [
  {
    resource: "compute_ms",
    unit: "millisecond",
    resource_class: "controlled",
    allowed_quantity,
  },
];
const submit = (worker_id: string) => ({
  request_id: crypto.randomUUID(),
  worker_id,
  execution_class: "controlled",
  runtime_ms: 1000,
  controlled_duration_ms: 10,
});
const fixture = () =>
  localFixture({ handlers: [hostedAdmissionRoute, hostedAuthorityRoute] });
async function admit(
  h: Awaited<ReturnType<typeof fixture>>,
  a: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["login"]>>,
  worker: string,
  key = crypto.randomUUID(),
) {
  return h.request(
    `/v1/tenants/${a.tenant}/tasks`,
    { ...a.headers, "idempotency-key": key },
    "POST",
    submit(worker),
  );
}

test("current policy zero allowance cannot borrow a positive historical allowance", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("10000") });
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("0") });
    const r = await admit(h, a, w.worker_id);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "allowance_exhausted",
    );
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_tasks").get(),
    ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .all(),
    ).toEqual([{ reserved_quantity: "0" }, { reserved_quantity: "0" }]);
  } finally {
    h.close();
  }
});

test("admission reserves only the pinned current policy allowance", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("0") });
    const latest = await h.seedPolicy(a.tenant, {
      ...policy,
      allowances: meter("10000"),
    });
    expect((await admit(h, a, w.worker_id)).status).toBe(202);
    expect(
      h.db.sqlite
        .query(
          "SELECT reserved_quantity FROM hosted_allowances ORDER BY created_at,allowance_id",
        )
        .all()
        .map((r) => (r as { reserved_quantity: string }).reserved_quantity)
        .sort(),
    ).toEqual(["0", "1000"]);
    expect(
      h.db.sqlite
        .query(
          "SELECT a.entitlement_id FROM hosted_reservations r JOIN hosted_allowances a USING(allowance_id)",
        )
        .get(),
    ).toEqual({ entitlement_id: latest.entitlement_id });
  } finally {
    h.close();
  }
});

test("reused cancellation key for another task changes no state or meter", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w1 = await h.enrolledWorker(a);
    const w2 = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("10000") });
    const one = (await (
      await admit(h, a, w1.worker_id)
    ).json()) as AdmissionReply;
    const two = (await (
      await admit(h, a, w2.worker_id)
    ).json()) as AdmissionReply;
    const key = crypto.randomUUID();
    const headers = { ...a.headers, "idempotency-key": key };
    expect(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/tasks/${one.task.task_id}/cancel`,
          headers,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/tasks/${two.task.task_id}/cancel`,
          headers,
          "POST",
          {},
        )
      ).status,
    ).toBe(409);
    expect(
      h.db.sqlite
        .query("SELECT state FROM hosted_tasks WHERE task_id=?")
        .get(two.task.task_id),
    ).toEqual({ state: "queued" });
    expect(
      h.db.sqlite
        .query("SELECT state FROM hosted_reservations WHERE task_id=?")
        .get(two.task.task_id),
    ).toEqual({ state: "active" });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "1000" });
  } finally {
    h.close();
  }
});

test("authority revocation between cancellation authentication and batch changes nothing", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, policy);
    const reply = (await (
      await admit(h, a, w.worker_id)
    ).json()) as AdmissionReply;
    h.db.beforeBatch = () => {
      h.db.beforeBatch = undefined;
      h.db.sqlite
        .query("UPDATE sessions SET revoked_at=? WHERE session_id=?")
        .run(Date.now(), a.sessionId);
    };
    const r = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${reply.task.task_id}/cancel`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    expect(r.status).toBe(403);
    expect(h.db.sqlite.query("SELECT state FROM hosted_tasks").get()).toEqual({
      state: "queued",
    });
    expect(
      h.db.sqlite.query("SELECT state FROM hosted_reservations").get(),
    ).toEqual({ state: "active" });
    expect(h.db.sqlite.query("SELECT state FROM hosted_outbox").get()).toEqual({
      state: "queued",
    });
  } finally {
    h.close();
  }
});

test("cancellation ledger mismatch cannot terminalize or release capacity", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("10000") });
    const reply = (await (
      await admit(h, a, w.worker_id)
    ).json()) as AdmissionReply;
    h.db.beforeBatch = () => {
      h.db.beforeBatch = undefined;
      h.db.sqlite
        .query("UPDATE hosted_allowances SET reserved_quantity='999'")
        .run();
    };
    const r = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${reply.task.task_id}/cancel`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    expect(r.status).toBe(409);
    expect(h.db.sqlite.query("SELECT state FROM hosted_tasks").get()).toEqual({
      state: "queued",
    });
    expect(
      h.db.sqlite.query("SELECT state FROM hosted_reservations").get(),
    ).toEqual({ state: "active" });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM hosted_operations WHERE operation='task.cancel'",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("legacy allowance alias cannot mutate unsupported meters", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const p = await h.seedPolicy(a.tenant, {
      ...policy,
      allowances: [
        {
          resource: "other",
          unit: "unit",
          resource_class: "controlled",
          allowed_quantity: "10000",
        },
      ],
    });
    const row = h.db.sqlite
      .query("SELECT allowance_id FROM hosted_allowances")
      .get() as { allowance_id: string };
    await allowanceCasStatement(
      h.context("/"),
      row.allowance_id,
      a.tenant,
      p.entitlement_id,
      "0",
      "0",
      "1",
      "0",
    ).run();
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "0" });
  } finally {
    h.close();
  }
});

test("full-meter admission replay is identical 202 without a second reservation", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("1000") });
    const path = `/v1/tenants/${a.tenant}/tasks`;
    const input = submit(w.worker_id);
    const headers = { ...a.headers, "idempotency-key": crypto.randomUUID() };
    const first = await h.request(path, headers, "POST", input);
    expect(first.status).toBe(202);
    const reply = (await first.json()) as AdmissionReply;
    const replay = await h.request(path, headers, "POST", input);
    expect(replay.status).toBe(202);
    expect((await replay.json()) as AdmissionReply).toEqual(reply);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_reservations").get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "1000" });
  } finally {
    h.close();
  }
});

test("allowance_exhausted returns 403 on both advisory and post-batch diagnostic paths", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const w2 = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("1000") });
    // Advisory path: full headroom consumed by the first admission, so the
    // second admission's advisory remaining-check denies 403 exhausted.
    expect((await admit(h, a, w.worker_id)).status).toBe(202);
    const denied = await admit(h, a, w2.worker_id);
    expect(denied.status).toBe(403);
    expect(
      ((await denied.json()) as { error: { code: string } }).error.code,
    ).toBe("allowance_exhausted");
    // Post-batch diagnostic path: same exhausted ledger state re-observed
    // after the batch elects nothing reports 403 exhausted (not 409), while
    // allowance_unavailable and concurrency conflicts stay 409.
    const probe = await admit(h, a, w2.worker_id);
    expect(probe.status).toBe(403);
    expect(
      ((await probe.json()) as { error: { code: string } }).error.code,
    ).toBe("allowance_exhausted");
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_tasks").get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "1000" });
  } finally {
    h.close();
  }
});

test("any missing required capability denies admission with 403", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    for (const cap of [
      "hosted_control_plane",
      "remote_worker_enrollment",
      "hosted_task_execution",
    ] as const) {
      await h.seedPolicy(a.tenant, {
        ...policy,
        capabilities: { ...policy.capabilities, [cap]: false },
      });
      expect((await admit(h, a, w.worker_id)).status).toBe(403);
    }
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_tasks").get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("SQL int64 meter arithmetic reaches the canonical boundary exactly and refuses overflow", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const w2 = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, {
      ...policy,
      allowances: meter("9007199254740991"),
    });
    h.db.sqlite
      .query(
        "UPDATE hosted_allowances SET consumed_quantity='9007199254739991'",
      )
      .run();
    expect((await admit(h, a, w.worker_id)).status).toBe(202);
    expect(
      h.db.sqlite
        .query(
          "SELECT reserved_quantity,typeof(CAST(consumed_quantity AS INTEGER)+CAST(reserved_quantity AS INTEGER)) arithmetic_type,printf('%d',CAST(consumed_quantity AS INTEGER)+CAST(reserved_quantity AS INTEGER)) total FROM hosted_allowances",
        )
        .get(),
    ).toEqual({
      reserved_quantity: "1000",
      arithmetic_type: "integer",
      total: "9007199254740991",
    });
    expect((await admit(h, a, w2.worker_id)).status).toBe(403);
    expect(() =>
      h.db.sqlite
        .query(
          "UPDATE hosted_allowances SET reserved_quantity='9007199254740992'",
        )
        .run(),
    ).toThrow();
    h.db.sqlite
      .query(
        "UPDATE hosted_allowances SET reserved_quantity='9007199254740991',consumed_quantity='9007199254740991'",
      )
      .run();
    expect(
      h.db.sqlite
        .query(
          "SELECT typeof(CAST(allowed_quantity AS INTEGER)-CAST(reserved_quantity AS INTEGER)-CAST(consumed_quantity AS INTEGER)) arithmetic_type FROM hosted_allowances",
        )
        .get(),
    ).toEqual({ arithmetic_type: "integer" });
  } finally {
    h.close();
  }
});

test("policy expiry while an admission waits to batch cannot elect a task", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, policy);
    h.db.sqlite
      .query("UPDATE hosted_entitlements SET valid_until=?")
      .run(Date.now() + 30);
    h.db.beforeBatch = async () => {
      h.db.beforeBatch = undefined;
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    expect((await admit(h, a, w.worker_id)).status).toBe(403);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_tasks").get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("same-org multi-user and multi-CLI races share caps while another org admits independently", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const b = await h.login(200);
    const now = Date.now();
    h.db.sqlite
      .query("INSERT INTO memberships VALUES(?,?,'member','active',?,?)")
      .run(a.tenant, b.user, now, now);
    const sharedB = { ...b, tenant: a.tenant };
    const grants: string[] = [];
    for (const account of [a, a, sharedB]) {
      const linked = await h.linked(account);
      const issued = await h.request(
        `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
        { ...account.headers, "idempotency-key": crypto.randomUUID() },
        "POST",
        {},
      );
      expect(issued.status).toBe(201);
      grants.push(((await issued.json()) as { credential: string }).credential);
    }
    await h.seedPolicy(a.tenant, {
      ...policy,
      max_active_tasks: 2,
      max_concurrent_workers: 2,
      maximum_resource_reservations: 2,
    });
    await h.seedPolicy(b.tenant, policy);
    const workers = [];
    for (let i = 0; i < 8; i++) workers.push(await h.enrolledWorker(a));
    const otherWorkers = [await h.enrolledWorker(b), await h.enrolledWorker(b)];
    const headers = [
      a.headers,
      sharedB.headers,
      ...grants.map((g) => ({ authorization: `Bearer ${g}` })),
    ];
    const results = await Promise.all([
      ...workers.map((w, i) =>
        h.request(
          `/v1/tenants/${a.tenant}/tasks`,
          {
            ...headers[i % headers.length],
            "idempotency-key": crypto.randomUUID(),
          },
          "POST",
          submit(w.worker_id),
        ),
      ),
      ...otherWorkers.map((w) => admit(h, b, w.worker_id)),
    ]);
    expect(
      results
        .slice(0, 8)
        .map((r) => r.status)
        .sort(),
    ).toEqual([202, 202, 409, 409, 409, 409, 409, 409]);
    expect(results.slice(8).map((r) => r.status)).toEqual([202, 202]);
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM hosted_reservations WHERE organization_id=? AND state IN ('active','quarantined')",
        )
        .get(a.tenant),
    ).toEqual({ n: 2 });
  } finally {
    h.close();
  }
});

test("failed dependent SQL rolls back task reservation outbox audit operation and meter together", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("10000") });
    h.db.sqlite.exec(
      "CREATE TRIGGER forced_outbox_failure BEFORE INSERT ON hosted_outbox BEGIN SELECT RAISE(ABORT,'forced outbox failure'); END",
    );
    expect((await admit(h, a, w.worker_id)).status).toBe(503);
    for (const table of [
      "hosted_tasks",
      "hosted_reservations",
      "hosted_outbox",
      "hosted_operations",
    ])
      expect(
        h.db.sqlite.query(`SELECT count(*) n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.task_admitted'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "0" });
  } finally {
    h.close();
  }
});

test("a ledger CAS miss on admission elects no task or dependent writes", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("10000") });
    h.db.beforeBatch = () => {
      h.db.beforeBatch = undefined;
      h.db.sqlite
        .query("UPDATE hosted_allowances SET reserved_quantity='1'")
        .run();
    };
    expect((await admit(h, a, w.worker_id)).status).toBe(409);
    for (const table of [
      "hosted_tasks",
      "hosted_reservations",
      "hosted_outbox",
      "hosted_operations",
    ])
      expect(
        h.db.sqlite.query(`SELECT count(*) n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.task_admitted'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "1" });
  } finally {
    h.close();
  }
});

test("admission denies a registered worker after its enroller loses admin authority", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, policy);
    h.db.sqlite
      .query(
        "UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?",
      )
      .run(a.tenant, a.user);
    expect((await admit(h, a, w.worker_id)).status).toBe(403);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_tasks").get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("admission rechecks the worker enroller admin chain at batch election", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, policy);
    h.db.beforeBatch = () => {
      h.db.beforeBatch = undefined;
      h.db.sqlite
        .query(
          "UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?",
        )
        .run(a.tenant, a.user);
    };
    expect((await admit(h, a, w.worker_id)).status).toBe(403);
    for (const table of [
      "hosted_tasks",
      "hosted_reservations",
      "hosted_outbox",
      "hosted_operations",
    ])
      expect(
        h.db.sqlite.query(`SELECT count(*) n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("cancellation elected before authority expires completes and reports its committed result", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("10000") });
    const reply = (await (
      await admit(h, a, w.worker_id)
    ).json()) as AdmissionReply;
    // Simulate authority expiring after the operation election, inside the
    // serialized transaction. All later effects depend on that election.
    h.db.sqlite.exec(
      "CREATE TRIGGER expire_after_cancel_election AFTER INSERT ON hosted_operations WHEN NEW.operation='task.cancel' BEGIN UPDATE sessions SET created_at=0,expires_at=1 WHERE session_id=(SELECT authorizing_session_id FROM hosted_tasks WHERE task_id=NEW.task_id); END",
    );
    const r = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${reply.task.task_id}/cancel`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { task: { state: string } }).task.state).toBe(
      "cancelled",
    );
    expect(
      h.db.sqlite.query("SELECT state FROM hosted_reservations").get(),
    ).toEqual({ state: "released" });
    expect(h.db.sqlite.query("SELECT state FROM hosted_outbox").get()).toEqual({
      state: "dead",
    });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "0" });
  } finally {
    h.close();
  }
});

test("unavailable policy source denies new work with 503 and no admission effects", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    // No policies or dependent rows exist; dropping the source simulates an
    // unavailable store while preserving foreign-key enforcement.
    h.db.sqlite.exec("DROP TABLE hosted_entitlements");
    const r = await admit(h, a, w.worker_id);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "policy_unavailable",
    );
    for (const table of [
      "hosted_tasks",
      "hosted_reservations",
      "hosted_outbox",
      "hosted_operations",
    ])
      expect(
        h.db.sqlite.query(`SELECT count(*) n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("failed cancellation dependent SQL reports unavailable and rolls back elected effects", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, { ...policy, allowances: meter("10000") });
    const reply = (await (
      await admit(h, a, w.worker_id)
    ).json()) as AdmissionReply;
    h.db.sqlite.exec(
      "CREATE TRIGGER failed_cancel_outbox BEFORE UPDATE ON hosted_outbox BEGIN SELECT RAISE(ABORT,'outbox store unavailable'); END",
    );
    const r = await h.request(
      `/v1/tenants/${a.tenant}/tasks/${reply.task.task_id}/cancel`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    expect(r.status).toBe(503);
    expect(h.db.sqlite.query("SELECT state FROM hosted_tasks").get()).toEqual({
      state: "queued",
    });
    expect(
      h.db.sqlite.query("SELECT state FROM hosted_reservations").get(),
    ).toEqual({ state: "active" });
    expect(h.db.sqlite.query("SELECT state FROM hosted_outbox").get()).toEqual({
      state: "queued",
    });
    expect(
      h.db.sqlite
        .query("SELECT reserved_quantity FROM hosted_allowances")
        .get(),
    ).toEqual({ reserved_quantity: "1000" });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM hosted_operations WHERE operation='task.cancel'",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("execution grant issuance cannot elect after browser or installation expiry while waiting to batch", async () => {
  for (const boundary of ["browser", "installation"] as const) {
    const h = await fixture();
    try {
      const a = await h.login();
      const linked = await h.linked(a);
      if (boundary === "browser")
        h.db.sqlite
          .query("UPDATE sessions SET expires_at=? WHERE session_id=?")
          .run(Date.now() + 40, a.sessionId);
      else
        h.db.sqlite
          .query(
            "UPDATE cli_installations SET authorization_expires_at=? WHERE installation_id=?",
          )
          .run(Date.now() + 40, linked.installation_id);
      h.db.beforeBatch = async () => {
        h.db.beforeBatch = undefined;
        await Bun.sleep(60);
      };
      const r = await h.request(
        `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
        { ...a.headers, "idempotency-key": crypto.randomUUID() },
        "POST",
        {},
      );
      expect(r.status).toBe(409);
      expect(
        h.db.sqlite
          .query("SELECT count(*) n FROM hosted_execution_grants")
          .get(),
      ).toEqual({ n: 0 });
      expect(
        h.db.sqlite
          .query(
            "SELECT count(*) n FROM audit_events WHERE action='hosted.execution_authorized'",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      h.close();
    }
  }
});

test("execution grant issuance replay rechecks browser expiry at SQL time despite a stale Worker clock", async () => {
  const h = await fixture();
  const realNow = Date.now;
  try {
    const a = await h.login();
    const linked = await h.linked(a);
    const path = `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`;
    const headers = { ...a.headers, "idempotency-key": crypto.randomUUID() };
    const first = await h.request(path, headers, "POST", {});
    expect(first.status).toBe(201);
    const clock = Date.now();
    h.db.sqlite
      .query("UPDATE sessions SET expires_at=? WHERE session_id=?")
      .run(clock + 10, a.sessionId);
    await Bun.sleep(20);
    Date.now = () => clock;
    const replay = await h.request(path, headers, "POST", {});
    expect(replay.status).toBe(409);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_execution_grants").get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.execution_authorized'",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    Date.now = realNow;
    h.close();
  }
});

test("fresh grant election returns its committed reply after browser expiry within the batch", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const linked = await h.linked(a);
    h.db.sqlite.exec(
      "CREATE TRIGGER expire_browser_after_grant AFTER INSERT ON hosted_execution_grants BEGIN UPDATE sessions SET created_at=0,expires_at=1 WHERE session_id=NEW.session_id; END",
    );
    const r = await h.request(
      `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    expect(r.status).toBe(201);
    const reply = (await r.json()) as { grant_id: string };
    expect(
      h.db.sqlite.query("SELECT grant_id FROM hosted_execution_grants").get(),
    ).toEqual({ grant_id: reply.grant_id });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.execution_authorized'",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    h.close();
  }
});

test("execution grant election refuses a proposed credential already expired on the SQL clock", async () => {
  const h = await fixture();
  const realNow = Date.now;
  try {
    const a = await h.login();
    const linked = await h.linked(a);
    Date.now = () => realNow() - 3601000;
    const r = await h.request(
      `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    expect(r.status).toBe(409);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_execution_grants").get(),
    ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.execution_authorized'",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    Date.now = realNow;
    h.close();
  }
});

test("same-key grant issuance race replays one fresh winner and refuses a revoked winner without phantom audit", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const linked = await h.linked(a);
    const path = `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`;
    const headers = { ...a.headers, "idempotency-key": crypto.randomUUID() };
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.db.beforeBatch = async () => {
      if (++arrivals === 2) {
        h.db.beforeBatch = undefined;
        release();
      }
      await barrier;
    };
    const responses = await Promise.all([
      h.request(path, headers, "POST", {}),
      h.request(path, headers, "POST", {}),
    ]);
    expect(arrivals).toBe(2);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const replies = (await Promise.all(responses.map((r) => r.json()))) as {
      grant_id: string;
    }[];
    expect(replies[0]).toEqual(replies[1]);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_execution_grants").get(),
    ).toEqual({ n: 1 });
    h.db.sqlite
      .query("UPDATE hosted_execution_grants SET revoked_at=? WHERE grant_id=?")
      .run(Date.now(), replies[0]!.grant_id);
    expect((await h.request(path, headers, "POST", {})).status).toBe(409);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_execution_grants").get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='hosted.execution_authorized'",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    h.close();
  }
});

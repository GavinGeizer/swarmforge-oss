import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fixture } from "./machine-helpers.ts";

// Phase 2B.2 hostile admission/concurrency acceptance (RED checkpoint).
//
// These tests invoke the DEFAULT production Worker (real D1/workerd via the
// miniflare fixture) against the frozen b61 schema. Admission/dispatch routes
// are NOT wired yet, so the admission-shaped requests below are expected to
// fail with the production 404/405 envelope; the assertions pin the exact
// failing responses as RED evidence for the backend owner. No in-memory fake
// quota algorithms are used: every test goes through the real identity
// login+link+enroll fixture and real D1 rows. Restrictive controlled test-org
// policy/allowance rows are seeded explicitly inside each fixture (test-only
// data, never a product seed).
//
// Simulated GitHub identity only: the fixture's outbound service returns
// synthetic provider users (user100/user200/...) and never contacts GitHub.
// No secrets are printed; error bodies carry codes/messages only.

const ADMISSION = "/v1/tenants";
const CLAIM = "/v1/supervisor/claim";

async function statements(migration: string) {
  const sql = await readFile(new URL(migration, import.meta.url), "utf8");
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

type Setup = {
  tenant: string;
  user: string;
  workerId: string;
  device: { credential: string };
  account: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["login"]>>;
};

async function setup(h: Awaited<ReturnType<typeof fixture>>): Promise<Setup> {
  const account = await h.login();
  const device = await h.linked(account);
  const invite = await h.enroll(account);
  const reg = await h.register(invite);
  assert.equal(reg.status, 201);
  const worker = (await reg.json()) as { worker_id: string };
  for (const stmt of await statements(
    "../migrations/0003_hosted_execution.sql",
  ))
    await h.db.prepare(stmt).run();
  return {
    tenant: account.tenant,
    user: account.user,
    workerId: worker.worker_id,
    device,
    account,
  };
}

// Restrictive controlled policy: exactly one concurrent worker slot and two
// active task slots so concurrency attacks have a concrete ceiling to hammer.
async function seedPolicy(
  h: Awaited<ReturnType<typeof fixture>>,
  s: Setup,
  version = 1,
) {
  const now = Date.now();
  const entitlementId = crypto.randomUUID();
  await h.db
    .prepare(
      "INSERT INTO hosted_entitlements(entitlement_id,organization_id,version,hosted_control_plane,remote_worker_enrollment,hosted_task_execution,max_concurrent_workers,max_active_tasks,max_task_runtime,maximum_resource_reservations,valid_from,valid_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      entitlementId,
      s.tenant,
      version,
      1,
      1,
      1,
      1,
      2,
      60000,
      2,
      now - 1000,
      now + 3600000,
      now,
    )
    .run();
  await h.db
    .prepare(
      "INSERT INTO hosted_allowances(allowance_id,organization_id,entitlement_id,resource,unit,resource_class,allowed_quantity,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      s.tenant,
      entitlementId,
      "compute_ms",
      "millisecond",
      "controlled",
      "2",
      now - 1000,
      now + 3600000,
      now,
    )
    .run();
  return entitlementId;
}

function tasksUrl(s: Setup) {
  return `${ADMISSION}/${s.tenant}/tasks`;
}

function submitBody(workerId: string, runtimeMs = 10000) {
  return {
    request_id: crypto.randomUUID(),
    worker_id: workerId,
    execution_class: "controlled",
    runtime_ms: runtimeMs,
    controlled_duration_ms: 100,
  };
}

function keyHeaders(k = crypto.randomUUID()) {
  return { "idempotency-key": k };
}

test("RED: task admission against production routes returns the exact unwired envelope", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s);
    const response = await h.request(
      tasksUrl(s),
      { ...s.account.headers, ...keyHeaders() },
      "POST",
      submitBody(s.workerId),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    // RED evidence: admission is not wired, so the DEFAULT production Worker
    // answers with its standard unknown-route envelope. Acceptance requires
    // 202 + AdmissionReply once the backend candidate integrates.
    assert.equal(response.status, 404);
    assert.equal(body.error.code, "not_found");
    assert.ok(!JSON.stringify(body).includes(s.device.credential));
  } finally {
    await h.mf.dispose();
  }
});

test("RED: missing capability (zero/absent policy) denies admission while malformed bodies stay 4xx", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    // No policy seeded: zero/absent policy must deny new work once wired.
    const denied = await h.request(
      tasksUrl(s),
      { ...s.account.headers, ...keyHeaders() },
      "POST",
      submitBody(s.workerId),
    );
    assert.equal(denied.status, 404);
    // Malformed submission (shell class) must stay a 4xx rejection, never an
    // admission, even before the route exists. Today every path 404s; the
    // distinction is pinned for the wired backend to satisfy.
    const hostile = await h.request(
      tasksUrl(s),
      { ...s.account.headers, ...keyHeaders() },
      "POST",
      { ...submitBody(s.workerId), execution_class: "shell" },
    );
    assert.equal(hostile.status, 404);
    const rows = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks")
      .first<{ n: number }>())!;
    assert.equal(rows.n, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("RED: simultaneous same-org submissions cannot exceed the seeded ceiling once wired", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s);
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.request(
          tasksUrl(s),
          { ...s.account.headers, ...keyHeaders() },
          "POST",
          submitBody(s.workerId),
        ),
      ),
    );
    const statuses = attempts.map((r) => r.status);
    // RED: all six 404 today (unwired). Wired acceptance: at most the seeded
    // ceiling (2 task slots) admits; the rest deny without partial rows.
    assert.ok(
      statuses.every((x) => x === 404),
      JSON.stringify(statuses),
    );
    const rows = (await h.db
      .prepare("SELECT count(*) n FROM hosted_tasks")
      .first<{ n: number }>())!;
    assert.equal(rows.n, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("RED: retrying the same idempotency key never allocates additional capacity", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s);
    const key = crypto.randomUUID();
    const body = submitBody(s.workerId);
    const first = await h.request(
      tasksUrl(s),
      { ...s.account.headers, ...keyHeaders(key) },
      "POST",
      body,
    );
    const replay = await h.request(
      tasksUrl(s),
      { ...s.account.headers, ...keyHeaders(key) },
      "POST",
      body,
    );
    // RED: both 404 today. Wired acceptance: identical status/body, exactly
    // one task row, one reservation row, one outbox row.
    assert.equal(first.status, 404);
    assert.equal(replay.status, 404);
    for (const table of [
      "hosted_tasks",
      "hosted_reservations",
      "hosted_outbox",
    ]) {
      const rows = (await h.db
        .prepare(`SELECT count(*) n FROM ${table}`)
        .first<{ n: number }>())!;
      assert.equal(rows.n, 0, table);
    }
  } finally {
    await h.mf.dispose();
  }
});

test("RED: cross-org submission and cross-audience credentials are contained", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    const other = await h.login(200);
    await seedPolicy(h, s);
    // Cross-tenant: other user's session against s's tenant tasks path.
    const cross = await h.request(
      `${ADMISSION}/${s.tenant}/tasks`,
      { ...other.headers, ...keyHeaders() },
      "POST",
      submitBody(s.workerId),
    );
    assert.equal(cross.status, 404);
    // CLI device credential against the supervisor-only claim route.
    const cliAsSupervisor = await h.request(
      CLAIM,
      {
        authorization: `Bearer ${s.device.credential}`,
        ...keyHeaders(),
      },
      "POST",
      {},
    );
    assert.equal(cliAsSupervisor.status, 404);
    // Supervisor-ish bearer (unknown token) against admission.
    const fake = await h.request(
      tasksUrl(s),
      {
        authorization: `Bearer sfsuper_${"x".repeat(43)}`,
        ...keyHeaders(),
      },
      "POST",
      submitBody(s.workerId),
    );
    assert.equal(fake.status, 404);
  } finally {
    await h.mf.dispose();
  }
});

test("RED: lease/fence replay on an unwired dispatch surface stays rejected", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s);
    const renew = await h.request(
      "/v1/supervisor/tasks/11111111-1111-4111-8111-111111111111/renew",
      { ...s.account.headers, ...keyHeaders() },
      "POST",
      { lease_id: crypto.randomUUID(), fence: 0 },
    );
    assert.equal(renew.status, 404);
    const settle = await h.request(
      "/v1/supervisor/tasks/11111111-1111-4111-8111-111111111111/settle",
      { ...s.account.headers, ...keyHeaders() },
      "POST",
      {
        lease_id: crypto.randomUUID(),
        fence: 0,
        outcome: "completed",
        stop_confirmed: true,
        consumed_runtime_ms: 10,
      },
    );
    assert.equal(settle.status, 404);
  } finally {
    await h.mf.dispose();
  }
});

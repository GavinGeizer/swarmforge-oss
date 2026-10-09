import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AdmissionReply,
  admissionReplySchema,
} from "../src/hosted-types.ts";
import { fixture } from "./machine-helpers.ts";

// Phase 2B.2 hostile admission/concurrency acceptance — CORRECTED RED checkpoint.
//
// The prior turn (commit 7300825, preserved as test-report-rejected-7300825.md
// and tag rejected-7300825-green404) pinned 404 envelopes as passing
// assertions: green missing-route probes, not acceptance tests. This file
// asserts DESIRED protocol behavior instead, so every test FAILS against the
// unwired production Worker and only passes once the backend wires the routes.
// A future endpoint implementation can never pass by weakening these
// assertions; it must produce the required codes, bodies and row counts.
//
// Desired contract (frozen protocol + dispatch):
// - valid policy + registered worker + browser submission
//   => 202 + AdmissionReply + exactly one active reservation + one queued outbox.
// - same idempotency key + same body => identical 202, same task, exactly one row.
// - same key + different body => 409 conflict, no additional rows.
// - concurrent N distinct submissions => EXACTLY the configured ceiling wins
//   (worker-exclusive with one worker; task-quota ceiling with several workers),
//   the rest real quota 409, zero partial writes.
// - absent/expired/revoked capability => 403 with an error envelope
//   (exact code defined by the backend later; status + envelope shape asserted).
// - malformed execution_class/duration/runtime/extra fields => 400.
// - wrong audience or missing auth on admission => 401.
// - cross-org submission => 404 containment (zero rows).
// - supervisor claim/renew/settle without a supervisor credential => 401.
//
// All tests invoke the DEFAULT production Worker (real D1/workerd via the
// miniflare fixture) with real identity login+link+enroll. Policy rows are
// browser-seeded TECHNICAL fixtures only (finite ceilings, no pricing). The
// meter/allowance contract is still undefined, so pure-concurrency tests seed
// NO allowance rows; only the technical entitlement ceiling governs.
// Simulated GitHub identity only (synthetic provider users); no secrets printed.

const CLAIM = "/v1/supervisor/claim";

// Setup compatibility: the shared fixture on this branch applies only the
// phase2b1 migrations (compatibility789 makes all-3 the default once
// integrated), so tests apply migration 0003 explicitly themselves.
// Assertion behavior is unchanged.

async function statements(migration: string) {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL(migration, import.meta.url), "utf8");
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function hostedFixture() {
  const h = await fixture();
  for (const stmt of await statements(
    "../migrations/0003_hosted_execution.sql",
  ))
    await h.db.prepare(stmt).run();
  return h;
}

type HostedHarness = Awaited<ReturnType<typeof hostedFixture>>;
type Setup = {
  tenant: string;
  user: string;
  workerId: string;
  account: Awaited<ReturnType<HostedHarness["login"]>>;
};

async function setup(h: HostedHarness): Promise<Setup> {
  const account = await h.login();
  await h.linked(account);
  const invite = await h.enroll(account);
  const reg = await h.register(invite);
  assert.equal(reg.status, 201);
  const worker = (await reg.json()) as { worker_id: string };
  return {
    tenant: account.tenant,
    user: account.user,
    workerId: worker.worker_id,
    account,
  };
}

async function extraWorker(h: HostedHarness, s: Setup): Promise<string> {
  const invite = await h.enroll(s.account);
  const reg = await h.register(invite);
  assert.equal(reg.status, 201);
  return ((await reg.json()) as { worker_id: string }).worker_id;
}

type PolicyOptions = {
  version?: number;
  maxWorkers?: number | null;
  maxTasks?: number | null;
  maxReservations?: number | null;
  validFrom?: number;
  validUntil?: number;
  revokedAt?: number | null;
};

// Technical policy fixture only: finite ceilings, no pricing, no meter rows.
async function seedPolicy(
  h: HostedHarness,
  s: Setup,
  options: PolicyOptions = {},
) {
  const now = Date.now();
  const {
    version = 1,
    maxWorkers = null,
    maxTasks = null,
    maxReservations = null,
    validFrom = now - 1000,
    validUntil = now + 3600000,
    revokedAt = null,
  } = options;
  const entitlementId = crypto.randomUUID();
  await h.db
    .prepare(
      "INSERT INTO hosted_entitlements(entitlement_id,organization_id,version,hosted_control_plane,remote_worker_enrollment,hosted_task_execution,max_concurrent_workers,max_active_tasks,max_task_runtime,maximum_resource_reservations,valid_from,valid_until,revoked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      entitlementId,
      s.tenant,
      version,
      1,
      1,
      1,
      maxWorkers,
      maxTasks,
      60000,
      maxReservations,
      validFrom,
      validUntil,
      revokedAt,
      now,
    )
    .run();
  return entitlementId;
}

function tasksUrl(s: Setup) {
  return `/v1/tenants/${s.tenant}/tasks`;
}

function submitBody(workerId: string) {
  return {
    request_id: crypto.randomUUID(),
    worker_id: workerId,
    execution_class: "controlled",
    runtime_ms: 10000,
    controlled_duration_ms: 100,
  };
}

function keyHeaders(k = crypto.randomUUID()) {
  return { "idempotency-key": k };
}

async function count(h: HostedHarness, table: string): Promise<number> {
  // Real count query against the migrated test DB. A missing table is a
  // failure, never a zero: nothing here may swallow SQL errors.
  const row = (await h.db
    .prepare(`SELECT count(*) n FROM ${table}`)
    .first()) as unknown as { n: number };
  return row.n;
}

async function admission(
  h: HostedHarness,
  s: Setup,
  headers: Record<string, string>,
  body: unknown,
) {
  return h.request(tasksUrl(s), headers, "POST", body);
}

test("valid policy and registered worker admit exactly one task with reservation and outbox", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s, { maxTasks: 10 });
    const response = await admission(
      h,
      s,
      { ...s.account.headers, ...keyHeaders() },
      submitBody(s.workerId),
    );
    // DESIRED: 202 AdmissionReply. TODAY: 404 (unwired) => RED failure.
    assert.equal(response.status, 202);
    const reply = admissionReplySchema.parse(
      (await response.json()) as AdmissionReply,
    );
    assert.equal(reply.task.tenant_id, s.tenant);
    assert.equal(reply.task.worker_id, s.workerId);
    assert.equal(reply.task.state, "queued");
    assert.equal(reply.reservation_id, reply.task.reservation_id);
    assert.equal(await count(h, "hosted_tasks"), 1);
    const reservation = (await h.db
      .prepare("SELECT state,task_id FROM hosted_reservations")
      .first()) as unknown as { state: string; task_id: string };
    assert.equal(reservation.state, "active");
    assert.equal(reservation.task_id, reply.task.task_id);
    const outbox = (await h.db
      .prepare("SELECT state,task_id FROM hosted_outbox")
      .first()) as unknown as { state: string; task_id: string };
    assert.equal(outbox.state, "queued");
    assert.equal(outbox.task_id, reply.task.task_id);
  } finally {
    await h.mf.dispose();
  }
});

test("same idempotency key replays the same task; changed body conflicts without new rows", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s, { maxTasks: 10 });
    const key = crypto.randomUUID();
    const body = submitBody(s.workerId);
    const headers = () => ({ ...s.account.headers, ...keyHeaders(key) });
    const first = await admission(h, s, headers(), body);
    assert.equal(first.status, 202);
    const firstReply = admissionReplySchema.parse(await first.json());
    const replay = await admission(h, s, headers(), body);
    // DESIRED: identical 202 with the same task. TODAY: 404 => RED failure.
    assert.equal(replay.status, 202);
    const replayReply = admissionReplySchema.parse(await replay.json());
    assert.deepEqual(replayReply, firstReply);
    assert.equal(await count(h, "hosted_tasks"), 1);
    assert.equal(await count(h, "hosted_reservations"), 1);
    assert.equal(await count(h, "hosted_outbox"), 1);
    // DESIRED: same key with a different fingerprint conflicts and allocates
    // nothing. TODAY: 404 => RED failure.
    const conflict = await admission(h, s, headers(), submitBody(s.workerId));
    assert.equal(conflict.status, 409);
    assert.equal(await count(h, "hosted_tasks"), 1);
    assert.equal(await count(h, "hosted_reservations"), 1);
    assert.equal(await count(h, "hosted_outbox"), 1);
  } finally {
    await h.mf.dispose();
  }
});

test("one worker admits exactly one of six concurrent submissions; losers get quota 409", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s, { maxTasks: 10 });
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        admission(
          h,
          s,
          { ...s.account.headers, ...keyHeaders() },
          submitBody(s.workerId),
        ),
      ),
    );
    // DESIRED: worker exclusivity admits EXACTLY one; the other five deny
    // with real quota 409 and leave no partial writes. TODAY: six 404s.
    const winners = attempts.filter((r) => r.status === 202);
    const denied = attempts.filter((r) => r.status === 409);
    assert.equal(winners.length, 1);
    assert.equal(denied.length, 5);
    for (const w of winners) admissionReplySchema.parse(await w.json());
    assert.equal(await count(h, "hosted_tasks"), 1);
    assert.equal(await count(h, "hosted_reservations"), 1);
    assert.equal(await count(h, "hosted_outbox"), 1);
  } finally {
    await h.mf.dispose();
  }
});

test("three workers against a two-task ceiling admit exactly two; losers get quota 409", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s, { maxWorkers: 3, maxTasks: 2 });
    const workers = [
      s.workerId,
      await extraWorker(h, s),
      await extraWorker(h, s),
    ];
    const attempts = await Promise.all(
      workers.flatMap((workerId) =>
        Array.from({ length: 2 }, () =>
          admission(
            h,
            s,
            { ...s.account.headers, ...keyHeaders() },
            submitBody(workerId),
          ),
        ),
      ),
    );
    // DESIRED: task-quota ceiling admits EXACTLY two across workers; the
    // other four deny with real quota 409. TODAY: six 404s.
    const winners = attempts.filter((r) => r.status === 202);
    const denied = attempts.filter((r) => r.status === 409);
    assert.equal(winners.length, 2);
    assert.equal(denied.length, 4);
    const taskIds = new Set<string>();
    for (const w of winners) {
      const reply = admissionReplySchema.parse(await w.json());
      taskIds.add(reply.task.task_id);
    }
    assert.equal(taskIds.size, 2);
    assert.equal(await count(h, "hosted_tasks"), 2);
    assert.equal(await count(h, "hosted_reservations"), 2);
    assert.equal(await count(h, "hosted_outbox"), 2);
  } finally {
    await h.mf.dispose();
  }
});

test("absent, expired and revoked capability each deny admission with 403", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    const now = Date.now();
    async function attempt() {
      const response = await admission(
        h,
        s,
        { ...s.account.headers, ...keyHeaders() },
        submitBody(s.workerId),
      );
      return {
        status: response.status,
        body: (await response.json()) as {
          error?: { code?: unknown; message?: unknown };
        },
      };
    }
    // No policy seeded: DESIRED 403 denial. TODAY: 404.
    {
      const { status, body } = await attempt();
      assert.equal(status, 403);
      assert.equal(typeof body.error?.code, "string");
    }
    // Expired policy window: DESIRED 403. TODAY: 404.
    await seedPolicy(h, s, {
      version: 1,
      validFrom: now - 3600000,
      validUntil: now - 1000,
    });
    {
      const { status, body } = await attempt();
      assert.equal(status, 403);
      assert.equal(typeof body.error?.code, "string");
    }
    // Revoked policy: DESIRED 403. TODAY: 404.
    await seedPolicy(h, s, { version: 2, revokedAt: now - 500 });
    {
      const { status, body } = await attempt();
      assert.equal(status, 403);
      assert.equal(typeof body.error?.code, "string");
    }
    assert.equal(await count(h, "hosted_tasks"), 0);
  } finally {
    await h.mf.dispose();
  }
});

test("malformed execution bodies are rejected with 400 and admit nothing", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s, { maxTasks: 10 });
    const base = submitBody(s.workerId);
    const hostile = [
      { ...base, execution_class: "shell" },
      { ...base, controlled_duration_ms: base.runtime_ms + 1 },
      { ...base, runtime_ms: 3600001 },
      { ...base, extra: 1 },
      { ...base, worker_id: "not-a-uuid" },
    ];
    for (const body of hostile) {
      const response = await admission(
        h,
        s,
        { ...s.account.headers, ...keyHeaders() },
        body,
      );
      // DESIRED: strict 400 for every malformed body. TODAY: 404.
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(await count(h, "hosted_tasks"), 0);
  } finally {
    await h.mf.dispose();
  }
});

test("wrong audience or missing auth on admission is rejected with 401", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s, { maxTasks: 10 });
    const device = await h.linked(s.account);
    const cases: { name: string; headers: Record<string, string> }[] = [
      { name: "no-auth", headers: { ...keyHeaders() } },
      {
        name: "worker-credential",
        headers: {
          authorization: `Bearer ${((await (await h.register(await h.enroll(s.account))).json()) as { credential: string }).credential}`,
          ...keyHeaders(),
        },
      },
      {
        name: "cli-device-credential",
        headers: {
          authorization: `Bearer ${device.credential}`,
          ...keyHeaders(),
        },
      },
    ];
    for (const c of cases) {
      const response = await admission(h, s, c.headers, submitBody(s.workerId));
      // DESIRED: 401 — worker and CLI device credentials are insufficient
      // for execution admission. TODAY: 404.
      assert.equal(response.status, 401, c.name);
    }
    assert.equal(await count(h, "hosted_tasks"), 0);
  } finally {
    await h.mf.dispose();
  }
});

test("cross-org submission is contained with 404 and leaves no rows", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    const other = await h.login(200);
    await seedPolicy(h, s, { maxTasks: 10 });
    // DESIRED: a foreign session against this tenant's tasks path is
    // contained as 404 (existing membership convention) with zero rows.
    // This invariant must hold both before and after the backend wires.
    const cross = await admission(
      h,
      s,
      { ...other.headers, ...keyHeaders() },
      submitBody(s.workerId),
    );
    assert.equal(cross.status, 404);
    assert.equal(await count(h, "hosted_tasks"), 0);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor claim, renew and settle require a supervisor credential with 401", async () => {
  const h = await hostedFixture();
  try {
    const s = await setup(h);
    await seedPolicy(h, s, { maxTasks: 10 });
    const taskId = "11111111-1111-4111-8111-111111111111";
    const claim = await h.request(
      CLAIM,
      { ...s.account.headers, ...keyHeaders() },
      "POST",
      {},
    );
    // DESIRED: browser sessions cannot claim; supervisor auth required.
    // TODAY: 404 (unwired).
    assert.equal(claim.status, 401);
    const device = await h.linked(s.account);
    const cliClaim = await h.request(
      CLAIM,
      { authorization: `Bearer ${device.credential}`, ...keyHeaders() },
      "POST",
      {},
    );
    // DESIRED: CLI device credentials cannot claim either. TODAY: 404.
    assert.equal(cliClaim.status, 401);
    for (const path of [
      `/v1/supervisor/tasks/${taskId}/renew`,
      `/v1/supervisor/tasks/${taskId}/settle`,
    ]) {
      const response = await h.request(
        path,
        { ...s.account.headers, ...keyHeaders() },
        "POST",
        path.endsWith("renew")
          ? { lease_id: crypto.randomUUID(), fence: 0 }
          : {
              lease_id: crypto.randomUUID(),
              fence: 0,
              outcome: "completed",
              stop_confirmed: true,
              consumed_runtime_ms: 10,
            },
      );
      // DESIRED: 401 without a supervisor credential. TODAY: 404.
      assert.equal(response.status, 401, path);
    }
  } finally {
    await h.mf.dispose();
  }
});

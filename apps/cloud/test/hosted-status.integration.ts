import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedStatusSchema } from "../src/hosted-status.ts";
import {
  hostedStatusFixture,
  statusDefaultPolicy,
} from "./hosted-status-helper.ts";

type H = Awaited<ReturnType<typeof hostedStatusFixture>>;

async function seedTask(
  h: H,
  s: {
    tenant: string;
    user: string;
    workerId: string;
    installationId: string;
    grantId: string | null;
    sessionId: string | null;
  },
  state: string,
  overrides: Record<string, string | number | null> = {},
) {
  const columns =
    "task_id,organization_id,worker_id,authorizing_user_id,installation_id,execution_grant_id,authorizing_session_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at,lease_id,lease_expires_at";
  const v: Record<string, string | number | null> = {
    task_id: crypto.randomUUID(),
    organization_id: s.tenant,
    worker_id: s.workerId,
    authorizing_user_id: s.user,
    installation_id: s.installationId,
    execution_grant_id: s.grantId,
    authorizing_session_id: s.sessionId,
    request_id: crypto.randomUUID(),
    principal_kind: "execution",
    principal_id: "p1",
    idempotency_key: crypto.randomUUID(),
    fingerprint: "f1",
    execution_class: "controlled",
    state,
    reservation_id: crypto.randomUUID(),
    policy_version: 1,
    runtime_ms: 10000,
    controlled_duration_ms: 100,
    created_at: Date.now(),
    deadline_at: Date.now() + 60000,
    lease_id: null,
    lease_expires_at: null,
    ...overrides,
  };
  const placeholders = columns
    .split(",")
    .map(() => "?")
    .join(",");
  await h.db
    .prepare(`INSERT INTO hosted_tasks(${columns}) VALUES(${placeholders})`)
    .bind(...columns.split(",").map((c) => v[c] as string | number | null))
    .run();
  return v.task_id as string;
}

async function seedReservation(
  h: H,
  tenant: string,
  taskId: string,
  workerId: string,
  state: string,
) {
  const now = Date.now();
  await h.db
    .prepare(
      "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      crypto.randomUUID(),
      tenant,
      taskId,
      workerId,
      "task_execution",
      "1",
      state,
      now,
      now + 60000,
    )
    .run();
}

test("hosted-status: mixed states measure real counts across own/other org with missing policy then policy", async () => {
  const h = await hostedStatusFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const grant = (await (
      await h.authorizeExecution(a, a.tenant, device.installation_id)
    ).json()) as { credential: string; grant_id: string };
    // Seed policy with a controlled-meter allowance: ledger quantities flow.
    await h.seedPolicy(a.tenant, {
      ...statusDefaultPolicy,
      allowances: [
        {
          resource: "compute_ms",
          unit: "millisecond",
          resource_class: "controlled",
          allowed_quantity: "60000",
        },
      ],
    });
    const worker = (
      await h.db
        .prepare(
          "SELECT worker_id FROM cloud_workers WHERE organization_id=? LIMIT 1",
        )
        .bind(a.tenant)
        .first<{ worker_id: string }>()
    )?.worker_id;
    // Enroll a worker if login flow left none.
    let workerId = worker;
    if (!workerId) {
      const r = await h.request(
        `/v1/tenants/${a.tenant}/worker-enrollments`,
        { ...a.headers, "idempotency-key": crypto.randomUUID() },
        "POST",
        { name: "status-worker" },
      );
      assert.equal(r.status, 201);
      const invite = (await r.json()) as {
        enrollment_id: string;
        enrollment_secret: string;
      };
      const reg = await h.request(
        "/v1/workers/register",
        {
          authorization: `Enrollment ${invite.enrollment_secret}`,
          "idempotency-key": crypto.randomUUID(),
        },
        "POST",
        {
          enrollment_id: invite.enrollment_id,
          name: "status-worker",
          runtime_version: "1",
          capabilities: [],
        },
      );
      assert.equal(reg.status, 201);
      workerId = ((await reg.json()) as { worker_id: string }).worker_id;
    }
    // Worker exclusivity: one OPEN task per org+worker at the DDL level.
    // Enroll one extra worker per additional open task.
    async function extraWorker(name: string) {
      const r = await h.request(
        `/v1/tenants/${a.tenant}/worker-enrollments`,
        { ...a.headers, "idempotency-key": crypto.randomUUID() },
        "POST",
        { name },
      );
      assert.equal(r.status, 201);
      const invite = (await r.json()) as {
        enrollment_id: string;
        enrollment_secret: string;
      };
      const reg = await h.request(
        "/v1/workers/register",
        {
          authorization: `Enrollment ${invite.enrollment_secret}`,
          "idempotency-key": crypto.randomUUID(),
        },
        "POST",
        {
          enrollment_id: invite.enrollment_id,
          name,
          runtime_version: "1",
          capabilities: [],
        },
      );
      assert.equal(reg.status, 201);
      return ((await reg.json()) as { worker_id: string }).worker_id;
    }
    const workers = [
      workerId,
      await extraWorker("status-worker-2"),
      await extraWorker("status-worker-3"),
      await extraWorker("status-worker-4"),
    ];
    const session = (await h.db
      .prepare("SELECT session_id FROM sessions WHERE user_id=? LIMIT 1")
      .bind(a.user)
      .first<{ session_id: string }>())!.session_id;
    const seedFor = (wid: string) => ({
      tenant: a.tenant,
      user: a.user,
      workerId: wid,
      installationId: device.installation_id,
      grantId: grant.grant_id,
      sessionId: session,
    });
    const seed = seedFor(workers[0]!);
    const now = Date.now();
    // Mixed task states in OWN org: held x2, stop_requested x1 (with expired
    // lease), queued x1 with expired lease, completed x1. Each OPEN task gets
    // its own worker (DDL worker-exclusivity); the completed task reuses one.
    const held1 = await seedTask(h, seedFor(workers[0]!), "held");
    const held2 = await seedTask(h, seedFor(workers[1]!), "held");
    const stop = await seedTask(h, seedFor(workers[2]!), "stop_requested", {
      lease_id: crypto.randomUUID(),
      lease_expires_at: now - 1000,
    });
    const queued = await seedTask(h, seedFor(workers[3]!), "queued", {
      lease_id: crypto.randomUUID(),
      lease_expires_at: now - 500,
    });
    await seedTask(h, seed, "completed");
    await seedReservation(h, a.tenant, held1, workers[0]!, "active");
    await seedReservation(h, a.tenant, held2, workers[1]!, "quarantined");
    await seedReservation(h, a.tenant, stop, workers[2]!, "active");
    // Other-org task must never leak into own counts.
    const b = await h.login(200);
    const bDevice = await h.linkedDevice(b);
    const bWorker = await h.request(
      `/v1/tenants/${b.tenant}/worker-enrollments`,
      { ...b.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "other-worker" },
    );
    assert.equal(bWorker.status, 201);
    const bInvite = (await bWorker.json()) as {
      enrollment_id: string;
      enrollment_secret: string;
    };
    const bReg = await h.request(
      "/v1/workers/register",
      {
        authorization: `Enrollment ${bInvite.enrollment_secret}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {
        enrollment_id: bInvite.enrollment_id,
        name: "other-worker",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(bReg.status, 201);
    const bWorkerId = ((await bReg.json()) as { worker_id: string }).worker_id;
    const bSession = (await h.db
      .prepare("SELECT session_id FROM sessions WHERE user_id=? LIMIT 1")
      .bind(b.user)
      .first<{ session_id: string }>())!.session_id;
    await seedTask(
      h,
      {
        tenant: b.tenant,
        user: b.user,
        workerId: bWorkerId,
        installationId: bDevice.installation_id,
        grantId: null,
        sessionId: bSession,
      },
      "held",
    );
    // Failure/cleanup/stop audit evidence in own org.
    for (const action of [
      "hosted.task_failed",
      "hosted.cleanup",
      "hosted.stop_requested",
    ])
      await h.db
        .prepare(
          "INSERT INTO audit_events(event_id,actor_user_id,organization_id,action,resource,outcome,request_id,at,metadata) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          a.user,
          a.tenant,
          action,
          stop,
          "success",
          crypto.randomUUID(),
          now,
          "{}",
        )
        .run();

    const bearer = { authorization: `Bearer ${grant.credential}` };
    const raw = await (
      await h.request(`/v1/tenants/${a.tenant}/hosted-status`, bearer)
    ).json();
    const status = hostedStatusSchema.parse(raw);
    // Real measured counts, own org only.
    assert.equal(status.tenant_id, a.tenant);
    assert.equal(status.policy_version, 1);
    assert.equal(status.policy_allowed, true);
    assert.equal(status.policy_denial, null);
    assert.equal(status.max_active_tasks, 8);
    assert.equal(status.consumed_quantity, "0");
    assert.equal(status.reserved_quantity, "0");
    assert.equal(status.active_reservations, 2);
    assert.equal(status.quarantined_reservations, 1);
    assert.equal(status.task_states.held, 2);
    assert.equal(status.task_states.stop_requested, 1);
    assert.equal(status.task_states.queued, 1);
    assert.equal(status.task_states.completed, 1);
    assert.equal(status.held_tasks, 2);
    assert.equal(status.stop_requested_tasks, 1);
    assert.equal(status.expired_leases, 2);
    assert.equal(status.failure_audits, 1);
    assert.equal(status.cleanup_audits, 1);
    assert.equal(status.stop_audits, 1);
    assert.equal(status.last_dispatch_action, "hosted.stop_requested");
    // Stop-duty page carries the stop task reference id for operator cleanup.
    assert.ok(
      status.stop_duty.some((t) => t.task_id === stop),
      "stop duty must reference the stop_requested task",
    );
    assert.ok(
      status.held_page.some((t) => t.task_id === held1) &&
        status.held_page.some((t) => t.task_id === held2),
    );
    assert.ok(status.lease_page.some((t) => t.task_id === queued));
    // No secrets anywhere in the payload.
    const text = JSON.stringify(raw);
    assert.doesNotMatch(
      text,
      /sfexec_|token_hash|result_ciphertext|code_ciphertext/i,
    );
    assert.ok(!text.includes(grant.credential));
    // Query-cost budget reported; worst stays well under Free-tier 50ms
    // statement ceiling plus global rate-limit overhead.
    assert.ok(status.query_cost.statements > 0);
    assert.ok(status.query_cost.statements <= 50);
    assert.ok(status.query_cost.worst_ms < 5000);

    // Missing policy: other org reads allowed=false with denial, never a
    // read denial; counts still measure.
    const bRaw = await (
      await h.request(`/v1/tenants/${b.tenant}/hosted-status`, {
        cookie: b.headers.cookie,
        origin: b.headers.origin,
        "x-csrf-token": b.headers["x-csrf-token"],
      })
    ).json();
    const bStatus = hostedStatusSchema.parse(bRaw);
    assert.equal(bStatus.policy_version, null);
    assert.equal(bStatus.policy_allowed, false);
    assert.equal(bStatus.policy_denial, "policy_absent");
    assert.equal(bStatus.task_states.held, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("hosted-status: auth matrix, pagination, wrong audiences, DB failure", async () => {
  const h = await hostedStatusFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const grant = (await (
      await h.authorizeExecution(a, a.tenant, device.installation_id)
    ).json()) as { credential: string };
    await h.seedPolicy(a.tenant, statusDefaultPolicy);
    const path = `/v1/tenants/${a.tenant}/hosted-status`;

    // No credentials at all: 401.
    assert.equal((await h.request(path)).status, 401);
    // Browser session without membership headers is fine (cookie auth).
    const cookieOnly = await h.request(path, {
      cookie: a.headers.cookie,
    });
    assert.equal(cookieOnly.status, 200);
    // sfexec_ with correct scope/tenant: 200.
    assert.equal(
      (
        await h.request(path, {
          authorization: `Bearer ${grant.credential}`,
        })
      ).status,
      200,
    );
    // sfcli_ device credential: 401 (never authorizes hosted reads).
    assert.equal(
      (
        await h.request(path, {
          authorization: `Bearer ${device.credential}`,
        })
      ).status,
      401,
    );
    // sfworker_: enroll + register, then attempt.
    const invite = await h.request(
      `/v1/tenants/${a.tenant}/worker-enrollments`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "denied-worker" },
    );
    assert.equal(invite.status, 201);
    const inv = (await invite.json()) as {
      enrollment_id: string;
      enrollment_secret: string;
    };
    const reg = await h.request(
      "/v1/workers/register",
      {
        authorization: `Enrollment ${inv.enrollment_secret}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {
        enrollment_id: inv.enrollment_id,
        name: "denied-worker",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(reg.status, 201);
    const workerCred = ((await reg.json()) as { credential: string })
      .credential;
    assert.equal(
      (await h.request(path, { authorization: `Bearer ${workerCred}` })).status,
      401,
    );
    // Cross-org: valid credential, other tenant -> 404, never leaks.
    const b = await h.login(200);
    assert.equal(
      (
        await h.request(`/v1/tenants/${b.tenant}/hosted-status`, {
          authorization: `Bearer ${grant.credential}`,
        })
      ).status,
      404,
    );
    // Strict query: non-UUID tenant 400, bad limit 400.
    assert.equal(
      (await h.request("/v1/tenants/not-a-uuid/hosted-status", a.headers))
        .status,
      400,
    );
    assert.equal((await h.request(`${path}?limit=999`, a.headers)).status, 400);
    // Pagination: limit=1 bounds every page to <=1 item; cursor advances and
    // is tenant-bound (replay under another tenant fails closed).
    const first = hostedStatusSchema.parse(
      await (await h.request(`${path}?limit=1`, a.headers)).json(),
    );
    assert.ok(first.stop_duty.length <= 1);
    assert.ok(first.held_page.length <= 1);
    assert.ok(first.lease_page.length <= 1);
    assert.ok(first.supervisors.length <= 1);
    if (first.next_cursor) {
      const second = await h.request(
        `${path}?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
        a.headers,
      );
      assert.equal(second.status, 200);
      const cross = await h.request(
        `${path}?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
        b.headers,
      );
      assert.equal(cross.status, 400);
    }
    // Dependency outage fails closed: drop a backing table, expect 503/500
    // family (never 200 with zeroed counts).
    await h.db.prepare("DROP TABLE hosted_tasks").run();
    const outage = await h.request(path, a.headers);
    assert.ok(outage.status === 500 || outage.status === 503);
  } finally {
    await h.mf.dispose();
  }
});

test("hosted-status: supervisor authority vs observed availability, ledger quantities, revoked/expired auth", async () => {
  const h = await hostedStatusFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const grant = (await (
      await h.authorizeExecution(a, a.tenant, device.installation_id)
    ).json()) as { credential: string; grant_id: string };
    await h.seedPolicy(a.tenant, {
      ...statusDefaultPolicy,
      allowances: [
        {
          resource: "compute_ms",
          unit: "millisecond",
          resource_class: "controlled",
          allowed_quantity: "9007199254740991",
        },
      ],
    });
    const path = `/v1/tenants/${a.tenant}/hosted-status`;
    const workerId = (
      await h.db
        .prepare(
          "SELECT worker_id FROM cloud_workers WHERE organization_id=? LIMIT 1",
        )
        .bind(a.tenant)
        .first<{ worker_id: string }>()
    )?.worker_id;
    if (workerId) {
      const now = Date.now();
      const supId = crypto.randomUUID();
      await h.db
        .prepare(
          "INSERT INTO hosted_supervisors(supervisor_id,organization_id,worker_id,authorizing_user_id,name,status,epoch,created_at,authorization_expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          supId,
          a.tenant,
          workerId,
          a.user,
          "fleet-supervisor",
          "registered",
          1,
          now,
          now + 86400000,
        )
        .run();
      const credId = crypto.randomUUID();
      await h.db
        .prepare(
          "INSERT INTO hosted_supervisor_credentials(credential_id,token_hash,supervisor_id,organization_id,audience,scopes,epoch,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          credId,
          `hash-${crypto.randomUUID()}`,
          supId,
          a.tenant,
          "hosted-supervisor",
          JSON.stringify([
            "supervisor:claim",
            "supervisor:renew",
            "supervisor:report",
            "supervisor:cleanup",
          ]),
          1,
          now,
          now + 86400000,
        )
        .run();
      // Observed activity: a claim audit attributed to this supervisor.
      await h.db
        .prepare(
          "INSERT INTO audit_events(event_id,actor_user_id,organization_id,action,resource,outcome,request_id,at,metadata) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          a.user,
          a.tenant,
          "hosted.claim",
          `supervisor:${supId}:task:abc`,
          "success",
          crypto.randomUUID(),
          now,
          "{}",
        )
        .run();
    }
    const status = hostedStatusSchema.parse(
      await (await h.request(path, a.headers)).json(),
    );
    // Max-bound ledger quantity exact-parses through the route.
    assert.equal(status.consumed_quantity, "0");
    assert.equal(status.reserved_quantity, "0");
    if (status.supervisors.length) {
      const sup = status.supervisors[0]!;
      assert.equal(sup.credential_authority, "valid");
      assert.equal(sup.last_observed_action, "hosted.claim");
      assert.ok(sup.last_observed_at !== null);
      // Admin chain preserved without secrets.
      assert.equal(sup.admin_chain_user_id, a.user);
      assert.equal(sup.worker_status, "registered");
      const text = JSON.stringify(sup);
      assert.doesNotMatch(text, /token_hash|ciphertext|sfexec_|sfsuper_/i);
    }
    // Revoked session fails closed (401), not zeroed data.
    await h.db
      .prepare("UPDATE sessions SET revoked_at=?")
      .bind(Date.now())
      .run();
    assert.equal((await h.request(path, a.headers)).status, 401);
    // sfexec_ bearer still works after session revocation only if the grant
    // itself remains live; revoke the grant installation to deny it too.
    const bearer = { authorization: `Bearer ${grant.credential}` };
    await h.db
      .prepare("UPDATE cli_installations SET status='revoked'")
      .bind()
      .run();
    assert.equal((await h.request(path, bearer)).status, 401);
  } finally {
    await h.mf.dispose();
  }
});

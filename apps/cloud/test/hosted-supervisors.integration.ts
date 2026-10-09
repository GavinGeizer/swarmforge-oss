import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type HostedSupervisorPrincipal,
  supervisorAuth,
  supervisorGuard,
} from "../src/hosted-supervisors.ts";
import {
  registerSupervisor,
  type SupervisorCredential,
  supervisorBearer,
  supervisorFixture,
} from "./hosted-supervisor-helpers.ts";

async function setup() {
  const h = await supervisorFixture();
  const browser = await h.seedBrowser(100, "owner");
  const workerId = await h.seedWorker(
    browser.tenant,
    browser.user,
    browser.session,
  );
  return { h, browser, workerId };
}

async function registered() {
  const s = await setup();
  const response = await registerSupervisor(s.h, s.browser, s.workerId);
  assert.equal(response.status, 201);
  const credential = (await response.json()) as SupervisorCredential;
  assert.ok(credential.credential.startsWith("sfsuper_"));
  assert.deepEqual(credential.scopes, [
    "supervisor:claim",
    "supervisor:renew",
    "supervisor:report",
    "supervisor:cleanup",
  ]);
  return { ...s, credential };
}

test("supervisor identity: register then read identity", async () => {
  const { h, credential } = await registered();
  try {
    const me = await h.request(
      "/v1/supervisor/me",
      supervisorBearer(credential),
    );
    assert.equal(me.status, 200);
    const identity = (await me.json()) as Record<string, unknown>;
    assert.equal(identity.supervisor_id, credential.supervisor_id);
    assert.equal(identity.tenant_id, credential.tenant_id);
    assert.equal(identity.worker_id, credential.worker_id);
    assert.equal(identity.subject_id, credential.subject_id);
    assert.deepEqual(identity.scopes, credential.scopes);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: registration grants no capabilities or tasks", async () => {
  const { h, browser, credential } = await registered();
  try {
    const tasks = await h.db
      .prepare("SELECT task_id FROM hosted_tasks WHERE organization_id=?")
      .bind(browser.tenant)
      .all();
    assert.equal(tasks.results.length, 0);
    const caps = await h.db
      .prepare("SELECT * FROM hosted_entitlements WHERE organization_id=?")
      .bind(browser.tenant)
      .all();
    assert.equal(caps.results.length, 0);
    assert.equal(credential.scopes.includes("tasks:create"), false);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: cross-tenant registration is not found", async () => {
  const { h, workerId } = await registered();
  try {
    const other = await h.seedBrowser(200, "owner");
    const response = await registerSupervisor(h, other, workerId);
    assert.equal(response.status, 404);
    const leaked = await h.db
      .prepare(
        "SELECT supervisor_id FROM hosted_supervisors WHERE organization_id=?",
      )
      .bind(other.tenant)
      .all();
    assert.equal(leaked.results.length, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: wrong audience credentials rejected", async () => {
  const { h, browser } = await setup();
  try {
    for (const bad of [
      "Bearer sfcli_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Bearer sfworker_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Bearer sfexec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Bearer sfenroll_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Bearer sfsuper_short",
      "Bearer nothing-here",
    ]) {
      const me = await h.request("/v1/supervisor/me", { authorization: bad });
      assert.equal(me.status, 401, bad);
      const code = ((await me.json()) as { error: { code: string } }).error
        .code;
      assert.equal(code, "unauthenticated");
    }
    // Cookie-only request (no bearer) is rejected, never falls through.
    const cookieOnly = await h.request("/v1/supervisor/me", {
      cookie: browser.headers.cookie,
    });
    assert.equal(cookieOnly.status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: malformed scopes rejected by strict auth", async () => {
  const { h, credential } = await registered();
  try {
    // Tamper the stored scope list: anything but the exact tuple fails.
    await h.db
      .prepare(
        "UPDATE hosted_supervisor_credentials SET scopes=? WHERE credential_id=?",
      )
      .bind('["supervisor:claim"]', credential.credential_id)
      .run();
    const me = await h.request(
      "/v1/supervisor/me",
      supervisorBearer(credential),
    );
    assert.equal(me.status, 401);
    await h.db
      .prepare(
        "UPDATE hosted_supervisor_credentials SET scopes=? WHERE credential_id=?",
      )
      .bind('["supervisor:claim","supervisor:renew"]', credential.credential_id)
      .run();
    const me2 = await h.request(
      "/v1/supervisor/me",
      supervisorBearer(credential),
    );
    assert.equal(me2.status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: non-admin browser cannot register or revoke", async () => {
  const { h, browser, workerId, credential } = await registered();
  try {
    const member = await h.seedBrowser(300, "member");
    // Member has no tenant overlap at all: membership() maps to 404.
    const reg = await registerSupervisor(
      h,
      { ...member, tenant: browser.tenant } as typeof browser,
      workerId,
    );
    assert.ok([403, 404].includes(reg.status), String(reg.status));
    // A member OF the tenant gets 403 forbidden.
    const now = Date.now();
    await h.db
      .prepare(
        "INSERT INTO users(user_id,display_name,status,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .bind("member-user", "member", "active", now, now)
      .run();
    await h.db
      .prepare(
        "INSERT INTO memberships(organization_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(browser.tenant, "member-user", "member", "active", now, now)
      .run();
    const memberRaw = "m".repeat(43);
    const { hash } = await import("../src/crypto.ts");
    await h.db
      .prepare(
        "INSERT INTO sessions(session_id,user_id,token_hash,created_at,expires_at,revoked_at,revocation_id) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        "member-session",
        "member-user",
        await hash(memberRaw),
        now,
        now + 43200000,
        null,
        null,
      )
      .run();
    const { sign } = await import("../src/crypto.ts");
    const memberHeaders = {
      cookie: `__Host-swarmforge=${memberRaw}`,
      origin: "https://api.example.invalid",
      "x-csrf-token": await sign(
        "test-auth-secret-with-at-least-thirty-two-characters",
        `csrf:${memberRaw}`,
      ),
    };
    const reg2 = await h.request(
      `/v1/tenants/${browser.tenant}/supervisors`,
      { ...memberHeaders, "idempotency-key": crypto.randomUUID() },
      "POST",
      { worker_id: workerId, name: "member-attempt" },
    );
    assert.equal(reg2.status, 403);
    const del = await h.request(
      `/v1/tenants/${browser.tenant}/supervisors/${credential.supervisor_id}`,
      { ...memberHeaders, "idempotency-key": crypto.randomUUID() },
      "DELETE",
    );
    assert.equal(del.status, 403);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: revoked credential and old replay after revoke rejected", async () => {
  const { h, browser, credential } = await registered();
  try {
    const rawCredential = credential.credential;
    const del = await h.request(
      `/v1/tenants/${browser.tenant}/supervisors/${credential.supervisor_id}`,
      { ...browser.headers, "idempotency-key": crypto.randomUUID() },
      "DELETE",
    );
    assert.equal(del.status, 200);
    // Old key never regains general authority.
    const me = await h.request("/v1/supervisor/me", {
      authorization: `Bearer ${rawCredential}`,
    });
    assert.equal(me.status, 401);
    const rotate = await h.request(
      "/v1/supervisor/me/rotate",
      {
        authorization: `Bearer ${rawCredential}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(rotate.status, 401);
    // Supervisor-scoped guard now fails too.
    const principal: HostedSupervisorPrincipal = {
      credential_id: credential.credential_id,
      supervisor_id: credential.supervisor_id,
      organization_id: credential.tenant_id,
      worker_id: credential.worker_id,
      authorizing_user_id: credential.subject_id,
      epoch: 1,
      scopes: [...credential.scopes],
      expires_at: credential.expires_at,
      authorization_expires_at: credential.authorization_expires_at,
    };
    const guard = supervisorGuard(principal, Date.now(), "execution");
    const check = await h.db
      .prepare(`SELECT (${guard.sql}) ok`)
      .bind(...guard.args)
      .first<{ ok: number }>();
    assert.equal(check!.ok, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: expired credential rejected", async () => {
  const { h, credential } = await registered();
  try {
    await h.db
      .prepare(
        "UPDATE hosted_supervisor_credentials SET created_at=?,expires_at=? WHERE credential_id=?",
      )
      .bind(Date.now() - 2000, Date.now() - 1000, credential.credential_id)
      .run();
    const me = await h.request(
      "/v1/supervisor/me",
      supervisorBearer(credential),
    );
    assert.equal(me.status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: worker revoked blocks execution but permits cleanup", async () => {
  const { h, credential } = await registered();
  try {
    await h.db
      .prepare(
        "UPDATE cloud_workers SET status='revoked',revoked_at=? WHERE worker_id=?",
      )
      .bind(Date.now(), credential.worker_id)
      .run();
    const target = "https://api.example.invalid/v1/supervisor/me";
    const authed = async (mode: "execution" | "cleanup") =>
      supervisorAuth(
        {
          request: new Request(target, {
            headers: { authorization: `Bearer ${credential.credential}` },
          }),
          env: { DB: h.db } as never,
          request_id: crypto.randomUUID(),
          route: "supervisor-test",
          actor: null,
        },
        mode,
      );
    await assert.rejects(
      () => authed("execution"),
      /valid supervisor credential/,
    );
    const cleanup = await authed("cleanup");
    assert.equal(cleanup.supervisor_id, credential.supervisor_id);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: rotation issues successor and invalidates old key", async () => {
  const { h, credential } = await registered();
  try {
    const first = await h.request(
      "/v1/supervisor/me/rotate",
      {
        ...supervisorBearer(credential),
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(first.status, 200);
    const next = (await first.json()) as SupervisorCredential;
    assert.notEqual(next.credential, credential.credential);
    assert.equal(next.supervisor_id, credential.supervisor_id);
    const oldMe = await h.request(
      "/v1/supervisor/me",
      supervisorBearer(credential),
    );
    assert.equal(oldMe.status, 401);
    const newMe = await h.request("/v1/supervisor/me", supervisorBearer(next));
    assert.equal(newMe.status, 200);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: rotation exact-key replay recovers successor only while valid", async () => {
  const { h, credential } = await registered();
  try {
    const replayKey = crypto.randomUUID();
    const first = await h.request(
      "/v1/supervisor/me/rotate",
      { ...supervisorBearer(credential), "idempotency-key": replayKey },
      "POST",
      {},
    );
    assert.equal(first.status, 200);
    const next = (await first.json()) as SupervisorCredential;
    // Exact same-key retry with the OLD key returns the sealed successor.
    const retry = await h.request(
      "/v1/supervisor/me/rotate",
      { ...supervisorBearer(credential), "idempotency-key": replayKey },
      "POST",
      {},
    );
    assert.equal(retry.status, 200);
    assert.equal(
      ((await retry.json()) as SupervisorCredential).credential,
      next.credential,
    );
    // A different key after rotation conflicts: the old key is revoked.
    const conflict = await h.request(
      "/v1/supervisor/me/rotate",
      {
        ...supervisorBearer(credential),
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(conflict.status, 401);
    // Successor revocation ends recovery: replay now fails closed.
    const killed = await h.request(
      "/v1/supervisor/me/rotate",
      { ...supervisorBearer(next), "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    assert.equal(killed.status, 200);
    const dead = await h.request(
      "/v1/supervisor/me/rotate",
      { ...supervisorBearer(credential), "idempotency-key": replayKey },
      "POST",
      {},
    );
    assert.equal(dead.status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: rotation duplicate guard allows only one successor (concurrent keys)", async () => {
  const { h, credential } = await registered();
  try {
    const a = await h.request(
      "/v1/supervisor/me/rotate",
      {
        ...supervisorBearer(credential),
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(a.status, 200);
    const b = await h.request(
      "/v1/supervisor/me/rotate",
      {
        ...supervisorBearer(credential),
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    // Old credential is revoked by the first rotation, so the second attempt
    // authenticates as revoked: exactly one live successor exists.
    assert.equal(b.status, 401);
    const live = await h.db
      .prepare(
        "SELECT count(*) n FROM hosted_supervisor_credentials WHERE supervisor_id=? AND revoked_at IS NULL",
      )
      .bind(credential.supervisor_id)
      .first<{ n: number }>();
    assert.equal(live!.n, 1);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: registration idempotency replays without duplicates, conflict on changed payload", async () => {
  const { h, browser, workerId } = await setup();
  try {
    const k = crypto.randomUUID();
    const first = await registerSupervisor(h, browser, workerId, "edge-one", k);
    assert.equal(first.status, 201);
    const again = await registerSupervisor(h, browser, workerId, "edge-one", k);
    assert.equal(again.status, 201);
    assert.equal(
      ((await again.json()) as SupervisorCredential).supervisor_id,
      ((await first.json()) as SupervisorCredential).supervisor_id,
    );
    const rows = await h.db
      .prepare(
        "SELECT count(*) n FROM hosted_supervisors WHERE organization_id=?",
      )
      .bind(browser.tenant)
      .first<{ n: number }>();
    assert.equal(rows!.n, 1);
    const conflict = await registerSupervisor(
      h,
      browser,
      workerId,
      "edge-two",
      k,
    );
    assert.equal(conflict.status, 409);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: revocation holds assignments, retains reservations, never confirms stop", async () => {
  const { h, browser, workerId, credential } = await registered();
  try {
    const taskId = crypto.randomUUID(),
      reservationId = crypto.randomUUID(),
      now = Date.now();
    await h.db
      .prepare(
        "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,authorizing_user_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at,lease_id,supervisor_id,fence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        taskId,
        browser.tenant,
        workerId,
        browser.user,
        crypto.randomUUID(),
        "account",
        browser.user,
        crypto.randomUUID(),
        "fp",
        "controlled",
        "running",
        reservationId,
        1,
        10000,
        100,
        now,
        now + 60000,
        crypto.randomUUID(),
        credential.supervisor_id,
        1,
      )
      .run();
    await h.db
      .prepare(
        "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        reservationId,
        browser.tenant,
        taskId,
        workerId,
        "task_execution",
        "1",
        "active",
        now,
        now + 60000,
      )
      .run();
    const del = await h.request(
      `/v1/tenants/${browser.tenant}/supervisors/${credential.supervisor_id}`,
      { ...browser.headers, "idempotency-key": crypto.randomUUID() },
      "DELETE",
    );
    assert.equal(del.status, 200);
    const task = await h.db
      .prepare("SELECT state,supervisor_id FROM hosted_tasks WHERE task_id=?")
      .bind(taskId)
      .first<{ state: string; supervisor_id: string }>();
    assert.equal(task!.state, "held");
    const reservation = await h.db
      .prepare("SELECT state FROM hosted_reservations WHERE reservation_id=?")
      .bind(reservationId)
      .first<{ state: string }>();
    // Uncertain execution is retained, never released or consumed here.
    assert.equal(reservation!.state, "active");
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: DB failure rolls back registration (no partial rows, no audit)", async () => {
  const { h, browser, workerId } = await setup();
  try {
    // Drop the audit table so the authority-guarded audit write fails and
    // the whole D1 batch must roll back.
    await h.db.prepare("DROP TABLE audit_events").run();
    const response = await registerSupervisor(h, browser, workerId);
    assert.equal(response.status, 503);
    const rows = await h.db
      .prepare("SELECT count(*) n FROM hosted_supervisors")
      .first<{ n: number }>();
    assert.equal(rows!.n, 0);
    const creds = await h.db
      .prepare("SELECT count(*) n FROM hosted_supervisor_credentials")
      .first<{ n: number }>();
    assert.equal(creds!.n, 0);
    const ops = await h.db
      .prepare("SELECT count(*) n FROM hosted_operations")
      .first<{ n: number }>();
    assert.equal(ops!.n, 0);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: strict schemas and safe error envelope", async () => {
  const { h, browser, workerId, credential } = await registered();
  try {
    const extra = await h.request(
      `/v1/tenants/${browser.tenant}/supervisors`,
      { ...browser.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { worker_id: workerId, name: "x", unexpected: 1 },
    );
    assert.equal(extra.status, 400);
    const noKey = await h.request(
      `/v1/tenants/${browser.tenant}/supervisors`,
      { ...browser.headers },
      "POST",
      { worker_id: workerId, name: "x" },
    );
    assert.equal(noKey.status, 400);
    const badQuery = await h.request(
      "/v1/supervisor/me?unexpected=1",
      supervisorBearer(credential),
    );
    assert.equal(badQuery.status, 400);
    const badBody = await h.request(
      "/v1/supervisor/me/rotate",
      {
        ...supervisorBearer(credential),
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      { unexpected: 1 },
    );
    assert.equal(badBody.status, 400);
    const body = (await badBody.json()) as {
      error: { code: string; message: string; request_id: string };
    };
    assert.ok(body.error.code);
    assert.ok(body.error.request_id);
    assert.equal("credential" in body, false);
  } finally {
    await h.mf.dispose();
  }
});

test("supervisor identity: supervisorGuard mirrors execution/cleanup auth", async () => {
  const { h, credential } = await registered();
  try {
    const principal: HostedSupervisorPrincipal = {
      credential_id: credential.credential_id,
      supervisor_id: credential.supervisor_id,
      organization_id: credential.tenant_id,
      worker_id: credential.worker_id,
      authorizing_user_id: credential.subject_id,
      epoch: 1,
      scopes: [...credential.scopes],
      expires_at: credential.expires_at,
      authorization_expires_at: credential.authorization_expires_at,
    };
    for (const mode of ["execution", "cleanup"] as const) {
      const guard = supervisorGuard(principal, Date.now(), mode);
      const check = await h.db
        .prepare(`SELECT (${guard.sql}) ok`)
        .bind(...guard.args)
        .first<{ ok: number }>();
      assert.equal(check!.ok, 1, mode);
    }
    // Execution guard is stricter: revoke the worker and only cleanup passes.
    await h.db
      .prepare("UPDATE cloud_workers SET status='revoked' WHERE worker_id=?")
      .bind(credential.worker_id)
      .run();
    const exec = supervisorGuard(principal, Date.now(), "execution");
    const execCheck = await h.db
      .prepare(`SELECT (${exec.sql}) ok`)
      .bind(...exec.args)
      .first<{ ok: number }>();
    assert.equal(execCheck!.ok, 0);
    const cleanup = supervisorGuard(principal, Date.now(), "cleanup");
    const cleanupCheck = await h.db
      .prepare(`SELECT (${cleanup.sql}) ok`)
      .bind(...cleanup.args)
      .first<{ ok: number }>();
    assert.equal(cleanupCheck!.ok, 1);
  } finally {
    await h.mf.dispose();
  }
});

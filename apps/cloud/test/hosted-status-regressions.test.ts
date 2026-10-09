import { expect, test } from "bun:test";
import { type HostedStatus, hostedStatusRoute } from "../src/hosted-status.ts";
import { supervisorRoute } from "../src/hosted-supervisors.ts";
import { hostedSupervisorScopes } from "../src/hosted-types.ts";
import { localFixture } from "./local-fixture.ts";

const fixture = () => localFixture({ handlers: [hostedStatusRoute] });
async function status(
  h: Awaited<ReturnType<typeof fixture>>,
  tenant: string,
  headers: Record<string, string>,
  query = "",
) {
  const r = await h.request(
    `/v1/tenants/${tenant}/hosted-status${query}`,
    headers,
  );
  expect(r.status).toBe(200);
  return (await r.json()) as HostedStatus;
}

test("status combined task pagination enumerates disjoint UUID ranges without skips", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const now = Date.now();
    const expected: string[] = [];
    const expectedSupervisors: string[] = [];
    for (const [prefix, state] of [
      ["10000000", "held"],
      ["90000000", "stop_requested"],
    ] as const) {
      for (let n = 1; n <= 3; n++) {
        const w = await h.enrolledWorker(a);
        const supervisor = `50000000-0000-4000-8000-${String(expectedSupervisors.length + 1).padStart(12, "0")}`;
        expectedSupervisors.push(supervisor);
        h.db.sqlite
          .query(
            "INSERT INTO hosted_supervisors(supervisor_id,organization_id,worker_id,authorizing_user_id,name,status,epoch,created_at,authorization_expires_at) VALUES(?,?,?,?,'observer','registered',1,?,?)",
          )
          .run(supervisor, a.tenant, w.worker_id, a.user, now, now + 100000);
        const id = `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
        expected.push(id);
        h.db.sqlite
          .query(
            "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,authorizing_user_id,authorizing_session_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,'account',?,?,?,'controlled',?,?,1,1000,10,?,?)",
          )
          .run(
            id,
            a.tenant,
            w.worker_id,
            a.user,
            a.sessionId,
            crypto.randomUUID(),
            a.sessionId,
            crypto.randomUUID(),
            "fp",
            state,
            crypto.randomUUID(),
            now,
            now + 1000,
          );
      }
    }
    let query = "?limit=1";
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await status(h, a.tenant, a.headers, query);
      seen.push(
        ...[...page.held_page, ...page.stop_duty].map((t) => t.task_id),
      );
      if (!page.next_cursor) break;
      query = `?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`;
    }
    expect(seen.sort()).toEqual(expected.sort());
    const first = await status(h, a.tenant, a.headers, "?limit=1");
    expect(first.next_cursor).not.toBeNull();
    expect(first.next_supervisor_cursor).not.toBeNull();
    const seenSupervisors = first.supervisors.map((s) => s.supervisor_id);
    let nextSupervisor = first.next_supervisor_cursor;
    for (let i = 0; nextSupervisor && i < 10; i++) {
      const page = await status(
        h,
        a.tenant,
        a.headers,
        `?limit=1&supervisor_cursor=${encodeURIComponent(nextSupervisor)}&cursor=${encodeURIComponent(first.next_cursor!)}`,
      );
      seenSupervisors.push(...page.supervisors.map((s) => s.supervisor_id));
      nextSupervisor = page.next_supervisor_cursor;
    }
    expect(seenSupervisors).toEqual(expectedSupervisors);
    for (const query of [
      `cursor=${encodeURIComponent(first.next_supervisor_cursor!)}`,
      `supervisor_cursor=${encodeURIComponent(first.next_cursor!)}`,
    ])
      expect(
        (
          await h.request(
            `/v1/tenants/${a.tenant}/hosted-status?limit=1&${query}`,
            a.headers,
          )
        ).status,
      ).toBe(400);
  } finally {
    h.close();
  }
});

test("status fails closed on unavailable policy or operational source tables", async () => {
  for (const table of ["hosted_entitlements", "hosted_outbox"]) {
    const h = await fixture();
    try {
      const a = await h.login();
      h.db.sqlite.exec(`DROP TABLE ${table}`);
      const r = await h.request(
        `/v1/tenants/${a.tenant}/hosted-status`,
        a.headers,
      );
      expect(r.status).toBe(503);
      expect((await r.json()) as object).toHaveProperty("error");
    } finally {
      h.close();
    }
  }
});

test("supervisor authority checks current epoch and admin authorizer; observations use real task audits", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const now = Date.now();
    const supervisor = crypto.randomUUID();
    const task = crypto.randomUUID();
    h.db.sqlite
      .query(
        "INSERT INTO hosted_supervisors(supervisor_id,organization_id,worker_id,authorizing_user_id,name,status,epoch,created_at,authorization_expires_at) VALUES(?,?,?,?,'observer','registered',2,?,?)",
      )
      .run(supervisor, a.tenant, w.worker_id, a.user, now, now + 100000);
    h.db.sqlite
      .query(
        "INSERT INTO hosted_supervisor_credentials(credential_id,token_hash,supervisor_id,organization_id,audience,scopes,epoch,created_at,expires_at) VALUES(?,?,?,?,'hosted-supervisor',?,1,?,?)",
      )
      .run(
        crypto.randomUUID(),
        crypto.randomUUID(),
        supervisor,
        a.tenant,
        JSON.stringify(hostedSupervisorScopes),
        now,
        now + 100000,
      );
    h.db.sqlite
      .query(
        "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,authorizing_user_id,authorizing_session_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at,supervisor_id) VALUES(?,?,?,?,?,?,'account',?,?,?,'controlled','completed',?,1,1000,10,?,?,?)",
      )
      .run(
        task,
        a.tenant,
        w.worker_id,
        a.user,
        a.sessionId,
        crypto.randomUUID(),
        a.sessionId,
        crypto.randomUUID(),
        "fp",
        crypto.randomUUID(),
        now,
        now + 1000,
        supervisor,
      );
    h.db.sqlite
      .query("INSERT INTO audit_events VALUES(?,?,?,?,?,'success',?,?,?)")
      .run(
        crypto.randomUUID(),
        a.user,
        a.tenant,
        "dispatch.settled",
        `task:${task}`,
        crypto.randomUUID(),
        now,
        JSON.stringify({ outcome: "failed" }),
      );
    const page = await status(h, a.tenant, a.headers);
    expect(page.supervisors[0]!.credential_authority).not.toBe("valid");
    expect(page.supervisors[0]!.last_observed_action).toBe("dispatch.settled");
    expect(page.supervisors[0]!.last_observed_at).toBe(now);
    expect(page.failure_audits).toBe(1);
    expect(page.cleanup_audits).toBe(1);
    h.db.sqlite.query("UPDATE hosted_supervisor_credentials SET epoch=2").run();
    h.db.sqlite.query("UPDATE cloud_workers SET status='revoked'").run();
    const revokedWorker = await status(h, a.tenant, a.headers);
    expect(revokedWorker.supervisors[0]!.cleanup_eligible).toBe(true);
    expect(revokedWorker.supervisors[0]!.execution_eligible).toBe(false);
    h.db.sqlite.query("UPDATE memberships SET role='member'").run();
    const member = await status(h, a.tenant, a.headers);
    expect(member.supervisors[0]!.cleanup_eligible).toBe(false);
  } finally {
    h.close();
  }
});

test("status denies execution when a different worker enroller loses authority while preserving supervisor cleanup", async () => {
  const h = await localFixture({
    handlers: [hostedStatusRoute, supervisorRoute],
  });
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const b = await h.login(200);
    const now = Date.now();
    h.db.sqlite
      .query("INSERT INTO memberships VALUES(?,?,'admin','active',?,?)")
      .run(a.tenant, b.user, now, now);
    await h.seedPolicy(a.tenant, {
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
    });
    await h.registerSupervisor({ ...b, tenant: a.tenant }, w.worker_id);
    const before = await status(h, a.tenant, b.headers);
    expect(before.supervisors[0]!.execution_eligible).toBe(true);
    h.db.sqlite
      .query(
        "UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?",
      )
      .run(a.tenant, a.user);
    const current = await status(h, a.tenant, b.headers);
    expect(current.supervisors[0]!.execution_eligible).toBe(false);
    expect(current.supervisors[0]!.cleanup_eligible).toBe(true);
  } finally {
    h.close();
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  admissionReplySchema,
  claimReplySchema,
  hostedAllowanceSchema,
  hostedCapabilities,
  hostedCliScopes,
  hostedExecutionCredentialReplySchema,
  hostedPolicySchema,
  hostedQuantitySchema,
  hostedSupervisorCredentialReplySchema,
  hostedSupervisorScopes,
  hostedTableNames,
  hostedTaskSchema,
  leaseReplySchema,
  leaseRequestSchema,
  settlementRequestSchema,
  taskSubmitSchema,
} from "../src/hosted-types.ts";
import { fixture } from "./machine-helpers.ts";

async function statements(migration: string) {
  const sql = await readFile(new URL(migration, import.meta.url), "utf8");
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

test("hosted schema checkpoint: frozen DTOs expose exact protocol names", async () => {
  assert.deepEqual(
    [...hostedCapabilities],
    [
      "hosted_control_plane",
      "remote_worker_enrollment",
      "hosted_task_execution",
    ],
  );
  assert.deepEqual(
    [...hostedCliScopes],
    ["tasks:create", "tasks:read", "tasks:cancel", "entitlements:read"],
  );
  assert.deepEqual(
    [...hostedSupervisorScopes],
    [
      "supervisor:claim",
      "supervisor:renew",
      "supervisor:report",
      "supervisor:cleanup",
    ],
  );
  assert.deepEqual(
    [...hostedTableNames],
    [
      "hosted_entitlements",
      "hosted_allowances",
      "hosted_execution_grants",
      "hosted_supervisors",
      "hosted_supervisor_credentials",
      "hosted_supervisor_rotations",
      "hosted_tasks",
      "hosted_reservations",
      "hosted_outbox",
      "hosted_operations",
    ],
  );
  // Canonical quantity: exact bounded integer strings only.
  assert.ok(hostedQuantitySchema.safeParse("0").success);
  assert.ok(hostedQuantitySchema.safeParse("1844674407370955161").success);
  for (const bad of [
    "",
    "-1",
    "01",
    "1.5",
    " 42",
    "18446744073709551619",
    "abc",
  ])
    assert.equal(hostedQuantitySchema.safeParse(bad).success, false);
  // Exact submission body from protocol.
  const submit = taskSubmitSchema.parse({
    request_id: crypto.randomUUID(),
    worker_id: crypto.randomUUID(),
    execution_class: "controlled",
    runtime_ms: 10000,
    controlled_duration_ms: 100,
  });
  assert.equal(submit.execution_class, "controlled");
  assert.throws(() =>
    taskSubmitSchema.parse({ ...submit, execution_class: "shell" }),
  );
  assert.throws(() =>
    taskSubmitSchema.parse({
      ...submit,
      controlled_duration_ms: submit.runtime_ms + 1,
    }),
  );
  assert.throws(() => taskSubmitSchema.parse({ ...submit, extra: 1 }));
  // server_time present on claim/lease replies (root watchdog contract).
  const task = hostedTaskSchema.parse({
    task_id: crypto.randomUUID(),
    tenant_id: crypto.randomUUID(),
    worker_id: crypto.randomUUID(),
    execution_class: "controlled",
    state: "queued",
    reservation_id: crypto.randomUUID(),
    policy_version: 1,
    runtime_ms: 10000,
    controlled_duration_ms: 100,
    created_at: 1,
    deadline_at: 2,
    lease_id: null,
    supervisor_id: null,
    fence: 0,
    lease_expires_at: null,
  });
  assert.equal(claimReplySchema.parse({ task, server_time: 7 }).server_time, 7);
  assert.equal(
    claimReplySchema.parse({ task: null, server_time: 7 }).task,
    null,
  );
  assert.throws(() => claimReplySchema.parse({ task }));
  assert.equal(
    leaseReplySchema.parse({ task, directive: "stop", server_time: 9 })
      .directive,
    "stop",
  );
  assert.throws(() => leaseReplySchema.parse({ task, directive: "stop" }));
  const lease = { lease_id: crypto.randomUUID(), fence: 3 };
  assert.deepEqual(leaseRequestSchema.parse(lease), lease);
  const settle = settlementRequestSchema.parse({
    ...lease,
    outcome: "completed",
    stop_confirmed: true,
    consumed_runtime_ms: 50,
  });
  assert.equal(settle.stop_confirmed, true);
  assert.throws(() =>
    settlementRequestSchema.parse({ ...settle, stop_confirmed: false }),
  );
  const policy = hostedPolicySchema.parse({
    organization_id: crypto.randomUUID(),
    version: 2,
    capabilities: {
      hosted_control_plane: true,
      remote_worker_enrollment: true,
      hosted_task_execution: true,
    },
    max_concurrent_workers: 4,
    max_active_tasks: 8,
    max_task_runtime: 60000,
    maximum_resource_reservations: 16,
    valid_from: 1,
    valid_until: 2,
    revoked_at: null,
  });
  assert.equal(policy.version, 2);
  const allowance = hostedAllowanceSchema.parse({
    allowance_id: crypto.randomUUID(),
    organization_id: crypto.randomUUID(),
    entitlement_id: crypto.randomUUID(),
    resource: "compute_ms",
    unit: "millisecond",
    resource_class: "controlled",
    allowed_quantity: "60000",
    consumed_quantity: "0",
    reserved_quantity: "0",
    period_start: 1,
    period_end: 2,
  });
  assert.equal(allowance.allowed_quantity, "60000");
  assert.throws(() =>
    hostedAllowanceSchema.parse({ ...allowance, allowed_quantity: "01" }),
  );
  // Credential prefixes/audiences stay disjoint from sfcli_/sfworker_.
  const exec = hostedExecutionCredentialReplySchema.parse({
    credential: `sfexec_${"a".repeat(43)}`,
    credential_id: crypto.randomUUID(),
    grant_id: crypto.randomUUID(),
    installation_id: crypto.randomUUID(),
    subject_id: crypto.randomUUID(),
    tenant_id: crypto.randomUUID(),
    scopes: ["tasks:create", "tasks:read", "tasks:cancel", "entitlements:read"],
    expires_at: 5,
    authorization_expires_at: 9,
  });
  assert.ok(exec.credential.startsWith("sfexec_"));
  assert.throws(() =>
    hostedExecutionCredentialReplySchema.parse({
      ...exec,
      credential: `sfcli_${"a".repeat(43)}`,
    }),
  );
  const sup = hostedSupervisorCredentialReplySchema.parse({
    credential: `sfsuper_${"b".repeat(43)}`,
    credential_id: crypto.randomUUID(),
    supervisor_id: crypto.randomUUID(),
    worker_id: crypto.randomUUID(),
    subject_id: crypto.randomUUID(),
    tenant_id: crypto.randomUUID(),
    scopes: [
      "supervisor:claim",
      "supervisor:renew",
      "supervisor:report",
      "supervisor:cleanup",
    ],
    expires_at: 5,
    authorization_expires_at: 9,
  });
  assert.ok(sup.credential.startsWith("sfsuper_"));
  assert.equal(
    admissionReplySchema.parse({
      task,
      reservation_id: task.reservation_id,
      policy_version: 1,
    }).policy_version,
    1,
  );
});

test("hosted schema checkpoint: clean install creates all tables with strict constraints", async () => {
  const h = await fixture();
  try {
    for (const stmt of await statements(
      "../migrations/0003_hosted_execution.sql",
    ))
      await h.db.prepare(stmt).run();
    const tables = (
      await h.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'hosted_%' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    assert.deepEqual(tables, [...hostedTableNames].sort());
    // Duration cannot exceed runtime; unknown execution class rejected.
    await assert.rejects(() =>
      h.db
        .prepare(
          "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          "cli",
          "p",
          "k",
          "f",
          "controlled",
          "queued",
          crypto.randomUUID(),
          1,
          100,
          101,
          1,
          2,
        )
        .run(),
    );
    // Malformed quantities rejected at DDL level.
    for (const bad of ["", "-1", "01", "1.5", "x", "9".repeat(20)])
      await assert.rejects(() =>
        h.db
          .prepare(
            "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            crypto.randomUUID(),
            crypto.randomUUID(),
            "task_execution",
            bad,
            "active",
            1,
            2,
          )
          .run(),
      );
    // One reservation per task enforced by UNIQUE(task_id).
    const a = await h.login();
    const invite = await h.enroll(a);
    const reg = await h.register(invite);
    assert.equal(reg.status, 201);
    const worker = (await reg.json()) as { worker_id: string };
    const taskId = crypto.randomUUID(),
      resId = crypto.randomUUID();
    await h.db
      .prepare(
        "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        taskId,
        a.tenant,
        worker.worker_id,
        crypto.randomUUID(),
        "cli",
        "p1",
        "k1",
        "f1",
        "controlled",
        "queued",
        resId,
        1,
        10000,
        100,
        1,
        2,
      )
      .run();
    await h.db
      .prepare(
        "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(resId, a.tenant, taskId, "task_execution", "1", "active", 1, 2)
      .run();
    await assert.rejects(() =>
      h.db
        .prepare(
          "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          a.tenant,
          taskId,
          "task_execution",
          "1",
          "active",
          1,
          2,
        )
        .run(),
    );
    // Idempotency scope binds tenant + principal + operation.
    await assert.rejects(() =>
      h.db
        .prepare(
          "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          a.tenant,
          worker.worker_id,
          crypto.randomUUID(),
          "cli",
          "p1",
          "k1",
          "fX",
          "controlled",
          "queued",
          crypto.randomUUID(),
          1,
          10000,
          100,
          1,
          2,
        )
        .run(),
    );
    const b = await h.login(200);
    // Cross-tenant binding: D1/Miniflare does not enforce FKs at INSERT
    // time (same as 0001/0002 identity tables), so FKs are declared in DDL
    // and enforced by conditional batch SQL at admission. Assert the FK is
    // declared and that tenant-scoped reads never cross tenants.
    const taskDdl = (await h.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='hosted_tasks'",
      )
      .first<{ sql: string }>())!.sql;
    assert.ok(taskDdl.includes("REFERENCES cloud_workers(worker_id)"));
    assert.ok(taskDdl.includes("REFERENCES organizations(organization_id)"));
    const crossTenant = await h.db
      .prepare(
        "SELECT t.task_id FROM hosted_tasks t JOIN cloud_workers w ON w.worker_id=t.worker_id WHERE t.organization_id=? AND t.task_id=? AND w.organization_id=?",
      )
      .bind(b.tenant, taskId, b.tenant)
      .first();
    assert.equal(crossTenant ?? null, null);
    // Transactional audit rollback: a batch that fails reverts task+reservation.
    const rollbackTask = crypto.randomUUID();
    await assert.rejects(() =>
      h.db.batch([
        h.db
          .prepare(
            "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            rollbackTask,
            a.tenant,
            worker.worker_id,
            crypto.randomUUID(),
            "cli",
            "px",
            "kx",
            "fx",
            "controlled",
            "queued",
            crypto.randomUUID(),
            1,
            10000,
            100,
            1,
            2,
          ),
        h.db.prepare("INSERT INTO hosted_reservations VALUES('bad')"),
      ]),
    );
    assert.equal(
      (await h.db
        .prepare("SELECT task_id FROM hosted_tasks WHERE task_id=?")
        .bind(rollbackTask)
        .first()) ?? null,
      null,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("hosted schema checkpoint: 2B.1 upgrade keeps existing credentials valid", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const device = await h.linked(a);
    const invite = await h.enroll(a);
    const reg = await h.register(invite);
    assert.equal(reg.status, 201);
    const before = {
      links: (await h.db
        .prepare("SELECT count(*) n FROM cli_links")
        .first<{ n: number }>())!.n,
      installations: (await h.db
        .prepare("SELECT count(*) n FROM cli_installations")
        .first<{ n: number }>())!.n,
      workers: (await h.db
        .prepare("SELECT count(*) n FROM cloud_workers")
        .first<{ n: number }>())!.n,
      credentials: (await h.db
        .prepare("SELECT count(*) n FROM machine_credentials")
        .first<{ n: number }>())!.n,
    };
    for (const stmt of await statements(
      "../migrations/0003_hosted_execution.sql",
    ))
      await h.db.prepare(stmt).run();
    const after = {
      links: (await h.db
        .prepare("SELECT count(*) n FROM cli_links")
        .first<{ n: number }>())!.n,
      installations: (await h.db
        .prepare("SELECT count(*) n FROM cli_installations")
        .first<{ n: number }>())!.n,
      workers: (await h.db
        .prepare("SELECT count(*) n FROM cloud_workers")
        .first<{ n: number }>())!.n,
      credentials: (await h.db
        .prepare("SELECT count(*) n FROM machine_credentials")
        .first<{ n: number }>())!.n,
    };
    assert.deepEqual(after, before);
    // Pre-existing identities keep working after upgrade.
    assert.equal(
      (
        await h.request("/v1/cli/me", {
          authorization: `Bearer ${device.credential}`,
        })
      ).status,
      200,
    );
    const worker = (await reg.json()) as { credential: string };
    assert.equal(
      (
        await h.request("/v1/workers/me", {
          authorization: `Bearer ${worker.credential}`,
        })
      ).status,
      200,
    );
    // Old audience CHECK untouched: hosted audiences rejected in machine_credentials.
    await assert.rejects(() =>
      h.db
        .prepare(
          "INSERT INTO machine_credentials(credential_id,token_hash,installation_id,worker_id,audience,scopes,epoch,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          "h",
          null,
          null,
          "hosted-supervisor",
          "[]",
          1,
          1,
          2,
        )
        .run(),
    );
  } finally {
    await h.mf.dispose();
  }
});

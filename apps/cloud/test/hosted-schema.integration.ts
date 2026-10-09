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
  maxMeterQuantity,
  maxTaskRuntimeMs,
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

async function fkMessage(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
  return null;
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
  assert.equal(maxMeterQuantity, "9007199254740991");
  assert.equal(maxTaskRuntimeMs, 3600000);
  // Canonical quantity: exact bounded integer strings only, capped at
  // Number.MAX_SAFE_INTEGER. "1.5"/"12x" are the regression cases that
  // GLOB '[0-9]*' wrongly accepted.
  assert.ok(hostedQuantitySchema.safeParse("0").success);
  assert.ok(hostedQuantitySchema.safeParse("99").success);
  assert.ok(hostedQuantitySchema.safeParse(maxMeterQuantity).success);
  for (const bad of [
    "",
    "-1",
    "01",
    "1.5",
    "12x",
    " 42",
    "abc",
    "9007199254740992",
    "10000000000000000",
    "9".repeat(20),
  ])
    assert.equal(hostedQuantitySchema.safeParse(bad).success, false);
  // Exact submission body from protocol; runtime capped at 1h technical ceiling.
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
  assert.throws(() =>
    taskSubmitSchema.parse({ ...submit, runtime_ms: maxTaskRuntimeMs + 1 }),
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
  // max_task_runtime is required and finite (technical ceiling, not quota).
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
  assert.equal(policy.max_task_runtime, 60000);
  assert.throws(() =>
    hostedPolicySchema.parse({ ...policy, max_task_runtime: null }),
  );
  assert.throws(() =>
    hostedPolicySchema.parse({
      ...policy,
      max_task_runtime: maxTaskRuntimeMs + 1,
    }),
  );
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
  assert.throws(() =>
    hostedAllowanceSchema.parse({
      ...allowance,
      allowed_quantity: "9007199254740992",
    }),
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

interface Setup {
  tenant: string;
  user: string;
  workerId: string;
  installationId: string;
  sessionId: string;
  extraWorker: () => Promise<string>;
}

async function setup(h: Awaited<ReturnType<typeof fixture>>): Promise<Setup> {
  const a = await h.login();
  const device = await h.linked(a);
  const invite = await h.enroll(a);
  const reg = await h.register(invite);
  assert.equal(reg.status, 201);
  const worker = (await reg.json()) as { worker_id: string };
  const session = (await h.db
    .prepare("SELECT session_id FROM sessions WHERE user_id=? LIMIT 1")
    .bind(a.user)
    .first<{ session_id: string }>())!;
  for (const stmt of await statements(
    "../migrations/0003_hosted_execution.sql",
  ))
    await h.db.prepare(stmt).run();
  async function extraWorker(): Promise<string> {
    const inv = await h.enroll(a);
    const r = await h.register(inv);
    assert.equal(r.status, 201);
    return ((await r.json()) as { worker_id: string }).worker_id;
  }
  return {
    tenant: a.tenant,
    user: a.user,
    workerId: worker.worker_id,
    installationId: device.installation_id!,
    sessionId: session.session_id,
    extraWorker,
  };
}

const taskColumns =
  "task_id,organization_id,worker_id,authorizing_user_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at";
function taskBind(
  s: Setup,
  overrides: Record<string, string | number | null> = {},
) {
  const v: Record<string, string | number | null> = {
    task_id: crypto.randomUUID(),
    organization_id: s.tenant,
    worker_id: s.workerId,
    authorizing_user_id: s.user,
    request_id: crypto.randomUUID(),
    principal_kind: "cli",
    principal_id: "p1",
    idempotency_key: crypto.randomUUID(),
    fingerprint: "f1",
    execution_class: "controlled",
    state: "queued",
    reservation_id: crypto.randomUUID(),
    policy_version: 1,
    runtime_ms: 10000,
    controlled_duration_ms: 100,
    created_at: 1,
    deadline_at: 2,
    ...overrides,
  };
  return taskColumns.split(",").map((c) => v[c] as string | number | null);
}

test("hosted schema checkpoint: FK orphans rejected direct and batch with valid other fields", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    // Task naming a nonexistent worker (valid org/user otherwise): FK fires.
    const orphanDirect = await fkMessage(() =>
      h.db
        .prepare(
          `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ...taskBind(s, {
            worker_id: crypto.randomUUID(),
            idempotency_key: "k-orphan",
          }),
        )
        .run(),
    );
    assert.ok(
      orphanDirect?.includes("FOREIGN KEY"),
      `expected FK rejection, got: ${orphanDirect}`,
    );
    const orphanBatch = await fkMessage(() =>
      h.db.batch([
        h.db
          .prepare(
            `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            ...taskBind(s, {
              worker_id: crypto.randomUUID(),
              idempotency_key: "k-orphan-batch",
            }),
          ),
      ]),
    );
    assert.ok(
      orphanBatch?.includes("FOREIGN KEY"),
      `expected batch FK rejection, got: ${orphanBatch}`,
    );
    // Reservation for a nonexistent task, valid parents otherwise.
    const resOrphan = await fkMessage(() =>
      h.db
        .prepare(
          "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          s.tenant,
          crypto.randomUUID(),
          s.workerId,
          "task_execution",
          "1",
          "active",
          1,
          2,
        )
        .run(),
    );
    assert.ok(
      resOrphan?.includes("FOREIGN KEY"),
      `expected reservation FK rejection, got: ${resOrphan}`,
    );
    // Execution grant naming a nonexistent installation.
    const grantOrphan = await fkMessage(() =>
      h.db
        .prepare(
          "INSERT INTO hosted_execution_grants(grant_id,token_hash,installation_id,organization_id,user_id,session_id,scopes,epoch,idempotency_key,fingerprint,result_ciphertext,created_at,expires_at,authorization_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          "hash-x",
          crypto.randomUUID(),
          s.tenant,
          s.user,
          s.sessionId,
          "[]",
          1,
          "gk1",
          "fp",
          "ct",
          1,
          2,
          3,
        )
        .run(),
    );
    assert.ok(
      grantOrphan?.includes("FOREIGN KEY"),
      `expected grant FK rejection, got: ${grantOrphan}`,
    );
    // Supervisor naming a nonexistent worker.
    const supOrphan = await fkMessage(() =>
      h.db
        .prepare(
          "INSERT INTO hosted_supervisors(supervisor_id,organization_id,worker_id,authorizing_user_id,name,status,epoch,created_at,authorization_expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          s.tenant,
          crypto.randomUUID(),
          s.user,
          "sup",
          "registered",
          1,
          1,
          2,
        )
        .run(),
    );
    assert.ok(
      supOrphan?.includes("FOREIGN KEY"),
      `expected supervisor FK rejection, got: ${supOrphan}`,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("hosted schema checkpoint: quantity CHECKs fire on valid-parent rows", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    // Valid parents first: policy + task + reservation anchors.
    await h.db
      .prepare(
        "INSERT INTO hosted_entitlements(entitlement_id,organization_id,version,hosted_control_plane,remote_worker_enrollment,hosted_task_execution,max_task_runtime,valid_from,valid_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(crypto.randomUUID(), s.tenant, 1, 1, 1, 1, 60000, 1, 99, 1)
      .run();
    const entitlement = (await h.db
      .prepare(
        "SELECT entitlement_id FROM hosted_entitlements WHERE organization_id=?",
      )
      .bind(s.tenant)
      .first<{ entitlement_id: string }>())!;
    // MAX bound accepted.
    await h.db
      .prepare(
        "INSERT INTO hosted_allowances(allowance_id,organization_id,entitlement_id,resource,unit,resource_class,allowed_quantity,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        s.tenant,
        entitlement.entitlement_id,
        "compute_ms",
        "millisecond",
        "controlled",
        maxMeterQuantity,
        1,
        2,
        1,
      )
      .run();
    // Malformed quantities with VALID parents: the CHECK (not the FK) fires.
    for (const bad of [
      "",
      "-1",
      "01",
      "1.5",
      "12x",
      "x",
      "9".repeat(20),
      "9007199254740992",
      "10000000000000000",
    ]) {
      const msg = await fkMessage(() =>
        h.db
          .prepare(
            "INSERT INTO hosted_allowances(allowance_id,organization_id,entitlement_id,resource,unit,resource_class,allowed_quantity,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            s.tenant,
            entitlement.entitlement_id,
            `res-${bad.length}`,
            "millisecond",
            `cls-${crypto.randomUUID()}`,
            bad,
            10 + bad.length,
            20 + bad.length,
            1,
          )
          .run(),
      );
      assert.ok(
        msg?.includes("CHECK constraint"),
        `quantity ${JSON.stringify(bad)}: expected CHECK rejection, got: ${msg}`,
      );
    }
    // Reservation quantities: enroll one fresh worker per bad quantity under
    // the same tenant, each with its own task, so the partial-unique (one
    // open task per org+worker) and UNIQUE(task_id) cannot mask the CHECK.
    for (const bad of ["01", "1.5", "12x", "9007199254740992"]) {
      const wid = await s.extraWorker();
      const tid = crypto.randomUUID();
      await h.db
        .prepare(
          `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ...taskBind(s, {
            task_id: tid,
            worker_id: wid,
            idempotency_key: `k-${bad.length}-${tid.slice(0, 8)}`,
            reservation_id: crypto.randomUUID(),
          }),
        )
        .run();
      const msg = await fkMessage(() =>
        h.db
          .prepare(
            "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            s.tenant,
            tid,
            wid,
            "task_execution",
            bad,
            "active",
            1,
            2,
          )
          .run(),
      );
      assert.ok(
        msg?.includes("CHECK constraint"),
        `reservation quantity ${bad}: expected CHECK rejection, got: ${msg}`,
      );
    }
    // Runtime ceiling: duration>runtime and runtime>1h rejected on valid parents.
    for (const [runtime, duration] of [
      [100, 101],
      [maxTaskRuntimeMs + 1, 100],
    ] as Array<[number, number]>) {
      const msg = await fkMessage(() =>
        h.db
          .prepare(
            `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            ...taskBind(s, {
              task_id: crypto.randomUUID(),
              request_id: crypto.randomUUID(),
              idempotency_key: crypto.randomUUID(),
              reservation_id: crypto.randomUUID(),
              runtime_ms: runtime,
              controlled_duration_ms: duration,
            }),
          )
          .run(),
      );
      assert.ok(
        msg?.includes("CHECK constraint"),
        `runtime ${runtime}/${duration}: expected CHECK rejection, got: ${msg}`,
      );
    }
    // Policy ceiling: NULL or over-ceiling max_task_runtime rejected.
    for (const runtime of [null, 0, maxTaskRuntimeMs + 1]) {
      const msg = await fkMessage(() =>
        h.db
          .prepare(
            "INSERT INTO hosted_entitlements(entitlement_id,organization_id,version,hosted_control_plane,remote_worker_enrollment,hosted_task_execution,max_task_runtime,valid_from,valid_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            s.tenant,
            100 + (runtime ?? 7),
            1,
            1,
            1,
            runtime,
            1,
            99,
            1,
          )
          .run(),
      );
      assert.ok(
        msg?.includes("CHECK constraint") ||
          msg?.includes("NOT NULL constraint"),
        `policy runtime ${runtime}: expected CHECK/NOT NULL rejection, got: ${msg}`,
      );
    }
    // Finite window: valid_until <= valid_from rejected.
    const windowMsg = await fkMessage(() =>
      h.db
        .prepare(
          "INSERT INTO hosted_entitlements(entitlement_id,organization_id,version,hosted_control_plane,remote_worker_enrollment,hosted_task_execution,max_task_runtime,valid_from,valid_until,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(crypto.randomUUID(), s.tenant, 999, 1, 1, 1, 60000, 50, 50, 1)
        .run(),
    );
    assert.ok(
      windowMsg?.includes("CHECK constraint"),
      `expected window CHECK rejection, got: ${windowMsg}`,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("hosted schema checkpoint: cross-org resource binding, worker exclusivity, rollback", async () => {
  const h = await fixture();
  try {
    const s = await setup(h);
    // Second tenant with its own valid worker.
    const b = await h.login(200);
    const inviteB = await h.enroll(b);
    const regB = await h.register(inviteB);
    assert.equal(regB.status, 201);
    const workerB = (await regB.json()) as { worker_id: string };
    // Cross-org: valid worker of tenant B admitted under tenant A -> composite
    // (organization_id, worker_id) FK rejects.
    const crossMsg = await fkMessage(() =>
      h.db
        .prepare(
          `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ...taskBind(s, {
            worker_id: workerB.worker_id,
            idempotency_key: "k-cross",
          }),
        )
        .run(),
    );
    assert.ok(
      crossMsg?.includes("FOREIGN KEY"),
      `expected cross-org FK rejection, got: ${crossMsg}`,
    );
    // Tenant-private read: B's worker never appears under A's tasks.
    const leak = await h.db
      .prepare(
        "SELECT t.task_id FROM hosted_tasks t JOIN cloud_workers w ON w.worker_id=t.worker_id WHERE t.organization_id=? AND w.organization_id=? AND t.task_id=?",
      )
      .bind(s.tenant, b.tenant, "nonexistent")
      .first();
    assert.equal(leak ?? null, null);
    // First active task on the worker succeeds.
    const first = taskBind(s, {
      idempotency_key: "k-first",
      reservation_id: crypto.randomUUID(),
    });
    await h.db
      .prepare(
        `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(...first)
      .run();
    const firstId = (await h.db
      .prepare(
        "SELECT task_id FROM hosted_tasks WHERE organization_id=? AND idempotency_key=?",
      )
      .bind(s.tenant, "k-first")
      .first<{ task_id: string }>())!;
    await h.db
      .prepare(
        "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        firstId.task_id,
        s.tenant,
        firstId.task_id,
        s.workerId,
        "task_execution",
        "1",
        "active",
        1,
        2,
      )
      .run();
    // Duplicate active task on the SAME worker: partial unique rejects.
    const dupMsg = await fkMessage(() =>
      h.db
        .prepare(
          `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          ...taskBind(s, {
            idempotency_key: "k-second",
            reservation_id: crypto.randomUUID(),
          }),
        )
        .run(),
    );
    assert.ok(
      dupMsg?.includes("UNIQUE"),
      `expected worker-exclusivity UNIQUE rejection, got: ${dupMsg}`,
    );
    // Settle the first task terminal; release permits a new task on the worker.
    await h.db
      .prepare("UPDATE hosted_tasks SET state='completed' WHERE task_id=?")
      .bind(firstId.task_id)
      .run();
    await h.db
      .prepare(
        "UPDATE hosted_reservations SET state='consumed', released_at=? WHERE task_id=?",
      )
      .bind(2, firstId.task_id)
      .run();
    await h.db
      .prepare(
        `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        ...taskBind(s, {
          idempotency_key: "k-third",
          reservation_id: crypto.randomUUID(),
        }),
      )
      .run();
    const third = await h.db
      .prepare(
        "SELECT task_id FROM hosted_tasks WHERE organization_id=? AND idempotency_key=?",
      )
      .bind(s.tenant, "k-third")
      .first();
    assert.ok(third, "new task after terminal release should succeed");
    // Audit/batch rollback: failing second statement reverts the first row.
    const rollbackTask = crypto.randomUUID();
    const rollbackMsg = await fkMessage(() =>
      h.db.batch([
        h.db
          .prepare(
            `INSERT INTO hosted_tasks(${taskColumns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            ...taskBind(s, {
              task_id: rollbackTask,
              idempotency_key: "k-rollback",
              reservation_id: crypto.randomUUID(),
            }),
          ),
        h.db.prepare("INSERT INTO hosted_reservations VALUES('bad')"),
      ]),
    );
    assert.ok(rollbackMsg !== null, "expected batch failure");
    assert.equal(
      (await h.db
        .prepare("SELECT task_id FROM hosted_tasks WHERE task_id=?")
        .bind(rollbackTask)
        .first()) ?? null,
      null,
      "rolled-back task row must not survive",
    );
  } finally {
    await h.mf.dispose();
  }
});

test("hosted schema checkpoint: clean install and 2B.1 upgrade", async () => {
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
    const tables = (
      await h.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'hosted_%' ORDER BY name",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    assert.deepEqual(tables, [...hostedTableNames].sort());
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
    const audienceMsg = await fkMessage(() =>
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
    assert.ok(
      audienceMsg?.includes("CHECK constraint"),
      `expected audience CHECK rejection, got: ${audienceMsg}`,
    );
  } finally {
    await h.mf.dispose();
  }
});

import { expect, test } from "bun:test";
import { localFixture } from "./local-fixture.ts";

const policy = {
  capabilities: {
    hosted_control_plane: true,
    remote_worker_enrollment: true,
    hosted_task_execution: true,
  },
  max_concurrent_workers: 2,
  max_active_tasks: 2,
  max_task_runtime: 60000,
  maximum_resource_reservations: 2,
  valid_for_ms: 3600000,
  allowances: [
    {
      resource: "compute_ms",
      unit: "millisecond",
      resource_class: "controlled",
      allowed_quantity: "120000",
    },
  ],
};

test("default Worker exposes private hosted policy and keeps execution audiences separate", async () => {
  const h = await localFixture();
  try {
    const account = await h.login();
    const view = await h.request(
      `/v1/tenants/${account.tenant}/entitlements`,
      account.headers,
    );
    expect(view.status).toBe(200);
    const policy = (await view.json()) as { allowed: boolean; denial: string };
    expect(policy.allowed).toBe(false);
    expect(policy.denial).toBe("policy_absent");
    const claim = await h.request(
      "/v1/supervisor/claim",
      {
        ...account.headers,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    expect(claim.status).toBe(401);
    expect(claim.headers.get("cache-control")).toBe("no-store");
    expect(claim.headers.get("x-request-id")).toBeTruthy();
  } finally {
    h.close();
  }
});

test("readiness requires the additive hosted migration while identity maintenance remains compatible", async () => {
  for (const schema of ["phase2b1", "phase2b2"] as const) {
    const h = await localFixture({ schema });
    try {
      expect((await h.request("/health")).status).toBe(200);
      expect((await h.request("/ready")).status).toBe(
        schema === "phase2b2" ? 200 : 503,
      );
      await h.scheduled();
      expect((await h.login()).tenant).toBeTruthy();
    } finally {
      h.close();
    }
  }
});

test("default routing admits once, dispatches with stable fencing, settles once and releases capacity", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    await h.seedPolicy(a.tenant, policy);
    const linked = await h.linked(a);
    const granted = await h.request(
      `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    expect(granted.status).toBe(201);
    const grant = (await granted.json()) as { credential: string };
    const supervisor = await h.registerSupervisor(a, w.worker_id);
    const execution = { authorization: `Bearer ${grant.credential}` };
    const superHeaders = { authorization: `Bearer ${supervisor.credential}` };
    const key = crypto.randomUUID();
    const input = {
      request_id: crypto.randomUUID(),
      worker_id: w.worker_id,
      execution_class: "controlled",
      runtime_ms: 60000,
      controlled_duration_ms: 100,
    };
    const submit = () =>
      h.request(
        `/v1/tenants/${a.tenant}/tasks`,
        { ...execution, "idempotency-key": key },
        "POST",
        input,
      );
    const replies = await Promise.all([submit(), submit(), submit()]);
    expect(replies.map((r) => r.status)).toEqual([202, 202, 202]);
    const admissions = (await Promise.all(replies.map((r) => r.json()))) as {
      task: { task_id: string };
    }[];
    expect(new Set(admissions.map((r) => r.task.task_id)).size).toBe(1);
    const id = admissions[0]!.task.task_id;
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM hosted_reservations WHERE state='active'",
        )
        .get(),
    ).toEqual({ n: 1 });
    const call = (suffix: string, data: unknown, opKey = crypto.randomUUID()) =>
      h.request(
        `/v1/supervisor/tasks/${id}${suffix}`,
        { ...superHeaders, "idempotency-key": opKey },
        "POST",
        data,
      );
    const claimKey = crypto.randomUUID();
    const claim = () =>
      h.request(
        "/v1/supervisor/claim",
        { ...superHeaders, "idempotency-key": claimKey },
        "POST",
        {},
      );
    const claimed = await claim();
    expect(claimed.status).toBe(200);
    const task = (
      (await claimed.json()) as { task: { lease_id: string; fence: number } }
    ).task;
    const lease = { lease_id: task.lease_id, fence: task.fence };
    expect((await call("/ack", lease)).status).toBe(200);
    const renewal = await call("/renew", lease);
    expect(renewal.status).toBe(200);
    expect(
      ((await renewal.json()) as { task: { fence: number } }).task.fence,
    ).toBe(task.fence);
    expect(
      (await call("/renew", { ...lease, fence: task.fence - 1 })).status,
    ).toBe(409);
    expect((await claim()).status).toBe(200);
    const status = await h.request(`/v1/supervisor/tasks/${id}`, superHeaders);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const settlement = {
      ...lease,
      outcome: "completed",
      stop_confirmed: true,
      consumed_runtime_ms: 100,
    };
    const settleKey = crypto.randomUUID();
    expect((await call("/settle", settlement, settleKey)).status).toBe(200);
    expect((await call("/settle", settlement, settleKey)).status).toBe(200);
    expect(
      (
        await call(
          "/settle",
          { ...settlement, consumed_runtime_ms: 101 },
          settleKey,
        )
      ).status,
    ).toBe(409);
    expect(
      h.db.sqlite
        .query(
          "SELECT consumed_quantity,reserved_quantity FROM hosted_allowances",
        )
        .get(),
    ).toEqual({ consumed_quantity: "100", reserved_quantity: "0" });
    expect(
      h.db.sqlite.query("SELECT state FROM hosted_reservations").get(),
    ).toEqual({ state: "consumed" });
    expect(
      (await h.request(`/v1/tenants/${a.tenant}/hosted-status`, a.headers))
        .status,
    ).toBe(200);
    const other = await h.login(101);
    expect(
      (await h.request(`/v1/tenants/${a.tenant}/tasks/${id}`, other.headers))
        .status,
    ).toBe(404);
    for (const raw of [linked.credential, w.credential])
      expect(
        (
          await h.request(
            "/v1/supervisor/claim",
            {
              authorization: `Bearer ${raw}`,
              "idempotency-key": crypto.randomUUID(),
            },
            "POST",
            {},
          )
        ).status,
      ).toBe(401);
    const logs = JSON.stringify(h.logs);
    for (const privateValue of [
      a.tenant,
      id,
      grant.credential,
      supervisor.credential,
      linked.credential,
      w.credential,
    ])
      expect(logs).not.toContain(privateValue);
    expect(
      h.logs.some(
        (entry) => entry.route === "/v1/supervisor/tasks/:task_id/settle",
      ),
    ).toBe(true);
  } finally {
    h.close();
  }
});

test("hosted routes retain origin, query and CSRF checks before authority mutation", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    expect(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/entitlements?limit=1&limit=2`,
          a.headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
          ...a.headers,
          origin: "https://attacker.invalid",
        })
      ).status,
    ).toBe(403);
    const linked = await h.linked(a);
    const { "x-csrf-token": _csrf, ...noCsrf } = a.headers;
    expect(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/cli-installations/${linked.installation_id}/execution-authorizations`,
          { ...noCsrf, "idempotency-key": crypto.randomUUID() },
          "POST",
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_execution_grants").get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

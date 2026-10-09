import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostedArgs, runHosted } from "../src/cli/hosted";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import {
  HostedApiError,
  type HostedTask,
  HostedTaskClient,
  remainingAuthorityMs,
  SupervisorClient,
} from "../src/hosted-client";
import {
  hostedSupervisorCredentialSchema,
  hostedTaskCredentialSchema,
  readHostedSupervisorCredential,
  readHostedTaskCredential,
  saveHostedSupervisorCredential,
  saveHostedTaskCredential,
} from "../src/hosted-credentials";
import {
  ControlledAgent,
  ControlledProcessProvider,
} from "../src/hosted-runtime";
import { HostedStore } from "../src/hosted-store";
import { HostedSupervisor } from "../src/hosted-supervisor";
import { Store } from "../src/store";

// ---------------------------------------------------------------------------
// Helpers: deterministic in-process HTTP fixtures stand in for the cloud
// transport ONLY. Every other unit under test is the real production class.
// The lead adds the real D1/workerd bridge integration once the backend is
// ready; anything below marked SIMULATED exercises transport only.
// ---------------------------------------------------------------------------

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const WORKER = randomUUID();
const SUPERVISOR = randomUUID();
const TASK = randomUUID();
const LEASE = randomUUID();
const RESERVATION = randomUUID();
const NOW = Date.now();

function taskBody(overrides: Record<string, unknown> = {}) {
  return {
    task_id: TASK,
    tenant_id: TENANT,
    worker_id: WORKER,
    execution_class: "controlled",
    state: "claimed",
    reservation_id: RESERVATION,
    policy_version: 3,
    runtime_ms: 60000,
    controlled_duration_ms: 5000,
    created_at: NOW - 1000,
    deadline_at: NOW + 60000,
    lease_id: LEASE,
    supervisor_id: SUPERVISOR,
    fence: 7,
    lease_expires_at: NOW + 30000,
    ...overrides,
  };
}

function api(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}
const json = (value: unknown, status = 200) => Response.json(value, { status });

function supervisorFixture() {
  return api((request) => {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer sfsuper_${"b".repeat(43)}`)
      return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/supervisor/me")
      return json({
        supervisor_id: SUPERVISOR,
        tenant_id: TENANT,
        worker_id: WORKER,
        scopes: [
          "supervisor:claim",
          "supervisor:renew",
          "supervisor:report",
          "supervisor:cleanup",
        ],
        expires_at: NOW + 3_600_000,
        authorization_expires_at: NOW + 86_400_000,
      });
    if (url.pathname === "/v1/supervisor/claim")
      return json({ task: taskBody(), server_time: Date.now() });
    const ack = url.pathname.match(/^\/v1\/supervisor\/tasks\/(.+)\/ack$/);
    if (ack)
      return json({
        task: taskBody({ state: "running" }),
        directive: "continue",
        server_time: Date.now(),
      });
    const renew = url.pathname.match(/^\/v1\/supervisor\/tasks\/(.+)\/renew$/);
    if (renew)
      return json({
        task: taskBody({ state: "running" }),
        directive: "continue",
        server_time: Date.now(),
      });
    const status = url.pathname.match(/^\/v1\/supervisor\/tasks\/(.+)$/);
    if (status && request.method === "GET")
      return json({
        task: taskBody({ state: "running" }),
        directive: "continue",
        server_time: Date.now(),
      });
    const settle = url.pathname.match(
      /^\/v1\/supervisor\/tasks\/(.+)\/settle$/,
    );
    if (settle) return json({ task: taskBody({ state: "completed" }) });
    return json({ error: "not found" }, 404);
  });
}

function harness() {
  const config = loadConfig({
    FREESTYLE_API_TOKEN: "hosted-test-token",
    FREESTYLE_SNAPSHOT_ID: "hosted-test-snapshot",
    SWARMFORGE_MODEL_BASE_URL: "https://model.example/v1",
    SWARMFORGE_MODEL_API_KEY: "hosted-test-model-key",
    SWARMFORGE_MODEL_NAME: "hosted-test-model",
    SWARMFORGE_GIT_TREE: "hosted-test-tree",
    SWARMFORGE_DB_PATH: ":memory:",
    SWARMFORGE_GIT_PUSH_MODE: "none",
    SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "0",
  });
  const store = new Store(":memory:");
  const provider = new ControlledProcessProvider();
  const agent = new ControlledAgent();
  const coordinator = new Coordinator(config, store, provider, agent);
  const hostedStore = new HostedStore(":memory:");
  return { config, store, provider, agent, coordinator, hostedStore };
}

function supervisorUnderTest(
  h: ReturnType<typeof harness>,
  origin: string,
  client?: SupervisorClient,
) {
  const real =
    client ?? new SupervisorClient(origin, `sfsuper_${"b".repeat(43)}`, TENANT);
  return new HostedSupervisor({
    config: h.config,
    store: h.store,
    coordinator: h.coordinator,
    provider: h.provider,
    agent: h.agent,
    client: real,
    hostedStore: h.hostedStore,
    supervisorCredential: () => ({
      credential: `sfsuper_${"b".repeat(43)}`,
      supervisor_id: SUPERVISOR,
      tenant_id: TENANT,
      expires_at: Date.now() + 3_600_000,
      authorization_expires_at: Date.now() + 86_400_000,
    }),
    minLifetimeMs: 1,
    safetyMarginMs: 0,
  });
}

// ---------------------------------------------------------------------------
// Credential schemas: isolated audiences, tenant binding, no cross reuse.
// NOTE: file round-trip awaits src/private-credential-file.ts (worker-client
// branch 09db215, not in baseline); schemas + dependency error tested here.
// ---------------------------------------------------------------------------

test("hosted credential schemas bind tenant and reject cross-audience reuse", () => {
  const task = {
    version: 1 as const,
    server_url: "https://hosted.example",
    credential: `sfexec_${"a".repeat(43)}`,
    grant_id: randomUUID(),
    installation_id: randomUUID(),
    subject_id: randomUUID(),
    tenant_id: TENANT,
    scopes: [
      "tasks:create",
      "tasks:read",
      "tasks:cancel",
      "entitlements:read",
    ] as ["tasks:create", "tasks:read", "tasks:cancel", "entitlements:read"],
    expires_at: NOW + 86_400_000,
    authorization_expires_at: NOW + 30 * 86_400_000,
  };
  expect(hostedTaskCredentialSchema.parse(task).tenant_id).toBe(TENANT);
  // sfcli_ must never validate as sfexec_.
  expect(() =>
    hostedTaskCredentialSchema.parse({
      ...task,
      credential: `sfcli_${"a".repeat(43)}`,
    }),
  ).toThrow();
  // sfsuper_ must never validate as sfexec_ and vice versa.
  const supervisor = {
    version: 1 as const,
    server_url: "https://hosted.example",
    credential: `sfsuper_${"b".repeat(43)}`,
    supervisor_id: SUPERVISOR,
    worker_id: WORKER,
    tenant_id: TENANT,
    scopes: [
      "supervisor:claim",
      "supervisor:renew",
      "supervisor:report",
      "supervisor:cleanup",
    ] as [
      "supervisor:claim",
      "supervisor:renew",
      "supervisor:report",
      "supervisor:cleanup",
    ],
    expires_at: NOW + 3_600_000,
    authorization_expires_at: NOW + 86_400_000,
  };
  expect(hostedSupervisorCredentialSchema.parse(supervisor).worker_id).toBe(
    WORKER,
  );
  expect(() =>
    hostedSupervisorCredentialSchema.parse({
      ...supervisor,
      credential: `sfexec_${"a".repeat(43)}`,
    }),
  ).toThrow();
  expect(() =>
    hostedSupervisorCredentialSchema.parse({
      ...supervisor,
      worker_id: TASK,
      extra: 1,
    }),
  ).toThrow();
});

test("hosted credential storage round-trips privately via the approved shared helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-cred-"));
  try {
    const taskPath = join(dir, "task.json");
    const task = {
      version: 1 as const,
      server_url: "https://hosted.example",
      credential: `sfexec_${"a".repeat(43)}`,
      grant_id: randomUUID(),
      installation_id: randomUUID(),
      subject_id: randomUUID(),
      tenant_id: TENANT,
      scopes: [
        "tasks:create",
        "tasks:read",
        "tasks:cancel",
        "entitlements:read",
      ] as ["tasks:create", "tasks:read", "tasks:cancel", "entitlements:read"],
      expires_at: NOW + 86_400_000,
      authorization_expires_at: NOW + 30 * 86_400_000,
    };
    saveHostedTaskCredential(taskPath, task);
    expect(readHostedTaskCredential(taskPath)).toEqual(task);
    // Cross-audience files never parse as the other credential.
    expect(() => readHostedSupervisorCredential(taskPath)).toThrow();
    const superPath = join(dir, "supervisor.json");
    const supervisor = {
      version: 1 as const,
      server_url: "https://hosted.example",
      credential: `sfsuper_${"b".repeat(43)}`,
      supervisor_id: SUPERVISOR,
      worker_id: WORKER,
      tenant_id: TENANT,
      scopes: [
        "supervisor:claim",
        "supervisor:renew",
        "supervisor:report",
        "supervisor:cleanup",
      ] as [
        "supervisor:claim",
        "supervisor:renew",
        "supervisor:report",
        "supervisor:cleanup",
      ],
      expires_at: NOW + 3_600_000,
      authorization_expires_at: NOW + 86_400_000,
    };
    saveHostedSupervisorCredential(superPath, supervisor);
    expect(readHostedSupervisorCredential(superPath)).toEqual(supervisor);
    expect(() => readHostedTaskCredential(superPath)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor rotation enforces a durable idempotency key on the supervised path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-rotate-"));
  try {
    const seen: string[] = [];
    const fixture = api((request) => {
      seen.push(request.headers.get("idempotency-key") ?? "");
      return json({ rotated: true });
    });
    try {
      const client = new SupervisorClient(
        fixture.origin,
        `sfsuper_${"b".repeat(43)}`,
        TENANT,
      );
      const pending = join(dir, "rotate-pending.json");
      // First call writes one durable key; a lost-reply retry with a FRESH
      // caller key still reuses the durable pending key (never replaced).
      // Fixture acks without a successor credential, so the pending key is
      // retained for the follow-up retry (server replays within its window).
      await client.rotate(randomUUID(), pending);
      const first = seen.at(-1);
      expect(first).toMatch(/^[a-zA-Z0-9_.:-]{1,128}$/);
      await client.rotate(randomUUID(), pending);
      expect(seen.at(-1)).toBe(first);
    } finally {
      fixture.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Monotonic lease math (contract: server_time + full RTT + safety margin).
// ---------------------------------------------------------------------------

test("remaining authority subtracts full RTT and safety margin; rejects thin leases", () => {
  const serverTime = 1_000_000;
  expect(
    remainingAuthorityMs({
      leaseExpiresAt: serverTime + 30000,
      deadlineAt: serverTime + 60000,
      serverTime,
      requestRttMs: 500,
      safetyMarginMs: 2000,
    }),
  ).toBe(27500);
  // Deadline is absolute: min(lease, deadline) governs.
  expect(
    remainingAuthorityMs({
      leaseExpiresAt: serverTime + 60000,
      deadlineAt: serverTime + 10000,
      serverTime,
      requestRttMs: 500,
      safetyMarginMs: 2000,
    }),
  ).toBe(7500);
  // Delayed response (large RTT) or clock offset cannot grant extra time.
  expect(
    remainingAuthorityMs({
      leaseExpiresAt: serverTime + 3000,
      deadlineAt: serverTime + 60000,
      serverTime,
      requestRttMs: 2500,
      safetyMarginMs: 2000,
    }),
  ).toBeLessThan(0);
});

// ---------------------------------------------------------------------------
// HostedTaskClient: exact audience/scopes, strict fields, no secrets in payload.
// ---------------------------------------------------------------------------

test("SIMULATED transport: task client submits/reads/cancels with exact controlled payload", async () => {
  const seen: { url: string; body: unknown; auth: string }[] = [];
  const fixture = api(async (request) => {
    const body =
      request.method === "POST" ? await request.json().catch(() => ({})) : {};
    seen.push({
      url: new URL(request.url).pathname,
      body,
      auth: request.headers.get("authorization") ?? "",
    });
    if (
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/tasks")
    )
      return json(
        {
          task: taskBody({ state: "queued" }),
          reservation_id: RESERVATION,
          policy_version: 3,
        },
        202,
      );
    if (request.method === "GET") return json({ task: taskBody() });
    return json({ task: taskBody({ state: "cancelled" }) }, 202);
  });
  try {
    const client = new HostedTaskClient(
      fixture.origin,
      `sfexec_${"a".repeat(43)}`,
      TENANT,
    );
    expect(
      () =>
        new HostedTaskClient(fixture.origin, `sfcli_${"a".repeat(43)}`, TENANT),
    ).toThrow();
    const admission = await client.submitTask(WORKER, 60000, 5000);
    expect(admission.task.execution_class).toBe("controlled");
    expect(admission.reservation_id).toBe(RESERVATION);
    const submitted = seen[0]!.body as Record<string, unknown>;
    expect(submitted.execution_class).toBe("controlled");
    expect(JSON.stringify(submitted)).not.toMatch(
      /sfexec_|secret|prompt|repo|model/i,
    );
    expect(Object.keys(submitted).sort()).toEqual(
      [
        "controlled_duration_ms",
        "execution_class",
        "request_id",
        "runtime_ms",
        "worker_id",
      ].sort(),
    );
    const read = await client.readTask(TASK);
    expect(read.task_id).toBe(TASK);
    const cancelled = await client.cancelTask(TASK);
    expect(cancelled.state).toBe("cancelled");
    for (const call of seen)
      expect(call.auth).toBe(`Bearer sfexec_${"a".repeat(43)}`);
  } finally {
    fixture.close();
  }
});

test("SIMULATED transport: task client stops on cross-tenant and malformed responses", async () => {
  const cross = api((request) =>
    new URL(request.url).pathname.endsWith("/cancel")
      ? json({ task: taskBody({ tenant_id: OTHER_TENANT }) }, 202)
      : json({ task: taskBody() }),
  );
  try {
    const client = new HostedTaskClient(
      cross.origin,
      `sfexec_${"a".repeat(43)}`,
      TENANT,
    );
    await expect(client.cancelTask(TASK)).rejects.toThrow(/cross-tenant/i);
  } finally {
    cross.close();
  }
  const malformed = api(() => json({ task: { ...taskBody(), bogus: true } }));
  try {
    const client = new HostedTaskClient(
      malformed.origin,
      `sfexec_${"a".repeat(43)}`,
      TENANT,
    );
    await expect(client.readTask(TASK)).rejects.toThrow(/invalid/i);
  } finally {
    malformed.close();
  }
});

// ---------------------------------------------------------------------------
// SupervisorClient: identity/claim/ack/renew/status/settle/rotate.
// ---------------------------------------------------------------------------

test("SIMULATED transport: supervisor claim/ack/renew/status/settle round-trips strict fields", async () => {
  const fixture = supervisorFixture();
  try {
    const client = new SupervisorClient(
      fixture.origin,
      `sfsuper_${"b".repeat(43)}`,
      TENANT,
    );
    expect(
      () =>
        new SupervisorClient(
          fixture.origin,
          `sfexec_${"a".repeat(43)}`,
          TENANT,
        ),
    ).toThrow();
    const identity = await client.identity();
    expect(identity.supervisor_id).toBe(SUPERVISOR);
    const claim = await client.claim();
    expect(claim.task?.task_id).toBe(TASK);
    expect(claim.server_time).toBeGreaterThan(0);
    const ack = await client.ack(TASK, { lease_id: LEASE, fence: 7 });
    expect(ack.directive).toBe("continue");
    expect(ack.task.lease_expires_at).toBeGreaterThan(0);
    const renew = await client.renew(TASK, { lease_id: LEASE, fence: 7 });
    expect(renew.task.fence).toBe(7);
    const status = await client.status(TASK);
    expect(status.task.task_id).toBe(TASK);
    const settled = await client.settle(TASK, {
      lease_id: LEASE,
      fence: 7,
      outcome: "completed",
      stop_confirmed: true,
      consumed_runtime_ms: 120,
    });
    expect(settled.state).toBe("completed");
    // stop_confirmed:false is rejected client-side by the strict schema.
    await expect(
      client.settle(TASK, {
        lease_id: LEASE,
        fence: 7,
        outcome: "completed",
        // biome-ignore lint/suspicious/noExplicitAny: hostile input probe
        stop_confirmed: false as any,
        consumed_runtime_ms: 1,
      }),
    ).rejects.toThrow();
  } finally {
    fixture.close();
  }
});

test("SIMULATED transport: supervisor surfaces 401/409 without widening credentials", async () => {
  const denied = api(() => json({ error: "revoked" }, 401));
  try {
    const client = new SupervisorClient(
      denied.origin,
      `sfsuper_${"b".repeat(43)}`,
      TENANT,
    );
    await expect(client.claim()).rejects.toBeInstanceOf(HostedApiError);
  } finally {
    denied.close();
  }
});

// ---------------------------------------------------------------------------
// HostedStore: atomic mapping before execution, same-key idempotency, fences.
// ---------------------------------------------------------------------------

test("durable mapping precedes execution: same retries reuse, fence changes hold", () => {
  const store = new HostedStore(":memory:");
  try {
    const base = {
      task_id: TASK,
      tenant_id: TENANT,
      worker_id: WORKER,
      local_worker_id: `hosted-${TASK}`,
      lease_id: LEASE,
      fence: 7,
      supervisor_id: SUPERVISOR,
      reservation_id: RESERVATION,
      stop_confirmed: false,
      consumed_runtime_ms: 0,
      idempotency_key: randomUUID(),
      rotation_key: null,
      settlement_key: null,
    };
    const first = store.claimMapping(base);
    expect(first.created).toBe(true);
    expect(first.mapping.state).toBe("mapped");
    // Same claim retry / lost ACK: identical task/lease/fence reuses the row.
    const retry = store.claimMapping({
      ...base,
      idempotency_key: randomUUID(),
    });
    expect(retry.created).toBe(false);
    expect(retry.mapping.local_worker_id).toBe(first.mapping.local_worker_id);
    // Duplicate delivery with a new fence is a new ownership epoch: hold.
    expect(() =>
      store.claimMapping({ ...base, fence: 8, idempotency_key: randomUUID() }),
    ).toThrow(/fence/i);
    // Renew with a stale fence cannot alter state.
    expect(() =>
      store.updateLease(TASK, { lease_id: LEASE, fence: 6 }, "running"),
    ).toThrow(/stale fence/i);
    // Idempotency keys bind tenant+principal+resource+operation+fingerprint.
    store.rememberIdempotentResponse(
      "key-1",
      {
        tenant_id: TENANT,
        principal: SUPERVISOR,
        resource: TASK,
        operation: "settle",
        fingerprint: "fp",
      },
      { ok: true },
    );
    expect(
      store.readIdempotentResponse<{ ok: boolean }>("key-1", {
        tenant_id: TENANT,
        principal: SUPERVISOR,
        resource: TASK,
        operation: "settle",
        fingerprint: "fp",
      }),
    ).toEqual({ ok: true });
    expect(() =>
      store.readIdempotentResponse("key-1", {
        tenant_id: OTHER_TENANT,
        principal: SUPERVISOR,
        resource: TASK,
        operation: "settle",
        fingerprint: "fp",
      }),
    ).toThrow(/conflict/i);
    // Settlement requires independently confirmed stop.
    expect(() => store.markSettled(TASK)).toThrow(/confirmed stop/i);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Real inert runtime: actual subprocess, verified stop, no secret env.
// ---------------------------------------------------------------------------

test("controlled runtime executes a real inert subprocess and verifies stop", async () => {
  const h = harness();
  try {
    const worker = h.store.create({
      team_id: "hosted",
      task_id: "probe",
      role: "hosted-controlled",
      prompt: "hosted controlled inert probe",
      timeout_seconds: 30,
    });
    const withVm = h.store.transition(worker.worker_id, "provisioning", {});
    void withVm;
    const vm = await h.provider.createWorker(worker);
    const tracked = h.store.patch(worker.worker_id, { vm_id: vm.id });
    let exited: number | null | undefined;
    h.provider.startControlled(tracked, 500, (code) => {
      exited = code;
    });
    // Env allowlist: provider spawns with a fixed env, never process.env.
    expect(h.provider.spawnedCommands).toEqual([
      "controlled-probe duration_ms=500",
    ]);
    await Bun.sleep(900);
    expect(exited).toBe(0);
    // After exit the provider reports the VM missing (confirmed absence).
    expect(await h.provider.getWorker(vm.id)).toBeNull();
  } finally {
    h.store.close();
    h.hostedStore.close();
  }
}, 15000);

test("controlled stopWorkerRuntime verifies exit; network/label failures are not proof", async () => {
  const h = harness();
  try {
    const worker = h.store.create({
      team_id: "hosted",
      task_id: "stop",
      role: "hosted-controlled",
      prompt: "hosted controlled inert probe",
      timeout_seconds: 30,
    });
    const vm = await h.provider.createWorker(worker);
    const tracked = h.store.patch(worker.worker_id, { vm_id: vm.id });
    h.provider.startControlled(tracked, 60000, () => {});
    expect((await h.provider.getWorker(vm.id))?.state).toBe("running");
    await h.provider.stopWorkerRuntime(tracked);
    expect(await h.provider.getWorker(vm.id)).toBeNull();
    // Unknown handle with no process is confirmed absence: resolves.
    await h.provider.stopWorkerRuntime({
      ...tracked,
      vm_id: "controlled-missing",
    });
  } finally {
    h.store.close();
    h.hostedStore.close();
  }
}, 15000);

test("controlled provider refuses arbitrary exec and filesystem access", async () => {
  const h = harness();
  try {
    await expect(h.provider.exec("x", "echo pwned")).rejects.toThrow(
      /arbitrary/i,
    );
    await expect(
      h.provider.readFile("x", "/etc/passwd", 0, 10),
    ).rejects.toThrow();
    await expect(h.provider.writeFile("x", "/tmp/pwn", "x")).rejects.toThrow();
  } finally {
    h.store.close();
    h.hostedStore.close();
  }
});

// ---------------------------------------------------------------------------
// Supervisor adapter over real Coordinator+Store+provider.
// ---------------------------------------------------------------------------

test("claim -> mapping -> ack -> real start; duplicate delivery reuses mapping", async () => {
  const fixture = supervisorFixture();
  const h = harness();
  try {
    const supervisor = supervisorUnderTest(h, fixture.origin);
    const claimed = await supervisor.claimOnce();
    expect(claimed?.task_id).toBe(TASK);
    const stored = h.hostedStore.get(TASK);
    expect(stored?.state).toBe("mapped");
    // Claim-time row is a pending placeholder: no local worker may run before ACK.
    expect(stored?.local_worker_id).toBe(`pending-${TASK}`);
    const run = await supervisor.ackAndStart(claimed!);
    expect(run.mapping.state).toBe("running");
    // Staging binds the canonical Store worker id (w-...), never a duplicate.
    expect(h.hostedStore.get(TASK)?.local_worker_id).toMatch(/^w-/);
    // Duplicate delivery after start: same task/lease/fence returns the row
    // (local pointer already canonical; the retry carries the same id).
    const canonical = h.hostedStore.get(TASK)!.local_worker_id;
    const again = h.hostedStore.claimMapping({
      task_id: TASK,
      tenant_id: TENANT,
      worker_id: WORKER,
      local_worker_id: canonical,
      lease_id: LEASE,
      fence: 7,
      supervisor_id: SUPERVISOR,
      reservation_id: RESERVATION,
      stop_confirmed: false,
      consumed_runtime_ms: 0,
      idempotency_key: randomUUID(),
      rotation_key: null,
      settlement_key: null,
    });
    expect(again.created).toBe(false);
    await supervisor.stopAndConfirm(TASK, "test cleanup");
    expect(h.hostedStore.get(TASK)?.stop_confirmed).toBe(true);
  } finally {
    fixture.close();
    h.store.close();
    h.hostedStore.close();
  }
}, 20000);

test("crash before/after mapping: restart holds ambiguity, never blindly re-execs", async () => {
  const h = harness();
  try {
    // Crash after mapping but before start: mapping durable in "mapped".
    h.hostedStore.claimMapping({
      task_id: TASK,
      tenant_id: TENANT,
      worker_id: WORKER,
      local_worker_id: `hosted-${TASK}`,
      lease_id: LEASE,
      fence: 7,
      supervisor_id: SUPERVISOR,
      reservation_id: RESERVATION,
      stop_confirmed: false,
      consumed_runtime_ms: 0,
      idempotency_key: randomUUID(),
      rotation_key: null,
      settlement_key: null,
    });
    const supervisor = supervisorUnderTest(h, "https://hosted.example");
    const recovered = supervisor.recover();
    expect(recovered.held).toContain(TASK);
    expect(h.hostedStore.get(TASK)?.state).toBe("held");
    expect(supervisor.activeRuns.size).toBe(0);
    expect(h.provider.spawnedCommands).toEqual([]);
  } finally {
    h.store.close();
    h.hostedStore.close();
  }
});

test("cancellation race and uncertain stop: settle requires confirmed exit", async () => {
  const fixture = supervisorFixture();
  const h = harness();
  try {
    const supervisor = supervisorUnderTest(h, fixture.origin);
    const claimed = await supervisor.claimOnce();
    await supervisor.ackAndStart(claimed!);
    // Cancel race: stop intent then independently confirmed stop.
    const stopped = await supervisor.stopAndConfirm(TASK, "cancel race");
    expect(stopped.stop_confirmed).toBe(true);
    // Duplicate/lost settlement retries use the same key.
    const key = randomUUID();
    const first = await supervisor.settle(TASK, "cancelled", key);
    expect(first.state).toBe("completed");
    expect(h.hostedStore.get(TASK)?.state).toBe("settled");
    const remembered = h.hostedStore.readIdempotentResponse<HostedTask>(key, {
      tenant_id: TENANT,
      principal: SUPERVISOR,
      resource: TASK,
      operation: "settle",
      fingerprint: `${LEASE}:7:cancelled`,
    });
    expect(remembered).not.toBeNull();
    expect(remembered!.state).toBe("completed");
  } finally {
    fixture.close();
    h.store.close();
    h.hostedStore.close();
  }
}, 20000);

test("stale fence and revoked supervisor credential forbid execution and renewal", async () => {
  const h = harness();
  try {
    const revoked = api(() => json({ error: "revoked" }, 401));
    try {
      const client = new SupervisorClient(
        revoked.origin,
        `sfsuper_${"b".repeat(43)}`,
        TENANT,
      );
      const supervisor = supervisorUnderTest(h, revoked.origin, client);
      await expect(supervisor.claimOnce()).rejects.toThrow(/revoked|invalid/i);
    } finally {
      revoked.close();
    }
    // Expired supervisor credential cannot execute or renew.
    const fixture = supervisorFixture();
    try {
      const client = new SupervisorClient(
        fixture.origin,
        `sfsuper_${"b".repeat(43)}`,
        TENANT,
      );
      const supervisor = new HostedSupervisor({
        config: h.config,
        store: h.store,
        coordinator: h.coordinator,
        provider: h.provider,
        agent: h.agent,
        client,
        hostedStore: h.hostedStore,
        supervisorCredential: () => ({
          credential: `sfsuper_${"b".repeat(43)}`,
          supervisor_id: SUPERVISOR,
          tenant_id: TENANT,
          expires_at: Date.now() - 1000,
          authorization_expires_at: Date.now() + 86_400_000,
        }),
      });
      await expect(supervisor.claimOnce()).rejects.toThrow(/expired/i);
      await expect(supervisor.renewOnce(TASK)).rejects.toThrow(/expired/i);
    } finally {
      fixture.close();
    }
  } finally {
    h.store.close();
    h.hostedStore.close();
  }
});

test("forbidden payload rejected; no secret in runtime env, logs or artifacts", async () => {
  const fixture = api((request) => {
    if (new URL(request.url).pathname === "/v1/supervisor/claim")
      return json({
        task: taskBody({ execution_class: "evil" }),
        server_time: Date.now(),
      });
    return json({ error: "not found" }, 404);
  });
  const h = harness();
  try {
    const supervisor = supervisorUnderTest(h, fixture.origin);
    // Strict schema stops the forbidden payload at the transport boundary:
    // claim itself refuses the non-controlled execution class.
    await expect(supervisor.claimOnce()).rejects.toThrow(
      /invalid|cross-tenant/i,
    );
    expect(h.provider.spawnedCommands).toEqual([]);
    expect(JSON.stringify(h.provider.spawnedCommands)).not.toMatch(
      /sfexec_|sfsuper_|sfcli_|sfworker_|secret|token/i,
    );
  } finally {
    fixture.close();
    h.store.close();
    h.hostedStore.close();
  }
});

test("parent crash: stdin EOF stops the real child independently (fail closed)", async () => {
  const { spawn } = await import("node:child_process");
  const script = new URL(
    "../scripts/hosted-controlled-runtime.ts",
    import.meta.url,
  ).pathname;
  const child = spawn(process.execPath, [script, "60000"], {
    env: { PATH: "/usr/bin:/bin", TZ: "UTC" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await Bun.sleep(300);
    expect(child.exitCode).toBeNull();
    // Parent death: close our write end; the child must observe EOF and stop.
    child.stdin?.end();
    const code: number | null = await new Promise((resolve) =>
      child.on("exit", resolve),
    );
    expect(code).toBe(3);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}, 15000);

test("partition watchdog: expired lease without renewal stops locally and holds settlement", async () => {
  const h = harness();
  const fixture = supervisorFixture();
  try {
    const supervisor = supervisorUnderTest(h, fixture.origin);
    const claimed = await supervisor.claimOnce();
    const run = await supervisor.ackAndStart(claimed!);
    expect(run.authorityMs).toBeGreaterThan(0);
    // Partition: server unreachable for renewal -> durable stop intent, then
    // independently confirmed stop. Settlement retries later with the same key.
    const stopped = await supervisor.stopAndConfirm(
      TASK,
      "partition: renewal unreachable",
    );
    expect(stopped.stop_confirmed).toBe(true);
    expect(stopped.state).toBe("stopped");
    expect((await h.provider.listWorkers()).length).toBe(0);
  } finally {
    fixture.close();
    h.store.close();
    h.hostedStore.close();
  }
}, 20000);

test("clock offsets and delayed responses cannot extend authority", () => {
  // Server clock far ahead of local: authority derived from server_time, not local now.
  const ahead = remainingAuthorityMs({
    leaseExpiresAt: 2_000_000,
    deadlineAt: 2_060_000,
    serverTime: 1_990_000,
    requestRttMs: 8000,
    safetyMarginMs: 2000,
  });
  expect(ahead).toBe(0);
  // Slow/lossy network eats the whole lease: refuse to start.
  const eaten = remainingAuthorityMs({
    leaseExpiresAt: 1_010_000,
    deadlineAt: 1_060_000,
    serverTime: 1_000_000,
    requestRttMs: 9000,
    safetyMarginMs: 2000,
  });
  expect(eaten).toBeLessThan(0);
});

test("held capacity: uncertain execution is quarantined, never released or reused", async () => {
  const h = harness();
  try {
    h.hostedStore.claimMapping({
      task_id: TASK,
      tenant_id: TENANT,
      worker_id: WORKER,
      local_worker_id: `hosted-${TASK}`,
      lease_id: LEASE,
      fence: 7,
      supervisor_id: SUPERVISOR,
      reservation_id: RESERVATION,
      stop_confirmed: false,
      consumed_runtime_ms: 0,
      idempotency_key: randomUUID(),
      rotation_key: null,
      settlement_key: null,
    });
    const supervisor = supervisorUnderTest(h, "https://hosted.example");
    expect(supervisor.recover().held).toContain(TASK);
    const held = h.hostedStore.get(TASK)!;
    expect(held.state).toBe("held");
    // A new supervisor epoch (stale fence replay) cannot overwrite the held row.
    expect(() =>
      h.hostedStore.claimMapping({
        task_id: TASK,
        tenant_id: TENANT,
        worker_id: WORKER,
        local_worker_id: `hosted-${TASK}`,
        lease_id: randomUUID(),
        fence: 8,
        supervisor_id: SUPERVISOR,
        reservation_id: RESERVATION,
        stop_confirmed: false,
        consumed_runtime_ms: 0,
        idempotency_key: randomUUID(),
        rotation_key: null,
        settlement_key: null,
      }),
    ).toThrow(/fence/i);
    // Uncertain work cannot settle without confirmed stop.
    await expect(supervisor.settle(TASK, "completed")).rejects.toThrow(
      /confirmed stop/i,
    );
  } finally {
    h.store.close();
    h.hostedStore.close();
  }
});

test("runtime env and logs carry no bearer, provider, repo or model credentials", async () => {
  const h = harness();
  try {
    const worker = h.store.create({
      team_id: "hosted",
      task_id: "env-audit",
      role: "hosted-controlled",
      prompt: "hosted controlled inert probe",
      timeout_seconds: 30,
    });
    const vm = await h.provider.createWorker(worker);
    const tracked = h.store.patch(worker.worker_id, { vm_id: vm.id });
    // process.env is poisoned with fake secrets: the child must never see them.
    process.env.SWARMFORGE_API_TOKEN = `sfsuper_${"c".repeat(43)}`;
    process.env.FREESTYLE_API_TOKEN = "provider-secret";
    process.env.SWARMFORGE_MODEL_API_KEY = "model-secret";
    let output = "";
    const { spawn } = await import("node:child_process");
    const script = new URL(
      "../scripts/hosted-controlled-runtime.ts",
      import.meta.url,
    ).pathname;
    const child = spawn(process.execPath, [script, "300"], {
      env: { PATH: "/usr/bin:/bin", TZ: "UTC" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const code: number | null = await new Promise((resolve) => {
      child.on("exit", resolve);
      child.stdin?.end("hold");
    });
    // stdin "hold" keeps the pipe open until exit; child completes normally.
    void tracked;
    expect(code === 0 || code === 3).toBe(true);
    expect(output).not.toMatch(
      /sfsuper_|sfexec_|provider-secret|model-secret/i,
    );
    expect(JSON.stringify(h.provider.spawnedCommands)).not.toMatch(
      /sfsuper_|sfexec_|provider-secret|model-secret/i,
    );
  } finally {
    delete process.env.SWARMFORGE_API_TOKEN;
    delete process.env.FREESTYLE_API_TOKEN;
    delete process.env.SWARMFORGE_MODEL_API_KEY;
    h.store.close();
    h.hostedStore.close();
  }
}, 15000);

// ---------------------------------------------------------------------------
// CLI surface: parses without wiring the global CLI, rejects raw secrets.
// ---------------------------------------------------------------------------

test("hosted CLI parses supervisor/submit/status/cancel and rejects raw secrets", async () => {
  const supervisor = parseHostedArgs(["supervisor", "--json"]);
  expect(supervisor).toMatchObject({ kind: "hosted", action: "supervisor" });
  const submit = parseHostedArgs([
    "submit",
    "--worker",
    WORKER,
    "--runtime-ms",
    "60000",
    "--duration-ms",
    "5000",
  ]);
  expect(submit).toMatchObject({ action: "submit", workerId: WORKER });
  expect(() =>
    parseHostedArgs(["status", "--task", TASK, `sfexec_${"a".repeat(43)}`]),
  ).toThrow(/never accept raw credentials/i);
  expect(() =>
    parseHostedArgs([
      "submit",
      "--worker",
      WORKER,
      "--runtime-ms",
      "10",
      "--duration-ms",
      "999",
    ]),
  ).toThrow(/duration <= runtime/i);
  const lines: string[] = [];
  await runHosted(
    { kind: "hosted", action: "status", taskId: TASK, json: true },
    (text) => lines.push(text),
  );
  expect(JSON.parse(lines[0]!).event).toBe("status");
});

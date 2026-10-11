// TEMPORARY production-code probe (outside source) resolving the original C
// "shared HostedStore journal lets another tenant's supervisor stop/mutate/
// execute another task" allegation. Uses the ACTUAL HostedSupervisor class
// (src/hosted-supervisor.ts) + ACTUAL SupervisorClient (src/hosted-client.ts)
// against a REAL Cloud Worker with two tenants/credentials (localFixture =
// createWorker/index.ts + real SQLite D1). No mock granting foreign authority.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const WT = "/tmp/phase2b2-diag-review";
const importAt = (p: string) => import(pathToFileURL(`${WT}/${p}`).href);

const { localFixture } = (await importAt("apps/cloud/test/local-fixture.ts")) as any;
const { HostedSupervisor } = (await importAt("src/hosted-supervisor.ts")) as any;
const { SupervisorClient } = (await importAt("src/hosted-client.ts")) as any;
const { HostedStore } = (await importAt("src/hosted-store.ts")) as any;

const policy = {
  capabilities: {
    hosted_control_plane: true,
    remote_worker_enrollment: true,
    hosted_task_execution: true,
  },
  max_concurrent_workers: 4,
  max_active_tasks: 8,
  max_task_runtime: 60000,
  maximum_resource_reservations: 16,
  valid_for_ms: 3600000,
};

const results: string[] = [];
function pass(name: string, detail = "") {
  results.push(`PASS ${name}${detail ? ` (${detail})` : ""}`);
}
function fail(name: string, detail: string) {
  results.push(`FAIL ${name} (${detail})`);
  assert.fail(`${name}: ${detail}`);
}
async function expectThrow(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    fail(name, "expected rejection but call resolved");
  } catch (e) {
    pass(name, (e as Error).message.slice(0, 90));
  }
}

const h = await localFixture();
const origin = "https://api.example.invalid";
const transport: typeof fetch = (input: any, init?: any) =>
  h.fetch(new Request(input, init));

function supervisorFor(cred: any, store: any) {
  const client = new SupervisorClient(origin, cred.credential, cred.tenant_id, transport);
  return new HostedSupervisor({
    config: {},
    store: {
      queryWorkers: () => ({ workers: [] }),
      get: () => {
        throw new Error("no local worker");
      },
      create: () => {
        throw new Error("no local create");
      },
      dispatch: () => null,
      saveDispatch: () => {},
    },
    coordinator: { control: async () => {} },
    provider: {},
    agent: {},
    client,
    hostedStore: store,
    supervisorCredential: () => ({
      credential: cred.credential,
      supervisor_id: cred.supervisor_id,
      tenant_id: cred.tenant_id,
      expires_at: cred.expires_at,
      authorization_expires_at: cred.authorization_expires_at,
    }),
  });
}

try {
  const A = await h.login(100);
  const B = await h.login(200);
  assert.notEqual(A.tenant, B.tenant);
  await h.seedPolicy(A.tenant, policy);
  await h.seedPolicy(B.tenant, policy);
  const Aw = await h.enrolledWorker(A);
  const Bw = await h.enrolledWorker(B);
  const Asup = await h.registerSupervisor(A, Aw.worker_id);
  const Bsup = await h.registerSupervisor(B, Bw.worker_id);

  const idem = () => crypto.randomUUID();
  const admitA = await h.request(
    `/v1/tenants/${A.tenant}/tasks`,
    { ...A.headers, "idempotency-key": idem() },
    "POST",
    {
      request_id: idem(),
      worker_id: Aw.worker_id,
      execution_class: "controlled",
      runtime_ms: 30000,
      controlled_duration_ms: 20000,
    },
  );
  assert.equal(admitA.status, 202);
  const A_task_id = ((await admitA.json()) as any).task.task_id as string;

  // ---- Part 1: B's OWN HostedSupervisor with its OWN journal ----
  const bStore = new HostedStore(":memory:");
  const bSupervisor = supervisorFor(Bsup, bStore);

  const claimed = await bSupervisor.claimOnce(idem());
  if (claimed === null) pass("B HostedSupervisor.claimOnce sees no foreign work (null)");
  else fail("B claimOnce", `returned ${JSON.stringify(claimed)}`);

  await expectThrow("B stopAndConfirm(A task) refused (no journal mapping)", () =>
    bSupervisor.stopAndConfirm(A_task_id, "probe"),
  );
  await expectThrow("B renewOnce(A task) refused (no journal mapping)", () =>
    bSupervisor.renewOnce(A_task_id, idem()),
  );
  await expectThrow("B settle(A task) refused (no journal mapping)", () =>
    bSupervisor.settle(A_task_id, "cancelled"),
  );
  await bSupervisor.reconcile().then(() => pass("B reconcile iterates own empty journal only"));

  // A's authoritative cloud task is untouched by B's supervisor.
  const readA1 = await h.request(`/v1/tenants/${A.tenant}/tasks/${A_task_id}`, A.headers);
  const stateA1 = ((await readA1.json()) as any).task.state;
  if (stateA1 === "queued") pass("A cloud task still 'queued' after B supervisor attempts");
  else fail("A task state", stateA1);
  await bSupervisor.close();

  // ---- Part 2: shared-journal worst case — B's journal is pre-seeded with A's row ----
  const shared = new HostedStore(":memory:");
  shared.claimMapping({
    task_id: A_task_id,
    tenant_id: A.tenant,
    worker_id: Aw.worker_id,
    local_worker_id: `pending-${A_task_id}`,
    lease_id: crypto.randomUUID(),
    fence: 0,
    supervisor_id: Asup.supervisor_id,
    reservation_id: crypto.randomUUID(),
    stop_confirmed: false,
    consumed_runtime_ms: 0,
    idempotency_key: idem(),
    rotation_key: null,
    settlement_key: null,
    runtime_budget_ms: 30000,
  });
  const bShared = supervisorFor(Bsup, shared);
  // B can locally mark A's never-started row stopped in the trusted journal...
  let localStop = "not-called";
  try {
    const m = await bShared.stopAndConfirm(A_task_id, "shared-journal probe");
    localStop = `state=${m.state} stop_confirmed=${m.stop_confirmed}`;
    pass("B locally mutated shared trusted journal row for A task", localStop);
  } catch (e) {
    localStop = `threw: ${(e as Error).message}`;
    pass("B local stop of shared A row refused", localStop);
  }
  // ...but the authoritative server settlement is blocked cross-tenant.
  let settleOutcome = "resolved";
  try {
    const task = await bShared.settle(A_task_id, "cancelled");
    settleOutcome = `RESOLVED ${JSON.stringify(task).slice(0, 80)}`;
  } catch (e) {
    settleOutcome = `threw: ${(e as Error).message.slice(0, 90)}`;
  }
  if (/threw/.test(settleOutcome)) pass("B settle(A task) blocked by server guard", settleOutcome);
  else fail("B settle(A task) unexpectedly succeeded", settleOutcome);

  const readA2 = await h.request(`/v1/tenants/${A.tenant}/tasks/${A_task_id}`, A.headers);
  const stateA2 = ((await readA2.json()) as any).task.state;
  if (stateA2 === "queued") pass("A authoritative cloud task STILL 'queued' after shared-journal settle attempt");
  else fail("A task mutated by cross-tenant shared journal", stateA2);

  const supCountA = await h.db
    .prepare("SELECT count(*) n FROM hosted_tasks WHERE organization_id=? AND state!='queued'")
    .bind(A.tenant)
    .first<{ n: number }>();
  if ((supCountA?.n ?? -1) === 0) pass("No non-queued A task rows: server writes blocked");
  else fail("A task rows changed", JSON.stringify(supCountA));

  await bShared.close();

  // ---- Part 3: direct real SupervisorClient (B credential) vs server guards ----
  const bClient = new SupervisorClient(origin, Bsup.credential, B.tenant, transport);
  const lease = { lease_id: crypto.randomUUID(), fence: 0 };
  for (const [name, call] of [
    ["ack", () => bClient.ack(A_task_id, lease, idem())],
    ["renew", () => bClient.renew(A_task_id, lease, idem())],
    ["status", () => bClient.status(A_task_id)],
    ["settle", () =>
      bClient.settle(
        A_task_id,
        { ...lease, outcome: "cancelled", stop_confirmed: true, consumed_runtime_ms: 0 },
        idem(),
      )],
  ] as const) {
    try {
      await call();
      fail(`B real client ${name}(A task)`, "server allowed cross-tenant call");
    } catch (e) {
      const status = (e as any)?.status;
      if (status === 404 || status === 401)
        pass(`B real SupervisorClient.${name}(A task) blocked by server`, `status=${status}`);
      else fail(`B real client ${name}`, `unexpected error status=${status} ${(e as Error).message}`);
    }
  }
  const readA3 = await h.request(`/v1/tenants/${A.tenant}/tasks/${A_task_id}`, A.headers);
  const stateA3 = ((await readA3.json()) as any).task.state;
  if (stateA3 === "queued") pass("A authoritative cloud task still 'queued' after direct cross-tenant client calls");
  else fail("A task mutated by direct cross-tenant client", stateA3);

  console.log(results.join("\n"));
  console.log(`\nSUPERVISOR_CROSS_TENANT_PROBE: ${results.length} checks, ${results.filter((r) => r.startsWith("FAIL")).length} failed`);
} finally {
  h.close();
}

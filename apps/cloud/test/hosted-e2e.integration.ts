import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./machine-helpers.ts";

// Phase 2B.2 hostile end-to-end admission scaffold (RED checkpoint).
//
// Joint E2E rides on the same DEFAULT production Worker + real D1/workerd as
// the adversarial file. Until the backend candidate integrates, the full
// admission→claim→ack→renew→settle path is unwired, so this file pins the
// seam probes the joint E2E stage will promote: tenant status read (wired),
// entitlement view (unwired), and admission (unwired). No Bun supervisor,
// Coordinator, Store, or fixed child is spawned in this checkpoint turn; the
// E2E bridge scaffolding (real Node Miniflare D1 HTTP listener + actual Bun
// subprocess through the worker-client loopback pattern) lands in the joint
// E2E stage after the backend candidate integrates, reading the ready
// client/factory signatures at that time.
//
// Simulated GitHub identity only (synthetic provider users); no secrets printed.

async function statusOf(response: { status: number }) {
  return response.status;
}

test("RED E2E scaffold: wired tenant read vs unwired entitlement/admission seams", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const tenant = await h.request(`/v1/tenants/${a.tenant}`, a.headers);
    assert.equal(await statusOf(tenant), 200);
    const entitlements = await h.request(
      `/v1/tenants/${a.tenant}/entitlements`,
      a.headers,
    );
    const admission = await h.request(
      `/v1/tenants/${a.tenant}/tasks`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {
        request_id: crypto.randomUUID(),
        worker_id: crypto.randomUUID(),
        execution_class: "controlled",
        runtime_ms: 10000,
        controlled_duration_ms: 100,
      },
    );
    // RED seam map: tenant authority is live (200); entitlement view and
    // admission are unwired (404 each). The joint E2E stage promotes these
    // two to their protocol replies (entitlement view / 202 AdmissionReply)
    // once the backend candidate integrates.
    assert.equal(await statusOf(entitlements), 404);
    assert.equal(await statusOf(admission), 404);
  } finally {
    await h.mf.dispose();
  }
});

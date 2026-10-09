import assert from "node:assert/strict";
import { test } from "node:test";
import { admissionReplySchema } from "../src/hosted-types.ts";
import { fixture } from "./machine-helpers.ts";

// Phase 2B.2 hostile end-to-end admission — CORRECTED RED checkpoint.
//
// The prior turn pinned seam 404s as passing assertions (rejected approach,
// preserved as test-report-rejected-7300825.md). This file asserts DESIRED
// protocol behavior: tenant read is 200 today (wired, stays green), while the
// entitlement view and the full admission path assert their protocol replies
// and FAIL until the backend wires them. The joint E2E stage (real Node
// Miniflare D1 HTTP listener + actual Bun Supervisor + Coordinator + Store +
// fixed child through real clients) lands after the backend candidate
// integrates, reading the ready client/factory signatures at that time.
//
// Simulated GitHub identity only (synthetic provider users); no secrets printed.

test("E2E admission: tenant reads 200 while entitlement view and admission assert protocol replies", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const tenant = await h.request(`/v1/tenants/${a.tenant}`, a.headers);
    assert.equal(tenant.status, 200);
    const entitlements = await h.request(
      `/v1/tenants/${a.tenant}/entitlements`,
      a.headers,
    );
    // DESIRED: 200 entitlement view (policy/denial + reserved/consumed
    // counts). TODAY: 404 => RED failure.
    assert.equal(entitlements.status, 200);
    const invite = await h.enroll(a);
    const reg = await h.register(invite);
    assert.equal(reg.status, 201);
    const worker = (await reg.json()) as { worker_id: string };
    const admission = await h.request(
      `/v1/tenants/${a.tenant}/tasks`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {
        request_id: crypto.randomUUID(),
        worker_id: worker.worker_id,
        execution_class: "controlled",
        runtime_ms: 10000,
        controlled_duration_ms: 100,
      },
    );
    // DESIRED: 202 AdmissionReply. TODAY: 404 => RED failure.
    assert.equal(admission.status, 202);
    admissionReplySchema.parse(await admission.json());
  } finally {
    await h.mf.dispose();
  }
});

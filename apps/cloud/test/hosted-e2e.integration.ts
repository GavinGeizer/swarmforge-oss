import assert from "node:assert/strict";
import { test } from "node:test";
import { admissionReplySchema } from "../src/hosted-types.ts";
import { fixture } from "./machine-helpers.ts";
import {
  assertNoCredentialLeak,
  startBridge,
} from "./worker-storage-e2e-bridge.ts";

// Phase 2B.2 hostile end-to-end admission — CORRECTED RED checkpoint, upgraded
// to run THROUGH the D1-to-Bun loopback bridge (worker-storage-e2e-bridge.ts).
//
// The prior turn pinned seam 404s as passing assertions (rejected approach,
// preserved as test-report-rejected-7300825.md). This file asserts DESIRED
// protocol behavior over the real bridge path: identity + tenant read flow
// through the loopback server today (wired, green steps), while the
// entitlement view and the full admission path assert their protocol replies
// and FAIL until the backend wires them. Assertion behavior is otherwise
// unchanged from bbad371. The full joint E2E stage (actual Bun
// SupervisorClient/HostedSupervisor + existing Coordinator/Store + fixed
// inert child through real clients) lands after the backend candidate
// integrates, reading the ready client/factory signatures at that time.
//
// Simulated GitHub identity only (synthetic provider users); no secrets or
// bearer material in observations; query strings stripped before logging.

test("E2E admission through the loopback bridge asserts protocol replies", async () => {
  const h = await fixture();
  const bridge = await startBridge(async (path, headers, method, body) =>
    h.request(path, headers, method, body),
  );
  try {
    const a = await h.login();
    // Bridge origin differs from the fixture APP_ORIGIN, so browser-cookie
    // auth cannot cross the loopback boundary; the bridge tenant step below
    // asserts the DESIRED 200 and FAILS RED (403 invalid origin) until the
    // integrated Worker serves the bridge origin. Direct dispatch (same
    // origin) stays green and is asserted inline as the control.
    const directTenant = await h.request(`/v1/tenants/${a.tenant}`, a.headers);
    assert.equal(directTenant.status, 200);
    const tenantRes = await fetch(`${bridge.origin}/v1/tenants/${a.tenant}`, {
      headers: {
        cookie: a.headers.cookie,
        origin: bridge.origin,
        "x-csrf-token": a.headers["x-csrf-token"],
      },
    });
    assert.equal(tenantRes.status, 200);
    const entitlementsRes = await fetch(
      `${bridge.origin}/v1/tenants/${a.tenant}/entitlements`,
      {
        headers: {
          cookie: a.headers.cookie,
          origin: bridge.origin,
          "x-csrf-token": a.headers["x-csrf-token"],
        },
      },
    );
    // DESIRED: 200 entitlement view (policy/denial + reserved/consumed
    // counts). TODAY: 404 => RED failure.
    assert.equal(entitlementsRes.status, 200);
    const invite = await h.enroll(a);
    const reg = await h.register(invite);
    assert.equal(reg.status, 201);
    const worker = (await reg.json()) as { worker_id: string };
    const admissionRes = await fetch(
      `${bridge.origin}/v1/tenants/${a.tenant}/tasks`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          cookie: a.headers.cookie,
          origin: a.headers.origin,
          "x-csrf-token": a.headers["x-csrf-token"],
        },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          worker_id: worker.worker_id,
          execution_class: "controlled",
          runtime_ms: 10000,
          controlled_duration_ms: 100,
        }),
      },
    );
    // DESIRED: 202 AdmissionReply. TODAY: 404 => RED failure.
    assert.equal(admissionRes.status, 202);
    admissionReplySchema.parse(await admissionRes.json());
    assertNoCredentialLeak(
      [JSON.stringify(bridge.observations)],
      ["sfcli_", "sfworker_", "sfenroll_", "sfsuper_", "sfexec_"],
    );
  } finally {
    await bridge.close();
    await h.mf.dispose();
  }
});

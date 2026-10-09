import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admissionReplySchema } from "../src/hosted-types.ts";
import { fixture } from "./machine-helpers.ts";
import {
  assertNoCredentialLeak,
  startBridge,
} from "./worker-storage-e2e-bridge.ts";

// Phase 2B.2 D1-to-Bun runtime E2E — bridge checkpoint (RED, behavior-preserving).
//
// Owns NEW test/hosted-runtime-e2e.integration.ts plus the uniquely named
// bridge helper worker-storage-e2e-bridge.ts. No product sources, no global
// router, no schema, no other-test edits. The bbad371 hostile assertions in
// hosted-adversarial/load stay behaviorally unchanged (this turn only removes
// their manual 0003 application in favor of the default all-3 fixture schema
// per compatibility789 — setup compatibility only).
//
// Bridge plan: REAL Node Miniflare/workerd D1 + actual DEFAULT production
// Cloud Worker over a loopback HTTP server with no bearer-credential logs;
// actual Bun SupervisorClient/HostedSupervisor + existing Coordinator/Store +
// fixed inert child once routing lands. Provisional adapter (explicitly
// labeled): the bridge currently fronts the fixture's production handler
// (real D1/workerd identity + machine routes); it switches to the default
// Worker with no shape change once the lead integrates approved route modules.
// Private scratch candidates (compat 7897898, foundation 7a17205, supervisor
// identity 56790bc, dispatch 55faf47, root d1b925f) were inspected read-only
// and are NOT imported: they are unapproved with known defects, so meaningful
// RED is expected until their correction commits land.
//
// Simulated GitHub identity only (synthetic provider users); synthetic
// secrets only; credential files 0600 / dirs 0700; no inherited
// repository/model/service keys in any child; each child/server shutdown
// bounded with evidence retained.

test("bridge checkpoint: provisional adapter serves real identity; admission stays RED until routing lands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swarmforge-runtime-e2e-"));
  const h = await fixture();
  const bridge = await startBridge(async (path, headers, method, body) =>
    h.request(path, headers, method, body),
  );
  try {
    // Real browser identity (synthetic GitHub provider) through the bridge.
    const start = await fetch(`${bridge.origin}/v1/auth/github`, {
      redirect: "manual",
    });
    assert.equal(start.status, 302);
    // Admission asserts the DESIRED protocol reply and FAILS RED (404) until
    // routing lands — same behavior as the bbad371 hostile assertions.
    const admission = await fetch(`${bridge.origin}/v1/tenants/x/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        worker_id: crypto.randomUUID(),
        execution_class: "controlled",
        runtime_ms: 10000,
        controlled_duration_ms: 100,
      }),
    });
    assert.equal(admission.status, 202);
    admissionReplySchema.parse(await admission.json());
    assertNoCredentialLeak(
      [JSON.stringify(bridge.observations)],
      ["sfcli_", "sfworker_", "sfenroll_", "sfsuper_", "sfexec_"],
    );
  } finally {
    await bridge.close();
    await h.mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

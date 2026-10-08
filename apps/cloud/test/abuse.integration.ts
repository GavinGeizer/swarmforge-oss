import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupIdentity } from "../src/abuse.ts";
import type { Env } from "../src/index.ts";
import { count, fixture } from "./machine-helpers.ts";

test("public starts/polls and failure audit writes are bounded, untrusted rate headers cannot bypass budgets, limiter failure denies closed", async () => {
  const h = await fixture();
  try {
    for (let i = 0; i < 10; i++) await h.start();
    const before = await count(h, "cli_links");
    const res = await h.request(
      "/v1/cli-links",
      {
        "idempotency-key": "x",
        authorization: `LinkInitiator ${"x".repeat(43)}`,
        "x-forwarded-for": "new-ip",
      },
      "POST",
      {
        client_name: "abuse",
        requested_scopes: ["identity:read", "devices:self"],
      },
    );
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"));
    assert.equal(await count(h, "cli_links"), before);
    for (let i = 0; i < 20; i++)
      assert.equal(
        (await h.request("/v1/auth/github/callback?code=secret&state=bad"))
          .status,
        400,
      );
    const audits = await h.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE action='login.failure'",
      )
      .first<{ n: number }>();
    assert.equal(audits?.n, 8);
    await h.db.prepare("DROP TABLE identity_rate_limits").run();
    assert.equal((await h.request("/v1/auth/github")).status, 503);
    assert.equal(
      (
        await h.request("/v1/cli/me", {
          authorization: `Bearer sfcli_${"x".repeat(43)}`,
        })
      ).status,
      503,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("bounded cleanup deletes expired unconsumed state/caches and preserves identity and revocation evidence", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      live = await h.linked(a),
      abandoned = await h.start(),
      invite = await h.enroll(a);
    await h.request(
      "/v1/cli/me",
      { authorization: `Bearer ${live.credential}` },
      "DELETE",
    );
    const now = Date.now() + 2 * 86400000;
    const env = { DB: h.db } as Env;
    await cleanupIdentity(env, now);
    assert.equal(await count(h, "oauth_transactions"), 0);
    assert.equal(await count(h, "identity_rate_limits"), 0);
    assert.equal(await count(h, "cli_links"), 1);
    assert.equal(await count(h, "worker_enrollments"), 0);
    assert.equal(await count(h, "cli_installations"), 1);
    assert.equal(await count(h, "machine_credentials"), 1);
    const link = await h.db
      .prepare("SELECT code_ciphertext,result_ciphertext FROM cli_links")
      .first<{ code_ciphertext: string; result_ciphertext: null }>();
    assert.equal(link?.code_ciphertext, "");
    assert.equal(link?.result_ciphertext, null);
    assert.equal(
      (
        await h.request(
          `/v1/cli-links/${abandoned.link_id}/status`,
          abandoned.headers,
        )
      ).status,
      404,
    );
    assert.equal((await h.register(invite)).status, 404);
    await cleanupIdentity(env,now);assert.equal(await count(h,"cli_installations"),1);
    const before=await count(h,"audit_events");assert.ok(before>0);
    await cleanupIdentity(env,now,now);assert.equal(await count(h,"audit_events"),0);
    assert.equal(await count(h,"cli_installations"),1);
    await assert.rejects(()=>cleanupIdentity(env,Number.NaN));
  } finally {
    await h.mf.dispose();
  }
});

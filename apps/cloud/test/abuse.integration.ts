import assert from "node:assert/strict";
import { test } from "node:test";
import { budget, cleanupIdentity } from "../src/abuse.ts";
import type { Context } from "../src/common.ts";
import { sign } from "../src/crypto.ts";
import type { Env } from "../src/index.ts";
import { count, fixture } from "./machine-helpers.ts";

const AUTH_SECRET = "test-auth-secret-with-at-least-thirty-two-characters";

// Resolve only the failure-audit budget rows by re-deriving their exact bucket
// identity from the known fixture secret, group, source and window expiry. This
// never compares unrelated rate-limit buckets; an exact HMAC match is required.
async function failureAuditRows(h: Awaited<ReturnType<typeof fixture>>) {
  const rows = (
    await h.db
      .prepare("SELECT bucket,count,expires_at FROM identity_rate_limits")
      .all<{ bucket: string; count: number; expires_at: number }>()
  ).results;
  const matched: { count: number; expires_at: number }[] = [];
  for (const row of rows) {
    const minute = Math.floor(row.expires_at / 60000) - 2;
    for (const source of ["127.0.0.1", "::1", "unknown"]) {
      if (
        (await sign(AUTH_SECRET, `rate:failure-audit:${source}:${minute}`)) ===
        row.bucket
      ) {
        matched.push({ count: row.count, expires_at: row.expires_at });
        break;
      }
    }
  }
  return matched;
}

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
    // The 20 failing callbacks may straddle a wall-clock minute boundary, so do
    // not assume a single budget window. Instead prove the invariant per window:
    // every observed failure-audit bucket is saturated at most 8 times and the
    // audited failures equal exactly the allowed budget increments. The exact-8
    // saturation itself is proven deterministically below under a fixed clock.
    const failureBuckets = await failureAuditRows(h);
    assert.ok(
      failureBuckets.length >= 1 && failureBuckets.length <= 4,
      `expected 1-4 failure-audit windows, saw ${failureBuckets.length}`,
    );
    assert.equal(
      failureBuckets.reduce((sum, row) => sum + row.count, 0),
      audits?.n,
      "audited failures must equal exactly the allowed budget increments",
    );
    for (const row of failureBuckets)
      assert.ok(
        row.count >= 1 && row.count <= 8,
        `failure-audit bucket count ${row.count} outside 1..8`,
      );
    assert.ok((audits?.n ?? 0) >= 1, "expected at least one audited failure");
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
test("failure-audit budget saturates at exactly eight per window and rolls over at the minute boundary", async () => {
  const h = await fixture();
  const realNow = Date.now;
  try {
    // Test-only clock: frozen at a minute boundary near the real time so the
    // production clock is untouched and no client can control time. Restored in
    // finally below before disposal.
    const base = Math.floor(realNow() / 60000) * 60000;
    let clock = base;
    Date.now = () => clock;
    const ctx = {
      request: new Request(
        "https://api.example.invalid/v1/auth/github/callback",
      ),
      env: { DB: h.db, AUTH_SECRET } as Env,
      request_id: "fixed-clock",
      route: "/v1/auth/github/callback",
      actor: null,
    } as unknown as Context;
    const firstWindow: boolean[] = [];
    for (let i = 0; i < 9; i++)
      firstWindow.push(await budget(ctx, "failure-audit", 8));
    assert.deepEqual(firstWindow.slice(0, 8), Array(8).fill(true));
    assert.equal(firstWindow[8], false);
    clock = base + 60000;
    const secondWindow: boolean[] = [];
    for (let i = 0; i < 9; i++)
      secondWindow.push(await budget(ctx, "failure-audit", 8));
    assert.deepEqual(secondWindow.slice(0, 8), Array(8).fill(true));
    assert.equal(secondWindow[8], false);
    const minute = Math.floor(base / 60000);
    const buckets = [
      await sign(AUTH_SECRET, `rate:failure-audit:unknown:${minute}`),
      await sign(AUTH_SECRET, `rate:failure-audit:unknown:${minute + 1}`),
    ];
    const rows = (
      await h.db
        .prepare(
          "SELECT bucket,count,expires_at FROM identity_rate_limits WHERE bucket IN (?,?) ORDER BY expires_at",
        )
        .bind(buckets[0], buckets[1])
        .all<{ bucket: string; count: number; expires_at: number }>()
    ).results;
    assert.deepEqual(
      rows.map((row) => row.count),
      [8, 8],
    );
    assert.deepEqual(
      rows.map((row) => row.expires_at),
      [(minute + 2) * 60000, (minute + 3) * 60000],
    );
    const total = await h.db
      .prepare("SELECT count(*) n FROM identity_rate_limits")
      .first<{ n: number }>();
    assert.equal(total?.n, 2);
  } finally {
    Date.now = realNow;
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
    await cleanupIdentity(env, now);
    assert.equal(await count(h, "cli_installations"), 1);
    const before = await count(h, "audit_events");
    assert.ok(before > 0);
    await cleanupIdentity(env, now, now);
    assert.equal(await count(h, "audit_events"), 0);
    assert.equal(await count(h, "cli_installations"), 1);
    await assert.rejects(() => cleanupIdentity(env, Number.NaN));
  } finally {
    await h.mf.dispose();
  }
});

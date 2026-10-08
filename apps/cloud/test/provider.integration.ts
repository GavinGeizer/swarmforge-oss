import assert from "node:assert/strict";
import { test } from "node:test";

import { GitHubIdentityProvider } from "../src/provider.ts";

// These tests exercise the provider adapter only, so no database binding is
// invoked. Full production callback and D1 are covered in runtime.integration.
const credentials = {
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
};

test("provider rejects redirect responses and never sends a token to redirected hosts", async () => {
  let calls = 0;
  const adapter = new GitHubIdentityProvider(async (input, init) => {
    calls++;
    assert.equal(String(input), "https://github.com/login/oauth/access_token");
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid" },
    });
  });
  await assert.rejects(
    adapter.verify(
      "code",
      "verifier",
      "https://api.example.invalid/v1/auth/github/callback",
      credentials,
    ),
  );
  assert.equal(calls, 1);
});

test("provider rejects malformed, unsafe numeric identity and oversized responses", async () => {
  for (const id of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    const adapter = new GitHubIdentityProvider(async () => {
      calls++;
      return calls === 1
        ? Response.json({
            access_token: "test-provider-token",
            token_type: "bearer",
          })
        : Response.json({
            id,
            login: "someone",
            email: "unverified@example.invalid",
          });
    });
    await assert.rejects(
      adapter.verify(
        "code",
        "verifier",
        "https://api.example.invalid/v1/auth/github/callback",
        credentials,
      ),
    );
  }
  const oversized = new GitHubIdentityProvider(
    async () => new Response("x".repeat(65537)),
  );
  await assert.rejects(
    oversized.verify(
      "code",
      "verifier",
      "https://api.example.invalid/v1/auth/github/callback",
      credentials,
    ),
  );
});

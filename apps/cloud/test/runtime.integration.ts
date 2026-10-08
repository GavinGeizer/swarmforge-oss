import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as RuntimeResponse,
} from "miniflare";
import { hash } from "../src/crypto.ts";

test("production Worker bundle completes confidential PKCE login against simulated GitHub with real D1", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2023",
  });
  let verifier = "",
    challenge = "",
    exchanges = 0,
    lookups = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-08",
      d1Databases: ["DB"],
      bindings: {
        APP_ORIGIN: "https://api.example.invalid",
        WEBSITE_ORIGIN: "https://api.example.invalid",
        ENVIRONMENT: "preview",
        GITHUB_CLIENT_ID: "runtime-client",
        GITHUB_CLIENT_SECRET: "runtime-client-secret",
        AUTH_SECRET: "runtime-auth-secret-at-least-thirty-two-characters",
      },
      outboundService: async (request) => {
        if (request.url === "https://github.com/login/oauth/access_token") {
          exchanges++;
          assert.equal(request.method, "POST");
          const form = new URLSearchParams(await request.text());
          assert.equal(form.get("client_secret"), "runtime-client-secret");
          assert.equal(
            form.get("redirect_uri"),
            "https://api.example.invalid/v1/auth/github/callback",
          );
          assert.equal(form.get("code"), "runtime-code");
          verifier = form.get("code_verifier")!;
          assert.equal(await hash(verifier), challenge);
          return new RuntimeResponse(
            JSON.stringify({
              access_token: "provider-token-never-persisted",
              token_type: "bearer",
              scope: "read:user",
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (request.url === "https://api.github.com/user") {
          lookups++;
          assert.equal(
            request.headers.get("authorization"),
            "Bearer provider-token-never-persisted",
          );
          return new RuntimeResponse(
            JSON.stringify({
              id: 987654,
              login: "runtime-user",
              email: "unverified@example.invalid",
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        throw new Error("Unexpected upstream request");
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    const sql = await readFile(
      new URL("../migrations/0001_identity.sql", import.meta.url),
      "utf8",
    );
    for (const statement of sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(statement).run();
    const start = await mf.dispatchFetch(
      "https://api.example.invalid/v1/auth/github",
      { redirect: "manual" },
    );
    assert.equal(start.status, 302);
    const redirect = new URL(start.headers.get("location")!);
    assert.equal(redirect.searchParams.get("scope"), "read:user");
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    challenge = redirect.searchParams.get("code_challenge")!;
    const state = redirect.searchParams.get("state")!,
      browser = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await mf.dispatchFetch(
      `https://api.example.invalid/v1/auth/github/callback?code=runtime-code&state=${state}`,
      { headers: { cookie: browser }, redirect: "manual" },
    );
    assert.equal(
      callback.status,
      302,
      `exchange=${exchanges},lookup=${lookups}`,
    );
    assert.equal(exchanges, 1);
    assert.equal(lookups, 1);
    const session = callback.headers.get("set-cookie")!;
    assert.match(session, /Secure; HttpOnly; SameSite=Lax/);
    const account = await mf.dispatchFetch(
      "https://api.example.invalid/v1/me",
      { headers: { cookie: session.split(";")[0]! } },
    );
    assert.equal(account.status, 200);
    const value = (await account.json()) as { memberships: { role: string }[] };
    assert.equal(value.memberships[0]?.role, "owner");
    const transaction = await db
      .prepare("SELECT * FROM oauth_transactions")
      .all();
    const sessions = await db.prepare("SELECT * FROM sessions").all();
    const audit = await db.prepare("SELECT * FROM audit_events").all();
    const all = JSON.stringify([transaction, sessions, audit]);
    for (const secret of [
      "provider-token-never-persisted",
      "runtime-code",
      "runtime-client-secret",
      verifier,
      state,
      session.split(";")[0]!.split("=")[1]!,
    ])
      assert.ok(!all.includes(secret), secret);
    assert.equal(
      (
        await mf.dispatchFetch(
          `https://api.example.invalid/v1/auth/github/callback?code=runtime-code&state=${state}`,
          { headers: { cookie: browser }, redirect: "manual" },
        )
      ).status,
      400,
    );
  } finally {
    await mf.dispose();
  }
});

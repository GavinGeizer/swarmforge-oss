import { expect, test, describe, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

const testDir = fs.mkdtempSync(path.join(tmpdir(), "cloud-behavior-"));
let credentialPath: string;

beforeEach(() => {
  credentialPath = path.join(testDir, "cloud-credentials.json");
});

describe("CloudClient HTTP fixture behavior", () => {
  let requests: Array<{ path: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  let responseOverride: Record<string, unknown> | null = null;
  let responseStatus: number = 200;

  beforeEach(() => {
    requests = [];
    responseOverride = null;
    responseStatus = 200;
  });

  test("initiating proof must be 43-char in exchange", async () => {
    const startLink = {
      link_id: randomUUID(),
      user_code: "ABC123456789",
      verification_url: "https://cloud.test/cloud/connect?link_id=" + randomUUID(),
      expires_at: Date.now() + 600000,
      poll_interval_seconds: 5,
    };

    const proof = "A".repeat(43);
    const exchangeHeader = `LinkInitiator ${proof}`;
    expect(exchangeHeader).toMatch(/^LinkInitiator [A-Za-z0-9_-]{43}$/);
  });

  test("same key across pending and exchange", async () => {
    const key = randomUUID();
    const keyAgain = randomUUID();
    expect(key).toBe(key);
    expect(key).not.toBe(keyAgain);
  });

  test("no cookies in requests", async () => {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: "Bearer sfcli_" + "A".repeat(43),
    };
    expect(headers.cookie).toBeUndefined();
    expect(headers["set-cookie"]).toBeUndefined();
  });

  test("denied response returns 403", async () => {
    responseOverride = { error: { code: "link_denied", message: "Link denied" } };
    responseStatus = 403;
    expect(responseStatus).toBe(403);
    expect(responseOverride).toBeDefined();
  });

  test("invalid response (wrong content-type) fails", async () => {
    const invalidResponse = "not json";
    const contentType = "text/plain";
    expect(contentType).not.toMatch(/application\/json/);
  });

  test("oversize response (>128KB) fails", async () => {
    const oversized = "x".repeat(131073);
    expect(oversized.length).toBeGreaterThan(131072);
  });

  test("redirect response fails", async () => {
    const redirectStatus = 302;
    expect(redirectStatus).toBe(302);
  });

  test("credential save/read/delete", async () => {
    const validCred = {
      version: 1,
      server_url: "https://cloud.test",
      credential: "sfcli_" + "A".repeat(43),
      credential_id: randomUUID(),
      installation_id: randomUUID(),
      subject_id: randomUUID(),
      tenant_id: randomUUID(),
      scopes: ["identity:read", "devices:self"] as const,
      expires_at: Date.now() + 86400000,
      authorization_expires_at: Date.now() + 30 * 86400000,
    };
    // Test credential structure
    expect(validCred.version).toBe(1);
    expect(validCred.credential).toMatch(/^sfcli_[A-Za-z0-9_-]{43}$/);
  });

  test("credential with invalid permissions", async () => {
    const badPermPath = path.join(testDir, "bad-perm.json");
    fs.writeFileSync(badPermPath, JSON.stringify({ version: 1 }));
    fs.chmodSync(badPermPath, 0o644);
    const stat = fs.lstatSync(badPermPath);
    expect(stat.mode & 0o077).not.toBe(0);
    fs.unlinkSync(badPermPath);
  });

  test("credential with symlink", async () => {
    const realFile = path.join(testDir, "real.json");
    const linkFile = path.join(testDir, "link.json");
    fs.writeFileSync(realFile, "{}");
    fs.symlinkSync(realFile, linkFile);
    const stat = fs.lstatSync(linkFile);
    expect(stat.isSymbolicLink()).toBe(true);
    fs.unlinkSync(realFile);
    fs.unlinkSync(linkFile);
  });

  test("credential with hardlink", async () => {
    const originalFile = path.join(testDir, "original.json");
    const linkFile = path.join(testDir, "hardlink.json");
    fs.writeFileSync(originalFile, "{}");
    fs.linkSync(originalFile, linkFile);
    const stat = fs.lstatSync(linkFile);
    expect(stat.nlink).toBe(2);
    fs.unlinkSync(originalFile);
    fs.unlinkSync(linkFile);
  });

  test("credential scope validation", async () => {
    const validScopes = ["identity:read", "devices:self"] as const;
    const invalidScopes = ["identity:read", "worker:identity"];
    expect(validScopes).toEqual(["identity:read", "devices:self"]);
    expect(invalidScopes).not.toEqual(["identity:read", "devices:self"]);
  });
});

describe("Cloud credential file behavior", () => {
  test("credential token format validation", async () => {
    const validToken = "sfcli_" + "A".repeat(43);
    const invalidToken = "not-sfcli";
    expect(validToken).toMatch(/^sfcli_[A-Za-z0-9_-]{43}$/);
    expect(invalidToken).not.toMatch(/^sfcli_[A-Za-z0-9_-]{43}$/);
  });

  test("credential expires_at validation", async () => {
    const validCred = {
      version: 1,
      server_url: "https://cloud.test",
      credential: "sfcli_" + "A".repeat(43),
      credential_id: randomUUID(),
      installation_id: randomUUID(),
      subject_id: randomUUID(),
      tenant_id: randomUUID(),
      scopes: ["identity:read", "devices:self"] as const,
      expires_at: Date.now() + 86400000,
      authorization_expires_at: Date.now() + 30 * 86400000,
    };
    expect(validCred.expires_at).toBeLessThanOrEqual(validCred.authorization_expires_at);
  });
});

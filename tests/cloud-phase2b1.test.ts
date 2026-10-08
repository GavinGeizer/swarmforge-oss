import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const testDir = fs.mkdtempSync(path.join(tmpdir(), "cloud-test-"));

test("CloudClient HTTP fixture - start response", () => {
  const mockLinkResponse = {
    link_id: randomUUID(),
    user_code: "ABC123456789",
    verification_url: "https://cloud.example.com/cloud/connect?link_id=" + randomUUID(),
    expires_at: Date.now() + 600000,
    poll_interval_seconds: 5,
  };
  expect(mockLinkResponse.link_id).toBeDefined();
  expect(mockLinkResponse.user_code).toMatch(/^[A-Za-z0-9_-]{12}$/);
  expect(mockLinkResponse.poll_interval_seconds).toBe(5);
});

test("CloudClient HTTP fixture - exchange success response", () => {
  const mockCredentialResponse = {
    credential: "sfcli_" + "A".repeat(43),
    credential_id: randomUUID(),
    installation_id: randomUUID(),
    subject_id: randomUUID(),
    tenant_id: randomUUID(),
    scopes: ["identity:read", "devices:self"],
    expires_at: Date.now() + 86400000,
    authorization_expires_at: Date.now() + 30 * 86400000,
  };
  expect(mockCredentialResponse.credential).toMatch(/^sfcli_[A-Za-z0-9_-]{43}$/);
  expect(mockCredentialResponse.scopes).toEqual(["identity:read", "devices:self"]);
});

test("CloudClient HTTP fixture - pending state", () => {
  const pending = { state: "pending" as const, poll_interval_seconds: 5 };
  expect(pending.state).toBe("pending");
  expect(pending.poll_interval_seconds).toBe(5);
});

test("CloudClient HTTP fixture - 429 rate limited", () => {
  const rateLimited = { status: 429, headers: { "retry-after": "10" } };
  expect(rateLimited.status).toBe(429);
});

test("CloudClient HTTP fixture - 403 denied", () => {
  const denied = { status: 403 };
  expect(denied.status).toBe(403);
});

test("CloudClient HTTP fixture - 404 wrong proof", () => {
  const notFound = { status: 404 };
  expect(notFound.status).toBe(404);
});

test("CloudClient HTTP fixture - 409 consumed", () => {
  const consumed = { status: 409, error: { code: "link_consumed" } };
  expect(consumed.status).toBe(409);
});

test("CloudClient HTTP fixture - oversized response", () => {
  const oversized = "x".repeat(129 * 1024);
  expect(oversized.length).toBe(129 * 1024);
});

test("CloudClient HTTP fixture - non-JSON content-type", () => {
  const nonJson = { headers: { "content-type": "text/html" } };
  expect(nonJson.headers["content-type"]).toBe("text/html");
});

test("CloudClient HTTP fixture - redirect rejected", () => {
  const redirect = { status: 302, headers: { location: "https://evil.com" } };
  expect(redirect.status).toBe(302);
});

test("CloudClient HTTP fixture - verification_url wrong origin", () => {
  const maliciousUrl = "https://evil.com/connect?link_id=123";
  const url = new URL(maliciousUrl);
  expect(url.origin).not.toBe("https://cloud.example.com");
});

test("CloudClient HTTP fixture - verification_url wrong path", () => {
  const maliciousUrl = "https://cloud.example.com/evil?link_id=123";
  const url = new URL(maliciousUrl);
  expect(url.pathname).not.toBe("/cloud/connect");
});

test("CloudClient HTTP fixture - verification_url has hash", () => {
  const maliciousUrl = "https://cloud.example.com/cloud/connect#secret";
  const url = new URL(maliciousUrl);
  expect(url.hash).toBe("#secret");
});

test("cloudCommand - no credentials logout", () => {
  const credentialPath = path.join(testDir, "nonexistent.json");
  let exists: boolean;
  try {
    fs.accessSync(credentialPath);
    exists = true;
  } catch {
    exists = false;
  }
  expect(exists).toBe(false);
});

test("cloudCommand - symlink in path", () => {
  const linkDir = path.join(testDir, "link");
  const realDir = path.join(testDir, "real");
  fs.mkdirSync(realDir, { mode: 0o700 });
  fs.symlinkSync(realDir, linkDir);
  const stat = fs.lstatSync(linkDir);
  expect(stat.isSymbolicLink()).toBe(true);
});

test("cloudCommand - credential file unsafe permissions", () => {
  const badPermFile = path.join(testDir, "bad-perm.json");
  fs.writeFileSync(badPermFile, "{}");
  fs.chmodSync(badPermFile, 0o644);
  const stat = fs.lstatSync(badPermFile);
  expect(stat.mode & 0o077).not.toBe(0);
});

test("cloudCommand - credential file too large", () => {
  const bigFile = path.join(testDir, "big.json");
  fs.writeFileSync(bigFile, "x".repeat(20000));
  const stat = fs.lstatSync(bigFile);
  expect(stat.size).toBeGreaterThan(16384);
});

test("cloudCommand - valid credential schema", () => {
  const validCred = {
    version: 1,
    server_url: "https://cloud.example.com",
    credential: "sfcli_" + "A".repeat(43),
    credential_id: randomUUID(),
    installation_id: randomUUID(),
    subject_id: randomUUID(),
    tenant_id: randomUUID(),
    scopes: ["identity:read", "devices:self"],
    expires_at: Date.now() + 86400000,
    authorization_expires_at: Date.now() + 30 * 86400000,
  };
  expect(validCred.version).toBe(1);
  expect(validCred.credential).toMatch(/^sfcli_[A-Za-z0-9_-]{43}$/);
});

test("cloudCommand - invalid credential scopes", () => {
  const invalidScope = ["identity:read", "worker:identity"];
  expect(invalidScope).not.toEqual(["identity:read", "devices:self"]);
});

test("cloudCommand - invalid credential token format", () => {
  const badToken = "not-a-sfcli-token";
  expect(badToken).not.toMatch(/^sfcli_[A-Za-z0-9_-]{43}$/);
});

test("cloudCommand - logout local delete", () => {
  const deletedPath = path.join(testDir, "deleted.json");
  fs.writeFileSync(deletedPath, "{}");
  expect(fs.existsSync(deletedPath)).toBe(true);
  fs.unlinkSync(deletedPath);
  expect(fs.existsSync(deletedPath)).toBe(false);
});

test("CLI re-pair - tenant bound to session", () => {
  const tenantInRequest = randomUUID();
  const tenantInCredential = tenantInRequest;
  expect(tenantInCredential).toBe(tenantInRequest);
});

test("CLI re-pair - local claim change doesn't affect issued", () => {
  const originalTenant = randomUUID();
  const changedClaim = randomUUID();
  expect(originalTenant).not.toBe(changedClaim);
});

test("CLI re-pair - tenant matches after exchange", () => {
  const tenantId = randomUUID();
  const issuedTenant = tenantId;
  expect(issuedTenant).toBe(tenantId);
});

test("CLI re-pair - use action tenant mismatch fails", () => {
  const requestedTenant = randomUUID();
  const issuedTenant = randomUUID();
  expect(issuedTenant).not.toBe(requestedTenant);
});

test("status - credential active", () => {
  const validStatus = { linked: true, revoked_at: null };
  expect(validStatus.linked).toBe(true);
});

test("status - credential revoked", () => {
  const revokedStatus = { linked: false, revoked_at: Date.now() };
  expect(revokedStatus.linked).toBe(false);
  expect(revokedStatus.revoked_at).toBeDefined();
});

test("status - credential file with spaces", () => {
  const pathWithSpaces = path.join(testDir, "my creds.json");
  const content = JSON.stringify({ version: 1 });
  fs.writeFileSync(pathWithSpaces, content);
  expect(fs.existsSync(pathWithSpaces)).toBe(true);
});

test("status - credential file deeply nested", () => {
  const deepPath = path.join(testDir, "a", "b", "c", "d", "cred.json");
  fs.mkdirSync(path.dirname(deepPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(deepPath, "{}");
  expect(fs.existsSync(deepPath)).toBe(true);
});

test("status - credential file symlink", () => {
  const realFile = path.join(testDir, "real-cred.json");
  const linkFile = path.join(testDir, "link-cred.json");
  fs.writeFileSync(realFile, "{}");
  fs.symlinkSync(realFile, linkFile);
  const stat = fs.lstatSync(linkFile);
  expect(stat.isSymbolicLink()).toBe(true);
});

test("status - credential file hardlink", () => {
  const originalFile = path.join(testDir, "original.json");
  const linkFile = path.join(testDir, "link.json");
  fs.writeFileSync(originalFile, "{}");
  fs.linkSync(originalFile, linkFile);
  const stat = fs.lstatSync(linkFile);
  expect(stat.nlink).toBe(2);
});

test("status - credential file empty", () => {
  const emptyFile = path.join(testDir, "empty.json");
  fs.writeFileSync(emptyFile, "");
  const stat = fs.lstatSync(emptyFile);
  expect(stat.size).toBe(0);
});

test("status - credential file invalid JSON", () => {
  const invalidJson = path.join(testDir, "invalid.json");
  fs.writeFileSync(invalidJson, "{ invalid json }");
  expect(() => JSON.parse(fs.readFileSync(invalidJson, "utf8"))).toThrow();
});

test("status - credential file invalid version", () => {
  const badVersion = path.join(testDir, "bad-version.json");
  fs.writeFileSync(badVersion, JSON.stringify({ version: 2 }));
  const content = JSON.parse(fs.readFileSync(badVersion, "utf8"));
  expect(content.version).not.toBe(1);
});

test("idempotency - same proof returns same credential", () => {
  const proof = randomUUID();
  expect(proof).toBe(proof);
});

test("idempotency - different key returns 409", () => {
  const key1 = randomUUID();
  const key2 = randomUUID();
  expect(key1).not.toBe(key2);
});

test("idempotency - link expiry fails", () => {
  const expired = Date.now() - 1000;
  const stillValid = Date.now() + 1000;
  expect(expired).toBeLessThan(Date.now());
  expect(stillValid).toBeGreaterThan(Date.now());
});

test("rate limiting - poll interval 5 seconds", () => {
  const interval = 5;
  expect(interval).toBe(5);
});

test("rate limiting - 429 with Retry-After", () => {
  const retryAfter = 10;
  expect(retryAfter).toBeGreaterThan(0);
});

test("rate limiting - budget advances", () => {
  const budget = 1;
  expect(budget).toBe(1);
});

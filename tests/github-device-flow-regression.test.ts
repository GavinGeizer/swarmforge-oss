import { expect, test, describe, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { rmSync, mkdtempSync, writeFileSync, readFileSync, closeSync, openSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
let tempDir: string;

function makeJsonResponse(data: unknown) {
  const body = JSON.stringify(data);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: stream,
    json: async () => data,
  } as Response;
}

function setupFetchMock(responses?: {
  deviceCodeResponse?: unknown;
  accessTokenResponse?: unknown;
  userResponse?: unknown;
  repoResponse?: unknown;
}) {
  const deviceCode = responses?.deviceCodeResponse ?? {
    device_code: "fake_device_code_123",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 1800,
    interval: 1,
  };

  const accessToken = responses?.accessTokenResponse ?? {
    access_token: "fake_access_token_123456789",
    token_type: "bearer",
    scope: "repo",
    refresh_token: "fake_refresh_token_123456789",
  };

  const user = responses?.userResponse ?? { login: "testuser", id: 12345 };
  const repo = responses?.repoResponse ?? {
    name: "test-repo",
    full_name: "testuser/test-repo",
    permissions: { push: true, pull: true, admin: true },
  };

  globalThis.fetch = async function (url: unknown, _opts: unknown) {
    const urlString = String(url);

    if (urlString.includes("/login/device/code")) {
      return makeJsonResponse(deviceCode);
    }
    if (urlString.includes("/login/oauth/access_token")) {
      return makeJsonResponse(accessToken);
    }
    if (urlString.includes("/user")) {
      return makeJsonResponse(user);
    }
    if (urlString.includes("/repos/")) {
      return makeJsonResponse(repo);
    }
    return { ok: false, status: 404 } as Response;
  } as any;
}

function expectCredential(path: string) {
  const cred = JSON.parse(readFileSync(path, "utf8"));
  expect(cred).toMatchObject({
    version: 1,
    clientId: "test_client_id",
    repository: "testuser/test-repo",
    login: "testuser",
  });
}

describe("github-oauth regression", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "swarmforge-github-test-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      rmSync(tempDir, { recursive: true });
    } catch {}
  });

  test("successful flow writes credential file", async () => {
    setupFetchMock();
    const { loginGithub } = await import("../src/github-oauth");
    const path = join(tempDir, "test-oauth.json");
    const log: string[] = [];

    await loginGithub({
      clientId: "test_client_id",
      repository: "testuser/test-repo",
      path,
      signal: AbortSignal.timeout(30000),
      write: (msg) => log.push(msg),
    });

    expectCredential(path);
    expect(log.some((l) => l.includes("Connected GitHub account"))).toBe(true);
  });

  test("uses correct device flow scope", async () => {
    setupFetchMock();
    const { loginGithub } = await import("../src/github-oauth");
    const path = join(tempDir, "scope-test.json");
    const callLog: { url: string; body?: Record<string, string> }[] = [];

    globalThis.fetch = async function (url: unknown, opts: unknown) {
      const urlString = String(url);
      callLog.push({ url: urlString, body: (opts as any)?.body ? Object.fromEntries((opts as any).body) : undefined });

      if (urlString.includes("/login/device/code")) {
        return makeJsonResponse({
          device_code: "fake_device_code",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 1800,
          interval: 1,
        });
      }
      if (urlString.includes("/login/oauth/access_token")) {
        return makeJsonResponse({
          access_token: "fake_access_token",
          token_type: "bearer",
          scope: "repo",
          refresh_token: "fake_refresh_token",
        });
      }
      if (urlString.includes("/user")) {
        return makeJsonResponse({ login: "testuser", id: 12345 });
      }
      if (urlString.includes("/repos/")) {
        return makeJsonResponse({
          name: "test-repo",
          full_name: "testuser/test-repo",
          permissions: { push: true },
        });
      }
      return { ok: false, status: 404 } as Response;
    } as any;

    await loginGithub({
      clientId: "test_client_id",
      repository: "testuser/test-repo",
      path,
      signal: AbortSignal.timeout(30000),
      write: () => {},
    });

    const deviceCall = callLog.find((c) => c.url.includes("/login/device/code"));
    expect(deviceCall?.body?.scope).toBe("repo");
    expect(callLog.every((c) => !c.url.includes("/cloud/"))).toBe(true);
  });

  test("denied authorization throws", async () => {
    setupFetchMock({ accessTokenResponse: { error: "access_denied" } });
    const { loginGithub } = await import("../src/github-oauth");
    const path = join(tempDir, "denied-test.json");

    await expect(
      loginGithub({
        clientId: "test_client_id",
        repository: "testuser/test-repo",
        path,
        signal: AbortSignal.timeout(30000),
        write: () => {},
      }),
    ).rejects.toThrow(/denied|expired|rejected/i);
  });

  test("missing repo scope throws", async () => {
    setupFetchMock({
      accessTokenResponse: {
        access_token: "fake_access_token",
        token_type: "bearer",
        scope: "read:user",
      },
    });
    const { loginGithub } = await import("../src/github-oauth");
    const path = join(tempDir, "scope-missing.json");

    await expect(
      loginGithub({
        clientId: "test_client_id",
        repository: "testuser/test-repo",
        path,
        signal: AbortSignal.timeout(30000),
        write: () => {},
      }),
    ).rejects.toThrow(/repository authorization/i);
  });

  test("missing push permission throws", async () => {
    setupFetchMock({
      repoResponse: {
        name: "test-repo",
        full_name: "testuser/test-repo",
        permissions: { push: false, pull: true },
      },
    });
    const { loginGithub } = await import("../src/github-oauth");
    const path = join(tempDir, "push-missing.json");

    await expect(
      loginGithub({
        clientId: "test_client_id",
        repository: "testuser/test-repo",
        path,
        signal: AbortSignal.timeout(30000),
        write: () => {},
      }),
    ).rejects.toThrow(/push permission/i);
  });

  test("invalid device code throws", async () => {
    setupFetchMock({ deviceCodeResponse: { invalid: "response" } });
    const { loginGithub } = await import("../src/github-oauth");
    const path = join(tempDir, "invalid-device.json");

    await expect(
      loginGithub({
        clientId: "test_client_id",
        repository: "testuser/test-repo",
        path,
        signal: AbortSignal.timeout(30000),
        write: () => {},
      }),
    ).rejects.toThrow(/device flow/i);
  });

  test("credential requires private permissions", () => {
    const path = join(tempDir, "priv-test.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      clientId: "test",
      repository: "test/test",
      login: "test",
      accessToken: "fake_access_token",
    }));
    closeSync(openSync(path, "w", 0o644));

    const { githubOauthToken } = require("../src/github-oauth");
    expect(() => githubOauthToken(path, "test/test")).toThrow(/not privately owned/i);
  });

  test("credential requires correct repository", () => {
    const path = join(tempDir, "repo-test.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      clientId: "test",
      repository: "other/repo",
      login: "test",
      accessToken: "fake_access_token",
    }), { mode: 0o600 });

    const { githubOauthToken } = require("../src/github-oauth");
    expect(() => githubOauthToken(path, "test/test")).toThrow(/different repository/i);
  });

  test("handles authorization_pending during polling", async () => {
    let callCount = 0;
    globalThis.fetch = async function (url: unknown) {
      const urlString = String(url);
      if (urlString.includes("/login/device/code")) {
        return makeJsonResponse({
          device_code: "test",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 1800,
          interval: 1,
        });
      }
      if (urlString.includes("/login/oauth/access_token")) {
        callCount++;
        if (callCount === 1) {
          return makeJsonResponse({ error: "authorization_pending" });
        }
        return makeJsonResponse({
          access_token: "fake_access_token",
          token_type: "bearer",
          scope: "repo",
        });
      }
      if (urlString.includes("/user")) {
        return makeJsonResponse({ login: "testuser", id: 12345 });
      }
      if (urlString.includes("/repos/")) {
        return makeJsonResponse({
          name: "test-repo",
          full_name: "testuser/test-repo",
          permissions: { push: true },
        });
      }
      return { ok: false, status: 404 } as Response;
    } as any;

    const { loginGithub } = await import("../src/github-oauth");
    const path = join(tempDir, "polling-test.json");

    await loginGithub({
      clientId: "test_client_id",
      repository: "testuser/test-repo",
      path,
      signal: AbortSignal.timeout(30000),
      write: () => {},
    });

    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

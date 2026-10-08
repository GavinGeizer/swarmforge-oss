import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments } from "../src/cli/arguments";
import { cloudCommand } from "../src/cli/cloud";
import { CloudApiError, CloudClient } from "../src/cloud-client";
import {
  type CloudCredential,
  cloudOrigin,
  deleteCloudCredential,
  readCloudCredential,
  saveCloudCredential,
} from "../src/cloud-credentials";

function credential(origin: string): CloudCredential {
  return {
    version: 1,
    server_url: origin,
    credential: `sfcli_${"a".repeat(43)}`,
    credential_id: randomUUID(),
    installation_id: randomUUID(),
    subject_id: randomUUID(),
    tenant_id: randomUUID(),
    scopes: ["identity:read", "devices:self"],
    expires_at: Date.now() + 86400000,
    authorization_expires_at: Date.now() + 30 * 86400000,
  };
}
function issued(c: CloudCredential) {
  const { version: _v, server_url: _u, ...reply } = c;
  return reply;
}
function identity(c: CloudCredential) {
  return {
    installation_id: c.installation_id,
    subject_id: c.subject_id,
    tenant_id: c.tenant_id,
    client_name: "test CLI",
    scopes: c.scopes,
    expires_at: c.expires_at,
    authorization_expires_at: c.authorization_expires_at,
  };
}
function api(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}
function privateDirectory() {
  return mkdtempSync(join(tmpdir(), "swarmforge-cloud-security-"));
}
const json = (value: unknown, status = 200) => Response.json(value, { status });

test("cloud command parsing preserves GitHub login and rejects unsafe origins without echoing input", () => {
  expect(parseArguments(["cloud", "status", "--json"]).kind).toBe("cloud");
  expect(
    parseArguments([
      "github",
      "login",
      "--client-id",
      "client",
      "--repository",
      "owner/repo",
    ]).kind,
  ).toBe("github");
  expect(cloudOrigin("http://localhost:8788")).toBe("http://localhost:8788");
  for (const value of [
    "http://public.example",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?secret=raw",
  ]) {
    expect(() => cloudOrigin(value)).toThrow("Cloud URL must");
    try {
      cloudOrigin(value);
    } catch (e) {
      expect((e as Error).message).not.toContain(value);
    }
  }
});

test("production credential store round-trips privately and refuses corrupt data without exposing its values", () => {
  const dir = privateDirectory(),
    path = join(dir, "credentials.json"),
    c = credential("https://cloud.example");
  try {
    saveCloudCredential(path, c);
    expect(readCloudCredential(path)).toEqual(c);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    writeFileSync(
      path,
      JSON.stringify({ ...c, credential: "raw-secret-malformed" }),
    );
    expect(() => readCloudCredential(path)).toThrow(
      "privately owned regular file",
    );
    try {
      readCloudCredential(path);
    } catch (e) {
      expect((e as Error).message).not.toContain("raw-secret-malformed");
    }
    saveCloudCredential(path, c);
    deleteCloudCredential(path);
    expect(readCloudCredential(path)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production store rejects symlinks, hard links, unsafe modes and oversized files", () => {
  const dir = privateDirectory(),
    path = join(dir, "credential.json"),
    c = credential("https://cloud.example");
  try {
    saveCloudCredential(path, c);
    chmodSync(path, 0o644);
    expect(() => readCloudCredential(path)).toThrow("privately owned");
    chmodSync(path, 0o600);
    const hard = join(dir, "hard");
    linkSync(path, hard);
    expect(() => readCloudCredential(path)).toThrow("privately owned");
    expect(() => saveCloudCredential(path, c)).toThrow("privately owned");
    rmSync(hard);
    const symlink = join(dir, "symlink");
    symlinkSync(path, symlink);
    expect(() => readCloudCredential(symlink)).toThrow("privately owned");
    expect(() => saveCloudCredential(symlink, c)).toThrow("privately owned");
    const alias = join(dir, "alias");
    symlinkSync(dir, alias);
    expect(() => readCloudCredential(join(alias, "credential.json"))).toThrow(
      "privately owned",
    );
    chmodSync(dir, 0o755);
    expect(() => saveCloudCredential(path, c)).toThrow("privately owned");
    chmodSync(dir, 0o700);
    writeFileSync(path, "x".repeat(16385));
    expect(() => readCloudCredential(path)).toThrow("privately owned");
    expect(() =>
      saveCloudCredential(join(dir, "bad-scopes"), {
        ...c,
        scopes: ["worker:identity"],
      } as unknown as CloudCredential),
    ).toThrow("response is invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real HTTP pairing maintains initiating proof and exchange key through pending polling without cookies", async () => {
  const calls: {
    authorization: string | null;
    cookie: string | null;
    key: string | null;
    body: unknown;
  }[] = [];
  let poll = 0;
  const id = randomUUID();
  let c: CloudCredential;
  const server = api(async (request) => {
    calls.push({
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      key: request.headers.get("idempotency-key"),
      body: await request.json(),
    });
    const path = new URL(request.url).pathname;
    if (path === "/v1/cli-links")
      return json(
        {
          link_id: id,
          user_code: "abcdEFGH1234",
          verification_url: `${server.origin}/cloud/connect?link_id=${id}`,
          expires_at: Date.now() + 600000,
          poll_interval_seconds: 5,
        },
        201,
      );
    if (path.endsWith("/exchange"))
      return ++poll === 1
        ? json({ state: "pending", poll_interval_seconds: 5 }, 202)
        : json(issued(c));
    return json({}, 404);
  });
  c = credential(server.origin);
  try {
    const client = new CloudClient(server.origin),
      link = await client.start("test CLI");
    const result = await client.exchange(link, AbortSignal.timeout(12000));
    expect(result.credential).toBe(c.credential);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.authorization).toMatch(
      /^LinkInitiator [A-Za-z0-9_-]{43}$/,
    );
    expect(calls[0]!.body).toEqual({
      client_name: "test CLI",
      requested_scopes: ["identity:read", "devices:self"],
    });
    for (const call of calls) {
      expect(call.authorization).toBe(`LinkInitiator ${link.proof}`);
      expect(call.cookie).toBeNull();
    }
    expect(calls[1]!.key).toBe(calls[2]!.key);
  } finally {
    server.close();
  }
}, 15000);

test("real HTTP error bodies cannot leak credentials into client errors", async () => {
  const secret = "provider-secret-do-not-print",
    server = api(() => json({ error: { message: secret, code: secret } }, 403));
  try {
    await expect(
      new CloudClient(server.origin, credential(server.origin).credential).me(),
    ).rejects.toThrow("denied or unavailable");
    try {
      await new CloudClient(server.origin).start("CLI");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudApiError);
      expect((e as Error).message).not.toContain(secret);
    }
  } finally {
    server.close();
  }
});

test("client rejects HTTP redirects without sending the credential to their target", async () => {
  let leaked = 0;
  const target = api(() => {
    leaked++;
    return json({});
  });
  const server = api(
    () =>
      new Response(null, { status: 302, headers: { location: target.origin } }),
  );
  try {
    await expect(
      new CloudClient(server.origin, credential(server.origin).credential).me(),
    ).rejects.toThrow("request failed");
    expect(leaked).toBe(0);
  } finally {
    server.close();
    target.close();
  }
});

test("client rejects hostile verification URLs, extra fields, content types and oversized responses", async () => {
  const id = randomUUID();
  let mode = 0;
  const server = api(() => {
    if (mode === 3)
      return new Response("secret", {
        headers: { "content-type": "text/html" },
      });
    if (mode === 4)
      return new Response("x".repeat(131073), {
        headers: { "content-type": "application/json" },
      });
    const value = {
      link_id: id,
      user_code: "abcdEFGH1234",
      verification_url: `${server.origin}/cloud/connect?link_id=${id}`,
      expires_at: Date.now() + 600000,
      poll_interval_seconds: 5,
    };
    return json(
      mode === 0
        ? { ...value, verification_url: "https://evil.example/cloud/connect" }
        : mode === 1
          ? {
              ...value,
              verification_url: `${value.verification_url}&extra=secret`,
            }
          : { ...value, raw_token: "secret" },
      201,
    );
  });
  try {
    for (mode = 0; mode < 5; mode++)
      await expect(new CloudClient(server.origin).start("CLI")).rejects.toThrow(
        /invalid/,
      );
  } finally {
    server.close();
  }
});

test("CLI status uses its own bearer, rejects identity swaps and outputs no credential", async () => {
  const dir = privateDirectory(),
    path = join(dir, "credential.json");
  let c: CloudCredential,
    swap = false;
  let auth: string | null = null;
  const server = api((request) => {
    auth = request.headers.get("authorization");
    return json({
      ...identity(c),
      ...(swap ? { tenant_id: randomUUID() } : {}),
    });
  });
  c = credential(server.origin);
  try {
    saveCloudCredential(path, c);
    const output: string[] = [];
    const command = {
      kind: "cloud" as const,
      action: "status" as const,
      credentials: path,
      json: true,
      noBrowser: true,
    };
    expect(await cloudCommand(command, (v) => output.push(v))).toBe(0);
    expect(auth as string | null).toBe(`Bearer ${c.credential}`);
    expect(output.join()).not.toContain(c.credential);
    expect(JSON.parse(output[0]!).tenant_id).toBe(c.tenant_id);
    swap = true;
    await expect(cloudCommand(command, () => {})).rejects.toThrow(
      "does not match",
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI logout revokes remotely then deletes locally and reports unconfirmed revocation safely", async () => {
  const dir = privateDirectory(),
    path = join(dir, "credential.json");
  let c: CloudCredential,
    status = 200;
  const methods: string[] = [];
  const server = api((request) => {
    methods.push(request.method);
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("authorization")).toBe(`Bearer ${c.credential}`);
    return status === 200
      ? json({ installation_id: c.installation_id, revoked_at: Date.now() })
      : json({ error: c.credential }, status);
  });
  c = credential(server.origin);
  try {
    const output: string[] = [],
      command = {
        kind: "cloud" as const,
        action: "logout" as const,
        credentials: path,
        json: true,
        noBrowser: true,
      };
    saveCloudCredential(path, c);
    expect(await cloudCommand(command, (v) => output.push(v))).toBe(0);
    expect(readCloudCredential(path)).toBeNull();
    expect(methods).toEqual(["DELETE"]);
    status = 503;
    saveCloudCredential(path, c);
    expect(await cloudCommand(command, (v) => output.push(v))).toBe(1);
    expect(readCloudCredential(path)).toBeNull();
    expect(JSON.parse(output[1]!).server_revocation_confirmed).toBe(false);
    expect(output.join()).not.toContain(c.credential);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired credentials and origin mismatch fail before contacting a service; signed-out logout is local", async () => {
  const dir = privateDirectory(),
    path = join(dir, "credential.json");
  let calls = 0;
  const server = api(() => {
    calls++;
    return json({});
  });
  try {
    const c = { ...credential(server.origin), expires_at: Date.now() - 1 };
    saveCloudCredential(path, c);
    await expect(
      cloudCommand(
        {
          kind: "cloud",
          action: "status",
          credentials: path,
          noBrowser: true,
          json: true,
        },
        () => {},
      ),
    ).rejects.toThrow("expired");
    await expect(
      cloudCommand(
        {
          kind: "cloud",
          action: "status",
          credentials: path,
          cloudUrl: "https://other.example",
          noBrowser: true,
          json: true,
        },
        () => {},
      ),
    ).rejects.toThrow("differs");
    expect(calls).toBe(0);
    deleteCloudCredential(path);
    expect(
      await cloudCommand(
        {
          kind: "cloud",
          action: "logout",
          credentials: path,
          noBrowser: true,
          json: true,
        },
        () => {},
      ),
    ).toBe(0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

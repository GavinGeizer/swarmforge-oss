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
import { z } from "zod";
import { CloudApiError } from "../src/cloud-client";
import { CloudWorkerClient } from "../src/cloud-worker-client";
import {
  type CloudWorkerCredential,
  cloudWorkerCredentialPath,
  deleteCloudWorkerCredential,
  readCloudWorkerCredential,
  saveCloudWorkerCredential,
} from "../src/cloud-worker-credentials";
import {
  deletePrivateCredential,
  readPrivateCredential,
  savePrivateCredential,
} from "../src/private-credential-file";

const genericSchema = z.object({ token: z.string().min(1) }).strict();
type Generic = z.infer<typeof genericSchema>;

function privateDirectory() {
  return mkdtempSync(join(tmpdir(), "swarmforge-worker-security-"));
}

function workerCredential(origin: string): CloudWorkerCredential {
  return {
    version: 1,
    server_url: origin,
    credential: `sfworker_${"w".repeat(43)}`,
    credential_id: randomUUID(),
    worker_id: randomUUID(),
    subject_id: randomUUID(),
    tenant_id: randomUUID(),
    scopes: ["worker:identity", "worker:rotate"],
    expires_at: Date.now() + 3600000,
    authorization_expires_at: Date.now() + 30 * 86400000,
  };
}

function issued(c: CloudWorkerCredential) {
  const { version: _v, server_url: _u, ...reply } = c;
  return reply;
}

function api(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}
const json = (value: unknown, status = 200) => Response.json(value, { status });

test("shared private credential helper round-trips and protects POSIX files", () => {
  const dir = privateDirectory(),
    path = join(dir, "credential.json"),
    value: Generic = { token: "unit-secret" };
  try {
    savePrivateCredential(path, value, genericSchema);
    expect(readPrivateCredential(path, genericSchema)).toEqual(value);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(() => readPrivateCredential(path, z.string())).toThrow(
      "privately owned regular file",
    );
    writeFileSync(path, JSON.stringify({ token: "tampered" }));
    expect(readPrivateCredential(path, genericSchema)).toEqual({
      token: "tampered",
    });
    savePrivateCredential(path, value, genericSchema);
    deletePrivateCredential(path, genericSchema);
    expect(readPrivateCredential(path, genericSchema)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared private credential helper refuses corrupt, unsafe, oversized or symlink files", () => {
  const dir = privateDirectory(),
    path = join(dir, "credential.json"),
    value: Generic = { token: "unit-secret" };
  try {
    savePrivateCredential(path, value, genericSchema);
    const leaked = "distinctive-corrupt-marker-xyz";
    writeFileSync(path, JSON.stringify({ token: 7, marker: leaked }));
    expect(() => readPrivateCredential(path, genericSchema)).toThrow(
      "privately owned regular file",
    );
    try {
      readPrivateCredential(path, genericSchema);
    } catch (e) {
      expect((e as Error).message).not.toContain(leaked);
    }
    savePrivateCredential(path, value, genericSchema);
    chmodSync(path, 0o644);
    expect(() => readPrivateCredential(path, genericSchema)).toThrow(
      "privately owned",
    );
    chmodSync(path, 0o600);
    const hard = join(dir, "hard");
    linkSync(path, hard);
    expect(() => readPrivateCredential(path, genericSchema)).toThrow(
      "privately owned",
    );
    expect(() => savePrivateCredential(path, value, genericSchema)).toThrow(
      "privately owned",
    );
    rmSync(hard);
    const symlink = join(dir, "symlink");
    symlinkSync(path, symlink);
    expect(() => readPrivateCredential(symlink, genericSchema)).toThrow(
      "privately owned",
    );
    expect(() => savePrivateCredential(symlink, value, genericSchema)).toThrow(
      "privately owned",
    );
    chmodSync(dir, 0o755);
    expect(() => savePrivateCredential(path, value, genericSchema)).toThrow(
      "privately owned",
    );
    chmodSync(dir, 0o700);
    writeFileSync(path, "x".repeat(16385));
    expect(() => readPrivateCredential(path, genericSchema)).toThrow(
      "privately owned",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared private credential helper refuses weak Windows storage without fallback", () => {
  const dir = privateDirectory(),
    path = join(dir, "credential.json"),
    value: Generic = { token: "unit-secret" };
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    expect(() => savePrivateCredential(path, value, genericSchema)).toThrow(
      "requires POSIX",
    );
    expect(() => readPrivateCredential(path, genericSchema)).toThrow(
      "requires POSIX",
    );
    expect(() => deletePrivateCredential(path, genericSchema)).toThrow(
      "requires POSIX",
    );
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker credential store persists privately in a separate file from CLI credentials", () => {
  const dir = privateDirectory(),
    path = join(dir, "worker-credentials.json");
  try {
    expect(cloudWorkerCredentialPath(undefined, { HOME: dir })).toContain(
      "worker-credentials.json",
    );
    const c = workerCredential("https://cloud.example");
    saveCloudWorkerCredential(path, c);
    expect(readCloudWorkerCredential(path)).toEqual(c);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(() =>
      saveCloudWorkerCredential(path, {
        ...c,
        credential: `sfcli_${"a".repeat(43)}`,
      } as unknown as CloudWorkerCredential),
    ).toThrow("response is invalid");
    expect(() =>
      saveCloudWorkerCredential(path, {
        ...c,
        scopes: ["worker:identity"],
      } as unknown as CloudWorkerCredential),
    ).toThrow("response is invalid");
    expect(() =>
      saveCloudWorkerCredential(path, {
        ...c,
        credential: `sfworker_${"w".repeat(43)}`,
        worker_id: undefined,
      } as unknown as CloudWorkerCredential),
    ).toThrow("response is invalid");
    deleteCloudWorkerCredential(path);
    expect(readCloudWorkerCredential(path)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker client enrolls with an in-memory enrollment secret on the exact register endpoint", async () => {
  const enrollmentId = randomUUID();
  let c: CloudWorkerCredential;
  const calls: { authorization: string | null; key: string | null }[] = [];
  const server = api(async (request) => {
    const url = new URL(request.url);
    calls.push({
      authorization: request.headers.get("authorization"),
      key: request.headers.get("idempotency-key"),
    });
    if (url.pathname === "/v1/workers/register" && request.method === "POST")
      return json(issued(c), 201);
    return json({}, 404);
  });
  c = workerCredential(server.origin);
  const secret = `sfenroll_${"e".repeat(43)}`;
  try {
    const client = new CloudWorkerClient(server.origin);
    const result = await client.enroll({
      enrollmentId,
      enrollmentSecret: secret,
      runtimeVersion: "test-1",
      capabilities: [],
    });
    expect(result.credential).toBe(c.credential);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe(`Enrollment ${secret}`);
    expect(calls[0]!.key).toMatch(/^[a-zA-Z0-9_.:-]{1,128}$/);
    expect(JSON.stringify(result)).not.toContain(secret);
  } finally {
    server.close();
  }
});

test("worker client verifies stored identity and rejects same-tenant mismatches locally", async () => {
  const dir = privateDirectory(),
    path = join(dir, "worker.json");
  let c: CloudWorkerCredential;
  let calls = 0;
  const server = api(() => {
    calls++;
    return json({
      worker_id: c.worker_id,
      tenant_id: c.tenant_id,
      audience: "worker-identity",
      scopes: c.scopes,
      registration_epoch: 1,
      expires_at: c.expires_at,
      authorization_expires_at: c.authorization_expires_at,
    });
  });
  c = workerCredential(server.origin);
  try {
    saveCloudWorkerCredential(path, c);
    const client = await CloudWorkerClient.reconnect(path);
    expect(client.origin).toBe(server.origin);
    const identity = await client.identity();
    expect(identity.worker_id).toBe(c.worker_id);
    const other = { ...c, tenant_id: randomUUID() };
    saveCloudWorkerCredential(path, other);
    await expect(
      CloudWorkerClient.reconnect(path).then((reconnected) =>
        reconnected.identity(),
      ),
    ).rejects.toThrow("does not match");
    expect(calls).toBe(2);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker rotation survives a lost reply by retrying the durable idempotency key", async () => {
  const dir = privateDirectory(),
    path = join(dir, "worker.json");
  let c: CloudWorkerCredential;
  const seen: (string | null)[] = [];
  let attempt = 0;
  const server = api(async (request) => {
    seen.push(request.headers.get("idempotency-key"));
    attempt++;
    if (attempt === 1) {
      request.signal.throwIfAborted();
      await request.json();
      return new Response(null, { status: 500 });
    }
    return json(issued(c));
  });
  c = workerCredential(server.origin);
  try {
    saveCloudWorkerCredential(path, c);
    const client = await CloudWorkerClient.reconnect(path, { maxAttempts: 2 });
    const rotated = await client.rotate(path);
    expect(rotated.credential).toBe(c.credential);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(readCloudWorkerCredential(path)).toEqual(c);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker client rejects wrong audience, hostile responses, leaked secrets and CLI credentials", async () => {
  const secret = "worker-provider-secret-do-not-print";
  const mode = { value: 0 };
  const server = api(() => {
    if (mode.value === 0)
      return json({
        credential: `sfcli_${"a".repeat(43)}`,
        credential_id: randomUUID(),
        installation_id: randomUUID(),
        subject_id: randomUUID(),
        tenant_id: randomUUID(),
        scopes: ["identity:read", "devices:self"],
        expires_at: Date.now() + 86400000,
        authorization_expires_at: Date.now() + 30 * 86400000,
      });
    if (mode.value === 1) return json({ error: { message: secret } }, 403);
    return new Response("x".repeat(131073), {
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const client = new CloudWorkerClient(
      server.origin,
      `sfworker_${"w".repeat(43)}`,
    );
    mode.value = 0;
    await expect(
      client.enroll({
        enrollmentId: randomUUID(),
        enrollmentSecret: `sfenroll_${"e".repeat(43)}`,
        runtimeVersion: "1",
        capabilities: [],
      }),
    ).rejects.toThrow("response is invalid");
    mode.value = 1;
    for (const run of [
      () =>
        client.enroll({
          enrollmentId: randomUUID(),
          enrollmentSecret: `sfenroll_${"e".repeat(43)}`,
          runtimeVersion: "1",
          capabilities: [],
        }),
      () => client.identity(),
    ])
      try {
        await run();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CloudApiError);
        expect((e as Error).message).not.toContain(secret);
      }
    mode.value = 2;
    await expect(client.identity()).rejects.toThrow("response is invalid");
    expect(
      () => new CloudWorkerClient(server.origin, `sfcli_${"a".repeat(43)}`),
    ).toThrow("credential is invalid");
  } finally {
    server.close();
  }
});

test("worker client follows redirects never, respects 429 and stops on expired or revoked credentials", async () => {
  let leaked = 0;
  const target = api(() => {
    leaked++;
    return json({});
  });
  let ratelimited = 0;
  let rotatedForRetry: CloudWorkerCredential | undefined;
  const server = api((request) => {
    if (new URL(request.url).pathname === "/v1/workers/me")
      return new Response(null, {
        status: 302,
        headers: { location: target.origin },
      });
    ratelimited++;
    if (
      ratelimited <= 5 &&
      request.headers.get("authorization") !== "Bearer retry-ok"
    )
      return json({ error: { code: "x", message: "y" } }, 429);
    if (new URL(request.url).pathname === "/v1/workers/me/rotate")
      return json(issued(rotatedForRetry!));
    return json({}, 404);
  });
  const expired = api(() => json({}, 401));
  try {
    await expect(
      new CloudWorkerClient(
        server.origin,
        `sfworker_${"w".repeat(43)}`,
      ).identity(),
    ).rejects.toThrow("request failed");
    expect(leaked).toBe(0);
    const dir = privateDirectory(),
      path = join(dir, "worker.json");
    try {
      const limited = workerCredential(server.origin);
      rotatedForRetry = {
        ...limited,
        credential: `sfworker_${"r".repeat(43)}`,
        credential_id: randomUUID(),
        expires_at: Date.now() + 3600000,
        authorization_expires_at: Date.now() + 30 * 86400000,
      };
      saveCloudWorkerCredential(path, {
        ...limited,
        expires_at: Date.now() + 3600000,
      });
      const client = await CloudWorkerClient.reconnect(path, {
        maxAttempts: 5,
        sleep: () => Promise.resolve(),
      });
      await expect(client.rotate(path)).rejects.toThrow("rate limit exceeded");
      expect(ratelimited).toBe(5);
      const gone = { ...limited, expires_at: Date.now() - 1 };
      saveCloudWorkerCredential(path, gone);
      await expect(
        CloudWorkerClient.reconnect(path).then((again) => again.identity()),
      ).rejects.toThrow("expired");
      saveCloudWorkerCredential(path, {
        ...limited,
        expires_at: Date.now() + 3600000,
      });
      const revoked = new CloudWorkerClient(
        expired.origin,
        `sfworker_${"w".repeat(43)}`,
      );
      await expect(revoked.identity()).rejects.toThrow(
        "invalid, expired or revoked",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    server.close();
    target.close();
    expired.close();
  }
});

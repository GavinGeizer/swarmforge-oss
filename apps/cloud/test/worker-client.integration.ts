import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Credential, fixture } from "./machine-helpers.ts";

// This integration test exercises the production worker identity/enrollment
// client (src/cloud-worker-client.ts) and the shared POSIX private-file helper
// (src/private-credential-file.ts) against a real workerd/D1 server. The Bun
// client runs as an actual Bun subprocess through the existing loopback bridge
// pattern from cli-runtime.integration.ts. The simulated GitHub identity used
// by the fixture is clearly labelled: the miniflare outbound service returns
// synthetic provider users (user100/user200) and never contacts GitHub.

const BUN = process.env.SWARMFORGE_TEST_BUN ?? "/tmp/opencode/bun142/bin/bun";

async function runDriver(
  directory: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const script = `
const mod = await import(${JSON.stringify(fileURLToPath(new URL("../../../src/cloud-worker-client.ts", import.meta.url)))});
const store = await import(${JSON.stringify(fileURLToPath(new URL("../../../src/cloud-worker-credentials.ts", import.meta.url)))});
const raw = await new Response(Bun.stdin.stream()).text();
const command = JSON.parse(raw);
const out = {};
try {
  if (command.op === "enroll") {
    const client = new mod.CloudWorkerClient(command.origin);
    const reply = await client.enroll({
      enrollmentId: command.enrollmentId,
      enrollmentSecret: command.enrollmentSecret,
      runtimeVersion: "integration-worker-1",
      capabilities: [],
    });
    const stored = mod.CloudWorkerClient.persistEnrollment(command.storagePath, command.origin, reply);
    out.ok = true;
    out.worker_id = stored.worker_id;
    out.tenant_id = stored.tenant_id;
  } else if (command.op === "identity") {
    const client = await mod.CloudWorkerClient.reconnect(command.storagePath);
    const identity = await client.identity();
    out.ok = true;
    out.worker_id = identity.worker_id;
    out.tenant_id = identity.tenant_id;
  } else if (command.op === "rotate") {
    const stored = store.readCloudWorkerCredential(command.storagePath);
    if (!stored) throw new Error("missing worker credential");
    const client = new mod.CloudWorkerClient(stored.server_url, stored.credential, {
      expected: { worker_id: stored.worker_id, tenant_id: stored.tenant_id, subject_id: stored.subject_id },
    });
    const reply = await client.rotate(command.storagePath);
    out.ok = true;
    out.credential_id = reply.credential_id;
  } else {
    throw new Error("unknown driver op");
  }
} catch (e) {
  out.ok = false;
  out.error = e instanceof Error ? e.message : String(e);
  out.errorName = e instanceof Error ? e.constructor.name : typeof e;
}
process.stdout.write(JSON.stringify(out) + "\\n");
`;
  const child = spawn(
    BUN,
    ["--no-env-file", "--config=/dev/null", "-e", script],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (v) => {
    stdout += v;
  });
  child.stderr.on("data", (v) => {
    stderr += v;
  });
  child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, `Bun driver exited ${code}: ${stderr}`);
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<
    string,
    unknown
  >;
  return { ...parsed, stderr };
}

test("real Bun worker client enrolls, verifies identity, rotates with lost-reply recovery and is contained by revocation/expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swarmforge-worker-client-"));
  let h: Awaited<ReturnType<typeof fixture>>;
  const observed: { path: string; has_cookie: boolean; status: number }[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const part of req) chunks.push(Buffer.from(part));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(",") : v;
      const result = await h.request(
        req.url!,
        headers,
        req.method,
        chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : undefined,
      );
      observed.push({
        path: req.url!,
        has_cookie: Boolean(req.headers.cookie),
        status: result.status,
      });
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "fixture_failure", message: "Fixture failed" },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  h = await fixture(origin);
  const storagePath = join(directory, "worker-credentials.json");
  try {
    // Simulated GitHub login via the fixture's synthetic provider identity.
    const account = await h.login();
    const invitation = await h.enroll(account);
    const secret = invitation.enrollment_secret;

    const enrolled = await runDriver(directory, {
      op: "enroll",
      origin,
      enrollmentId: invitation.enrollment_id,
      enrollmentSecret: secret,
      storagePath,
    });
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    const stored = JSON.parse(await readFile(storagePath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(stored.worker_id, enrolled.worker_id);
    assert.equal(stored.tenant_id, account.tenant);
    assert.deepEqual(stored.scopes, ["worker:identity", "worker:rotate"]);
    assert.ok(String(stored.credential).startsWith("sfworker_"));
    assert.equal((await stat(storagePath)).mode & 0o777, 0o600);
    // The enrollment secret lives in driver memory only: the driver echoed no
    // secret-bearing payload and the file/class APIs never log argv content.
    assert.ok(!JSON.stringify(enrolled).includes(secret));
    assert.ok(!String(enrolled.stderr ?? "").includes(secret));

    const identified = await runDriver(directory, {
      op: "identity",
      storagePath,
    });
    assert.equal(identified.ok, true, JSON.stringify(identified));
    assert.equal(identified.worker_id, enrolled.worker_id);

    // Same-tenant identity mismatch: tampering the stored tenant/ids must fail
    // the reconnected client's verification before further communication.
    const tampered = {
      ...(stored as object),
      tenant_id: crypto.randomUUID(),
    };
    const tamperedPath = join(directory, "worker-tampered.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(tamperedPath, `${JSON.stringify(tampered)}\n`, {
        mode: 0o600,
      }),
    );
    const mismatch = await runDriver(directory, {
      op: "identity",
      storagePath: tamperedPath,
    });
    assert.equal(mismatch.ok, false);
    assert.match(String(mismatch.error), /does not match/);

    // Lost rotation reply: first POST returns 500 after the server applied the
    // rotation; the client retries with the same durable idempotency key and
    // recovers the stored reply within the server window.
    const before = JSON.parse(
      await readFile(storagePath, "utf8"),
    ) as Credential & {
      credential_id: string;
    };
    let rotateCalls = 0;
    const originalRequest = h.request.bind(h);
    const flaky = async (
      ...args: Parameters<typeof h.request>
    ): Promise<Awaited<ReturnType<typeof h.request>>> => {
      if (args[0] === "/v1/workers/me/rotate") {
        rotateCalls++;
        if (rotateCalls === 1) {
          const response = await originalRequest(...args);
          assert.equal(response.status, 200);
          // Simulate the lost reply on the loopback bridge.
          return new Response(
            JSON.stringify({
              error: { code: "temporarily_unavailable", message: "lost" },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          ) as unknown as Awaited<ReturnType<typeof h.request>>;
        }
      }
      return originalRequest(...args);
    };
    (h as { request: typeof h.request }).request = flaky;
    const rotated = await runDriver(directory, {
      op: "rotate",
      storagePath,
    });
    (h as { request: typeof h.request }).request = originalRequest;
    assert.equal(rotated.ok, true, JSON.stringify(rotated));
    assert.ok(rotateCalls >= 2);
    const after = JSON.parse(
      await readFile(storagePath, "utf8"),
    ) as Credential & {
      credential_id: string;
    };
    assert.notEqual(after.credential, before.credential);
    assert.equal(after.credential_id, rotated.credential_id);
    assert.ok(!JSON.stringify(rotated).includes(before.credential));
    // The old epoch is dead: only the replay window can answer, never access.
    assert.equal(
      (
        await h.request("/v1/workers/me", {
          authorization: `Bearer ${before.credential}`,
        })
      ).status,
      401,
    );

    // Revoked workers fail closed: the production client's identity call stops
    // with an auth error that requires a fresh enrollment.
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${account.tenant}/workers/${String(stored.worker_id)}`,
          account.headers,
          "DELETE",
        )
      ).status,
      200,
    );
    const revoked = await runDriver(directory, {
      op: "identity",
      storagePath,
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.errorName, "CloudApiError");

    // Expired stored credentials stop locally without contacting the service.
    const seenPaths = observed.length;
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        tamperedPath,
        `${JSON.stringify({ ...(after as object), expires_at: Date.now() - 1 })}\n`,
        { mode: 0o600 },
      ),
    );
    const expired = await runDriver(directory, {
      op: "identity",
      storagePath: tamperedPath,
    });
    assert.equal(expired.ok, false);
    // Either the reconnect guard or the server reports expiry; both require a
    // new enrollment and emit no credential material.
    assert.match(String(expired.error), /expired|invalid, expired or revoked/);
    assert.equal(observed.length, seenPaths);

    // CLI credentials never authenticate as workers, and worker credentials
    // never authenticate as CLI devices: audiences stay separate.
    const device = await h.linked(account);
    assert.equal(
      (
        await h.request("/v1/cli/me", {
          authorization: `Bearer ${after.credential}`,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await h.request("/v1/workers/me", {
          authorization: `Bearer ${device.credential}`,
        })
      ).status,
      401,
    );
    assert.ok(observed.length > 3);
    assert.ok(observed.every((r) => r.has_cookie === false));
    const dump =
      JSON.stringify(observed) +
      JSON.stringify(enrolled) +
      JSON.stringify(rotated);
    assert.ok(!dump.includes(secret));
    assert.ok(!dump.includes(before.credential));
    assert.ok(!dump.includes(after.credential));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await h!.mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

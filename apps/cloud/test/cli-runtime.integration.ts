import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "./machine-helpers.ts";

test("real Bun CLI pairs with workerd/D1, persists privately, checks status, reauthorizes tenant and revokes server/local credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swarmforge-cloud-cli-"));
  let h: Awaited<ReturnType<typeof fixture>>,
    account: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["login"]>>;
  const observed: Record<string, unknown>[] = [];
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
      if (
        req.url === "/v1/cli-links" &&
        req.method === "POST" &&
        result.status === 201
      ) {
        const link = (await result.clone().json()) as {
          link_id: string;
          user_code: string;
          expires_at: number;
          verification_url: string;
        };
        const input = JSON.parse(Buffer.concat(chunks).toString()) as {
          tenant_id?: string;
        };
        const approval = await h.approve(
          {
            ...link,
            headers: {
              authorization: headers.authorization!,
              "idempotency-key": crypto.randomUUID(),
            },
            proof: headers.authorization!.slice(14),
          },
          account,
          input.tenant_id ?? account.tenant,
        );
        assert.equal(approval.status, 200);
      }
      observed.push({
        path: req.url,
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
  const credentialPath = join(directory, "credential.json");
  async function cli(...args: string[]) {
    const child = spawn(
      "bun",
      [
        "--no-env-file",
        "--config=/dev/null",
        fileURLToPath(new URL("../../../src/cli.ts", import.meta.url)),
        "cloud",
        ...args,
        "--credentials",
        credentialPath,
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
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
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr };
  }
  try {
    account = await h.login();
    const login = await cli(
      "login",
      "--cloud-url",
      origin,
      "--no-browser",
      "--json",
    );
    assert.equal(login.code, 0, login.stderr);
    const first = JSON.parse(await readFile(credentialPath, "utf8")) as {
      credential: string;
      tenant_id: string;
      installation_id: string;
    };
    assert.equal(first.tenant_id, account.tenant);
    assert.equal((await stat(credentialPath)).mode & 0o077, 0);
    assert.ok(!login.stdout.includes(first.credential));
    assert.ok(!login.stderr.includes(first.credential));
    const status = await cli("status", "--json");
    assert.equal(status.code, 0, status.stderr);
    const seen = await h.db
      .prepare(
        "SELECT last_seen_at FROM cli_installations WHERE installation_id=?",
      )
      .bind(first.installation_id)
      .first<{ last_seen_at: number }>();
    assert.ok(seen?.last_seen_at && seen.last_seen_at <= Date.now());
    assert.equal(
      JSON.parse(status.stdout).installation_id,
      first.installation_id,
    );
    const orgs = await cli("organizations", "--json");
    assert.equal(orgs.code, 0, orgs.stderr);
    assert.equal(JSON.parse(orgs.stdout).items.length, 1);
    const secondAccount = await h.login(200),
      now = Date.now();
    await h.db
      .prepare("INSERT INTO memberships VALUES(?,?,'member','active',?,?)")
      .bind(secondAccount.tenant, account.user, now, now)
      .run();
    const use = await cli(
      "use",
      secondAccount.tenant,
      "--no-browser",
      "--json",
    );
    assert.equal(use.code, 0, use.stderr);
    const second = JSON.parse(
      await readFile(credentialPath, "utf8"),
    ) as typeof first;
    assert.equal(second.tenant_id, secondAccount.tenant);
    assert.notEqual(second.installation_id, first.installation_id);
    assert.equal(
      (
        await h.request("/v1/cli/me", {
          authorization: `Bearer ${first.credential}`,
        })
      ).status,
      401,
    );
    const rotate = await cli("rotate", "--json");
    assert.equal(rotate.code, 0, rotate.stderr);
    const rotated = JSON.parse(
      await readFile(credentialPath, "utf8"),
    ) as typeof first;
    assert.notEqual(rotated.credential, second.credential);
    assert.equal(
      (
        await h.request("/v1/cli/me", {
          authorization: `Bearer ${second.credential}`,
        })
      ).status,
      401,
    );
    const logout = await cli("logout", "--json");
    assert.equal(logout.code, 0, logout.stderr);
    await assert.rejects(() => readFile(credentialPath), { code: "ENOENT" });
    assert.equal(
      (
        await h.request("/v1/cli/me", {
          authorization: `Bearer ${rotated.credential}`,
        })
      ).status,
      401,
    );
    for (const result of [login, status, orgs, use, rotate, logout])
      for (const credential of [
        first.credential,
        second.credential,
        rotated.credential,
      ])
        assert.ok(!JSON.stringify(result).includes(credential));
    assert.ok(observed.length > 5);
    assert.ok(observed.every((r) => r.has_cookie === false));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await h.mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

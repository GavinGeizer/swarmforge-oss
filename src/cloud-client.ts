import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { cloudCredentialSchema, cloudOrigin } from "./cloud-credentials";

const id = z.uuid(),
  time = z.number().int().positive();
const scopes = z.tuple([z.literal("identity:read"), z.literal("devices:self")]);
const display = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u);
const credentialSchema = cloudCredentialSchema.omit({
  version: true,
  server_url: true,
});
const linkSchema = z
  .object({
    link_id: id,
    user_code: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    verification_url: z.url(),
    expires_at: time,
    poll_interval_seconds: z.literal(5),
  })
  .strict();
const pendingSchema = z
  .object({ state: z.literal("pending"), poll_interval_seconds: z.literal(5) })
  .strict();
const meSchema = z
  .object({
    installation_id: id,
    subject_id: id,
    tenant_id: id,
    client_name: display,
    scopes,
    expires_at: time,
    authorization_expires_at: time,
  })
  .strict();
const organizationsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            tenant_id: id,
            display_name: display,
            role: z.enum(["owner", "admin", "member"]),
          })
          .strict(),
      )
      .max(100),
    next_cursor: z.string().max(2048).nullable(),
  })
  .strict();
export class CloudApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter = 5,
  ) {
    super(
      status === 401
        ? "Cloud credential is invalid, expired or revoked. Run swarmforge cloud login."
        : status === 429
          ? "Cloud request rate limit exceeded."
          : "Cloud request was denied or unavailable.",
    );
  }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Cloud response is invalid.");
  return result.data;
}
async function delay(ms: number, signal: AbortSignal) {
  if (signal.aborted) throw new Error("Cloud authorization cancelled.");
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new Error("Cloud authorization cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
export class CloudClient {
  readonly origin: string;
  constructor(
    origin: string,
    private credential?: string,
  ) {
    this.origin = cloudOrigin(origin);
    if (credential && !/^sfcli_[A-Za-z0-9_-]{43}$/.test(credential))
      throw new Error("Cloud credential is invalid.");
  }
  private async request(
    path: string,
    method = "GET",
    data?: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        method,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          accept: "application/json",
          ...(data === undefined ? {} : { "content-type": "application/json" }),
          ...(this.credential
            ? { authorization: `Bearer ${this.credential}` }
            : {}),
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch {
      throw new Error(
        signal?.aborted
          ? "Cloud authorization cancelled."
          : "Cloud request failed. Check the configured service and connectivity.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("retry-after") ?? "";
      throw new CloudApiError(
        response.status,
        /^\d+$/.test(retry) ? Math.min(120, Math.max(5, Number(retry))) : 5,
      );
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      throw new Error("Cloud response is invalid.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Cloud response is invalid.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 131072) throw new Error();
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new Error("Cloud response is invalid.");
    } finally {
      await reader.cancel();
    }
  }
  async start(name: string, tenant?: string) {
    parse(display, name);
    if (tenant) parse(id, tenant);
    const proof = randomBytes(32).toString("base64url"),
      key = randomUUID();
    const link = parse(
      linkSchema,
      await this.request(
        "/v1/cli-links",
        "POST",
        {
          client_name: name,
          requested_scopes: ["identity:read", "devices:self"],
          ...(tenant ? { tenant_id: tenant } : {}),
        },
        { authorization: `LinkInitiator ${proof}`, "idempotency-key": key },
      ),
    );
    let safe = false;
    try {
      const u = new URL(link.verification_url);
      safe =
        u.origin === this.origin &&
        u.pathname === "/cloud/connect" &&
        u.search === `?link_id=${link.link_id}` &&
        !u.hash &&
        !u.username &&
        !u.password;
    } catch {}
    if (
      !safe ||
      link.expires_at <= Date.now() ||
      link.expires_at > Date.now() + 660000
    )
      throw new Error("Cloud approval URL or expiration is invalid.");
    return { ...link, proof };
  }
  async cancel(link: Awaited<ReturnType<CloudClient["start"]>>) {
    try {
      await this.request(`/v1/cli-links/${link.link_id}`, "DELETE", undefined, {
        authorization: `LinkInitiator ${link.proof}`,
      });
    } catch {}
  }
  async exchange(
    link: Awaited<ReturnType<CloudClient["start"]>>,
    signal: AbortSignal,
  ) {
    const key = randomUUID();
    try {
      while (Date.now() < link.expires_at) {
        await delay(link.poll_interval_seconds * 1000, signal);
        let value: unknown;
        try {
          value = await this.request(
            `/v1/cli-links/${link.link_id}/exchange`,
            "POST",
            {},
            {
              authorization: `LinkInitiator ${link.proof}`,
              "idempotency-key": key,
            },
            signal,
          );
        } catch (e) {
          if (e instanceof CloudApiError && e.status === 429) {
            await delay(e.retryAfter * 1000, signal);
            continue;
          }
          throw e;
        }
        if (pendingSchema.safeParse(value).success) continue;
        const credential = parse(credentialSchema, value);
        if (
          credential.expires_at <= Date.now() ||
          credential.authorization_expires_at <= Date.now() ||
          credential.expires_at > credential.authorization_expires_at ||
          credential.authorization_expires_at > Date.now() + 31 * 86400000
        )
          throw new Error("Cloud credential expiration is invalid.");
        return credential;
      }
      throw new Error("Cloud authorization expired. Start a new login.");
    } catch (e) {
      await this.cancel(link);
      throw e;
    }
  }
  async me() {
    return parse(meSchema, await this.request("/v1/cli/me"));
  }
  async organizations(cursor?: string) {
    return parse(
      organizationsSchema,
      await this.request(
        `/v1/cli/organizations?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
  }
  async revoke() {
    return parse(
      z.object({ installation_id: id, revoked_at: time }).strict(),
      await this.request("/v1/cli/me", "DELETE"),
    );
  }
  async rotate() {
    return parse(
      credentialSchema,
      await this.request(
        "/v1/cli/me/rotate",
        "POST",
        {},
        { "idempotency-key": randomUUID() },
      ),
    );
  }
}

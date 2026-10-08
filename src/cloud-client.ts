import { randomUUID } from "node:crypto";
import { z } from "zod";

const _LinkInitiator = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .transform((s) => Buffer.from(s, "base64url"));

const _ExchangeResponse = z.object({
  credential: z.string().regex(/^sfcli_[A-Za-z0-9_-]+$/),
  credential_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  subject_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  scopes: z.array(z.string()),
  expires_at: z.number().int().positive(),
  authorization_expires_at: z.number().int().positive(),
});

const LinkResponse = z.object({
  link_id: z.string().uuid(),
  user_code: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
  verification_url: z.string().url(),
  expires_at: z.number().int().positive(),
  poll_interval_seconds: z.number().int().positive(),
});

const ExchangePending = z.object({
  state: z.literal("pending"),
  poll_interval_seconds: z.number().int().positive(),
});

const ExchangeSuccess = z.object({
  state: z.literal("approved"),
  credential: z.string().regex(/^sfcli_[A-Za-z0-9_-]+$/),
  credential_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  subject_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  scopes: z.array(z.string()),
  expires_at: z.number().int().positive(),
  authorization_expires_at: z.number().int().positive(),
});

const MeResponse = z.object({
  installation_id: z.string().uuid(),
  subject_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  client_name: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.number().int().positive(),
  authorization_expires_at: z.number().int().positive(),
});

const OrganizationsResponse = z.object({
  items: z.array(
    z.object({
      tenant_id: z.string().uuid(),
      display_name: z.string(),
      role: z.string(),
    }),
  ),
  next_cursor: z.union([z.string(), z.literal(null)]),
});

export class CloudApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public headers: Headers = new Headers(),
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export class CloudClient {
  constructor(
    private serverUrl: string,
    private credential: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    additionalHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.credential}`,
      ...additionalHeaders,
    };

    const response = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const _contentType = response.headers.get("content-type") ?? "";
      let errorText: string;
      try {
        const data = await response.json();
        errorText =
          typeof data === "object" && data !== null && "error" in data
            ? String(data.error)
            : String(data);
      } catch {
        errorText = await response.text();
      }
      throw new CloudApiError(
        `Cloud API error: ${response.status} ${response.statusText} - ${errorText}`,
        response.status,
        response.headers,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new CloudApiError("Cloud API returned non-JSON response", 502);
    }

    return response.json();
  }

  async createLink(
    clientName: string,
    tenantId?: string,
  ): Promise<{
    linkId: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: number;
    pollIntervalSeconds: number;
  }> {
    const initiator = base64url(Buffer.from(randomUUID().replace(/-/g, "")));

    const body = {
      client_name: clientName,
      requested_scopes: ["identity:read", "devices:self"],
      tenant_id: tenantId,
    };

    const result = await this.request<z.infer<typeof LinkResponse>>(
      "POST",
      "/v1/cli-links",
      body,
      {
        Authorization: `LinkInitiator ${initiator}`,
        "Idempotency-Key": randomUUID(),
      },
    );

    return {
      linkId: result.link_id,
      userCode: result.user_code,
      verificationUrl: result.verification_url,
      expiresAt: result.expires_at,
      pollIntervalSeconds: result.poll_interval_seconds,
    };
  }

  async exchangeLink(
    linkId: string,
    initiator: string,
    pollInterval: number,
    signal: AbortSignal,
  ): Promise<{
    credential: string;
    credentialId: string;
    installationId: string;
    subjectId: string;
    tenantId: string;
    scopes: string[];
    expiresAt: number;
    authorizationExpiresAt: number;
  }> {
    const deadline = Date.now() + 600000;
    const key = randomUUID();

    while (Date.now() < deadline && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
      if (signal.aborted) {
        await this.cancelLink(linkId, initiator);
        throw new Error("Authorization cancelled.");
      }

      try {
        const result = await this.request<
          z.infer<typeof ExchangePending> | z.infer<typeof ExchangeSuccess>
        >(
          "POST",
          `/v1/cli-links/${linkId}/exchange`,
          {},
          {
            Authorization: `LinkInitiator ${initiator}`,
            "Idempotency-Key": key,
          },
        );

        if (result.state === "pending") continue;

        if (result.credential?.startsWith("sfcli_")) {
          return {
            credential: result.credential,
            credentialId: result.credential_id,
            installationId: result.installation_id,
            subjectId: result.subject_id,
            tenantId: result.tenant_id,
            scopes: result.scopes,
            expiresAt: result.expires_at,
            authorizationExpiresAt: result.authorization_expires_at,
          };
        }
      } catch (error) {
        if (error instanceof CloudApiError) {
          if (error.status === 429) {
            const retryAfter = error.headers.get("Retry-After");
            const wait = retryAfter ? Number(retryAfter) : pollInterval;
            await new Promise((resolve) => setTimeout(resolve, wait * 1000));
            continue;
          }
          if (
            error.status === 403 ||
            error.status === 410 ||
            error.status === 409
          ) {
            throw new Error(
              "Authorization was denied, expired, or already consumed.",
            );
          }
        }
        throw error;
      }
    }

    throw new Error("Authorization timed out.");
  }

  async cancelLink(linkId: string, initiator: string): Promise<void> {
    try {
      await this.request("DELETE", `/v1/cli-links/${linkId}`, undefined, {
        Authorization: `LinkInitiator ${initiator}`,
      });
    } catch {
      // Best-effort cancel
    }
  }

  async me(): Promise<{
    installationId: string;
    subjectId: string;
    tenantId: string;
    clientName: string;
    scopes: string[];
    expiresAt: number;
    authorizationExpiresAt: number;
  }> {
    const result = await this.request<z.infer<typeof MeResponse>>(
      "GET",
      "/v1/cli/me",
    );
    return {
      installationId: result.installation_id,
      subjectId: result.subject_id,
      tenantId: result.tenant_id,
      clientName: result.client_name,
      scopes: result.scopes,
      expiresAt: result.expires_at,
      authorizationExpiresAt: result.authorization_expires_at,
    };
  }

  async organizations(cursor?: string | null): Promise<{
    items: {
      tenantId: string;
      displayName: string;
      role: string;
    }[];
    nextCursor: string | null;
  }> {
    const path = cursor
      ? `/v1/cli/organizations?cursor=${cursor}`
      : "/v1/cli/organizations";
    const result = await this.request<z.infer<typeof OrganizationsResponse>>(
      "GET",
      path,
    );
    return {
      items: result.items.map((i) => ({
        tenantId: i.tenant_id,
        displayName: i.display_name,
        role: i.role,
      })),
      nextCursor: result.next_cursor,
    };
  }

  async revoke(): Promise<void> {
    try {
      await this.request("DELETE", "/v1/cli/me");
    } catch {}
  }

  async rotate(): Promise<{
    credential: string;
    credentialId: string;
    installationId: string;
    subjectId: string;
    tenantId: string;
    scopes: string[];
    expiresAt: number;
    authorizationExpiresAt: number;
  }> {
    const result = await this.request<z.infer<typeof ExchangeSuccess>>(
      "POST",
      "/v1/cli/me/rotate",
      {},
      { "Idempotency-Key": randomUUID() },
    );
    return {
      credential: result.credential,
      credentialId: result.credential_id,
      installationId: result.installation_id,
      subjectId: result.subject_id,
      tenantId: result.tenant_id,
      scopes: result.scopes,
      expiresAt: result.expires_at,
      authorizationExpiresAt: result.authorization_expires_at,
    };
  }
}

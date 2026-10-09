import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CloudApiError } from "./cloud-client";
import { cloudOrigin } from "./cloud-credentials";
import {
  type CloudWorkerCredential,
  cloudWorkerCredentialSchema,
  readCloudWorkerCredential,
  saveCloudWorkerCredential,
} from "./cloud-worker-credentials";
import {
  deletePrivateCredential,
  readPrivateCredential,
  savePrivateCredential,
} from "./private-credential-file";

const id = z.uuid(),
  time = z.number().int().positive();
const scopes = z.tuple([
  z.literal("worker:identity"),
  z.literal("worker:rotate"),
]);
const enrollmentSecretFormat = /^sfenroll_[A-Za-z0-9_-]{43}$/;
const workerCredentialFormat = /^sfworker_[A-Za-z0-9_-]{43}$/;
const idempotencyKeyFormat = /^[a-zA-Z0-9_.:-]{1,128}$/;

const registerReplySchema = z
  .object({
    credential: z.string().regex(workerCredentialFormat),
    credential_id: id,
    worker_id: id,
    subject_id: id,
    tenant_id: id,
    scopes,
    expires_at: time,
    authorization_expires_at: time,
    worker: z
      .object({
        worker_id: id,
        tenant_id: id,
        name: z.string().min(1).max(100),
        state: z.enum(["registered", "revoked"]),
        registration_epoch: z.number().int(),
        created_at: time,
        revoked_at: z.number().int().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.expires_at <= v.authorization_expires_at)
  .refine(
    (v) =>
      v.worker === undefined ||
      (v.worker.worker_id === v.worker_id &&
        v.worker.tenant_id === v.tenant_id),
  );

const identitySchema = z
  .object({
    worker_id: id,
    tenant_id: id,
    audience: z.literal("worker-identity"),
    scopes,
    registration_epoch: z.number().int(),
    expires_at: time,
    authorization_expires_at: time,
  })
  .strict();

const pendingKeySchema = z
  .object({ idempotency_key: z.string().regex(idempotencyKeyFormat) })
  .strict();

export type WorkerEnrollInput = {
  enrollmentId: string;
  enrollmentSecret: string;
  runtimeVersion: string;
  capabilities: string[];
};

export type WorkerClientOptions = {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type WorkerIdentity = z.infer<typeof identitySchema>;
export type WorkerCredentialReply = z.infer<typeof registerReplySchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Cloud response is invalid.");
  return result.data;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function checkFreshness(
  value: { expires_at: number; authorization_expires_at: number },
  now = Date.now(),
) {
  if (
    value.expires_at <= now ||
    value.authorization_expires_at <= now ||
    value.expires_at > value.authorization_expires_at ||
    value.authorization_expires_at > now + 31 * 86400000
  )
    throw new Error("Cloud worker credential expiration is invalid.");
}

export class CloudWorkerClient {
  readonly origin: string;
  private readonly credential?: string;
  private readonly expected?: {
    worker_id: string;
    tenant_id: string;
    subject_id: string;
  };
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    origin: string,
    credential?: string,
    options: WorkerClientOptions & {
      expected?: {
        worker_id: string;
        tenant_id: string;
        subject_id: string;
      };
    } = {},
  ) {
    this.origin = cloudOrigin(origin);
    if (credential && !workerCredentialFormat.test(credential))
      throw new Error("Cloud worker credential is invalid.");
    this.credential = credential;
    this.expected = options.expected;
    this.maxAttempts = Math.min(
      10,
      Math.max(1, Math.floor(options.maxAttempts ?? 3)),
    );
    this.sleep = options.sleep ?? defaultSleep;
  }

  static async reconnect(
    storagePath: string,
    options: WorkerClientOptions = {},
  ): Promise<CloudWorkerClient> {
    const stored = readCloudWorkerCredential(storagePath);
    if (!stored)
      throw new Error(
        "Cloud worker is not enrolled. Complete enrollment first.",
      );
    if (
      stored.expires_at <= Date.now() ||
      stored.authorization_expires_at <= Date.now()
    )
      throw new Error(
        "Cloud worker credential has expired. Complete a new enrollment.",
      );
    return new CloudWorkerClient(stored.server_url, stored.credential, {
      ...options,
      expected: {
        worker_id: stored.worker_id,
        tenant_id: stored.tenant_id,
        subject_id: stored.subject_id,
      },
    });
  }

  private async request(
    path: string,
    method = "GET",
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    let response: Response;
    try {
      response = await fetch(this.origin + path, {
        method,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(30000),
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
        "Cloud worker request failed. Check the configured service and connectivity.",
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

  private async withRetries(
    run: (idempotencyKey: string) => Promise<unknown>,
    idempotencyKey: string,
  ): Promise<unknown> {
    let last: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await run(idempotencyKey);
      } catch (e) {
        last = e;
        if (e instanceof CloudApiError) {
          // Expired, revoked, invalid or conflicting credentials stop immediately
          // and require a new enrollment; never retry those as new operations.
          // Rate limits and retryable server failures reuse the same durable
          // idempotency key so a lost reply can recover the stored result.
          if (e.status === 401 || e.status === 409 || e.status === 410) throw e;
          if (
            (e.status === 429 ||
              e.status === 500 ||
              e.status === 502 ||
              e.status === 503 ||
              e.status === 504) &&
            attempt < this.maxAttempts
          ) {
            await this.sleep(
              e.status === 429 ? e.retryAfter * 1000 : 1000 * attempt,
            );
            continue;
          }
          throw e;
        }
        if (attempt < this.maxAttempts) continue;
        throw e;
      }
    }
    throw last;
  }

  async enroll(input: WorkerEnrollInput): Promise<WorkerCredentialReply> {
    parse(id, input.enrollmentId);
    if (!enrollmentSecretFormat.test(input.enrollmentSecret))
      throw new Error("Cloud enrollment credential is invalid.");
    parse(z.string().min(1).max(64), input.runtimeVersion);
    parse(z.array(z.string().min(1).max(64)).max(20), input.capabilities);
    const key = randomUUID();
    // The enrollment secret is held in memory only: it is sent in the
    // Authorization header and never written to argv, disk or error text.
    const reply = parse(
      registerReplySchema,
      await this.withRetries(
        (idempotencyKey) =>
          this.request(
            "/v1/workers/register",
            "POST",
            {
              enrollment_id: input.enrollmentId,
              name: "runtime-hint",
              runtime_version: input.runtimeVersion,
              capabilities: input.capabilities,
            },
            {
              authorization: `Enrollment ${input.enrollmentSecret}`,
              "idempotency-key": idempotencyKey,
            },
          ),
        key,
      ),
    );
    checkFreshness(reply);
    return reply;
  }

  async identity(): Promise<WorkerIdentity> {
    const live = parse(identitySchema, await this.request("/v1/workers/me"));
    if (
      this.expected &&
      (live.worker_id !== this.expected.worker_id ||
        live.tenant_id !== this.expected.tenant_id)
    )
      throw new Error(
        "Cloud worker identity does not match the stored worker.",
      );
    return live;
  }

  async rotate(storagePath?: string): Promise<WorkerCredentialReply> {
    if (!this.credential)
      throw new Error("Cloud worker credential is invalid.");
    const pendingPath =
      storagePath === undefined ? undefined : `${storagePath}.rotate-pending`;
    let key: string | undefined;
    if (pendingPath) {
      try {
        key =
          readPrivateCredential(pendingPath, pendingKeySchema)
            ?.idempotency_key ?? undefined;
      } catch {
        key = undefined;
      }
    }
    // One durable idempotency key per rotation: a lost reply retries the exact
    // context so the server can replay the stored result within its window.
    if (!key || !idempotencyKeyFormat.test(key)) {
      key = randomUUID();
      if (pendingPath)
        savePrivateCredential(
          pendingPath,
          { idempotency_key: key },
          pendingKeySchema,
        );
    }
    const stableKey = key;
    try {
      const reply = parse(
        registerReplySchema,
        await this.withRetries(
          (idempotencyKey) =>
            this.request(
              "/v1/workers/me/rotate",
              "POST",
              {},
              {
                "idempotency-key": idempotencyKey,
              },
            ),
          stableKey,
        ),
      );
      checkFreshness(reply);
      if (
        this.expected &&
        (reply.worker_id !== this.expected.worker_id ||
          reply.tenant_id !== this.expected.tenant_id ||
          reply.subject_id !== this.expected.subject_id ||
          JSON.stringify(reply.scopes) !==
            JSON.stringify(["worker:identity", "worker:rotate"]))
      )
        throw new Error("Cloud rotation changed the worker identity.");
      if (storagePath) {
        const stored = readCloudWorkerCredential(storagePath);
        if (stored) {
          const { worker: _echo, ...credential } = reply;
          saveCloudWorkerCredential(storagePath, {
            ...credential,
            version: 1,
            server_url: stored.server_url,
          });
        }
      }
      if (pendingPath) deletePrivateCredential(pendingPath, pendingKeySchema);
      return reply;
    } catch (e) {
      if (
        e instanceof CloudApiError &&
        (e.status === 401 || e.status === 409 || e.status === 410) &&
        pendingPath
      ) {
        // The previous credential can no longer authorize a replay.
        try {
          deletePrivateCredential(pendingPath, pendingKeySchema);
        } catch {}
      }
      throw e;
    }
  }

  static workerCredentialSchema() {
    return cloudWorkerCredentialSchema;
  }

  static persistEnrollment(
    storagePath: string,
    origin: string,
    reply: WorkerCredentialReply,
  ): CloudWorkerCredential {
    checkFreshness(reply);
    const { worker: _echo, ...credential } = reply;
    const stored: CloudWorkerCredential = {
      ...credential,
      version: 1,
      server_url: cloudOrigin(origin),
    };
    saveCloudWorkerCredential(storagePath, stored);
    return stored;
  }
}

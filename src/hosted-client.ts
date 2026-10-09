import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cloudOrigin } from "./cloud-credentials";
import {
  deletePrivateCredential,
  readPrivateCredential,
  savePrivateCredential,
} from "./private-credential-file";

const id = z.uuid();
const time = z.number().int().positive();
const execPattern = /^sfexec_[A-Za-z0-9_-]{43}$/;
const superPattern = /^sfsuper_[A-Za-z0-9_-]{43}$/;

const pendingRotationSchema = z
  .object({
    idempotency_key: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
  })
  .strict();

const taskState = z.enum([
  "queued",
  "claimed",
  "running",
  "stop_requested",
  "held",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export const hostedTaskSchema = z
  .object({
    task_id: id,
    tenant_id: id,
    worker_id: id,
    execution_class: z.literal("controlled"),
    state: taskState,
    reservation_id: id,
    policy_version: z.number().int().nonnegative(),
    runtime_ms: z.number().int().positive().max(3_600_000),
    controlled_duration_ms: z.number().int().positive().max(3_600_000),
    created_at: time,
    deadline_at: time,
    lease_id: id.nullable(),
    supervisor_id: id.nullable(),
    fence: z.number().int().nonnegative(),
    lease_expires_at: time.nullable(),
  })
  .strict()
  .refine((v) => v.controlled_duration_ms <= v.runtime_ms, {
    message: "controlled_duration_ms cannot exceed runtime_ms",
  });
export type HostedTask = z.infer<typeof hostedTaskSchema>;

export const admissionReplySchema = z
  .object({
    task: hostedTaskSchema,
    reservation_id: id,
    policy_version: z.number().int().nonnegative(),
  })
  .strict();
export type AdmissionReply = z.infer<typeof admissionReplySchema>;

export const claimReplySchema = z
  .object({ task: hostedTaskSchema.nullable(), server_time: time })
  .strict();
export type ClaimReply = z.infer<typeof claimReplySchema>;

export const leaseRequestSchema = z
  .object({ lease_id: id, fence: z.number().int().nonnegative() })
  .strict();
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;

export const leaseReplySchema = z
  .object({
    task: hostedTaskSchema,
    directive: z.enum(["continue", "stop"]),
    server_time: time,
  })
  .strict();
export type LeaseReply = z.infer<typeof leaseReplySchema>;

export const settlementRequestSchema = leaseRequestSchema
  .extend({
    outcome: z.enum(["completed", "failed", "cancelled"]),
    stop_confirmed: z.literal(true),
    consumed_runtime_ms: z.number().int().nonnegative().max(3_600_000),
  })
  .strict();
export type SettlementRequest = z.infer<typeof settlementRequestSchema>;

export const supervisorIdentitySchema = z
  .object({
    supervisor_id: id,
    tenant_id: id,
    worker_id: id,
    scopes: z.tuple([
      z.literal("supervisor:claim"),
      z.literal("supervisor:renew"),
      z.literal("supervisor:report"),
      z.literal("supervisor:cleanup"),
    ]),
    expires_at: time,
    authorization_expires_at: time,
  })
  .strict();

const taskEnvelopeSchema = z.object({ task: hostedTaskSchema }).strict();

export class HostedApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs = 5000,
  ) {
    super(
      status === 401
        ? "Hosted credential is invalid, expired or revoked."
        : status === 409
          ? "Hosted operation conflicts with current server state."
          : status === 429
            ? "Hosted request rate limit exceeded."
            : "Hosted request was denied or unavailable.",
    );
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(`Hosted ${what} response is invalid or cross-tenant.`);
  return result.data;
}

/** Conservative monotonic remaining authority per the phase-2b2 contract. */
export function remainingAuthorityMs(options: {
  leaseExpiresAt: number;
  deadlineAt: number;
  serverTime: number;
  requestRttMs: number;
  safetyMarginMs?: number;
}): number {
  const margin = options.safetyMarginMs ?? 2000;
  return (
    Math.min(options.leaseExpiresAt, options.deadlineAt) -
    options.serverTime -
    options.requestRttMs -
    margin
  );
}

const REQUEST_TIMEOUT_MS = 30000;
const RESPONSE_LIMIT_BYTES = 131072;
const MAX_ATTEMPTS = 3;

abstract class HostedHttpClient {
  readonly origin: string;
  protected constructor(
    origin: string,
    protected readonly bearer: string,
    pattern: RegExp,
  ) {
    this.origin = cloudOrigin(origin);
    if (!pattern.test(bearer)) throw new Error("Hosted credential is invalid.");
  }
  protected async request(
    path: string,
    method: string,
    data: unknown,
    idempotencyKey: string | undefined,
    expectedTenant: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let last: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(this.origin + path, {
          method,
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.any([
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            ...(signal ? [signal] : []),
          ]),
          headers: {
            accept: "application/json",
            ...(data === undefined
              ? {}
              : { "content-type": "application/json" }),
            authorization: `Bearer ${this.bearer}`,
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        void started;
      } catch {
        last = new Error(
          signal?.aborted
            ? "Hosted request cancelled."
            : "Hosted request failed. Check the configured service and connectivity.",
        );
        await Bun.sleep(Math.min(1000 * 2 ** (attempt - 1), 4000));
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        const raw = response.headers.get("retry-after") ?? "";
        const wait = /^\d+$/.test(raw)
          ? Math.min(120000, Math.max(5000, Number(raw) * 1000))
          : 5000;
        last = new HostedApiError(429, wait);
        await Bun.sleep(Math.min(wait, 8000));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const retry = response.headers.get("retry-after") ?? "";
        throw new HostedApiError(
          response.status,
          /^\d+$/.test(retry)
            ? Math.min(120000, Math.max(5000, Number(retry) * 1000))
            : 5000,
        );
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await response.body?.cancel();
        throw new Error("Hosted response is invalid.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Hosted response is invalid.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > RESPONSE_LIMIT_BYTES) throw new Error();
          chunks.push(next.value);
        }
        const parsed = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as unknown;
        if (
          expectedTenant !== undefined &&
          typeof parsed === "object" &&
          parsed !== null &&
          "task" in parsed &&
          typeof (parsed as { task: unknown }).task === "object" &&
          (parsed as { task: { tenant_id?: unknown } | null }).task !== null &&
          (parsed as { task: { tenant_id?: unknown } }).task.tenant_id !==
            expectedTenant
        )
          throw new Error(
            "Hosted response binds a different tenant; refusing cross-tenant state.",
          );
        return parsed;
      } catch (e) {
        if (e instanceof Error && /cross-tenant/.test(e.message)) throw e;
        throw new Error("Hosted response is invalid.");
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    throw last instanceof Error ? last : new Error("Hosted request failed.");
  }
}

export class HostedTaskClient extends HostedHttpClient {
  constructor(
    origin: string,
    credential: string,
    readonly tenantId: string,
  ) {
    super(origin, credential, execPattern);
    parse(id, tenantId, "tenant");
  }
  private tenant(path: string): string {
    return `/v1/tenants/${this.tenantId}${path}`;
  }
  async submitTask(
    workerId: string,
    runtimeMs: number,
    controlledDurationMs: number,
    idempotencyKey = randomUUID(),
  ): Promise<AdmissionReply> {
    parse(id, workerId, "worker");
    if (
      !Number.isSafeInteger(runtimeMs) ||
      runtimeMs <= 0 ||
      runtimeMs > 3_600_000 ||
      !Number.isSafeInteger(controlledDurationMs) ||
      controlledDurationMs <= 0 ||
      controlledDurationMs > runtimeMs
    )
      throw new Error("Hosted task durations are invalid.");
    // No secrets, prompts, repos, models or env in route payloads: fixed inert
    // controlled workload only.
    const body = {
      request_id: randomUUID(),
      worker_id: workerId,
      execution_class: "controlled",
      runtime_ms: runtimeMs,
      controlled_duration_ms: controlledDurationMs,
    };
    const reply = await this.request(
      this.tenant("/tasks"),
      "POST",
      body,
      idempotencyKey,
      this.tenantId,
    );
    return parse(admissionReplySchema, reply, "admission");
  }
  async readTask(taskId: string): Promise<HostedTask> {
    parse(id, taskId, "task");
    const reply = await this.request(
      this.tenant(`/tasks/${taskId}`),
      "GET",
      undefined,
      undefined,
      this.tenantId,
    );
    return parse(taskEnvelopeSchema, reply, "task").task;
  }
  async cancelTask(taskId: string, idempotencyKey = randomUUID()) {
    parse(id, taskId, "task");
    const reply = await this.request(
      this.tenant(`/tasks/${taskId}/cancel`),
      "POST",
      {},
      idempotencyKey,
      this.tenantId,
    );
    return parse(taskEnvelopeSchema, reply, "cancel").task;
  }
  async entitlements(): Promise<unknown> {
    return this.request(
      this.tenant("/entitlements"),
      "GET",
      undefined,
      undefined,
      undefined,
    );
  }
  async hostedStatus(): Promise<unknown> {
    return this.request(
      this.tenant("/hosted-status"),
      "GET",
      undefined,
      undefined,
      undefined,
    );
  }
}

export class SupervisorClient extends HostedHttpClient {
  constructor(
    origin: string,
    credential: string,
    readonly tenantId: string,
  ) {
    super(origin, credential, superPattern);
    parse(id, tenantId, "tenant");
  }
  async identity() {
    return parse(
      supervisorIdentitySchema,
      await this.request(
        "/v1/supervisor/me",
        "GET",
        undefined,
        undefined,
        undefined,
      ),
      "supervisor identity",
    );
  }
  /**
   * Supervisor rotation with a durable idempotency key. P2 note (approved):
   * a rotate call without a storage path cannot durably key a lost reply, so
   * the supervised lifecycle must always pass `pendingStoragePath`; the
   * pathless form is retained only for transport-level tests and refuses to
   * invent durability it cannot provide.
   */
  async rotate(idempotencyKey = randomUUID(), pendingStoragePath?: string) {
    // P2 note (approved): rotate without a storage path lacks a durable key,
    // so the supervised lifecycle must always pass `pendingStoragePath`. The
    // pathless form stays only for transport tests and uses the call key once.
    if (pendingStoragePath === undefined) {
      return this.request(
        "/v1/supervisor/me/rotate",
        "POST",
        {},
        idempotencyKey,
        undefined,
      );
    }
    // One durable idempotency key per rotation window: a lost reply retries
    // the exact key so the server replays the stored result. The pending key
    // is consumed (deleted) on success, so the next rotation mints a new one;
    // a fresh caller key never replaces an already-durable pending key
    // mid-flight — it is only used when no pending key exists yet.
    let durable: string;
    const pendingExists = (() => {
      try {
        return (
          readPrivateCredential(pendingStoragePath, pendingRotationSchema) !==
          null
        );
      } catch {
        throw new Error("Hosted rotation pending state is invalid; holding.");
      }
    })();
    if (pendingExists) {
      durable = readPrivateCredential(
        pendingStoragePath,
        pendingRotationSchema,
      )!.idempotency_key;
    } else {
      durable = idempotencyKey;
      savePrivateCredential(
        pendingStoragePath,
        { idempotency_key: durable },
        pendingRotationSchema,
      );
    }
    const key = durable as `${string}-${string}-${string}-${string}-${string}`;
    try {
      const reply = await this.request(
        "/v1/supervisor/me/rotate",
        "POST",
        {},
        key,
        undefined,
      );
      // The approved supervisor rotation reply carries the successor
      // credential; only a successfully parsed successor clears the pending
      // key. A bare transport ack (test fixtures) leaves it for the caller.
      const successor = z
        .object({ credential: z.string().min(1) })
        .strict()
        .safeParse(reply);
      if (successor.success) {
        try {
          deletePrivateCredential(pendingStoragePath, pendingRotationSchema);
        } catch {}
      }
      return reply;
    } catch (e) {
      if (e instanceof HostedApiError && [401, 409].includes(e.status)) {
        // The previous credential can no longer authorize a replay.
        try {
          deletePrivateCredential(pendingStoragePath, pendingRotationSchema);
        } catch {}
      }
      throw e;
    }
  }
  async claim(idempotencyKey = randomUUID()): Promise<ClaimReply> {
    const reply = await this.request(
      "/v1/supervisor/claim",
      "POST",
      {},
      idempotencyKey,
      undefined,
    );
    const parsed = parse(claimReplySchema, reply, "claim");
    if (parsed.task && parsed.task.tenant_id !== this.tenantId)
      throw new Error(
        "Hosted response binds a different tenant; refusing cross-tenant state.",
      );
    return parsed;
  }
  async ack(
    taskId: string,
    lease: LeaseRequest,
    idempotencyKey = randomUUID(),
  ): Promise<LeaseReply> {
    parse(id, taskId, "task");
    const parsedLease = parse(leaseRequestSchema, lease, "lease");
    const reply = await this.request(
      `/v1/supervisor/tasks/${taskId}/ack`,
      "POST",
      parsedLease,
      idempotencyKey,
      this.tenantId,
    );
    return parse(leaseReplySchema, reply, "ack");
  }
  async renew(
    taskId: string,
    lease: LeaseRequest,
    idempotencyKey = randomUUID(),
  ): Promise<LeaseReply> {
    parse(id, taskId, "task");
    const parsedLease = parse(leaseRequestSchema, lease, "lease");
    const reply = await this.request(
      `/v1/supervisor/tasks/${taskId}/renew`,
      "POST",
      parsedLease,
      idempotencyKey,
      this.tenantId,
    );
    return parse(leaseReplySchema, reply, "renew");
  }
  async status(taskId: string): Promise<LeaseReply> {
    parse(id, taskId, "task");
    const reply = await this.request(
      `/v1/supervisor/tasks/${taskId}`,
      "GET",
      undefined,
      undefined,
      this.tenantId,
    );
    return parse(leaseReplySchema, reply, "status");
  }
  async settle(
    taskId: string,
    settlement: SettlementRequest,
    idempotencyKey = randomUUID(),
  ): Promise<HostedTask> {
    parse(id, taskId, "task");
    const parsedSettlement = parse(
      settlementRequestSchema,
      settlement,
      "settlement",
    );
    const reply = await this.request(
      `/v1/supervisor/tasks/${taskId}/settle`,
      "POST",
      parsedSettlement,
      idempotencyKey,
      this.tenantId,
    );
    return parse(taskEnvelopeSchema, reply, "settle").task;
  }
}

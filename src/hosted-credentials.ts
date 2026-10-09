import { resolve } from "node:path";
import { z } from "zod";
import { cloudOrigin } from "./cloud-credentials";

// Agreed worker-client helper (src/private-credential-file.ts) is not yet in
// this baseline; resolve it lazily so the dependency stays explicit and local
// helpers never duplicate its POSIX boundary. The static import is
// intentionally absent: hosted files must not vendor a copy.
interface PrivateCredentialModule {
  readPrivateCredential<T>(path: string, schema: z.ZodType<T>): T | null;
  savePrivateCredential<T>(path: string, value: T, schema: z.ZodType<T>): void;
  deletePrivateCredential<T>(path: string, schema: z.ZodType<T>): void;
}
let cachedPrivateCredential: PrivateCredentialModule | null = null;
async function privateCredential(): Promise<PrivateCredentialModule> {
  if (cachedPrivateCredential) return cachedPrivateCredential;
  try {
    cachedPrivateCredential = (await import(
      // Dynamic specifier so tsc skips resolution until the worker-client
      // branch lands; a missing module reports the dependency, never a copy.
      "./private-credential-file.ts" as string
    )) as PrivateCredentialModule;
    return cachedPrivateCredential;
  } catch {
    throw new Error(
      "Hosted credential storage requires src/private-credential-file.ts " +
        "(worker-client branch 09db215a2529369d2aec00fadd3f62fa9e81703a, " +
        "not yet merged to this baseline); refusing to use placeholder storage. " +
        "See task report dependency.",
    );
  }
}

const id = z.uuid();
const time = z.number().int().positive();
const serverUrl = z.string().refine(
  (v) => {
    try {
      cloudOrigin(v);
      return true;
    } catch {
      return false;
    }
  },
  {
    message:
      "Hosted server URL must be an exact HTTPS origin or loopback HTTP.",
  },
);

export const hostedTaskScopes = [
  "tasks:create",
  "tasks:read",
  "tasks:cancel",
  "entitlements:read",
] as const;
export const hostedSupervisorScopes = [
  "supervisor:claim",
  "supervisor:renew",
  "supervisor:report",
  "supervisor:cleanup",
] as const;

export const hostedTaskCredentialSchema = z
  .object({
    version: z.literal(1),
    server_url: serverUrl,
    credential: z.string().regex(/^sfexec_[A-Za-z0-9_-]{43}$/),
    grant_id: id,
    installation_id: id,
    subject_id: id,
    tenant_id: id,
    scopes: z.tuple([
      z.literal("tasks:create"),
      z.literal("tasks:read"),
      z.literal("tasks:cancel"),
      z.literal("entitlements:read"),
    ]),
    expires_at: time,
    authorization_expires_at: time,
  })
  .strict()
  .refine((v) => v.expires_at <= v.authorization_expires_at);
export type HostedTaskCredential = z.infer<typeof hostedTaskCredentialSchema>;

export const hostedSupervisorCredentialSchema = z
  .object({
    version: z.literal(1),
    server_url: serverUrl,
    credential: z.string().regex(/^sfsuper_[A-Za-z0-9_-]{43}$/),
    supervisor_id: id,
    worker_id: id,
    tenant_id: id,
    scopes: z.tuple([
      z.literal("supervisor:claim"),
      z.literal("supervisor:renew"),
      z.literal("supervisor:report"),
      z.literal("supervisor:cleanup"),
    ]),
    expires_at: time,
    authorization_expires_at: time,
  })
  .strict()
  .refine((v) => v.expires_at <= v.authorization_expires_at);
export type HostedSupervisorCredential = z.infer<
  typeof hostedSupervisorCredentialSchema
>;

export function hostedTaskCredentialPath(path?: string): string {
  return resolve(
    path ??
      process.env.SWARMFORGE_HOSTED_CREDENTIALS_PATH ??
      "data/hosted-task-credentials.json",
  );
}
export function hostedSupervisorCredentialPath(path?: string): string {
  return resolve(
    path ??
      process.env.SWARMFORGE_HOSTED_SUPERVISOR_PATH ??
      "data/hosted-supervisor-credentials.json",
  );
}

/** Null when absent; throws sanitized storage error otherwise. Never logs secrets. */
export async function readHostedTaskCredential(
  path: string,
): Promise<HostedTaskCredential | null> {
  const helper = await privateCredential();
  return helper.readPrivateCredential(path, hostedTaskCredentialSchema);
}
export async function readHostedSupervisorCredential(
  path: string,
): Promise<HostedSupervisorCredential | null> {
  const helper = await privateCredential();
  return helper.readPrivateCredential(path, hostedSupervisorCredentialSchema);
}
export async function saveHostedTaskCredential(
  path: string,
  value: HostedTaskCredential,
): Promise<void> {
  const parsed = hostedTaskCredentialSchema.safeParse(value);
  if (!parsed.success) throw new Error("Hosted task credential is invalid.");
  const helper = await privateCredential();
  helper.savePrivateCredential(path, parsed.data, hostedTaskCredentialSchema);
}
export async function saveHostedSupervisorCredential(
  path: string,
  value: HostedSupervisorCredential,
): Promise<void> {
  const parsed = hostedSupervisorCredentialSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("Hosted supervisor credential is invalid.");
  const helper = await privateCredential();
  helper.savePrivateCredential(
    path,
    parsed.data,
    hostedSupervisorCredentialSchema,
  );
}
export async function deleteHostedTaskCredential(path: string): Promise<void> {
  const helper = await privateCredential();
  helper.deletePrivateCredential(path, hostedTaskCredentialSchema);
}
export async function deleteHostedSupervisorCredential(
  path: string,
): Promise<void> {
  const helper = await privateCredential();
  helper.deletePrivateCredential(path, hostedSupervisorCredentialSchema);
}

/** Execution gate: a credential that is expired cannot execute or renew. */
export function hostedCredentialExpired(
  credential: { expires_at: number },
  now = Date.now(),
): boolean {
  return credential.expires_at <= now;
}

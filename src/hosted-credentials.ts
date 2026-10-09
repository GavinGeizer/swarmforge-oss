import { resolve } from "node:path";
import { z } from "zod";
import { cloudOrigin } from "./cloud-credentials";
// Approved worker-client helper (cherry-picked exact SHA 09db215): static
// import so tsc/biome verify the agreed exports at build time.
import {
  deletePrivateCredential,
  readPrivateCredential,
  savePrivateCredential,
} from "./private-credential-file";

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
export function readHostedTaskCredential(
  path: string,
): HostedTaskCredential | null {
  return readPrivateCredential(path, hostedTaskCredentialSchema);
}
export function readHostedSupervisorCredential(
  path: string,
): HostedSupervisorCredential | null {
  return readPrivateCredential(path, hostedSupervisorCredentialSchema);
}
export function saveHostedTaskCredential(
  path: string,
  value: HostedTaskCredential,
): void {
  const parsed = hostedTaskCredentialSchema.safeParse(value);
  if (!parsed.success) throw new Error("Hosted task credential is invalid.");
  savePrivateCredential(path, parsed.data, hostedTaskCredentialSchema);
}
export function saveHostedSupervisorCredential(
  path: string,
  value: HostedSupervisorCredential,
): void {
  const parsed = hostedSupervisorCredentialSchema.safeParse(value);
  if (!parsed.success)
    throw new Error("Hosted supervisor credential is invalid.");
  savePrivateCredential(path, parsed.data, hostedSupervisorCredentialSchema);
}
export function deleteHostedTaskCredential(path: string): void {
  deletePrivateCredential(path, hostedTaskCredentialSchema);
}
export function deleteHostedSupervisorCredential(path: string): void {
  deletePrivateCredential(path, hostedSupervisorCredentialSchema);
}

/** Execution gate: a credential that is expired cannot execute or renew. */
export function hostedCredentialExpired(
  credential: { expires_at: number },
  now = Date.now(),
): boolean {
  return credential.expires_at <= now;
}

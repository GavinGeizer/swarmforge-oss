import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { cloudOrigin } from "./cloud-credentials";
import {
  deletePrivateCredential,
  readPrivateCredential,
  savePrivateCredential,
} from "./private-credential-file";
import { defaultConfigPath } from "./settings/paths";

export const cloudWorkerCredentialSchema = z
  .object({
    version: z.literal(1),
    server_url: z.string().refine((v) => {
      try {
        cloudOrigin(v);
        return true;
      } catch {
        return false;
      }
    }),
    credential: z.string().regex(/^sfworker_[A-Za-z0-9_-]{43}$/),
    credential_id: z.uuid(),
    worker_id: z.uuid(),
    subject_id: z.uuid(),
    tenant_id: z.uuid(),
    scopes: z.tuple([z.literal("worker:identity"), z.literal("worker:rotate")]),
    expires_at: z.number().int().positive(),
    authorization_expires_at: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.expires_at <= v.authorization_expires_at);
export type CloudWorkerCredential = z.infer<typeof cloudWorkerCredentialSchema>;
export function cloudWorkerCredentialPath(path?: string, env = process.env) {
  return resolve(
    path ??
      env.SWARMFORGE_WORKER_CREDENTIALS_PATH ??
      join(dirname(defaultConfigPath(env)), "worker-credentials.json"),
  );
}
export function readCloudWorkerCredential(
  path: string,
): CloudWorkerCredential | null {
  return readPrivateCredential(path, cloudWorkerCredentialSchema);
}
export function saveCloudWorkerCredential(
  path: string,
  value: CloudWorkerCredential,
) {
  savePrivateCredential(path, value, cloudWorkerCredentialSchema);
}
export function deleteCloudWorkerCredential(path: string) {
  deletePrivateCredential(path, cloudWorkerCredentialSchema);
}

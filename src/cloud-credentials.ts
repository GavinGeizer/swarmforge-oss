import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  deletePrivateCredential,
  readPrivateCredential,
  savePrivateCredential,
} from "./private-credential-file";
import { defaultConfigPath } from "./settings/paths";
export function cloudOrigin(value: string) {
  try {
    const u = new URL(value);
    if (
      u.origin !== value ||
      u.username ||
      u.password ||
      (u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname)
        ))
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "Cloud URL must be an exact HTTPS origin (HTTP is allowed only on loopback).",
    );
  }
}
export const cloudCredentialSchema = z
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
    credential: z.string().regex(/^sfcli_[A-Za-z0-9_-]{43}$/),
    credential_id: z.uuid(),
    installation_id: z.uuid(),
    subject_id: z.uuid(),
    tenant_id: z.uuid(),
    scopes: z.tuple([z.literal("identity:read"), z.literal("devices:self")]),
    expires_at: z.number().int().positive(),
    authorization_expires_at: z.number().int().positive(),
  })
  .strict()
  .refine((v) => v.expires_at <= v.authorization_expires_at);
export type CloudCredential = z.infer<typeof cloudCredentialSchema>;
export function cloudCredentialPath(path?: string, env = process.env) {
  return resolve(
    path ??
      env.SWARMFORGE_CLOUD_CREDENTIALS_PATH ??
      join(dirname(defaultConfigPath(env)), "cloud-credentials.json"),
  );
}
export function readCloudCredential(path: string): CloudCredential | null {
  return readPrivateCredential(path, cloudCredentialSchema);
}
export function saveCloudCredential(path: string, value: CloudCredential) {
  savePrivateCredential(path, value, cloudCredentialSchema);
}
export function deleteCloudCredential(path: string) {
  deletePrivateCredential(path, cloudCredentialSchema);
}

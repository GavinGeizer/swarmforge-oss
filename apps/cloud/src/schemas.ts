import { z } from "zod";
export const roleSchema = z.enum(["owner", "admin", "member"]);
export const idSchema = z.uuid();
export const organizationSchema = z
  .object({
    tenant_id: idSchema,
    display_name: z.string().min(1).max(100),
    status: z.enum(["active", "disabled", "deleted"]),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export const sessionSchema = z
  .object({
    session_id: idSchema,
    created_at: z.number().int(),
    expires_at: z.number().int(),
    revoked_at: z.number().int().nullable(),
  })
  .strict();
export const membershipSchema = z
  .object({ subject_id: idSchema, display_name: z.string(), role: roleSchema })
  .strict();
export const meSchema = z
  .object({
    subject_id: idSchema,
    display_name: z.string(),
    memberships: z.array(
      z.object({ tenant_id: idSchema, role: roleSchema }).strict(),
    ),
    next_cursor: z.string().nullable(),
  })
  .strict();
export const patchSchema = z
  .object({
    display_name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(
        (v) =>
          ![...v].some((character) => {
            const code = character.codePointAt(0)!;
            return code < 32 || (code >= 127 && code <= 159);
          }),
      ),
  })
  .strict();
export const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export const errorSchema = z
  .object({
    error: z
      .object({ code: z.string(), message: z.string(), request_id: idSchema })
      .strict(),
  })
  .strict();

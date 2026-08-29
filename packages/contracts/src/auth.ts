import { z } from "zod";
import { idSchema, instantSchema } from "./primitives.ts";
import { permissionSchema, roleSchema } from "./rbac.ts";

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginSchema>;

export const currentUserSchema = z.object({
  id: idSchema,
  email: z.email(),
  displayName: z.string(),
  roles: z.array(roleSchema).min(1),
  /** Flattened from roles so the client never re-derives the matrix. */
  permissions: z.array(permissionSchema),
  /** Home base IATA code, used to default time-zone display. */
  homeBase: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  active: z.boolean(),
  lastLoginAt: instantSchema.nullable(),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

export const loginResponseSchema = z.object({
  user: currentUserSchema,
  accessToken: z.string(),
  /** Seconds until the access token expires; the client refreshes ahead of it. */
  expiresIn: z.number().int().positive(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Claims carried in the signed access token. Deliberately minimal. */
export const accessClaimsSchema = z.object({
  sub: idSchema,
  roles: z.array(roleSchema),
  type: z.literal("access"),
});
export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export const refreshClaimsSchema = z.object({
  sub: idSchema,
  type: z.literal("refresh"),
  /** Rotated on every refresh so a stolen token dies on next legitimate use. */
  jti: z.string(),
});
export type RefreshClaims = z.infer<typeof refreshClaimsSchema>;

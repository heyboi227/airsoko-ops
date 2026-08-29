import { z } from "zod";

/**
 * Stable, machine-readable error codes. The brief asks for "actionable errors
 * with stable codes"; these are the ones the client is allowed to branch on.
 * Messages may be reworded freely, codes may not.
 */
export const API_ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RULE_VIOLATION",
  "PRECONDITION_FAILED",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const HTTP_STATUS_FOR_ERROR: Readonly<Record<ApiErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RULE_VIOLATION: 422,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export const fieldIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type FieldIssue = z.infer<typeof fieldIssueSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Present when code is VALIDATION_FAILED. */
    issues: z.array(fieldIssueSchema).optional(),
    /** Present when code is RULE_VIOLATION -- see rules.ts. */
    findings: z.array(z.unknown()).optional(),
    /** Correlates a client report with a server log line. */
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

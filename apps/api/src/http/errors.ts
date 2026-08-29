import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import {
  HTTP_STATUS_FOR_ERROR,
  type ApiErrorCode,
  type FieldIssue,
  type MutationPreview,
  type RuleFinding,
} from "@airsoko/contracts";
import { logger } from "../logger.ts";
import { isProduction } from "../env.ts";

/**
 * One error type, one envelope, one place that turns a throw into a response.
 *
 * Route handlers throw `ApiProblem` and never touch `res.status`. That keeps
 * the wire format identical everywhere and means a new endpoint cannot invent
 * its own error shape by accident.
 */
export class ApiProblem extends Error {
  readonly code: ApiErrorCode;
  readonly issues?: FieldIssue[];
  readonly findings?: RuleFinding[];
  readonly preview?: MutationPreview;

  constructor(
    code: ApiErrorCode,
    message: string,
    extras: { issues?: FieldIssue[]; findings?: RuleFinding[]; preview?: MutationPreview } = {},
  ) {
    super(message);
    this.name = "ApiProblem";
    this.code = code;
    if (extras.issues) this.issues = extras.issues;
    if (extras.findings) this.findings = extras.findings;
    if (extras.preview) this.preview = extras.preview;
  }

  get status(): number {
    return HTTP_STATUS_FOR_ERROR[this.code];
  }
}

export const notFound = (what: string): ApiProblem =>
  new ApiProblem("NOT_FOUND", `${what} not found.`);

export const forbidden = (
  message = "You do not have permission to perform this action.",
): ApiProblem => new ApiProblem("FORBIDDEN", message);

export const unauthenticated = (message = "Authentication required."): ApiProblem =>
  new ApiProblem("UNAUTHENTICATED", message);

export function zodIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Read a path parameter as a string.
 *
 * Express 5 types `req.params[name]` as `string | string[] | undefined`,
 * because a route *could* declare a repeating segment. Ours do not, so this
 * narrows once, here, instead of at thirty call sites.
 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiProblem("VALIDATION_FAILED", `Missing path parameter "${name}".`);
  }
  return value;
}

/** Terminal error handler. Must be registered last. */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // Express identifies the error handler by arity, so this stays even unused.
  _next: NextFunction,
): void {
  const requestId = res.getHeader("x-request-id");
  const requestIdText = typeof requestId === "string" ? requestId : undefined;

  if (error instanceof ApiProblem) {
    // Client mistakes are not incidents; log them at debug so real failures
    // stay visible in the noise.
    logger.debug({ code: error.code, path: req.path }, error.message);
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
        ...(error.findings ? { findings: error.findings } : {}),
        ...(error.preview ? { preview: error.preview } : {}),
        ...(requestIdText ? { requestId: requestIdText } : {}),
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "The request body did not match the expected shape.",
        issues: zodIssues(error),
        ...(requestIdText ? { requestId: requestIdText } : {}),
      },
    });
    return;
  }

  logger.error({ err: error, path: req.path, method: req.method }, "Unhandled error");
  res.status(500).json({
    error: {
      code: "INTERNAL",
      // Never leak an internal message to a client in production; the request
      // id is how a report gets correlated to the log line that has it.
      message: isProduction
        ? "Something went wrong. Quote the request id when reporting this."
        : error instanceof Error
          ? error.message
          : String(error),
      ...(requestIdText ? { requestId: requestIdText } : {}),
    },
  });
}

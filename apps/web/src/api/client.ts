import type {
  ApiErrorCode,
  FieldIssue,
  MutationPreview,
  RuleFinding,
} from "@airsoko/contracts";

/**
 * The only place this application talks to the network.
 *
 * Centralised so that the token, the error envelope and the rule-violation
 * shape are handled once. A component never sees a raw Response, and never has
 * to remember that a 422 carries findings the operator needs to read.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000";
const TOKEN_KEY = "airsoko.accessToken";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly issues: FieldIssue[];
  readonly findings: RuleFinding[];
  readonly preview: MutationPreview | null;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    extras: {
      issues?: FieldIssue[];
      findings?: RuleFinding[];
      preview?: MutationPreview;
      requestId?: string;
    } = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.issues = extras.issues ?? [];
    this.findings = extras.findings ?? [];
    this.preview = extras.preview ?? null;
    this.requestId = extras.requestId ?? null;
  }

  /** The operator can proceed if they explicitly accept these warnings. */
  get needsAcknowledgement(): boolean {
    return this.code === "PRECONDITION_FAILED" && this.findings.length > 0;
  }

  /** The change cannot be applied at all. */
  get isBlocked(): boolean {
    return this.code === "RULE_VIOLATION";
  }
}

let accessToken: string | null = null;

export function loadStoredToken(): string | null {
  if (accessToken) return accessToken;
  try {
    accessToken = window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private windows and blocked site data both throw here; an unauthenticated
    // session is the correct fallback, not a crash.
    accessToken = null;
  }
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Keeping it in memory alone is a worse session, not a broken one.
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => undefined;

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, API_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = loadStoredToken();

  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const requestId = response.headers.get("x-request-id") ?? undefined;
  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (response.ok) return payload as T;

  const envelope =
    payload && typeof payload === "object" && "error" in payload
      ? (
          payload as {
            error: {
              code?: ApiErrorCode;
              message?: string;
              issues?: FieldIssue[];
              findings?: RuleFinding[];
              preview?: MutationPreview;
            };
          }
        ).error
      : {};

  const code = envelope.code ?? "INTERNAL";

  // An expired or missing token is a session problem, not a page problem: hand
  // it to the auth layer rather than surfacing a scary dialog on whatever
  // screen the user happened to be on.
  if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
    setAccessToken(null);
    onUnauthorized();
  }

  throw new ApiRequestError(
    response.status,
    code,
    envelope.message ?? `Request failed with status ${response.status}.`,
    {
      ...(envelope.issues ? { issues: envelope.issues } : {}),
      ...(envelope.findings ? { findings: envelope.findings } : {}),
      ...(envelope.preview ? { preview: envelope.preview } : {}),
      ...(requestId ? { requestId } : {}),
    },
  );
}

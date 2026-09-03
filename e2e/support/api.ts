import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";

/**
 * Helpers for talking to the operations API directly, with no browser.
 *
 * Scenario G depends on this: the brief requires the permission boundary to
 * hold at the API, and a test that drives the UI can only ever prove the
 * button was hidden.
 */

export const DEMO_PASSWORD = "airsoko-demo";

export const ACCOUNTS = {
  superAdmin: "admin@airsoko.example",
  opsController: "ops@airsoko.example",
  fleetManager: "fleet@airsoko.example",
  crewScheduler: "crew@airsoko.example",
  bookingAdmin: "bookings@airsoko.example",
  commercialManager: "commercial@airsoko.example",
} as const;

export async function signIn(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.post("/api/auth/login", {
    data: { email, password: DEMO_PASSWORD },
  });

  if (!response.ok()) {
    throw new Error(
      `Sign-in failed for ${email}: ${response.status()} ${await response.text()}. ` +
        `Has the seed been run? (npm run db:seed)`,
    );
  }

  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

export function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Apply a mutation, acknowledging whatever its own preview asks for.
 *
 * A hard-coded acknowledgement list is a standing bet on which rules fire,
 * and the rules move underneath it: seeded maintenance dates age into their
 * thresholds, so a call that raised one warning the day it was written
 * raises two a fortnight later and comes back 412. A test that is not about
 * a particular rule should not be holding that bet -- it accepts what the
 * preview reports, exactly as an operator would, and asserts separately on
 * the rules it *is* about.
 *
 * `mutate()` in recorded-entries.api.spec.ts keeps its own copy: it has the
 * recording headers to carry and reads the applied body back.
 */
export async function applyAcknowledging(
  request: APIRequestContext,
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  token: string,
  data: Record<string, unknown> = {},
  reason?: string,
): Promise<APIResponse> {
  const headers = auth(token);

  const preview = await request.fetch(path, {
    method,
    headers,
    data: { ...data, mutation: { preview: true } },
  });
  const previewText = await preview.text();
  expect(preview.status(), `preview ${method} ${path}: ${previewText}`).toBe(200);
  const { requiresAcknowledgement } = JSON.parse(previewText) as {
    requiresAcknowledgement: string[];
  };

  return request.fetch(path, {
    method,
    headers,
    data: {
      ...data,
      mutation: {
        preview: false,
        acknowledgedWarnings: requiresAcknowledgement,
        ...(reason === undefined ? {} : { reason }),
      },
    },
  });
}

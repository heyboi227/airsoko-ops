import type { APIRequestContext } from "@playwright/test";

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

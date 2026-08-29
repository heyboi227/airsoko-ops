import { expect, test } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * Scenario G -- Permission boundary.
 *
 * "A Booking Administrator can work with bookings and seats but cannot cancel
 * a flight or modify aircraft maintenance. Both UI and API enforce the
 * restriction."
 *
 * The bookings and flights halves arrive with their phases. What can be proved
 * today is the part that matters most architecturally: the API refuses on its
 * own, with no browser involved and no hidden button doing the work.
 */

test.describe("Scenario G: permission boundary", () => {
  test("a Booking Administrator can read the network but not change it", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.bookingAdmin);

    const read = await request.get("/api/airports", { headers: auth(token) });
    expect(read.status(), "booking admins need to see stations to seat passengers").toBe(200);

    const write = await request.post("/api/airports", {
      headers: auth(token),
      data: {
        iataCode: "ZZZ",
        icaoCode: "ZZZZ",
        name: "Should Not Exist",
        city: "Nowhere",
        countryCode: "RS",
        latitude: 44.0,
        longitude: 20.0,
        timeZone: "Europe/Belgrade",
      },
    });

    expect(write.status()).toBe(403);
    const body = (await write.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    // The refusal names the missing permission, so it is diagnosable.
    expect(body.error.message).toContain("airport:write");
  });

  test("a Commercial Manager owns the station list", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);

    // Preview only -- this asserts the permission gate, not the write itself,
    // and leaves no row behind for the next test to trip over.
    const preview = await request.post("/api/airports", {
      headers: auth(token),
      data: {
        iataCode: "ZZZ",
        icaoCode: "ZZZZ",
        name: "Preview Only",
        city: "Nowhere",
        countryCode: "RS",
        latitude: 44.0,
        longitude: 20.0,
        timeZone: "Europe/Belgrade",
        mutation: { preview: true },
      },
    });

    expect(preview.status(), "network planning may add stations").toBe(200);
  });

  test("an unauthenticated request is refused before any permission check", async ({
    request,
  }) => {
    const response = await request.get("/api/airports");
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  test("every role's own permission set comes back from the API", async ({ request }) => {
    // The client renders navigation from this list. If it ever disagreed with
    // the server's enforcement, the UI would offer actions that get refused.
    const token = await signIn(request, ACCOUNTS.bookingAdmin);
    const response = await request.get("/api/auth/me", { headers: auth(token) });
    expect(response.status()).toBe(200);

    const me = (await response.json()) as { roles: string[]; permissions: string[] };
    expect(me.roles).toEqual(["booking_admin"]);
    expect(me.permissions).toContain("booking:write");
    expect(me.permissions).toContain("airport:read");
    expect(me.permissions).not.toContain("airport:write");
    expect(me.permissions).not.toContain("flight:cancel");
    expect(me.permissions).not.toContain("aircraft:maintenance");
  });

  test.fixme("a Booking Administrator cannot cancel a flight", async () => {
    // Phase 3 builds flight cancellation. The assertion will be:
    //   POST /api/flights/:id/cancel as bookings@ -> 403 FORBIDDEN
  });

  test.fixme("a Booking Administrator cannot modify aircraft maintenance", async () => {
    // Phase 2 builds the maintenance record. The assertion will be:
    //   POST /api/aircraft/:id/maintenance as bookings@ -> 403 FORBIDDEN
  });
});

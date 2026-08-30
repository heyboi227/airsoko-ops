import { expect, test, type APIRequestContext } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * Registering and retiring an airframe, and changing what a cabin offers.
 *
 * Idempotent by construction: the one test that writes registers a tail with a
 * fixed registration and retires it in a `finally`. Retiring frees the marks
 * again -- see migration 0004 -- so the suite can be re-run without a reset.
 */

interface Preview {
  intent: string;
  applicable: boolean;
  requiresAcknowledgement: string[];
  findings: { code: string; severity: string; title: string; detail: string }[];
  consequences: { kind: string; summary: string; count?: number }[];
}

interface TypeRow {
  id: string;
  icaoTypeCode: string;
}

const TEST_REGISTRATION = "YU-ZZT";

async function typeByCode(request: APIRequestContext, token: string, code: string) {
  const response = await request.get("/api/aircraft/types/list", { headers: auth(token) });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: TypeRow[] };
  const found = body.items.find((item) => item.icaoTypeCode === code);
  if (!found) throw new Error(`${code} is not a seeded aircraft type.`);
  return found;
}

/** A320 in the seeded configuration: 12 business, 136 economy, 148 seats. */
function draft(aircraftTypeId: string, overrides: Record<string, unknown> = {}) {
  return {
    registration: TEST_REGISTRATION,
    serialNumber: "ZZT-0001",
    name: "Probni",
    aircraftTypeId,
    deliveredOn: "2019-05-10",
    cabins: [
      { cabinClass: "business", firstRow: 1, lastRow: 3, layout: "AC-DF", pitchInches: 38 },
      { cabinClass: "economy", firstRow: 4, lastRow: 37, layout: "ABC-DEF", pitchInches: 30 },
    ],
    ...overrides,
  };
}

test.describe("registering an airframe", () => {
  test("capacity comes from the layout, and no seat count is accepted", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const type = await typeByCode(request, token, "A320");

    const response = await request.post("/api/aircraft", {
      headers: auth(token),
      data: { ...draft(type.id), mutation: { preview: true } },
    });

    expect(response.status()).toBe(200);
    const preview = (await response.json()) as Preview;

    // 3 rows x 4 letters + 34 rows x 6 letters = 216. Nothing in the request
    // said 216; the form cannot disagree with the layout because it never
    // states a total.
    const capacity = preview.consequences.find((item) => item.kind === "capacity_changed");
    expect(capacity?.count).toBe(216);
  });

  test("a layout the aircraft could not have is refused, not warned about", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const type = await typeByCode(request, token, "A320");

    const response = await request.post("/api/aircraft", {
      headers: auth(token),
      data: {
        ...draft(type.id, {
          cabins: [
            // Business claims rows 1-12 and Economy starts at 12. Row 12 would
            // belong to both, and the seat labels would collide.
            {
              cabinClass: "business",
              firstRow: 1,
              lastRow: 12,
              layout: "AC-DF",
              pitchInches: 38,
            },
            {
              cabinClass: "economy",
              firstRow: 12,
              lastRow: 30,
              layout: "ABC-DEF",
              pitchInches: 30,
            },
          ],
        }),
        mutation: { preview: true },
      },
    });

    const preview = (await response.json()) as Preview;
    const blocking = preview.findings.filter((finding) => finding.severity === "blocking");
    expect(blocking.map((finding) => finding.code)).toContain("AIRCRAFT_CABIN_LAYOUT_INVALID");
    expect(preview.applicable).toBe(false);
  });

  test("a duplicate registration is refused and names the airframe holding it", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const type = await typeByCode(request, token, "A320");

    const response = await request.post("/api/aircraft", {
      headers: auth(token),
      data: { ...draft(type.id, { registration: "YU-APE" }), mutation: { preview: true } },
    });

    const preview = (await response.json()) as Preview;
    const clash = preview.findings.find(
      (finding) => finding.code === "AIRCRAFT_REGISTRATION_IN_USE",
    );
    expect(clash?.severity).toBe("blocking");
  });

  test("each suspicious thing gets its own code to acknowledge", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const type = await typeByCode(request, token, "A320");

    const response = await request.post("/api/aircraft", {
      headers: auth(token),
      data: {
        ...draft(type.id, {
          // A prefix the fleet does not use, a delivery date that has not
          // happened, and a capacity the rest of the sub-fleet disagrees with.
          registration: "YO-ZZT",
          deliveredOn: "2030-01-01",
          cabins: [
            {
              cabinClass: "economy",
              firstRow: 1,
              lastRow: 23,
              layout: "ABC-DEF",
              pitchInches: 30,
            },
          ],
        }),
        mutation: { preview: true },
      },
    });

    const preview = (await response.json()) as Preview;

    // Three separate codes, so one tick cannot accept all three. That is the
    // whole reason they are not a single AIRCRAFT_INVALID.
    expect(preview.requiresAcknowledgement).toEqual(
      expect.arrayContaining([
        "AIRCRAFT_REGISTRATION_PREFIX_UNUSUAL",
        "AIRCRAFT_DELIVERY_DATE_FUTURE",
        "AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET",
      ]),
    );
    expect(new Set(preview.requiresAcknowledgement).size).toBe(
      preview.requiresAcknowledgement.length,
    );
  });

  test("a registered airframe has real seats, and retiring it frees the marks", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const type = await typeByCode(request, token, "A320");

    let created: string | null = null;

    try {
      const response = await request.post("/api/aircraft", {
        headers: auth(token),
        data: {
          ...draft(type.id),
          mutation: {
            preview: false,
            // The second code only appears on a re-run, once a previous run
            // has retired this tail. Acknowledging a code that was not raised
            // is harmless, and it keeps the test idempotent.
            // The last two appear only on a re-run, once a previous run has
            // retired this tail: its marks go back to the register but its
            // serial never does. Acknowledging a code that was not raised is
            // harmless, and it keeps the test idempotent.
            acknowledgedWarnings: [
              "AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET",
              "AIRCRAFT_REGISTRATION_PREVIOUSLY_USED",
              "AIRCRAFT_SERIAL_IN_USE",
            ],
          },
        },
      });

      expect(response.status()).toBe(201);
      const body = (await response.json()) as {
        aircraft: { id: string; registration: string; seatCapacity: number; seats: number };
      };
      created = body.aircraft.id;

      expect(body.aircraft.seatCapacity).toBe(216);
      // One seat row per seat, written in the same transaction. The seat map in
      // Phase 6 reads these, and a cabin with no seats behind it would be a
      // capacity figure with nothing under it.
      expect(body.aircraft.seats).toBe(216);

      const fleet = await request.get("/api/aircraft", {
        headers: auth(token),
        params: { search: TEST_REGISTRATION },
      });
      const listed = (await fleet.json()) as {
        items: {
          id: string;
          seatCapacity: number;
          seatsByCabin: Record<string, number>;
          serviceability: string;
          maintenance: { urgency: string };
        }[];
      };

      const [tail] = listed.items;
      expect(tail?.seatCapacity).toBe(216);
      expect(tail?.seatsByCabin).toEqual({ business: 12, economy: 204 });
      expect(tail?.serviceability).toBe("in_service");
      // No check has ever been recorded on a tail that just joined, and the
      // system says so rather than implying one is not due.
      expect(tail?.maintenance.urgency).toBe("unknown");
    } finally {
      if (created) {
        const retire = await request.post(`/api/aircraft/${created}/retire`, {
          headers: auth(token),
          data: { mutation: { preview: false, acknowledgedWarnings: [] } },
        });
        expect(retire.status()).toBe(200);
      }
    }

    // Gone from the fleet, and its marks are available again.
    const after = await request.get("/api/aircraft", {
      headers: auth(token),
      params: { search: TEST_REGISTRATION },
    });
    expect(((await after.json()) as { total: number }).total).toBe(0);

    const reuse = await request.post("/api/aircraft", {
      headers: auth(token),
      data: { ...draft(type.id), mutation: { preview: true } },
    });
    const preview = (await reuse.json()) as Preview;
    expect(preview.findings.map((finding) => finding.code)).not.toContain(
      "AIRCRAFT_REGISTRATION_IN_USE",
    );
    expect(preview.findings.map((finding) => finding.code)).toContain(
      "AIRCRAFT_REGISTRATION_PREVIOUSLY_USED",
    );
  });

  test("registering is refused to a role without aircraft:write", async ({ request }) => {
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);
    const type = await typeByCode(request, fleetToken, "A320");

    const token = await signIn(request, ACCOUNTS.bookingAdmin);
    const response = await request.post("/api/aircraft", {
      headers: auth(token),
      data: { ...draft(type.id), mutation: { preview: true } },
    });

    expect(response.status()).toBe(403);
  });
});

test.describe("assigning amenities", () => {
  async function amenityByCode(request: APIRequestContext, token: string, code: string) {
    const response = await request.get("/api/amenities", { headers: auth(token) });
    const body = (await response.json()) as { items: { id: string; code: string }[] };
    const found = body.items.find((item) => item.code === code);
    if (!found) throw new Error(`${code} is not a seeded amenity.`);
    return found;
  }

  async function aircraftByRegistration(
    request: APIRequestContext,
    token: string,
    registration: string,
  ) {
    const response = await request.get("/api/aircraft", {
      headers: auth(token),
      params: { search: registration },
    });
    const body = (await response.json()) as { items: { id: string; registration: string }[] };
    const found = body.items.find((item) => item.registration === registration);
    if (!found) throw new Error(`${registration} is not in the seeded fleet.`);
    return found;
  }

  test("a withdrawal says it will beat the grant already there", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);

    const wifi = await amenityByCode(request, token, "wifi");
    // YU-ANA has Wi-Fi fitted and nothing withdrawing it.
    const tail = await aircraftByRegistration(request, fleetToken, "YU-ANA");

    const response = await request.post("/api/amenities/assignments", {
      headers: auth(token),
      data: {
        amenityId: wifi.id,
        scope: "aircraft",
        included: false,
        aircraftId: tail.id,
        mutation: { preview: true },
      },
    });

    expect(response.status()).toBe(200);
    const preview = (await response.json()) as Preview;

    expect(preview.requiresAcknowledgement).toContain(
      "AMENITY_ASSIGNMENT_CONTRADICTS_EXISTING",
    );
    const warning = preview.findings.find(
      (finding) => finding.code === "AMENITY_ASSIGNMENT_CONTRADICTS_EXISTING",
    );
    expect(warning?.detail).toContain("withdrawal wins");

    // And it says which cabins stop offering it, counted rather than asserted.
    const effect = preview.consequences.find(
      (item) => item.kind === "amenity_resolution_changed",
    );
    expect(effect?.count).toBeGreaterThan(0);
  });

  test("a grant beside an existing withdrawal is warned as changing nothing", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);

    const power = await amenityByCode(request, token, "power_ac");
    // The ATRs have no AC power fitted, so a cabin-level withdrawal there
    // grants nothing and withholds nothing.
    const tail = await aircraftByRegistration(request, fleetToken, "YU-ALA");

    const response = await request.post("/api/amenities/assignments", {
      headers: auth(token),
      data: {
        amenityId: power.id,
        scope: "aircraft",
        included: false,
        aircraftId: tail.id,
        mutation: { preview: true },
      },
    });

    const preview = (await response.json()) as Preview;
    expect(preview.requiresAcknowledgement).toContain("AMENITY_WITHDRAWAL_GRANTS_NOTHING");
  });

  test("an identical assignment is refused outright", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);

    const wifi = await amenityByCode(request, token, "wifi");
    const tail = await aircraftByRegistration(request, fleetToken, "YU-ANA");

    const response = await request.post("/api/amenities/assignments", {
      headers: auth(token),
      data: {
        amenityId: wifi.id,
        scope: "aircraft",
        included: true,
        aircraftId: tail.id,
        mutation: { preview: true },
      },
    });

    const preview = (await response.json()) as Preview;
    expect(
      preview.findings.filter((finding) => finding.severity === "blocking").map((f) => f.code),
    ).toContain("AMENITY_ASSIGNMENT_DUPLICATE");
  });

  test("an assignment round-trips and the resolution follows it", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);

    const lieFlat = await amenityByCode(request, token, "lie_flat");
    // An A320 has no lie-flat seat fitted, so this is genuinely new.
    const tail = await aircraftByRegistration(request, fleetToken, "YU-APE");

    async function resolvesFor(aircraftId: string) {
      const response = await request.get(`/api/amenities/matrix/${aircraftId}`, {
        headers: auth(token),
      });
      const body = (await response.json()) as {
        cabins: {
          cabinClass: string;
          amenities: { amenityCode: string; included: boolean }[];
        }[];
      };
      return body.cabins.flatMap((cabin) =>
        cabin.amenities.filter((entry) => entry.amenityCode === "lie_flat"),
      );
    }

    expect(await resolvesFor(tail.id)).toEqual([]);

    let created: string | null = null;
    try {
      const response = await request.post("/api/amenities/assignments", {
        headers: auth(token),
        data: {
          amenityId: lieFlat.id,
          scope: "aircraft",
          included: true,
          aircraftId: tail.id,
          note: "Trial fit",
          mutation: { preview: false, acknowledgedWarnings: [] },
        },
      });

      expect(response.status()).toBe(201);
      created = ((await response.json()) as { assignment: { id: string } }).assignment.id;

      const resolved = await resolvesFor(tail.id);
      expect(resolved.length).toBeGreaterThan(0);
      expect(resolved.every((entry) => entry.included)).toBe(true);
    } finally {
      if (created) {
        const removal = await request.post(`/api/amenities/assignments/${created}/remove`, {
          headers: auth(token),
          data: { mutation: { preview: false, acknowledgedWarnings: [] } },
        });
        expect(removal.status()).toBe(200);
      }
    }

    expect(await resolvesFor(tail.id)).toEqual([]);
  });

  test("assigning is refused to a role without commercial:write", async ({ request }) => {
    const readToken = await signIn(request, ACCOUNTS.commercialManager);
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);
    const wifi = await amenityByCode(request, readToken, "wifi");
    const tail = await aircraftByRegistration(request, fleetToken, "YU-ANA");

    // The Fleet Manager reads amenities all day and may never change them.
    const response = await request.post("/api/amenities/assignments", {
      headers: auth(fleetToken),
      data: {
        amenityId: wifi.id,
        scope: "aircraft",
        included: false,
        aircraftId: tail.id,
        mutation: { preview: true },
      },
    });

    expect(response.status()).toBe(403);
  });
});

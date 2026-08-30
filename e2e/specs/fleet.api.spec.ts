import { expect, test, type APIRequestContext } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * The Phase 2 gate, stated as the two claims it has to survive:
 *
 *   1. An unavailable aircraft is not *silently* assignable. Withdrawing an
 *      airframe has to say, before it happens, which sectors it strands -- and
 *      the operator has to accept that in so many words.
 *   2. Capacity derives from the cabin configuration and is never stored twice.
 *      No total exists that could disagree with the layout.
 *
 * Everything here is idempotent. The one test that writes performs a round
 * trip and restores the airframe in a `finally`, so the suite can be re-run
 * against a seeded database without a reset.
 */

interface FleetFlightRef {
  flightNumber: string;
  originIata: string;
  destinationIata: string;
}

interface FleetRow {
  id: string;
  registration: string;
  serviceability: "in_service" | "maintenance" | "stored" | "out_of_service";
  state: {
    operationalState: "airborne" | "turnaround" | "on_ground" | "unavailable";
    locationIata: string | null;
    currentFlight: FleetFlightRef | null;
    nextFlight: FleetFlightRef | null;
  };
  seatCapacity: number;
  seatsByCabin: Record<string, number>;
  type: { icaoTypeCode: string; rangeNm: number };
  maintenance: { urgency: string; limitingFactor: string | null; summary: string };
}

interface Preview {
  intent: string;
  applicable: boolean;
  requiresAcknowledgement: string[];
  findings: { code: string; severity: string; title: string; detail: string }[];
  consequences: { kind: string; summary: string; count?: number }[];
}

async function loadFleet(request: APIRequestContext, token: string): Promise<FleetRow[]> {
  const response = await request.get("/api/aircraft", { headers: auth(token) });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: FleetRow[] };
  return body.items;
}

test.describe("fleet", () => {
  test("capacity is summed from the cabins, never stored alongside them", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, token);

    expect(fleet.length, "the brief asks for a fleet of 20 or more").toBeGreaterThanOrEqual(20);

    for (const aircraft of fleet) {
      const summed = Object.values(aircraft.seatsByCabin).reduce(
        (total, seats) => total + seats,
        0,
      );

      expect(
        aircraft.seatCapacity,
        `${aircraft.registration} reports a capacity its cabins do not add up to`,
      ).toBe(summed);

      expect(
        Object.keys(aircraft.seatsByCabin).length,
        `${aircraft.registration} has seats but no cabin configuration`,
      ).toBeGreaterThan(0);
    }

    // The other half of "never stored twice": the API exposes no separate
    // total that a client could read instead. If one were ever added, this
    // fails and the decision gets revisited deliberately.
    const [first] = fleet;
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {})).not.toContain("totalSeats");
  });

  test("serviceability and derived state can never contradict each other", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, token);

    for (const aircraft of fleet) {
      if (aircraft.serviceability !== "in_service") {
        expect(
          aircraft.state.operationalState,
          `${aircraft.registration} is ${aircraft.serviceability} but reports as ${aircraft.state.operationalState}`,
        ).toBe("unavailable");
        expect(
          aircraft.state.currentFlight,
          `${aircraft.registration} is not in service yet claims to be flying`,
        ).toBeNull();
      }

      // An aircraft in the air is not at an airport. Reporting one would be a
      // small lie that a map would render as a large one.
      if (aircraft.state.operationalState === "airborne") {
        expect(
          aircraft.state.locationIata,
          `${aircraft.registration} is airborne but claims to be at an airport`,
        ).toBeNull();
        expect(aircraft.state.currentFlight).not.toBeNull();
      }

      if (aircraft.state.operationalState === "turnaround") {
        expect(aircraft.state.locationIata).not.toBeNull();
      }
    }
  });

  test("withdrawing an airframe names the sectors it strands before it happens", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, token);

    const busy = fleet.find(
      (aircraft) =>
        aircraft.serviceability === "in_service" && aircraft.state.nextFlight !== null,
    );
    expect(busy, "no in-service airframe has an upcoming sector to strand").toBeDefined();
    if (!busy) return;

    const response = await request.post(`/api/aircraft/${busy.id}/serviceability`, {
      headers: auth(token),
      data: { serviceability: "maintenance", mutation: { preview: true } },
    });

    expect(response.status()).toBe(200);
    const preview = (await response.json()) as Preview;

    expect(preview.intent).toBe("aircraft.set_serviceability");
    expect(
      preview.requiresAcknowledgement,
      "stranding scheduled flights must be acknowledged, not merely displayed",
    ).toContain("AIRCRAFT_UNAVAILABLE");

    const warning = preview.findings.find((finding) => finding.code === "AIRCRAFT_UNAVAILABLE");
    expect(warning?.severity).toBe("warning");
    expect(warning?.detail, "the warning must name the flight, not just count them").toContain(
      busy.state.nextFlight?.flightNumber ?? "",
    );

    expect(preview.consequences.map((item) => item.kind)).toContain("aircraft_released");
    expect(preview.consequences.map((item) => item.kind)).toContain("alerts_raised");

    // A preview writes nothing.
    const after = await loadFleet(request, token);
    expect(after.find((aircraft) => aircraft.id === busy.id)?.serviceability).toBe(
      "in_service",
    );
  });

  test("the withdrawal is refused until the warning is acknowledged by code", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, token);

    const busy = fleet.find(
      (aircraft) =>
        aircraft.serviceability === "in_service" && aircraft.state.nextFlight !== null,
    );
    expect(busy).toBeDefined();
    if (!busy) return;

    const response = await request.post(`/api/aircraft/${busy.id}/serviceability`, {
      headers: auth(token),
      // Applying for real, but acknowledging nothing.
      data: { serviceability: "maintenance", mutation: { preview: false } },
    });

    expect(response.status()).toBe(412);
    const body = (await response.json()) as {
      error: { code: string; findings: { code: string }[] };
    };
    expect(body.error.code).toBe("PRECONDITION_FAILED");
    expect(body.error.findings.map((finding) => finding.code)).toContain(
      "AIRCRAFT_UNAVAILABLE",
    );

    const after = await loadFleet(request, token);
    expect(after.find((aircraft) => aircraft.id === busy.id)?.serviceability).toBe(
      "in_service",
    );
  });

  test("a withdrawn airframe round-trips, and the audit trail records both moves", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, token);

    // A parked airframe strands nothing, so this exercises apply and audit
    // without needing an acknowledgement -- and can be put back exactly.
    const parked = fleet.find(
      (aircraft) => aircraft.serviceability === "stored" && aircraft.state.nextFlight === null,
    );
    expect(parked, "the seed no longer contains a stored airframe").toBeDefined();
    if (!parked) return;

    try {
      const withdraw = await request.post(`/api/aircraft/${parked.id}/serviceability`, {
        headers: auth(token),
        data: {
          serviceability: "out_of_service",
          mutation: { preview: false, acknowledgedWarnings: [] },
        },
      });
      expect(withdraw.status()).toBe(200);

      const midway = await loadFleet(request, token);
      const changed = midway.find((aircraft) => aircraft.id === parked.id);
      expect(changed?.serviceability).toBe("out_of_service");
      expect(changed?.state.operationalState).toBe("unavailable");
    } finally {
      const restore = await request.post(`/api/aircraft/${parked.id}/serviceability`, {
        headers: auth(token),
        data: {
          serviceability: "stored",
          mutation: { preview: false, acknowledgedWarnings: [] },
        },
      });
      expect(restore.status()).toBe(200);
    }

    const restored = await loadFleet(request, token);
    expect(restored.find((aircraft) => aircraft.id === parked.id)?.serviceability).toBe(
      "stored",
    );

    const audit = await request.get("/api/audit", {
      headers: auth(await signIn(request, ACCOUNTS.superAdmin)),
      params: { action: "aircraft.set_serviceability", pageSize: 10 },
    });
    expect(audit.status()).toBe(200);
    const entries = (await audit.json()) as {
      items: { action: string; previousValue: unknown; newValue: unknown }[];
    };
    expect(entries.items.length, "an applied change must leave an audit entry").toBeGreaterThan(
      0,
    );
    // Both sides are recorded, so the trail says what changed rather than only
    // that something did.
    expect(entries.items[0]?.previousValue).not.toBeNull();
    expect(entries.items[0]?.newValue).not.toBeNull();
  });

  test("changing serviceability is refused to a role without aircraft:write", async ({
    request,
  }) => {
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, fleetToken);
    const [first] = fleet;
    expect(first).toBeDefined();
    if (!first) return;

    const bookingToken = await signIn(request, ACCOUNTS.bookingAdmin);
    const response = await request.post(`/api/aircraft/${first.id}/serviceability`, {
      headers: auth(bookingToken),
      data: { serviceability: "maintenance", mutation: { preview: true } },
    });

    // Even a preview is refused: a preview reveals the operation, and the
    // boundary is about what a role may know as well as what it may do.
    expect(response.status()).toBe(403);
  });

  test("maintenance standing names which limit bites first", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, token);

    const tracked = fleet.filter((aircraft) => aircraft.maintenance.urgency !== "unknown");
    expect(tracked.length, "no airframe has a next check recorded").toBeGreaterThan(0);

    for (const aircraft of tracked) {
      expect(
        aircraft.maintenance.limitingFactor,
        `${aircraft.registration} has a check due but no limiting factor`,
      ).not.toBeNull();
      expect(["calendar", "hours", "cycles"]).toContain(aircraft.maintenance.limitingFactor);
      expect(aircraft.maintenance.summary.length).toBeGreaterThan(0);
    }

    // The seed deliberately places airframes on both sides of the line, so the
    // approaching-limit warning the brief asks for has something to show.
    const urgencies = new Set(tracked.map((aircraft) => aircraft.maintenance.urgency));
    expect(urgencies).toContain("exceeded");
    expect(urgencies).toContain("approaching");
  });

  test("the maintenanceDue filter returns exactly the airframes at or past a limit", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);
    const response = await request.get("/api/aircraft", {
      headers: auth(token),
      params: { maintenanceDue: "true" },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: FleetRow[] };
    expect(body.items.length).toBeGreaterThan(0);

    for (const aircraft of body.items) {
      expect(["approaching", "exceeded"]).toContain(aircraft.maintenance.urgency);
    }
  });
});

test.describe("amenities", () => {
  test("a withdrawal beats a grant at the same level, and says why", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, fleetToken);

    // The seed fits this tail with Wi-Fi and then withdraws it, both at
    // aircraft level, precisely so the tie-break is exercised by real data.
    const tail = fleet.find((aircraft) => aircraft.registration === "YU-ANB");
    expect(tail, "YU-ANB is no longer in the seeded fleet").toBeDefined();
    if (!tail) return;

    const response = await request.get(`/api/amenities/matrix/${tail.id}`, {
      headers: auth(token),
    });
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      cabins: {
        cabinClass: string;
        amenities: {
          amenityCode: string;
          included: boolean;
          decidedBy: string;
          note: string | null;
          overridden: unknown[];
        }[];
      }[];
    };

    expect(body.cabins.length).toBeGreaterThan(0);

    for (const cabin of body.cabins) {
      const wifi = cabin.amenities.find((amenity) => amenity.amenityCode === "wifi");
      expect(wifi, `${cabin.cabinClass} does not mention Wi-Fi at all`).toBeDefined();
      expect(wifi?.included, "the withdrawal must win over the grant at the same level").toBe(
        false,
      );
      expect(wifi?.note, "the operator has to be told why").not.toBeNull();
      expect(
        wifi?.overridden.length,
        "the grant it overrode must stay visible, not vanish",
      ).toBeGreaterThan(0);
    }
  });

  test("a cabin-level amenity applies only to that cabin", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const fleetToken = await signIn(request, ACCOUNTS.fleetManager);
    const fleet = await loadFleet(request, fleetToken);

    const mixed = fleet.find((aircraft) => Object.keys(aircraft.seatsByCabin).length > 1);
    expect(mixed, "no airframe has more than one cabin").toBeDefined();
    if (!mixed) return;

    const response = await request.get(`/api/amenities/matrix/${mixed.id}`, {
      headers: auth(token),
    });
    const body = (await response.json()) as {
      cabins: { cabinClass: string; amenities: { amenityCode: string; decidedBy: string }[] }[];
    };

    const business = body.cabins.find((cabin) => cabin.cabinClass === "business");
    const economy = body.cabins.find((cabin) => cabin.cabinClass === "economy");
    expect(business).toBeDefined();
    expect(economy).toBeDefined();

    // A hot meal is standard in Business and not in Economy: the same airframe,
    // a different answer, decided at the cabin level.
    expect(business?.amenities.some((amenity) => amenity.amenityCode === "meal_hot")).toBe(
      true,
    );
    expect(economy?.amenities.some((amenity) => amenity.amenityCode === "meal_hot")).toBe(
      false,
    );
  });

  test("reading amenities is baseline, changing them is not", async ({ request }) => {
    // Deliberate: knowing what a passenger was promised is something every
    // operational role needs -- a crew scheduler answering a cabin query, a
    // controller handling a downgrade. So `commercial:read` is baseline and
    // this endpoint is open to all of them. The boundary is on `commercial:write`,
    // which only the Commercial Manager and Super Admin hold, and which the
    // assignment editor will sit behind in Phase 6.
    for (const account of [
      ACCOUNTS.crewScheduler,
      ACCOUNTS.bookingAdmin,
      ACCOUNTS.opsController,
    ]) {
      const token = await signIn(request, account);
      const response = await request.get("/api/amenities", { headers: auth(token) });
      expect(response.status(), `${account} cannot read amenities`).toBe(200);
    }

    const anonymous = await request.get("/api/amenities");
    expect(anonymous.status(), "an unauthenticated caller must still be refused").toBe(401);
  });
});

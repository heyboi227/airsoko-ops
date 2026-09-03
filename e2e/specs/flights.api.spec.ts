import { expect, test, type APIRequestContext } from "@playwright/test";
import { ACCOUNTS, applyAcknowledging, auth, signIn } from "../support/api.ts";

/**
 * Flights: the list, the control actions, and the rules that guard them.
 *
 * Every test that writes puts the flight back the way it found it, so the
 * suite runs repeatedly against one seeded database. The exception is the
 * delay tests, which clear the delay rather than restoring whatever the seed
 * happened to generate -- the seed's delays are deterministic given a
 * reference date, but a test that depends on which flight got one would be
 * depending on the wrong thing.
 */

interface Preview {
  intent: string;
  applicable: boolean;
  requiresAcknowledgement: string[];
  findings: {
    code: string;
    severity: string;
    title: string;
    detail: string;
    related: unknown[];
  }[];
  consequences: { kind: string; summary: string; count?: number }[];
}

interface FlightRow {
  id: string;
  flightNumber: string;
  serviceDate: string;
  status: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  estimatedDeparture: string | null;
  delayMinutes: number;
  delayed: boolean;
  progress: number;
  blockMinutes: number;
  distanceNm: number;
  overriddenFields: string[];
  scheduleId: string | null;
  plannedTypeCode: string | null;
  origin: { iataCode: string; localTime: string; timeZone: string; offsetMinutes: number };
  destination: { iataCode: string; localTime: string };
  aircraft: {
    id: string;
    registration: string;
    icaoTypeCode: string;
    seatCapacity: number;
  } | null;
}

interface FlightList {
  items: FlightRow[];
  total: number;
  truncated: boolean;
  generatedAt: string;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function flights(
  request: APIRequestContext,
  token: string,
  query: Record<string, string>,
): Promise<FlightList> {
  const response = await request.get("/api/flights", { headers: auth(token), params: query });
  expect(response.status()).toBe(200);
  return (await response.json()) as FlightList;
}

/** A day far enough ahead that nothing on it has operated. */
async function futureDate(request: APIRequestContext, token: string): Promise<string> {
  const today = await flights(request, token, { limit: "1" });
  const base = new Date(today.generatedAt);
  base.setUTCDate(base.getUTCDate() + 2);
  return base.toISOString().slice(0, 10);
}

test.describe("the flight list", () => {
  test("defaults to the current operating day and derives what it shows", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const list = await flights(request, token, {});

    expect(list.total).toBeGreaterThan(40);
    const dates = new Set(list.items.map((item) => item.serviceDate));
    expect(dates.size).toBe(1);

    for (const flight of list.items) {
      // Instants are ISO 8601 in UTC. Postgres does not send them that way, so
      // this is a real assertion rather than a tautology.
      expect(flight.scheduledDeparture).toMatch(ISO_INSTANT);
      expect(flight.scheduledArrival).toMatch(ISO_INSTANT);

      // Local time is a rendering of the instant in the airport's own zone.
      expect(flight.origin.localTime).toMatch(/^\d{2}:\d{2}$/);
      expect(flight.blockMinutes).toBeGreaterThan(0);
      expect(flight.progress).toBeGreaterThanOrEqual(0);
      expect(flight.progress).toBeLessThanOrEqual(1);

      // Delay is derived, never stored: it must agree with the timestamps.
      const expected = Math.round(
        (Date.parse(flight.estimatedDeparture ?? flight.scheduledDeparture) -
          Date.parse(flight.scheduledDeparture)) /
          60_000,
      );
      if (flight.status !== "arrived" && flight.status !== "airborne") {
        expect(flight.delayMinutes).toBe(expected);
      }
      expect(flight.delayed).toBe(flight.delayMinutes >= 15);
    }
  });

  test("filters by route, status, aircraft and delay", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);

    const fromHub = await flights(request, token, { originIata: "BEG" });
    expect(fromHub.items.every((item) => item.origin.iataCode === "BEG")).toBe(true);

    const touching = await flights(request, token, { airportIata: "VIE" });
    expect(
      touching.items.every(
        (item) => item.origin.iataCode === "VIE" || item.destination.iataCode === "VIE",
      ),
    ).toBe(true);

    const late = await flights(request, token, { delayedOnly: "true" });
    expect(late.items.every((item) => item.delayed)).toBe(true);

    const unassigned = await flights(request, token, { unassignedOnly: "true" });
    expect(unassigned.items.every((item) => item.aircraft === null)).toBe(true);

    // "false" must mean false. `z.coerce.boolean()` would read it as true.
    const all = await flights(request, token, { delayedOnly: "false" });
    expect(all.total).toBeGreaterThan(late.total);
  });

  test("searches by flight number, registration and route pair", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const anchor = (await flights(request, token, { limit: "1" })).items[0];
    if (!anchor) throw new Error("The seed produced no flights for today.");

    const byNumber = await flights(request, token, { search: anchor.flightNumber });
    expect(byNumber.items.some((item) => item.id === anchor.id)).toBe(true);

    const byRoute = await flights(request, token, {
      search: `${anchor.origin.iataCode}-${anchor.destination.iataCode}`,
    });
    expect(byRoute.total).toBeGreaterThan(0);
    expect(
      byRoute.items.every(
        (item) =>
          item.origin.iataCode === anchor.origin.iataCode &&
          item.destination.iataCode === anchor.destination.iataCode,
      ),
    ).toBe(true);
  });

  test("the detail page carries the timeline, the series and the rotation", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const assigned = (await flights(request, token, {})).items.find((item) => item.aircraft);
    if (!assigned) throw new Error("The seed assigned no aircraft today.");

    const response = await request.get(`/api/flights/${assigned.id}`, { headers: auth(token) });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      flight: FlightRow & {
        series: { flightNumber: string; operatingDays: boolean[] } | null;
        timeline: {
          eventType: string;
          label: string;
          scheduledAt: string;
          complete: boolean;
        }[];
        inventory: { seatCapacity: number; sold: number };
        rotation: { flightNumber: string }[];
      };
    };

    // A flight that has not started still shows its whole day. An empty
    // timeline would be true and useless.
    expect(body.flight.timeline.length).toBeGreaterThanOrEqual(9);
    expect(body.flight.timeline.map((step) => step.eventType)).toContain("pushback");
    expect(body.flight.timeline.map((step) => step.eventType)).toContain("on_blocks");

    // Capacity is summed from the cabins, here as everywhere else.
    expect(body.flight.inventory.seatCapacity).toBe(body.flight.aircraft?.seatCapacity);
    expect(body.flight.inventory.sold).toBe(0);

    if (body.flight.scheduleId) expect(body.flight.series?.operatingDays).toHaveLength(7);
  });
});

// --- Scenario A ------------------------------------------------------------

test.describe("Scenario A: aircraft reassignment", () => {
  test("refuses an airframe that is not available, naming why", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const date = await futureDate(request, token);

    const target = (await flights(request, token, { from: date, to: date })).items.find(
      (item) => item.status === "scheduled" && item.aircraft,
    );
    if (!target) throw new Error("No scheduled flight with an aircraft on the chosen date.");

    const fleet = await request.get("/api/aircraft", { headers: auth(token) });
    const airframes = (await fleet.json()) as {
      items: { id: string; registration: string; serviceability: string }[];
    };
    const unserviceable = airframes.items.find((item) => item.serviceability !== "in_service");
    if (!unserviceable) throw new Error("The seed left every airframe in service.");

    const response = await request.post(`/api/flights/${target.id}/aircraft`, {
      headers: auth(token),
      data: { aircraftId: unserviceable.id, mutation: { preview: true } },
    });
    expect(response.status()).toBe(200);
    const preview = (await response.json()) as Preview;

    expect(preview.applicable).toBe(false);
    const unavailable = preview.findings.find((f) => f.code === "AIRCRAFT_UNAVAILABLE");
    expect(unavailable?.severity).toBe("blocking");
    expect(unavailable?.detail).toContain(unserviceable.registration);
    expect(unavailable?.detail).toContain(target.flightNumber);
  });

  test("refuses an airframe already flying, and names the conflicting flight", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const date = await futureDate(request, token);
    const day = await flights(request, token, { from: date, to: date });

    // Two sectors in the air at the same moment, on different airframes.
    const withAircraft = day.items.filter((item) => item.aircraft);
    let pair: [FlightRow, FlightRow] | null = null;
    for (const first of withAircraft) {
      const clash = withAircraft.find(
        (other) =>
          other.aircraft &&
          other.aircraft.id !== first.aircraft?.id &&
          Date.parse(other.scheduledDeparture) < Date.parse(first.scheduledArrival) &&
          Date.parse(first.scheduledDeparture) < Date.parse(other.scheduledArrival),
      );
      if (clash) {
        pair = [first, clash];
        break;
      }
    }
    if (!pair) throw new Error("No two overlapping sectors on different airframes.");

    const [flight, other] = pair;
    const response = await request.post(`/api/flights/${flight.id}/aircraft`, {
      headers: auth(token),
      data: { aircraftId: other.aircraft?.id, mutation: { preview: true } },
    });
    const preview = (await response.json()) as Preview;

    expect(preview.applicable).toBe(false);
    const overlap = preview.findings.find(
      (finding) => finding.code === "AIRCRAFT_OVERLAPPING_ASSIGNMENT",
    );
    expect(overlap?.detail).toContain(other.flightNumber);
  });

  test("checks availability, overlap, turnaround, range, capacity and ratings", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const date = await futureDate(request, token);

    const target = (await flights(request, token, { from: date, to: date })).items.find(
      (item) => item.status === "scheduled" && item.aircraft,
    );
    if (!target) throw new Error("No scheduled flight with an aircraft on the chosen date.");
    const original = target.aircraft;
    if (!original) throw new Error("unreachable");

    // Release, then put the same airframe back. Releasing is the mirror rule
    // and has to warn; putting the aircraft back on the rotation it already
    // flies must be accepted, though not necessarily in silence -- rules
    // about the airframe itself, such as a check coming due, still speak.
    const releasePreview = (await (
      await request.post(`/api/flights/${target.id}/aircraft`, {
        headers: auth(token),
        data: { aircraftId: null, mutation: { preview: true } },
      })
    ).json()) as Preview;

    expect(releasePreview.applicable).toBe(true);
    expect(releasePreview.requiresAcknowledgement).toContain("FLIGHT_NO_AIRCRAFT_ASSIGNED");
    expect(releasePreview.consequences.map((c) => c.kind)).toContain("aircraft_released");
    expect(releasePreview.consequences.map((c) => c.kind)).toContain("alerts_raised");

    // A warning does not silently pass: without the acknowledgement, no write.
    const unacknowledged = await request.post(`/api/flights/${target.id}/aircraft`, {
      headers: auth(token),
      data: { aircraftId: null, mutation: { preview: false } },
    });
    expect(unacknowledged.status()).toBe(412);

    const stillThere = await request.get(`/api/flights/${target.id}`, { headers: auth(token) });
    expect(((await stillThere.json()) as { flight: FlightRow }).flight.aircraft?.id).toBe(
      original.id,
    );

    try {
      // Acknowledge what the preview above actually reported, not a list
      // written by hand: the assertion that releasing warns is the one
      // directly above, and a second rule firing here is not this test's
      // business. See `applyAcknowledging` in ../support/api.ts.
      const released = await request.post(`/api/flights/${target.id}/aircraft`, {
        headers: auth(token),
        data: {
          aircraftId: null,
          mutation: {
            preview: false,
            acknowledgedWarnings: releasePreview.requiresAcknowledgement,
            reason: "Scenario A",
          },
        },
      });
      expect(released.status(), await released.text()).toBe(200);

      const empty = await request.get(`/api/flights/${target.id}`, { headers: auth(token) });
      expect(((await empty.json()) as { flight: FlightRow }).flight.aircraft).toBeNull();

      // The release raises an alert a controller has to see.
      const alerts = await request.get("/api/audit", {
        headers: auth(token),
        params: { resourceId: target.id },
      });
      expect(alerts.status()).toBe(200);
    } finally {
      // Putting the airframe back is teardown, not a claim about the rules.
      // Which rules it trips depends on the calendar -- a seeded check ages
      // into MAINTENANCE_LIMIT_APPROACHING for the target date, and a fixed
      // list went 412 the day that happened, leaving the flight released.
      const restored = await applyAcknowledging(
        request,
        "POST",
        `/api/flights/${target.id}/aircraft`,
        token,
        { aircraftId: original.id },
        "Scenario A restore",
      );
      expect(restored.status(), await restored.text()).toBe(200);
    }

    const back = await request.get(`/api/flights/${target.id}`, { headers: auth(token) });
    const flight = ((await back.json()) as { flight: FlightRow }).flight;
    expect(flight.aircraft?.id).toBe(original.id);
    // Capacity follows the airframe, summed from its cabins.
    expect(flight.aircraft?.seatCapacity).toBe(original.seatCapacity);
  });

  test("an accepted change reaches the live map", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);

    // An active flight is on the map by definition; the assertion is that the
    // map reads the same aircraft record the flight does, not a copy of it.
    const live = await request.get("/api/live-operations", { headers: auth(token) });
    expect(live.status()).toBe(200);
    const body = (await live.json()) as {
      items: { id: string; flightNumber: string; registration: string | null }[];
    };

    const tracked = body.items.find((item) => item.registration);
    if (!tracked) throw new Error("Nothing is airborne in the seeded window.");

    const detail = await request.get(`/api/flights/${tracked.id}`, { headers: auth(token) });
    const flight = ((await detail.json()) as { flight: FlightRow }).flight;
    expect(flight.aircraft?.registration).toBe(tracked.registration);
  });
});

// --- The control actions ----------------------------------------------------

test.describe("flight control", () => {
  test("refuses a status the lifecycle does not offer, and says what it does", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const date = await futureDate(request, token);
    const target = (await flights(request, token, { from: date, to: date })).items.find(
      (item) => item.status === "scheduled",
    );
    if (!target) throw new Error("No scheduled flight on the chosen date.");

    const response = await request.post(`/api/flights/${target.id}/status`, {
      headers: auth(token),
      data: { status: "airborne", mutation: { preview: false } },
    });

    expect(response.status()).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; findings: Preview["findings"] };
    };
    expect(body.error.code).toBe("RULE_VIOLATION");
    expect(body.error.findings[0]?.code).toBe("FLIGHT_STATUS_TRANSITION_INVALID");
    expect(body.error.findings[0]?.detail).toContain("check-in open");

    const unchanged = await request.get(`/api/flights/${target.id}`, { headers: auth(token) });
    expect(((await unchanged.json()) as { flight: FlightRow }).flight.status).toBe("scheduled");
  });

  test("moving a flight forward writes its timeline entry", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const date = await futureDate(request, token);
    const target = (await flights(request, token, { from: date, to: date })).items.find(
      (item) => item.status === "scheduled" && item.aircraft,
    );
    if (!target) throw new Error("No scheduled flight with an aircraft.");

    const forward = await request.post(`/api/flights/${target.id}/status`, {
      headers: auth(token),
      data: { status: "check_in_open", note: "Spec", mutation: { preview: false } },
    });
    expect(forward.status()).toBe(200);

    const detail = await request.get(`/api/flights/${target.id}`, { headers: auth(token) });
    const flight = (await detail.json()) as {
      flight: FlightRow & {
        timeline: { eventType: string; complete: boolean; note: string | null }[];
      };
    };
    expect(flight.flight.status).toBe("check_in_open");
    const step = flight.flight.timeline.find((entry) => entry.eventType === "check_in_open");
    expect(step?.complete).toBe(true);
    expect(step?.note).toBe("Spec");

    // Back where it started: on stand, a correction is allowed.
    const back = await request.post(`/api/flights/${target.id}/status`, {
      headers: auth(token),
      data: { status: "scheduled", mutation: { preview: false } },
    });
    expect(back.status()).toBe(200);
  });

  test("a recorded delay moves the estimates and stays derived", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const date = await futureDate(request, token);
    const target = (await flights(request, token, { from: date, to: date })).items.find(
      (item) => item.status === "scheduled" && !item.delayed,
    );
    if (!target) throw new Error("No punctual scheduled flight on the chosen date.");

    try {
      const preview = (await (
        await request.post(`/api/flights/${target.id}/delay`, {
          headers: auth(token),
          data: {
            delayMinutes: 75,
            reason: "technical",
            note: "Spec",
            mutation: { preview: true },
          },
        })
      ).json()) as Preview;

      expect(preview.requiresAcknowledgement).toContain("FLIGHT_DELAY_SIGNIFICANT");

      const applied = await request.post(`/api/flights/${target.id}/delay`, {
        headers: auth(token),
        data: {
          delayMinutes: 75,
          reason: "technical",
          note: "Spec",
          mutation: {
            preview: false,
            acknowledgedWarnings: preview.requiresAcknowledgement,
          },
        },
      });
      expect(applied.status()).toBe(200);

      const detail = await request.get(`/api/flights/${target.id}`, { headers: auth(token) });
      const flight = ((await detail.json()) as { flight: FlightRow }).flight;
      expect(flight.delayMinutes).toBe(75);
      expect(flight.delayed).toBe(true);
      // Delay is a condition, not a status -- decision 4.
      expect(flight.status).toBe("scheduled");
      expect(flight.origin.localTime).not.toBe(target.origin.localTime);
    } finally {
      await request.post(`/api/flights/${target.id}/delay`, {
        headers: auth(token),
        data: { delayMinutes: 0, reason: "other", mutation: { preview: false } },
      });
    }
  });

  test("changing a gate is recorded and reported back", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const date = await futureDate(request, token);
    const target = (await flights(request, token, { from: date, to: date }))?.items[0];
    if (!target) throw new Error("No flight on the chosen date.");

    const preview = (await (
      await request.post(`/api/flights/${target.id}/gate`, {
        headers: auth(token),
        data: { departureGate: "Z99", mutation: { preview: true } },
      })
    ).json()) as Preview;
    expect(preview.consequences[0]?.summary).toContain("Z99");

    const applied = await request.post(`/api/flights/${target.id}/gate`, {
      headers: auth(token),
      data: { departureGate: "Z99", mutation: { preview: false } },
    });
    expect(applied.status()).toBe(200);

    const detail = await request.get(`/api/flights/${target.id}`, { headers: auth(token) });
    expect(((await detail.json()) as { flight: FlightRow }).flight.origin).toMatchObject({
      gate: "Z99",
    });
  });
});

// --- Scenario G, at the flight boundary -------------------------------------

test.describe("Scenario G: the permission boundary holds at the API", () => {
  test("a booking administrator reads flights but cannot change one", async ({ request }) => {
    const bookings = await signIn(request, ACCOUNTS.bookingAdmin);

    const list = await request.get("/api/flights", { headers: auth(bookings) });
    expect(list.status()).toBe(200);

    const target = ((await list.json()) as FlightList).items[0];
    if (!target) throw new Error("No flights today.");

    for (const [path, data] of [
      ["aircraft", { aircraftId: null }],
      ["status", { status: "check_in_open" }],
      ["delay", { delayMinutes: 10, reason: "other" }],
      ["gate", { departureGate: "A1" }],
    ] as const) {
      const response = await request.post(`/api/flights/${target.id}/${path}`, {
        headers: auth(bookings),
        data: { ...data, mutation: { preview: true } },
      });
      expect(response.status(), `POST /api/flights/:id/${path}`).toBe(403);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      // The message names the permission, so a refusal is diagnosable.
      expect(body.error.message).toMatch(/permission/);
    }

    // Preview mode is not a way past the boundary either: the check runs before
    // anything is evaluated.
    const stillThere = await request.get(`/api/flights/${target.id}`, {
      headers: auth(bookings),
    });
    expect(stillThere.status()).toBe(200);
  });
});

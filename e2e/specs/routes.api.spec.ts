import { expect, test, type APIRequestContext } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * Routes: opening a pair the airline does not serve yet.
 *
 * Filing a schedule was possible from Phase 3 only on a pair somebody had
 * seeded, which meant the console could not open a destination at all. These
 * tests pin the write path that fixes it, and the boundary around it: the two
 * roles that plan a service hold `route:write`, and a booking administrator
 * is refused at the API -- in preview mode as much as on apply.
 *
 * Most of what is asserted here is asserted in preview mode. That is not
 * timidity: a route cannot be deleted through the API, so a test that filed
 * one for every rule it wanted to see would leave a network behind it and
 * refuse to run twice.
 *
 * Which is also why each test owns its own unfiled pair below. Only one of
 * them writes, and it tolerates finding its pair already there -- so a second
 * run against the same database still asserts the same things, and the pair
 * the write leaves behind is not one another test needs to be open.
 */

interface Preview {
  applicable: boolean;
  requiresAcknowledgement: string[];
  findings: { code: string; severity: string; title: string; detail: string }[];
  consequences: { kind: string; summary: string; count?: number }[];
}

interface RouteRow {
  id: string;
  originIata: string;
  destinationIata: string;
  distanceNm: number;
  blockMinutes: number;
  status: string;
  typicalTypeCode: string | null;
  scheduleCount: number;
}

/**
 * A pair per test, each a station the seed puts on file and the network plan
 * never serves, so each is a pair that can be opened. The block times are the
 * ones a turboprop's 275 kt implies over the distance, which is what the form
 * itself would offer.
 *
 * Distinct rather than shared: the one test that writes leaves its pair on
 * file, and a shared pair would make every other test's second run assert a
 * duplicate it was not written to expect.
 */
const HUB = "BEG";
const PAIRS = {
  /** Podgorica, 155 nm. The only pair these tests actually file. */
  filed: { destination: "TGD", blockMinutes: 64 },
  /** Dubrovnik, 162 nm. Previewed, to read the consequences off it. */
  reviewed: { destination: "DBV", blockMinutes: 65 },
  /** Ohrid, 219 nm. Previewed by three roles, to read the boundary. */
  permission: { destination: "OHD", blockMinutes: 78 },
  /** Tuzla, 71 nm, with a block that leaves one minute to fly it. */
  implausible: { destination: "TZL", blockMinutes: 31 },
  /** Sydney, 8,474 nm: past the A332's usable range, so nothing reaches it. */
  unreachable: { destination: "SYD", blockMinutes: 20 * 60 },
} as const;

/** A number the seeded network does not use, and the other specs do not take. */
const TEST_FLIGHT_NUMBER = "SO980";
const MONDAYS_IN_APRIL = { from: "2027-04-05", to: "2027-04-26", count: 4 };
const MONDAY_ONLY = [false, true, false, false, false, false, false];

async function airportId(
  request: APIRequestContext,
  token: string,
  iataCode: string,
): Promise<string> {
  const response = await request.get("/api/airports", {
    headers: auth(token),
    params: { search: iataCode },
  });
  const body = (await response.json()) as { items: { id: string; iataCode: string }[] };
  const airport = body.items.find((item) => item.iataCode === iataCode);
  if (!airport) throw new Error(`${iataCode} is not a station on file. Has the seed been run?`);
  return airport.id;
}

async function typeId(
  request: APIRequestContext,
  token: string,
  icaoTypeCode: string,
): Promise<string> {
  const response = await request.get("/api/aircraft/types/list", { headers: auth(token) });
  const body = (await response.json()) as { items: { id: string; icaoTypeCode: string }[] };
  const type = body.items.find((item) => item.icaoTypeCode === icaoTypeCode);
  if (!type) throw new Error(`No ${icaoTypeCode} on file.`);
  return type.id;
}

async function routesBetween(
  request: APIRequestContext,
  token: string,
  originIata: string,
  destinationIata: string,
): Promise<RouteRow[]> {
  const response = await request.get("/api/routes", {
    headers: auth(token),
    params: { originIata, destinationIata },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: RouteRow[] };
  return body.items;
}

async function fileRoute(
  request: APIRequestContext,
  token: string,
  body: Record<string, unknown>,
) {
  return request.post("/api/routes", { headers: auth(token), data: body });
}

/** A draft for one of the pairs above, the mutation envelope left to the caller. */
async function draftFor(
  request: APIRequestContext,
  token: string,
  pair: { destination: string; blockMinutes: number },
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    originAirportId: await airportId(request, token, HUB),
    destinationAirportId: await airportId(request, token, pair.destination),
    blockMinutes: pair.blockMinutes,
    status: "active",
    typicalAircraftTypeId: await typeId(request, token, "AT76"),
    includeReturn: true,
    ...overrides,
  };
}

/** Remove every pattern under the test flight number, and its flights with it. */
async function removeTestSeries(request: APIRequestContext, token: string) {
  const response = await request.get("/api/schedules", {
    headers: auth(token),
    params: { search: TEST_FLIGHT_NUMBER, includeInactive: "true" },
  });
  const body = (await response.json()) as { items: { id: string }[] };

  for (const pattern of body.items) {
    const deleted = await request.delete(`/api/schedules/${pattern.id}`, {
      headers: auth(token),
      data: {
        preview: false,
        acknowledgedWarnings: ["SCHEDULE_HAS_OCCURRENCES"],
        reason: "Route acceptance fixture teardown",
      },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);
  }
}

test.beforeEach(async ({ request }) => {
  await removeTestSeries(request, await signIn(request, ACCOUNTS.opsController));
});

test.afterEach(async ({ request }) => {
  await removeTestSeries(request, await signIn(request, ACCOUNTS.opsController));
});

test.describe("filing a route", () => {
  test("the roles that plan a service may file a pair; a booking administrator may not", async ({
    request,
  }) => {
    const clerk = await signIn(request, ACCOUNTS.bookingAdmin);

    // Reading the network is a different question, and every role can: a
    // booking administrator needs the pair to seat a passenger on it.
    const read = await request.get("/api/routes", { headers: auth(clerk) });
    expect(read.status()).toBe(200);

    // Preview is refused too. An evaluation of a change this role may not
    // make is not a read it is entitled to -- and a client that skipped the
    // review would find the apply refused identically.
    const draft = await draftFor(request, clerk, PAIRS.permission);
    for (const mutation of [{ preview: true }, { preview: false }]) {
      const refused = await fileRoute(request, clerk, { ...draft, mutation });
      expect(refused.status()).toBe(403);
      const body = (await refused.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      // The refusal names the missing permission, so it is diagnosable.
      expect(body.error.message).toContain("route:write");
    }

    // Network planning owns the map, and the controller who files the pattern
    // holds the pair with it: refusing the pair to the role trusted with the
    // timetable is what made the schedule form a dead end.
    for (const account of [ACCOUNTS.commercialManager, ACCOUNTS.opsController]) {
      const token = await signIn(request, account);
      const allowed = await fileRoute(request, token, {
        ...(await draftFor(request, token, PAIRS.permission)),
        mutation: { preview: true },
      });
      expect(allowed.status(), await allowed.text()).toBe(200);
    }
  });

  test("the review says what filing the pair does, both legs of it", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await fileRoute(request, token, {
      ...(await draftFor(request, token, PAIRS.reviewed)),
      mutation: { preview: true },
    });

    expect(response.status()).toBe(200);
    const preview = (await response.json()) as Preview;
    expect(preview.applicable).toBe(true);
    expect(preview.findings).toEqual([]);

    const summaries = preview.consequences.map((item) => item.summary).join(" | ");
    expect(summaries).toContain("BEG-DBV");
    // A route is directional, and the return leg is filed with it.
    expect(summaries).toContain("DBV-BEG");
  });

  test("a pair the airline already flies is refused, naming what flies it", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await fileRoute(request, token, {
      originAirportId: await airportId(request, token, "BEG"),
      destinationAirportId: await airportId(request, token, "VIE"),
      blockMinutes: 95,
      mutation: { preview: true },
    });

    expect(response.status()).toBe(200);
    const preview = (await response.json()) as Preview;
    expect(preview.applicable).toBe(false);

    const finding = preview.findings.find((item) => item.code === "ROUTE_PAIR_IN_USE");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toMatch(/recurring schedules? already fly it/);
  });

  test("a pair to itself is refused", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const beg = await airportId(request, token, "BEG");
    const response = await fileRoute(request, token, {
      originAirportId: beg,
      destinationAirportId: beg,
      blockMinutes: 95,
      mutation: { preview: true },
    });

    const preview = (await response.json()) as Preview;
    expect(preview.applicable).toBe(false);
    expect(preview.findings.map((item) => item.code)).toEqual([
      "ROUTE_SAME_ORIGIN_AND_DESTINATION",
    ]);
  });

  test("a block time no aeroplane could keep is refused, with the figure", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await fileRoute(request, token, {
      ...(await draftFor(request, token, PAIRS.implausible)),
      mutation: { preview: true },
    });

    const preview = (await response.json()) as Preview;
    expect(preview.applicable).toBe(false);
    const finding = preview.findings.find((item) => item.code === "ROUTE_BLOCK_IMPLAUSIBLE");
    // 71 nm with one minute to cruise in: the refusal quotes the speed.
    expect(finding?.detail).toContain("kt");
  });

  test("a sector the fleet cannot reach warns, and the write waits for the tick", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const draft = await draftFor(request, token, PAIRS.unreachable, {
      status: "planned",
      typicalAircraftTypeId: null,
      includeReturn: false,
    });

    const preview = (await (
      await fileRoute(request, token, { ...draft, mutation: { preview: true } })
    ).json()) as Preview;
    // A route the fleet cannot fly is a plan, not an error -- so it warns.
    expect(preview.applicable).toBe(true);
    expect(preview.requiresAcknowledgement).toContain("ROUTE_BEYOND_FLEET_RANGE");
    expect(
      preview.findings.find((item) => item.code === "ROUTE_BEYOND_FLEET_RANGE")?.detail,
    ).toContain("A332");

    // Applying without the acknowledgement is refused, so nothing is written
    // and this test leaves no route behind.
    const unacknowledged = await fileRoute(request, token, {
      ...draft,
      mutation: { preview: false },
    });
    expect(unacknowledged.status()).toBe(412);

    expect(await routesBetween(request, token, HUB, PAIRS.unreachable.destination)).toEqual([]);
  });

  test("a filed pair is pickable, and a pattern can be filed on it", async ({ request }) => {
    // One role, one flow: the controller opening a pair from the schedule form
    // and then filing the service on it, which is the whole point of the
    // button being there.
    const planner = await signIn(request, ACCOUNTS.opsController);

    // Idempotent by design: a route cannot be removed through the API, so a
    // second run against the same database finds the pair already open. CI
    // seeds a fresh database every time and therefore always takes the write.
    const before = await routesBetween(request, planner, HUB, PAIRS.filed.destination);
    if (before.length === 0) {
      const filed = await fileRoute(request, planner, {
        ...(await draftFor(request, planner, PAIRS.filed)),
        mutation: { preview: false, reason: "Opening Podgorica" },
      });

      expect(filed.status(), await filed.text()).toBe(201);
      const body = (await filed.json()) as {
        route: RouteRow;
        returnRoute: RouteRow | null;
        preview: Preview;
      };
      expect(body.route.originIata).toBe("BEG");
      expect(body.route.destinationIata).toBe("TGD");
      // Derived from the stations' coordinates, not from anything sent.
      expect(body.route.distanceNm).toBe(155);
      expect(body.route.blockMinutes).toBe(PAIRS.filed.blockMinutes);
      expect(body.route.typicalTypeCode).toBe("AT76");
      expect(body.returnRoute?.originIata).toBe("TGD");
      expect(body.returnRoute?.destinationIata).toBe("BEG");
    }

    // Both legs are on file and pickable, whichever run this is.
    const [outbound] = await routesBetween(request, planner, HUB, PAIRS.filed.destination);
    expect(outbound?.distanceNm).toBe(155);
    expect(await routesBetween(request, planner, PAIRS.filed.destination, HUB)).toHaveLength(1);

    // The point of the whole exercise: a service on a pair that did not exist
    // before somebody opened it.
    const controller = planner;
    const search = await request.get("/api/routes", {
      headers: auth(controller),
      params: { search: "BEG-TGD" },
    });
    const found = (await search.json()) as { items: RouteRow[] };
    expect(found.items.map((item) => `${item.originIata}-${item.destinationIata}`)).toContain(
      "BEG-TGD",
    );

    const scheduled = await request.post("/api/schedules", {
      headers: auth(controller),
      data: {
        flightNumber: TEST_FLIGHT_NUMBER,
        routeId: outbound?.id,
        validFrom: MONDAYS_IN_APRIL.from,
        validTo: MONDAYS_IN_APRIL.to,
        operatingDays: MONDAY_ONLY,
        departureLocalTime: "06:20",
        arrivalLocalTime: "07:24",
        aircraftTypeId: await typeId(request, controller, "AT76"),
        generateOccurrences: true,
        mutation: { preview: false, reason: "First Podgorica rotation" },
      },
    });

    expect(scheduled.status(), await scheduled.text()).toBe(201);
    const pattern = (await scheduled.json()) as {
      schedule: { occurrencesFiled: number };
    };
    expect(pattern.schedule.occurrencesFiled).toBe(MONDAYS_IN_APRIL.count);

    // And the pair now reports the service, which is what sorts the picker.
    const [withService] = await routesBetween(request, planner, HUB, PAIRS.filed.destination);
    expect(withService?.scheduleCount).toBe(1);
  });
});

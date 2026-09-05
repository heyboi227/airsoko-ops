import { describe, expect, it } from "vitest";
import { isBlocking, warningCodes } from "@airsoko/contracts";
import { DEFAULT_POLICY } from "../policy.ts";
import {
  TIMETABLE_GRID_MINUTES,
  impliedCruiseKts,
  roundToTimetableGrid,
  suggestedBlockMinutes,
} from "../network.ts";
import {
  evaluateSaveRoute,
  type ExistingRoute,
  type FleetTypeReach,
  type RouteDraft,
  type RouteEndpointFacts,
  type SaveRouteContext,
} from "./route.ts";

const BEG: RouteEndpointFacts = {
  id: "11111111-1111-5111-8111-111111111111",
  iataCode: "BEG",
  name: "Belgrade Nikola Tesla",
  city: "Belgrade",
  latitude: 44.8184,
  longitude: 20.3091,
  active: true,
};

const VIE: RouteEndpointFacts = {
  id: "22222222-2222-5222-8222-222222222222",
  iataCode: "VIE",
  name: "Vienna International",
  city: "Vienna",
  latitude: 48.1103,
  longitude: 16.5697,
  active: true,
};

/** New York, to have a sector no short-haul type reaches: 3,910 nm from BEG. */
const JFK: RouteEndpointFacts = {
  id: "33333333-3333-5333-8333-333333333333",
  iataCode: "JFK",
  name: "John F. Kennedy International",
  city: "New York",
  latitude: 40.6413,
  longitude: -73.7781,
  active: true,
};

const TURBOPROP: FleetTypeReach = {
  aircraftTypeId: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
  typeCode: "AT76",
  rangeNm: 825,
  cruiseSpeedKts: 275,
};

const NARROW_BODY: FleetTypeReach = {
  aircraftTypeId: "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
  typeCode: "A20N",
  rangeNm: 3500,
  cruiseSpeedKts: 447,
};

/** BEG-VIE is 251 nm, which a 95-minute block flies at a sane 232 kt. */
function draft(overrides: Partial<RouteDraft> = {}): RouteDraft {
  return {
    origin: BEG,
    destination: VIE,
    blockMinutes: 95,
    status: "active",
    typicalType: null,
    ...overrides,
  };
}

function context(overrides: Partial<SaveRouteContext> = {}): SaveRouteContext {
  return {
    policy: DEFAULT_POLICY,
    existing: [],
    fleetTypes: [TURBOPROP, NARROW_BODY],
    ...overrides,
  };
}

function onFile(overrides: Partial<ExistingRoute> = {}): ExistingRoute {
  return {
    id: "cccccccc-cccc-5ccc-8ccc-cccccccccccc",
    originIata: "BEG",
    destinationIata: "VIE",
    status: "active",
    scheduleCount: 0,
    ...overrides,
  };
}

const codes = (findings: readonly { code: string }[]) =>
  findings.map((finding) => finding.code);

describe("evaluateSaveRoute", () => {
  it("passes a plausible pair, and says the pair becomes selectable", () => {
    const evaluation = evaluateSaveRoute(draft(), context());

    expect(evaluation.findings).toEqual([]);
    expect(evaluation.consequences).toHaveLength(1);
    expect(evaluation.consequences[0]?.summary).toContain("BEG-VIE");
  });

  it("refuses a route from an airport to itself, and says nothing else", () => {
    const evaluation = evaluateSaveRoute(draft({ destination: BEG }), context());

    // The one refusal is the whole answer: a sector of zero length has no
    // distance to judge a block time or a range against.
    expect(codes(evaluation.findings)).toEqual(["ROUTE_SAME_ORIGIN_AND_DESTINATION"]);
    expect(evaluation.consequences).toEqual([]);
  });

  it("refuses a pair the airline already holds, and says what flies it", () => {
    const evaluation = evaluateSaveRoute(
      draft(),
      context({ existing: [onFile({ scheduleCount: 3 })] }),
    );

    expect(isBlocking(evaluation.findings)).toBe(true);
    const clash = evaluation.findings.find((f) => f.code === "ROUTE_PAIR_IN_USE");
    expect(clash?.detail).toContain("3 recurring schedules");
    expect(clash?.subject).toEqual({
      kind: "route",
      id: "cccccccc-cccc-5ccc-8ccc-cccccccccccc",
      label: "BEG-VIE",
    });
    // Nothing is filed, so nothing becomes selectable.
    expect(evaluation.consequences).toEqual([]);
  });

  it("treats the return leg as a different route", () => {
    // A route is directional. VIE-BEG on file is not BEG-VIE on file, and a
    // rule that collapsed the two would make every second leg unfileable.
    const evaluation = evaluateSaveRoute(
      draft(),
      context({ existing: [onFile({ originIata: "VIE", destinationIata: "BEG" })] }),
    );

    expect(evaluation.findings).toEqual([]);
  });

  it("refuses a pair through a withdrawn station, naming the station", () => {
    const evaluation = evaluateSaveRoute(
      draft({ destination: { ...VIE, active: false } }),
      context(),
    );

    const finding = evaluation.findings.find((f) => f.code === "ROUTE_ENDPOINT_WITHDRAWN");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.subject?.label).toBe("VIE");
  });

  it("names both ends when both have been withdrawn", () => {
    const evaluation = evaluateSaveRoute(
      draft({ origin: { ...BEG, active: false }, destination: { ...VIE, active: false } }),
      context(),
    );

    expect(
      codes(evaluation.findings).filter((c) => c === "ROUTE_ENDPOINT_WITHDRAWN"),
    ).toHaveLength(2);
  });

  it("refuses a block time that leaves no time to cruise", () => {
    // 251 nm in 45 minutes is 1,004 kt in the cruise once taxi, climb and
    // descent are allowed for.
    const evaluation = evaluateSaveRoute(draft({ blockMinutes: 45 }), context());

    const finding = evaluation.findings.find((f) => f.code === "ROUTE_BLOCK_IMPLAUSIBLE");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("1,004 kt");
  });

  it("refuses a block shorter than any gate-to-gate movement", () => {
    const evaluation = evaluateSaveRoute(draft({ blockMinutes: 20 }), context());

    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(
      evaluation.findings.find((f) => f.code === "ROUTE_BLOCK_IMPLAUSIBLE")?.detail,
    ).toContain("an infinite speed");
  });

  it("warns on a block that is merely unusual, either way", () => {
    // 602 kt: fast for a scheduled sector, not impossible.
    const fast = evaluateSaveRoute(draft({ blockMinutes: 55 }), context());
    expect(isBlocking(fast.findings)).toBe(false);
    expect(warningCodes(fast.findings)).toEqual(["ROUTE_BLOCK_IMPLAUSIBLE"]);

    // 56 kt: five hours to Vienna is a typo, and every flight filed on the
    // route would inherit it.
    const slow = evaluateSaveRoute(draft({ blockMinutes: 300 }), context());
    expect(warningCodes(slow.findings)).toEqual(["ROUTE_BLOCK_IMPLAUSIBLE"]);
  });

  it("warns when the type the route is planned on cannot reach the destination", () => {
    const evaluation = evaluateSaveRoute(
      draft({ destination: JFK, blockMinutes: 9 * 60, typicalType: NARROW_BODY }),
      context(),
    );

    const finding = evaluation.findings.find((f) => f.code === "ROUTE_BEYOND_FLEET_RANGE");
    expect(finding?.severity).toBe("warning");
    expect(finding?.title).toContain("A20N");
    // The route is still fileable: it is a plan, and the warning is the point.
    expect(isBlocking(evaluation.findings)).toBe(false);
  });

  it("warns when nothing on the airline's books reaches the destination", () => {
    const evaluation = evaluateSaveRoute(
      draft({ destination: JFK, blockMinutes: 9 * 60 }),
      context(),
    );

    const finding = evaluation.findings.find((f) => f.code === "ROUTE_BEYOND_FLEET_RANGE");
    // The longest-legged type is the one worth naming; the turboprop is not news.
    expect(finding?.detail).toContain("A20N");
    expect(finding?.detail).not.toContain("AT76");
  });

  it("says nothing about range when the planned type reaches the destination", () => {
    const evaluation = evaluateSaveRoute(draft({ typicalType: TURBOPROP }), context());
    expect(evaluation.findings).toEqual([]);
  });

  it("asks about the chosen type rather than the fleet, when one is chosen", () => {
    // A turboprop planned on a sector its own range covers, in a fleet whose
    // longest-legged type is shorter still: one condition, one finding.
    const evaluation = evaluateSaveRoute(
      draft({ destination: JFK, blockMinutes: 9 * 60, typicalType: TURBOPROP }),
      context({ fleetTypes: [TURBOPROP] }),
    );

    expect(
      codes(evaluation.findings).filter((c) => c === "ROUTE_BEYOND_FLEET_RANGE"),
    ).toHaveLength(1);
  });

  it("says nothing about range when there is no fleet to ask", () => {
    const evaluation = evaluateSaveRoute(
      draft({ destination: JFK, blockMinutes: 9 * 60 }),
      context({ fleetTypes: [] }),
    );

    expect(evaluation.findings).toEqual([]);
  });
});

describe("block time and distance", () => {
  it("suggests the cruise the distance needs, plus the ground allowance, on the timetable grid", () => {
    // 251 nm at 447 kt is 33.7 minutes in the air, 63.7 gate to gate: a
    // timetable publishes that as 65, not 64.
    expect(suggestedBlockMinutes(251, 447)).toBe(65);
  });

  it("moves a figure to the nearest five minutes", () => {
    expect(roundToTimetableGrid(63.7)).toBe(65);
    expect(roundToTimetableGrid(62.4)).toBe(60);
    expect(roundToTimetableGrid(133)).toBe(135);
    expect(roundToTimetableGrid(0)).toBe(0);
  });

  it("lands every suggestion on the grid, whatever the distance and the type", () => {
    const sectors: [number, number][] = [
      [112, 275],
      [768, 447],
      [1_240, 455],
      [4_050, 470],
    ];
    for (const [distance, speed] of sectors) {
      expect(
        suggestedBlockMinutes(distance, speed) % TIMETABLE_GRID_MINUTES,
        `${distance} nm`,
      ).toBe(0);
    }
  });

  it("suggests nothing for a speed of zero rather than an infinite block", () => {
    expect(suggestedBlockMinutes(251, 0)).toBe(0);
  });

  it("round-trips: a suggested block implies roughly the speed it came from", () => {
    // The grid can move the block by up to two and a half minutes either way,
    // which over a half-hour cruise is a few percent of the speed.
    const implied = impliedCruiseKts(251, suggestedBlockMinutes(251, 447));
    expect(Math.abs(implied - 447) / 447).toBeLessThan(0.1);
  });

  it("reports an infinite implied speed when the block leaves no cruise", () => {
    expect(impliedCruiseKts(251, 30)).toBe(Infinity);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../policy.ts";
import {
  evaluateAircraftAssignment,
  evaluateWithdrawAircraft,
  type AssignAircraftContext,
  type CandidateAircraft,
  type SectorToFly,
} from "./aircraft.ts";
import { isBlocking } from "@airsoko/contracts";

const BEG = { latitude: 44.8184, longitude: 20.3091 };
const VIE = { latitude: 48.1103, longitude: 16.5697 };
const JFK = { latitude: 40.6413, longitude: -73.7781 };

const NOW = "2026-08-30T06:00:00.000Z";

function narrowBody(overrides: Partial<CandidateAircraft> = {}): CandidateAircraft {
  return {
    id: "11111111-1111-5111-8111-111111111111",
    registration: "YU-APE",
    serviceability: "in_service",
    typeCode: "A320",
    rangeNm: 3300,
    minimumTurnaroundMinutes: 35,
    seatCapacity: 148,
    seatsByCabin: { business: 16, economy: 132 },
    totalHours: 30_000,
    totalCycles: 12_000,
    maintenance: {
      nextCheckType: "a_check",
      nextCheckDueAt: "2026-12-01T00:00:00.000Z",
      nextCheckDueHours: 31_000,
      nextCheckDueCycles: 13_000,
      totalHours: 30_000,
      totalCycles: 12_000,
    },
    ...overrides,
  };
}

function sector(overrides: Partial<SectorToFly> = {}): SectorToFly {
  return {
    flightId: "22222222-2222-5222-8222-222222222222",
    flightNumber: "SO200",
    originIata: "BEG",
    destinationIata: "VIE",
    origin: BEG,
    destination: VIE,
    scheduledDeparture: "2026-08-30T08:00:00.000Z",
    scheduledArrival: "2026-08-30T09:05:00.000Z",
    soldByCabin: {},
    ...overrides,
  };
}

function context(overrides: Partial<AssignAircraftContext> = {}): AssignAircraftContext {
  return {
    now: NOW,
    policy: DEFAULT_POLICY,
    commitments: [],
    maintenanceWindows: [],
    ...overrides,
  };
}

const codes = (evaluation: { findings: { code: string }[] }) =>
  evaluation.findings.map((finding) => finding.code);

describe("aircraft assignment", () => {
  it("accepts a serviceable aircraft with a clear diary", () => {
    const result = evaluateAircraftAssignment(narrowBody(), sector(), context());
    expect(result.findings).toHaveLength(0);
    expect(isBlocking(result.findings)).toBe(false);
    // The operator still learns what it does.
    expect(result.consequences.map((c) => c.kind)).toContain("aircraft_assigned");
  });

  // --- The Phase 2 gate ----------------------------------------------------

  it.each(["maintenance", "stored", "out_of_service"] as const)(
    "refuses an aircraft that is %s",
    (serviceability) => {
      const result = evaluateAircraftAssignment(
        narrowBody({ serviceability }),
        sector(),
        context(),
      );
      expect(isBlocking(result.findings)).toBe(true);
      expect(codes(result)).toContain("AIRCRAFT_UNAVAILABLE");
    },
  );

  it("names the aircraft and the reason rather than refusing generically", () => {
    const result = evaluateAircraftAssignment(
      narrowBody({ registration: "YU-APD", serviceability: "maintenance" }),
      sector(),
      context(),
    );
    const finding = result.findings.find((f) => f.code === "AIRCRAFT_UNAVAILABLE");
    expect(finding?.detail).toContain("YU-APD");
    expect(finding?.detail).toContain("maintenance");
    expect(finding?.detail).toContain("SO200");
  });

  // --- Diary conflicts -----------------------------------------------------

  it("blocks an overlapping sector", () => {
    const result = evaluateAircraftAssignment(
      narrowBody(),
      sector(),
      context({
        commitments: [
          {
            flightId: "33333333-3333-5333-8333-333333333333",
            flightNumber: "SO118",
            originIata: "BEG",
            destinationIata: "FCO",
            departure: "2026-08-30T08:30:00.000Z",
            arrival: "2026-08-30T10:00:00.000Z",
          },
        ],
      }),
    );
    expect(codes(result)).toContain("AIRCRAFT_OVERLAPPING_ASSIGNMENT");
    expect(isBlocking(result.findings)).toBe(true);
  });

  it("blocks a turnaround shorter than the type's minimum", () => {
    const result = evaluateAircraftAssignment(
      narrowBody(),
      sector(),
      context({
        commitments: [
          {
            flightId: "33333333-3333-5333-8333-333333333333",
            flightNumber: "SO101",
            originIata: "SJJ",
            destinationIata: "BEG",
            departure: "2026-08-30T06:30:00.000Z",
            // Lands 20 minutes before departure; an A320 needs 35.
            arrival: "2026-08-30T07:40:00.000Z",
          },
        ],
      }),
    );
    const finding = result.findings.find((f) => f.code === "AIRCRAFT_INSUFFICIENT_TURNAROUND");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("35 minutes");
  });

  it("warns, rather than blocks, on a turnaround that is merely tight", () => {
    const result = evaluateAircraftAssignment(
      narrowBody(),
      sector(),
      context({
        commitments: [
          {
            flightId: "33333333-3333-5333-8333-333333333333",
            flightNumber: "SO101",
            originIata: "SJJ",
            destinationIata: "BEG",
            departure: "2026-08-30T06:00:00.000Z",
            // 40 minutes: above the 35 minimum, inside the 15-minute margin.
            arrival: "2026-08-30T07:20:00.000Z",
          },
        ],
      }),
    );
    const finding = result.findings.find((f) => f.code === "AIRCRAFT_INSUFFICIENT_TURNAROUND");
    expect(finding?.severity).toBe("warning");
    expect(isBlocking(result.findings)).toBe(false);
  });

  it("blocks an aircraft that would have to be in two places", () => {
    const result = evaluateAircraftAssignment(
      narrowBody(),
      sector(),
      context({
        commitments: [
          {
            flightId: "33333333-3333-5333-8333-333333333333",
            flightNumber: "SO301",
            originIata: "CDG",
            // Lands at Paris, but the new sector departs Belgrade.
            destinationIata: "CDG",
            departure: "2026-08-30T04:00:00.000Z",
            arrival: "2026-08-30T06:30:00.000Z",
          },
        ],
      }),
    );
    expect(codes(result)).toContain("AIRCRAFT_IMPOSSIBLE_REPOSITIONING");
    expect(isBlocking(result.findings)).toBe(true);
  });

  it("blocks a sector that runs through booked maintenance", () => {
    const result = evaluateAircraftAssignment(
      narrowBody(),
      sector(),
      context({
        maintenanceWindows: [
          {
            id: "44444444-4444-5444-8444-444444444444",
            checkType: "a_check",
            start: "2026-08-30T07:00:00.000Z",
            end: "2026-08-30T19:00:00.000Z",
          },
        ],
      }),
    );
    expect(isBlocking(result.findings)).toBe(true);
    expect(result.findings.some((f) => f.detail.includes("a check"))).toBe(true);
  });

  // --- Physics -------------------------------------------------------------

  it("blocks a turboprop sent transatlantic", () => {
    const atr = narrowBody({
      registration: "YU-ALA",
      typeCode: "AT76",
      rangeNm: 825,
      seatCapacity: 72,
      seatsByCabin: { economy: 72 },
    });
    const result = evaluateAircraftAssignment(
      atr,
      sector({ destinationIata: "JFK", destination: JFK, flightNumber: "SO500" }),
      context(),
    );
    const finding = result.findings.find((f) => f.code === "AIRCRAFT_RANGE_INSUFFICIENT");
    expect(finding?.severity).toBe("blocking");
    // The numbers are in the message, not just the verdict.
    expect(finding?.detail).toMatch(/nm/);
  });

  it("allows a long-haul type on the same sector", () => {
    const widebody = narrowBody({
      registration: "YU-ARA",
      typeCode: "A332",
      rangeNm: 7250,
      minimumTurnaroundMinutes: 75,
      seatCapacity: 249,
      seatsByCabin: { business: 20, premium_economy: 21, economy: 208 },
    });
    const result = evaluateAircraftAssignment(
      widebody,
      sector({ destinationIata: "JFK", destination: JFK, flightNumber: "SO500" }),
      context(),
    );
    expect(codes(result)).not.toContain("AIRCRAFT_RANGE_INSUFFICIENT");
  });

  // --- Capacity, which is Scenario F ---------------------------------------

  it("blocks when total seats sold exceed the airframe", () => {
    const result = evaluateAircraftAssignment(
      narrowBody({ seatCapacity: 126, seatsByCabin: { business: 12, economy: 114 } }),
      sector({ soldByCabin: { business: 10, economy: 130 } }),
      context(),
    );
    const finding = result.findings.find((f) => f.code === "AIRCRAFT_CAPACITY_BELOW_SOLD");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.title).toContain("14");
  });

  it("blocks a cabin shortfall even when the total would fit", () => {
    // 140 sold against 148 seats overall, but business is oversold 20 into 16.
    const result = evaluateAircraftAssignment(
      narrowBody(),
      sector({ soldByCabin: { business: 20, economy: 120 } }),
      context(),
    );
    expect(codes(result)).toContain("AIRCRAFT_CABIN_CAPACITY_BELOW_SOLD");
    expect(codes(result)).not.toContain("AIRCRAFT_CAPACITY_BELOW_SOLD");
    expect(isBlocking(result.findings)).toBe(true);
  });

  // --- Maintenance limits --------------------------------------------------

  it("warns when a check is approaching", () => {
    const result = evaluateAircraftAssignment(
      narrowBody({
        maintenance: {
          nextCheckType: "a_check",
          nextCheckDueAt: "2026-09-05T00:00:00.000Z",
          nextCheckDueHours: null,
          nextCheckDueCycles: null,
          totalHours: 30_000,
          totalCycles: 12_000,
        },
      }),
      sector(),
      context(),
    );
    const finding = result.findings.find((f) => f.code === "MAINTENANCE_LIMIT_APPROACHING");
    expect(finding?.severity).toBe("warning");
    expect(isBlocking(result.findings)).toBe(false);
  });

  it("blocks when a check is already overdue", () => {
    const result = evaluateAircraftAssignment(
      narrowBody({
        maintenance: {
          nextCheckType: "c_check",
          nextCheckDueAt: "2026-08-01T00:00:00.000Z",
          nextCheckDueHours: null,
          nextCheckDueCycles: null,
          totalHours: 30_000,
          totalCycles: 12_000,
        },
      }),
      sector(),
      context(),
    );
    expect(codes(result)).toContain("MAINTENANCE_LIMIT_EXCEEDED");
    expect(isBlocking(result.findings)).toBe(true);
  });

  it("catches an hours limit even when the calendar is comfortable", () => {
    const result = evaluateAircraftAssignment(
      narrowBody({
        totalHours: 30_990,
        maintenance: {
          nextCheckType: "a_check",
          nextCheckDueAt: "2027-06-01T00:00:00.000Z",
          nextCheckDueHours: 31_000,
          nextCheckDueCycles: 99_000,
          totalHours: 30_990,
          totalCycles: 12_000,
        },
      }),
      sector(),
      context(),
    );
    const finding = result.findings.find((f) => f.code === "MAINTENANCE_LIMIT_APPROACHING");
    expect(finding?.detail).toContain("flight hours");
  });

  it("reports several problems at once rather than stopping at the first", () => {
    const result = evaluateAircraftAssignment(
      narrowBody({ serviceability: "maintenance", rangeNm: 400 }),
      sector({ destinationIata: "JFK", destination: JFK, soldByCabin: { economy: 500 } }),
      context(),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "AIRCRAFT_UNAVAILABLE",
        "AIRCRAFT_RANGE_INSUFFICIENT",
        "AIRCRAFT_CAPACITY_BELOW_SOLD",
      ]),
    );
  });
});

describe("withdrawing an aircraft", () => {
  it("says nothing when the airframe flies nothing", () => {
    const result = evaluateWithdrawAircraft(
      { id: "11111111-1111-5111-8111-111111111111", registration: "YU-APE" },
      "maintenance",
      [],
    );
    expect(result.findings).toHaveLength(0);
  });

  it("warns with the flights that lose their aircraft", () => {
    const result = evaluateWithdrawAircraft(
      { id: "11111111-1111-5111-8111-111111111111", registration: "YU-APE" },
      "maintenance",
      [
        {
          flightId: "a1111111-1111-5111-8111-111111111111",
          flightNumber: "SO200",
          originIata: "BEG",
          destinationIata: "VIE",
          departure: "2026-08-30T08:00:00.000Z",
          arrival: "2026-08-30T09:05:00.000Z",
        },
        {
          flightId: "a2222222-2222-5222-8222-222222222222",
          flightNumber: "SO201",
          originIata: "VIE",
          destinationIata: "BEG",
          departure: "2026-08-30T10:00:00.000Z",
          arrival: "2026-08-30T11:05:00.000Z",
        },
      ],
    );

    const finding = result.findings[0];
    expect(finding?.severity).toBe("warning");
    expect(finding?.detail).toContain("SO200");
    expect(finding?.detail).toContain("SO201");
    expect(finding?.related).toHaveLength(2);
    expect(result.consequences.map((c) => c.kind)).toContain("aircraft_released");
  });
});

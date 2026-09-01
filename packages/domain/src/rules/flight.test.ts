import { describe, expect, it } from "vitest";
import { isBlocking, warningCodes, type RuleCode } from "@airsoko/contracts";
import { DEFAULT_POLICY } from "../policy.ts";
import {
  evaluateChangeGate,
  evaluateDeleteFlight,
  evaluateFlightSchedule,
  evaluateRecordDelay,
  evaluateReleaseAircraft,
  evaluateStatusChange,
  type FlightEndpointFacts,
  type FlightFacts,
  type FlightScheduleContext,
  type FlightScheduleDraft,
} from "./flight.ts";

const NOW = "2026-08-30T06:00:00.000Z";
const FLIGHT_ID = "22222222-2222-5222-8222-222222222222";
const SCHEDULE_ID = "33333333-3333-5333-8333-333333333333";
const AIRCRAFT_ID = "11111111-1111-5111-8111-111111111111";

const BEG: FlightEndpointFacts = {
  iataCode: "BEG",
  name: "Belgrade Nikola Tesla",
  timeZone: "Europe/Belgrade",
  latitude: 44.8184,
  longitude: 20.3091,
  isHub: true,
};

const VIE: FlightEndpointFacts = {
  iataCode: "VIE",
  name: "Vienna International",
  timeZone: "Europe/Vienna",
  latitude: 48.1103,
  longitude: 16.5697,
  isHub: false,
};

const JFK: FlightEndpointFacts = {
  iataCode: "JFK",
  name: "New York John F. Kennedy",
  timeZone: "America/New_York",
  latitude: 40.6413,
  longitude: -73.7781,
  isHub: false,
};

function codes(findings: { code: RuleCode }[]): RuleCode[] {
  return findings.map((finding) => finding.code);
}

function draft(overrides: Partial<FlightScheduleDraft> = {}): FlightScheduleDraft {
  return {
    flightId: null,
    flightNumber: "SO412",
    serviceDate: "2026-09-02",
    origin: BEG,
    destination: VIE,
    scheduledDeparture: "2026-09-02T05:45:00.000Z",
    scheduledArrival: "2026-09-02T06:50:00.000Z",
    ...overrides,
  };
}

function scheduleContext(
  overrides: Partial<FlightScheduleContext> = {},
): FlightScheduleContext {
  return {
    now: NOW,
    policy: DEFAULT_POLICY,
    numberClashes: [],
    series: null,
    current: null,
    ...overrides,
  };
}

function flight(overrides: Partial<FlightFacts> = {}): FlightFacts {
  return {
    id: FLIGHT_ID,
    flightNumber: "SO412",
    serviceDate: "2026-09-02",
    status: "scheduled",
    scheduledDeparture: "2026-09-02T05:45:00.000Z",
    estimatedDeparture: null,
    actualDeparture: null,
    scheduledArrival: "2026-09-02T06:50:00.000Z",
    estimatedArrival: null,
    actualArrival: null,
    aircraftId: AIRCRAFT_ID,
    aircraftRegistration: "YU-APE",
    scheduleId: null,
    ...overrides,
  };
}

describe("evaluateFlightSchedule", () => {
  it("accepts an ordinary sector without complaint", () => {
    const evaluation = evaluateFlightSchedule(draft(), scheduleContext());
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.consequences.map((item) => item.kind)).toContain("flight_created");
  });

  it("refuses a sector that arrives before it departs", () => {
    const evaluation = evaluateFlightSchedule(
      draft({ scheduledArrival: "2026-09-02T05:30:00.000Z" }),
      scheduleContext(),
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(codes(evaluation.findings)).toContain("SCHEDULE_INVALID_TIME_ORDER");
  });

  it("refuses an airport paired with itself", () => {
    const evaluation = evaluateFlightSchedule(draft({ destination: BEG }), scheduleContext());
    expect(codes(evaluation.findings)).toContain("SCHEDULE_SAME_ORIGIN_AND_DESTINATION");
    expect(isBlocking(evaluation.findings)).toBe(true);
  });

  it("refuses a block time no aeroplane could fly", () => {
    // BEG-JFK is roughly 3,900 nm. Ninety minutes is not a mistake to warn about.
    const evaluation = evaluateFlightSchedule(
      draft({
        destination: JFK,
        scheduledArrival: "2026-09-02T07:15:00.000Z",
      }),
      scheduleContext(),
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
    const finding = evaluation.findings.find(
      (item) => item.code === "SCHEDULE_DURATION_IMPLAUSIBLE",
    );
    // Precise, quantified, specific -- the phase gate's wording.
    expect(finding?.detail).toMatch(/nm/);
    expect(finding?.detail).toMatch(/kt cruise/);
  });

  it("warns rather than blocks on a merely generous block time", () => {
    const evaluation = evaluateFlightSchedule(
      draft({ scheduledArrival: "2026-09-02T09:45:00.000Z" }),
      scheduleContext(),
    );
    expect(isBlocking(evaluation.findings)).toBe(false);
    expect(warningCodes(evaluation.findings)).toContain("SCHEDULE_DURATION_IMPLAUSIBLE");
  });

  it("refuses a flight number already flying on that date", () => {
    const evaluation = evaluateFlightSchedule(
      draft(),
      scheduleContext({
        numberClashes: [
          {
            flightId: "44444444-4444-5444-8444-444444444444",
            flightNumber: "SO412",
            serviceDate: "2026-09-02",
          },
        ],
      }),
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(codes(evaluation.findings)).toContain("FLIGHT_NUMBER_IN_USE_ON_DATE");
  });

  it("does not treat the flight being edited as its own clash", () => {
    const evaluation = evaluateFlightSchedule(
      draft({ flightId: FLIGHT_ID }),
      scheduleContext({
        numberClashes: [
          { flightId: FLIGHT_ID, flightNumber: "SO412", serviceDate: "2026-09-02" },
        ],
        current: flight(),
      }),
    );
    expect(codes(evaluation.findings)).not.toContain("FLIGHT_NUMBER_IN_USE_ON_DATE");
  });

  it("refuses to retime a flight that has already gone", () => {
    const evaluation = evaluateFlightSchedule(
      draft({ flightId: FLIGHT_ID }),
      scheduleContext({ current: flight({ status: "airborne" }) }),
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(codes(evaluation.findings)).toContain("FLIGHT_ALREADY_DEPARTED");
  });

  it("warns when an occurrence falls outside its own season", () => {
    const evaluation = evaluateFlightSchedule(
      draft({
        flightId: FLIGHT_ID,
        serviceDate: "2026-12-02",
        scheduledDeparture: "2026-12-02T05:45:00.000Z",
        scheduledArrival: "2026-12-02T06:50:00.000Z",
      }),
      scheduleContext({
        series: {
          id: SCHEDULE_ID,
          flightNumber: "SO412",
          validFrom: "2026-03-29",
          validTo: "2026-10-24",
          operatingDays: [true, true, true, true, true, true, true],
        },
        current: flight(),
      }),
    );
    expect(isBlocking(evaluation.findings)).toBe(false);
    expect(warningCodes(evaluation.findings)).toContain("SCHEDULE_OUTSIDE_VALIDITY_WINDOW");
  });

  it("warns about a movement inside an outstation's quiet hours, and not at the hub", () => {
    // 01:30 local at Vienna, which is not a hub in this fixture.
    const nightArrival = evaluateFlightSchedule(
      draft({
        serviceDate: "2026-09-02",
        scheduledDeparture: "2026-09-02T21:30:00.000Z",
        scheduledArrival: "2026-09-02T23:30:00.000Z",
      }),
      scheduleContext(),
    );
    expect(warningCodes(nightArrival.findings)).toContain("SCHEDULE_AIRPORT_RESTRICTION");

    // The same clock time at the hub raises nothing: hubs run their own night.
    const fromHub = evaluateFlightSchedule(
      draft({
        origin: { ...VIE, isHub: true },
        destination: { ...BEG, isHub: true },
        scheduledDeparture: "2026-09-02T21:30:00.000Z",
        scheduledArrival: "2026-09-02T23:30:00.000Z",
      }),
      scheduleContext(),
    );
    expect(warningCodes(fromHub.findings)).not.toContain("SCHEDULE_AIRPORT_RESTRICTION");
  });
});

describe("evaluateStatusChange", () => {
  it("refuses a transition the lifecycle does not offer, and says what it does", () => {
    const evaluation = evaluateStatusChange(flight({ status: "scheduled" }), "airborne", {
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(isBlocking(evaluation.findings)).toBe(true);
    const finding = evaluation.findings[0];
    expect(finding?.code).toBe("FLIGHT_STATUS_TRANSITION_INVALID");
    expect(finding?.detail).toMatch(/check-in open/);
  });

  it("refuses a change to the state the flight is already in", () => {
    const evaluation = evaluateStatusChange(flight({ status: "boarding" }), "boarding", {
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(isBlocking(evaluation.findings)).toBe(true);
  });

  it("refuses pushback with no aircraft, and only warns before that", () => {
    const unassigned = flight({ aircraftId: null, aircraftRegistration: null });

    const pushback = evaluateStatusChange(
      { ...unassigned, status: "gate_closed" },
      "taxi_out",
      {
        now: NOW,
        policy: DEFAULT_POLICY,
      },
    );
    expect(isBlocking(pushback.findings)).toBe(true);
    expect(codes(pushback.findings)).toContain("FLIGHT_NO_AIRCRAFT_ASSIGNED");

    const boarding = evaluateStatusChange(
      { ...unassigned, status: "check_in_open" },
      "boarding",
      { now: NOW, policy: DEFAULT_POLICY },
    );
    expect(isBlocking(boarding.findings)).toBe(false);
    expect(warningCodes(boarding.findings)).toContain("FLIGHT_NO_AIRCRAFT_ASSIGNED");
  });

  it("reports the map appearing and disappearing", () => {
    const onto = evaluateStatusChange(flight({ status: "scheduled" }), "check_in_open", {
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(onto.consequences.map((item) => item.kind)).toContain("map_visibility_changed");

    const off = evaluateStatusChange(flight({ status: "taxi_in" }), "arrived", {
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(
      off.consequences.find((item) => item.kind === "map_visibility_changed")?.summary,
    ).toMatch(/leaves live operations/);
  });

  it("leaves an arrived flight with nowhere to go", () => {
    const evaluation = evaluateStatusChange(flight({ status: "arrived" }), "airborne", {
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(evaluation.findings[0]?.detail).toMatch(/its day is over/);
  });
});

describe("evaluateRecordDelay", () => {
  it("stays quiet on a small delay", () => {
    const evaluation = evaluateRecordDelay(
      flight(),
      { delayMinutes: 20, arrivalDelayMinutes: 12, reason: "ground_handling" },
      { now: NOW, policy: DEFAULT_POLICY, nextSector: null },
    );
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.consequences.map((item) => item.kind)).toContain("delay_recorded");
  });

  it("warns once a delay becomes significant", () => {
    const evaluation = evaluateRecordDelay(
      flight(),
      { delayMinutes: 75, arrivalDelayMinutes: 45, reason: "technical" },
      { now: NOW, policy: DEFAULT_POLICY, nextSector: null },
    );
    expect(warningCodes(evaluation.findings)).toContain("FLIGHT_DELAY_SIGNIFICANT");
  });

  it("names the next sector when the delay eats its turnaround", () => {
    const evaluation = evaluateRecordDelay(
      flight(),
      { delayMinutes: 60, arrivalDelayMinutes: 45, reason: "rotation" },
      {
        now: NOW,
        policy: DEFAULT_POLICY,
        nextSector: {
          flightId: "55555555-5555-5555-8555-555555555555",
          flightNumber: "SO413",
          originIata: "VIE",
          // 07:45Z, and the arrival slides from 06:50 to 07:35 -- ten minutes.
          departure: "2026-09-02T07:45:00.000Z",
          minimumTurnaroundMinutes: 35,
        },
      },
    );
    const finding = evaluation.findings.find(
      (item) => item.code === "AIRCRAFT_INSUFFICIENT_TURNAROUND",
    );
    expect(finding?.title).toMatch(/SO413/);
    expect(finding?.related.map((ref) => ref.label)).toContain("SO413");
  });

  it("refuses a delay on a flight whose day is over", () => {
    const evaluation = evaluateRecordDelay(
      flight({ status: "arrived" }),
      { delayMinutes: 30, arrivalDelayMinutes: 30, reason: "weather" },
      { now: NOW, policy: DEFAULT_POLICY, nextSector: null },
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
  });
});

describe("evaluateChangeGate", () => {
  it("reports the change as a consequence", () => {
    const evaluation = evaluateChangeGate(flight(), { departureGate: "A12" }, BEG);
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.consequences[0]?.summary).toMatch(/A12/);
  });

  it("warns when the aircraft has already left the gate", () => {
    const evaluation = evaluateChangeGate(
      flight({ status: "airborne" }),
      { departureGate: "A12" },
      BEG,
    );
    expect(warningCodes(evaluation.findings)).toContain("FLIGHT_ALREADY_DEPARTED");
  });

  it("refuses on a cancelled flight", () => {
    const evaluation = evaluateChangeGate(
      flight({ status: "cancelled" }),
      { departureGate: "A12" },
      BEG,
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
  });
});

describe("evaluateReleaseAircraft", () => {
  it("warns, states the time remaining, and promises an alert", () => {
    const evaluation = evaluateReleaseAircraft(flight(), { now: NOW });
    expect(isBlocking(evaluation.findings)).toBe(false);
    expect(warningCodes(evaluation.findings)).toContain("FLIGHT_NO_AIRCRAFT_ASSIGNED");
    expect(evaluation.consequences.map((item) => item.kind)).toContain("alerts_raised");
  });

  it("refuses to take the airframe off a flight already flying it", () => {
    const evaluation = evaluateReleaseAircraft(flight({ status: "airborne" }), { now: NOW });
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(evaluation.findings[0]?.detail).toMatch(/somewhere it is not/);
  });

  it("refuses when there is nothing to release", () => {
    const evaluation = evaluateReleaseAircraft(
      flight({ aircraftId: null, aircraftRegistration: null }),
      { now: NOW },
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
  });
});

describe("evaluateDeleteFlight", () => {
  it("permits removing a sector nobody has bought a seat on", () => {
    const evaluation = evaluateDeleteFlight(flight(), {
      now: NOW,
      bookingCount: 0,
      series: null,
    });
    expect(isBlocking(evaluation.findings)).toBe(false);
    expect(evaluation.consequences.map((item) => item.kind)).toContain("flight_deleted");
  });

  it("refuses once the flight has operated", () => {
    const evaluation = evaluateDeleteFlight(flight({ status: "arrived" }), {
      now: NOW,
      bookingCount: 0,
      series: null,
    });
    expect(isBlocking(evaluation.findings)).toBe(true);
  });

  it("refuses while passengers are ticketed, and points at cancellation instead", () => {
    const evaluation = evaluateDeleteFlight(flight(), {
      now: NOW,
      bookingCount: 42,
      series: null,
    });
    expect(codes(evaluation.findings)).toContain("FLIGHT_HAS_BOOKINGS");
    expect(evaluation.findings[0]?.detail).toMatch(/Cancel it/);
  });

  it("warns that a pattern will file the date again", () => {
    const evaluation = evaluateDeleteFlight(flight({ scheduleId: SCHEDULE_ID }), {
      now: NOW,
      bookingCount: 0,
      series: {
        id: SCHEDULE_ID,
        flightNumber: "SO412",
        validFrom: "2026-03-29",
        validTo: "2026-10-24",
        operatingDays: [true, true, true, true, true, true, true],
      },
    });
    expect(warningCodes(evaluation.findings)).toContain("FLIGHT_BELONGS_TO_SERIES");
    expect(evaluation.findings[0]?.detail).toMatch(/regenerating the series/);
  });
});

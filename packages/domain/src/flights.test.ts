import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "./policy.ts";
import {
  allowedNextStatuses,
  arrivalDelayMinutes,
  blockMinutes,
  departureDelayMinutes,
  effectiveArrival,
  effectiveDeparture,
  expectedTimeline,
  flightProgress,
  hasDeparted,
  isDelayed,
  isTerminal,
  shiftEstimates,
  type FlightTimes,
} from "./flights.ts";

const ON_TIME: FlightTimes = {
  scheduledDeparture: "2026-08-30T08:00:00.000Z",
  estimatedDeparture: null,
  actualDeparture: null,
  scheduledArrival: "2026-08-30T09:05:00.000Z",
  estimatedArrival: null,
  actualArrival: null,
};

describe("effective times", () => {
  it("prefers what happened, then what is expected, then what was promised", () => {
    expect(effectiveDeparture(ON_TIME)).toBe("2026-08-30T08:00:00.000Z");

    const estimated = { ...ON_TIME, estimatedDeparture: "2026-08-30T08:25:00.000Z" };
    expect(effectiveDeparture(estimated)).toBe("2026-08-30T08:25:00.000Z");

    // Once it has actually gone, the estimate is history too.
    const actual = { ...estimated, actualDeparture: "2026-08-30T08:31:00.000Z" };
    expect(effectiveDeparture(actual)).toBe("2026-08-30T08:31:00.000Z");
    expect(effectiveArrival({ ...ON_TIME, actualArrival: "2026-08-30T09:20:00.000Z" })).toBe(
      "2026-08-30T09:20:00.000Z",
    );
  });
});

describe("delay", () => {
  it("is measured at the departure and can be negative", () => {
    expect(departureDelayMinutes(ON_TIME)).toBe(0);
    expect(
      departureDelayMinutes({ ...ON_TIME, estimatedDeparture: "2026-08-30T08:40:00.000Z" }),
    ).toBe(40);
    expect(
      departureDelayMinutes({ ...ON_TIME, actualDeparture: "2026-08-30T07:52:00.000Z" }),
    ).toBe(-8);
  });

  it("tracks the arrival separately, because time is made up in the air", () => {
    const late = {
      ...ON_TIME,
      estimatedDeparture: "2026-08-30T08:40:00.000Z",
      estimatedArrival: "2026-08-30T09:30:00.000Z",
    };
    expect(departureDelayMinutes(late)).toBe(40);
    expect(arrivalDelayMinutes(late)).toBe(25);
  });

  it("only counts as delayed past the policy threshold", () => {
    expect(isDelayed(14, DEFAULT_POLICY)).toBe(false);
    expect(isDelayed(15, DEFAULT_POLICY)).toBe(true);
  });

  it("is a condition, not a status -- a flight can be boarding and late", () => {
    // The point of decision 4: nothing here reads or writes a status field.
    const boardingAndLate = { ...ON_TIME, estimatedDeparture: "2026-08-30T08:45:00.000Z" };
    expect(isDelayed(departureDelayMinutes(boardingAndLate), DEFAULT_POLICY)).toBe(true);
  });
});

describe("shiftEstimates", () => {
  it("carries the delay onto the new schedule", () => {
    const late = {
      ...ON_TIME,
      estimatedDeparture: "2026-08-30T08:56:00.000Z",
      estimatedArrival: "2026-08-30T09:39:00.000Z",
    };
    const moved = shiftEstimates(late, "2026-08-30T10:00:00.000Z", "2026-08-30T11:05:00.000Z");
    // 56 minutes late off, 34 on -- unchanged, against the new times.
    expect(moved.estimatedDeparture).toBe("2026-08-30T10:56:00.000Z");
    expect(moved.estimatedArrival).toBe("2026-08-30T11:39:00.000Z");
  });

  it("never leaves an estimate ahead of the schedule it belongs to", () => {
    const late = { ...ON_TIME, estimatedDeparture: "2026-08-30T08:56:00.000Z" };
    const moved = shiftEstimates(late, "2026-08-30T10:00:00.000Z", "2026-08-30T11:05:00.000Z");
    expect(moved.estimatedDeparture! > "2026-08-30T10:00:00.000Z").toBe(true);
  });

  it("keeps a flight with no estimate free of one", () => {
    const moved = shiftEstimates(
      ON_TIME,
      "2026-08-30T10:00:00.000Z",
      "2026-08-30T11:05:00.000Z",
    );
    expect(moved).toEqual({ estimatedDeparture: null, estimatedArrival: null });
  });
});

describe("progress", () => {
  it("is zero before pushback and one after arrival", () => {
    expect(flightProgress(ON_TIME, "2026-08-30T07:00:00.000Z")).toBe(0);
    expect(flightProgress(ON_TIME, "2026-08-30T10:00:00.000Z")).toBe(1);
  });

  it("measures against the expected times, not the promised ones", () => {
    const late = {
      ...ON_TIME,
      actualDeparture: "2026-08-30T09:00:00.000Z",
      estimatedArrival: "2026-08-30T10:05:00.000Z",
    };
    // Half an hour after an hour-late departure is half way, not past the end.
    expect(flightProgress(late, "2026-08-30T09:32:30.000Z")).toBeCloseTo(0.5, 5);
  });

  it("never reports past the destination", () => {
    const overrunning = { ...ON_TIME, actualDeparture: "2026-08-30T08:00:00.000Z" };
    expect(flightProgress(overrunning, "2026-08-31T00:00:00.000Z")).toBe(1);
  });
});

describe("block time", () => {
  it("is the scheduled gate-to-gate figure", () => {
    expect(blockMinutes(ON_TIME)).toBe(65);
  });
});

describe("status lifecycle", () => {
  it("moves forward one step at a time", () => {
    expect(allowedNextStatuses("scheduled")).toContain("check_in_open");
    expect(allowedNextStatuses("gate_closed")).toContain("taxi_out");
    expect(allowedNextStatuses("airborne")).toContain("taxi_in");
  });

  it("allows a correction backwards only while the aircraft is on stand", () => {
    expect(allowedNextStatuses("boarding")).toContain("check_in_open");
    // Once it has pushed back, the chain is one way: a return to stand is a
    // different operation, not "boarding again".
    expect(allowedNextStatuses("airborne")).not.toContain("taxi_out");
    expect(allowedNextStatuses("taxi_out")).not.toContain("gate_closed");
  });

  it("permits cancellation only before pushback", () => {
    expect(allowedNextStatuses("scheduled")).toContain("cancelled");
    expect(allowedNextStatuses("gate_closed")).toContain("cancelled");
    expect(allowedNextStatuses("taxi_out")).not.toContain("cancelled");
    expect(allowedNextStatuses("airborne")).not.toContain("cancelled");
  });

  it("offers diversion only from the air", () => {
    expect(allowedNextStatuses("airborne")).toContain("diverted");
    expect(allowedNextStatuses("boarding")).not.toContain("diverted");
    expect(allowedNextStatuses("diverted")).toEqual(["taxi_in", "arrived"]);
  });

  it("leaves nothing reachable from a terminal state", () => {
    expect(allowedNextStatuses("arrived")).toEqual([]);
    expect(allowedNextStatuses("cancelled")).toEqual([]);
    expect(isTerminal("arrived")).toBe(true);
    expect(isTerminal("diverted")).toBe(false);
  });

  it("treats everything from pushback onwards as departed", () => {
    expect(hasDeparted("gate_closed")).toBe(false);
    expect(hasDeparted("taxi_out")).toBe(true);
    expect(hasDeparted("diverted")).toBe(true);
  });
});

describe("expected timeline", () => {
  const steps = expectedTimeline(ON_TIME, DEFAULT_POLICY);

  it("covers the events the brief names, in time order", () => {
    expect(steps.map((step) => step.eventType)).toEqual([
      "check_in_open",
      "crew_report",
      "aircraft_at_gate",
      "boarding_started",
      "gate_closed",
      "pushback",
      "airborne",
      "landed",
      "on_blocks",
    ]);
  });

  it("takes the crew report time from the duty policy, not a constant", () => {
    const report = steps.find((step) => step.eventType === "crew_report");
    // 60 minutes before an 08:00Z departure.
    expect(report?.scheduledAt).toBe("2026-08-30T07:00:00.000Z");
  });

  it("puts pushback at the scheduled departure and on-blocks at the arrival", () => {
    expect(steps.find((step) => step.eventType === "pushback")?.scheduledAt).toBe(
      ON_TIME.scheduledDeparture,
    );
    expect(steps.find((step) => step.eventType === "on_blocks")?.scheduledAt).toBe(
      ON_TIME.scheduledArrival,
    );
  });
});

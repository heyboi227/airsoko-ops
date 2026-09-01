import { describe, expect, it } from "vitest";
import { isBlocking, warningCodes, type OverridableField } from "@airsoko/contracts";
import { DEFAULT_POLICY } from "../policy.ts";
import { formatLocalTime } from "../time.ts";
import type { FlightEndpointFacts } from "./flight.ts";
import {
  evaluateScheduleDefinition,
  evaluateSeriesEdit,
  expandSchedule,
  planSeriesEdit,
  type OccurrenceFacts,
  type ScheduleDefinitionContext,
  type SchedulePattern,
  type SchedulePatternDraft,
  type ScheduleOccurrence,
} from "./schedule.ts";

const NOW = "2026-08-30T06:00:00.000Z";
const SCHEDULE_ID = "33333333-3333-5333-8333-333333333333";
const OTHER_SCHEDULE_ID = "44444444-4444-5444-8444-444444444444";

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

const WEEKDAYS = [false, true, true, true, true, true, false];
const NEVER = [false, false, false, false, false, false, false];
const DAILY = [true, true, true, true, true, true, true];

function pattern(overrides: Partial<SchedulePattern> = {}): SchedulePattern {
  return {
    flightNumber: "SO412",
    validFrom: "2026-09-01",
    validTo: "2026-09-30",
    operatingDays: WEEKDAYS,
    departureLocalTime: "07:45",
    arrivalLocalTime: "08:50",
    arrivalDayOffset: 0,
    ...overrides,
  };
}

const ZONES = { originTimeZone: BEG.timeZone, destinationTimeZone: VIE.timeZone };

describe("expandSchedule", () => {
  it("produces one occurrence per operating day inside the window", () => {
    // September 2026: 30 days, 22 of them weekdays.
    const occurrences = expandSchedule(pattern(), ZONES);
    expect(occurrences).toHaveLength(22);
    expect(occurrences[0]?.serviceDate).toBe("2026-09-01");
    expect(occurrences.at(-1)?.serviceDate).toBe("2026-09-30");
  });

  it("reads the operating day at the origin, not in UTC", () => {
    // 01:00 Belgrade on a Sunday is 23:00Z the previous Saturday. A pattern
    // that says Sundays means the Sunday the passengers experience.
    const sundaysOnly = [true, false, false, false, false, false, false];
    const occurrences = expandSchedule(
      pattern({
        operatingDays: sundaysOnly,
        departureLocalTime: "01:00",
        arrivalLocalTime: "02:05",
        validFrom: "2026-09-01",
        validTo: "2026-09-14",
      }),
      ZONES,
    );

    expect(occurrences.map((occurrence) => occurrence.serviceDate)).toEqual([
      "2026-09-06",
      "2026-09-13",
    ]);
    for (const occurrence of occurrences) {
      expect(formatLocalTime(occurrence.scheduledDeparture, BEG.timeZone)).toBe("01:00");
    }
  });

  it("holds the published local time across a DST change", () => {
    // Europe moves its clocks back on 25 October 2026. The wall clock does not
    // budge; the instant behind it does.
    const across = expandSchedule(
      pattern({ validFrom: "2026-10-23", validTo: "2026-10-27", operatingDays: DAILY }),
      ZONES,
    );

    for (const occurrence of across) {
      expect(formatLocalTime(occurrence.scheduledDeparture, BEG.timeZone)).toBe("07:45");
    }
    // Same wall clock, an hour apart in UTC either side of the change.
    expect(across[0]?.scheduledDeparture.slice(11, 16)).toBe("05:45");
    expect(across.at(-1)?.scheduledDeparture.slice(11, 16)).toBe("06:45");
  });

  it("carries an overnight sector onto the next local day", () => {
    const overnight = expandSchedule(
      pattern({
        departureLocalTime: "23:30",
        arrivalLocalTime: "00:40",
        arrivalDayOffset: 1,
        validFrom: "2026-09-07",
        validTo: "2026-09-07",
      }),
      ZONES,
    );

    const first = overnight[0];
    expect(first?.serviceDate).toBe("2026-09-07");
    expect(first && first.scheduledArrival > first.scheduledDeparture).toBe(true);
  });

  it("clamps to the requested window without leaving the pattern's validity", () => {
    const narrowed = expandSchedule(pattern(), {
      ...ZONES,
      from: "2026-09-10",
      to: "2026-09-14",
    });
    expect(narrowed.map((occurrence) => occurrence.serviceDate)).toEqual([
      "2026-09-10",
      "2026-09-11",
      "2026-09-14",
    ]);

    // A window entirely outside the season yields nothing rather than throwing.
    expect(
      expandSchedule(pattern(), { ...ZONES, from: "2027-01-01", to: "2027-02-01" }),
    ).toEqual([]);
  });
});

// --- Pattern validity ------------------------------------------------------

function draft(overrides: Partial<SchedulePatternDraft> = {}): SchedulePatternDraft {
  return {
    ...pattern(),
    scheduleId: null,
    origin: BEG,
    destination: VIE,
    ...overrides,
  };
}

function definitionContext(
  patternDraft: SchedulePatternDraft,
  overrides: Partial<ScheduleDefinitionContext> = {},
): ScheduleDefinitionContext {
  return {
    now: NOW,
    policy: DEFAULT_POLICY,
    clashes: [],
    occurrences: expandSchedule(patternDraft, ZONES),
    occurrenceClashes: [],
    ...overrides,
  };
}

describe("evaluateScheduleDefinition", () => {
  it("accepts an ordinary weekday pattern and counts what it will produce", () => {
    const patternDraft = draft();
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft),
    );
    expect(evaluation.findings).toEqual([]);
    const consequence = evaluation.consequences.find(
      (item) => item.kind === "occurrences_affected",
    );
    expect(consequence?.count).toBe(22);
    expect(consequence?.summary).toMatch(/Mon-Fri/);
  });

  it("refuses a season that ends before it starts", () => {
    const patternDraft = draft({ validFrom: "2026-09-30", validTo: "2026-09-01" });
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft),
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(evaluation.findings.map((f) => f.code)).toContain("SCHEDULE_VALIDITY_INVERTED");
  });

  it("refuses a pattern with no operating days", () => {
    const patternDraft = draft({ operatingDays: NEVER });
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft),
    );
    expect(evaluation.findings.map((f) => f.code)).toContain("SCHEDULE_NO_OPERATING_DAYS");
  });

  it("refuses a flight number another pattern flies on the same days", () => {
    const patternDraft = draft();
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft, {
        clashes: [
          {
            scheduleId: OTHER_SCHEDULE_ID,
            flightNumber: "SO412",
            validFrom: "2026-09-15",
            validTo: "2026-10-15",
            operatingDays: DAILY,
            active: true,
          },
        ],
      }),
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(evaluation.findings.map((f) => f.code)).toContain("SCHEDULE_FLIGHT_NUMBER_IN_USE");
  });

  it("only warns when the two patterns never share a date", () => {
    const patternDraft = draft();
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft, {
        clashes: [
          {
            scheduleId: OTHER_SCHEDULE_ID,
            flightNumber: "SO412",
            validFrom: "2026-09-01",
            validTo: "2026-09-30",
            // Weekends only: the windows overlap, the dates never do.
            operatingDays: [true, false, false, false, false, false, true],
            active: true,
          },
        ],
      }),
    );
    expect(isBlocking(evaluation.findings)).toBe(false);
    expect(warningCodes(evaluation.findings)).toContain("SCHEDULE_FLIGHT_NUMBER_IN_USE");
  });

  it("ignores an inactive pattern holding the same number", () => {
    const patternDraft = draft();
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft, {
        clashes: [
          {
            scheduleId: OTHER_SCHEDULE_ID,
            flightNumber: "SO412",
            validFrom: "2026-09-01",
            validTo: "2026-09-30",
            operatingDays: DAILY,
            active: false,
          },
        ],
      }),
    );
    expect(evaluation.findings.map((f) => f.code)).not.toContain(
      "SCHEDULE_FLIGHT_NUMBER_IN_USE",
    );
  });

  it("says so when a window and its days never intersect", () => {
    // A Saturday-only pattern valid Monday to Friday flies nothing.
    const patternDraft = draft({
      validFrom: "2026-09-07",
      validTo: "2026-09-11",
      operatingDays: [false, false, false, false, false, false, true],
    });
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft),
    );
    expect(warningCodes(evaluation.findings)).toContain("SCHEDULE_EDIT_AFFECTS_NOTHING");
  });

  it("refuses a block time no aeroplane could fly", () => {
    const patternDraft = draft({ arrivalLocalTime: "07:50" });
    const evaluation = evaluateScheduleDefinition(
      patternDraft,
      definitionContext(patternDraft),
    );
    expect(isBlocking(evaluation.findings)).toBe(true);
    expect(evaluation.findings.map((f) => f.code)).toContain("SCHEDULE_DURATION_IMPLAUSIBLE");
  });
});

// --- Scenario C ------------------------------------------------------------

function occurrence(
  serviceDate: string,
  overrides: Partial<OccurrenceFacts> = {},
): OccurrenceFacts {
  return {
    flightId: `00000000-0000-5000-8000-${serviceDate.replace(/-/g, "").padEnd(12, "0")}`,
    flightNumber: "SO412",
    serviceDate,
    status: "scheduled",
    scheduledDeparture: `${serviceDate}T05:45:00.000Z`,
    estimatedDeparture: null,
    actualDeparture: null,
    scheduledArrival: `${serviceDate}T06:50:00.000Z`,
    estimatedArrival: null,
    actualArrival: null,
    aircraftId: null,
    aircraftRegistration: null,
    overriddenFields: [],
    ...overrides,
  };
}

function generatedFor(dates: readonly string[]): ScheduleOccurrence[] {
  return dates.map((serviceDate) => ({
    serviceDate,
    scheduledDeparture: `${serviceDate}T05:45:00.000Z`,
    scheduledArrival: `${serviceDate}T06:50:00.000Z`,
    departureResolution: "exact" as const,
    arrivalResolution: "exact" as const,
  }));
}

const RETIMING: OverridableField[] = ["scheduledDeparture", "scheduledArrival"];
const WEEKS = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"];

describe("planSeriesEdit", () => {
  it("reaches every remaining occurrence when the whole series is edited", () => {
    const plan = planSeriesEdit(
      WEEKS.map((date) => occurrence(date)),
      generatedFor(WEEKS),
      {
        now: NOW,
        changedFields: RETIMING,
        overwriteExceptions: false,
        fromDate: null,
        createMissing: true,
      },
    );

    expect(plan.update.map((item) => item.serviceDate)).toEqual(WEEKS);
    expect(plan.preserved).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("leaves an occurrence that was edited by hand exactly as it is", () => {
    const occurrences = [
      occurrence(WEEKS[0] as string),
      occurrence(WEEKS[1] as string, { overriddenFields: ["scheduledDeparture"] }),
      occurrence(WEEKS[2] as string),
      occurrence(WEEKS[3] as string),
    ];

    const plan = planSeriesEdit(occurrences, generatedFor(WEEKS), {
      now: NOW,
      changedFields: RETIMING,
      overwriteExceptions: false,
      fromDate: null,
      createMissing: true,
    });

    expect(plan.preserved.map((item) => item.serviceDate)).toEqual([WEEKS[1]]);
    expect(plan.update.map((item) => item.serviceDate)).toEqual([WEEKS[0], WEEKS[2], WEEKS[3]]);
  });

  it("reads which fields diverged, not merely that something did", () => {
    // A gate exception must not freeze the flight against a retiming.
    const occurrences = [
      occurrence(WEEKS[0] as string, { overriddenFields: ["departureGate"] }),
      occurrence(WEEKS[1] as string),
    ];

    const plan = planSeriesEdit(occurrences, generatedFor(WEEKS.slice(0, 2)), {
      now: NOW,
      changedFields: RETIMING,
      overwriteExceptions: false,
      fromDate: null,
      createMissing: true,
    });

    expect(plan.preserved).toEqual([]);
    expect(plan.update).toHaveLength(2);
  });

  it("takes the exception back when overwriting is asked for", () => {
    const occurrences = [
      occurrence(WEEKS[0] as string, { overriddenFields: ["scheduledDeparture"] }),
      occurrence(WEEKS[1] as string),
    ];

    const plan = planSeriesEdit(occurrences, generatedFor(WEEKS.slice(0, 2)), {
      now: NOW,
      changedFields: RETIMING,
      overwriteExceptions: true,
      fromDate: null,
      createMissing: true,
    });

    expect(plan.preserved).toEqual([]);
    expect(plan.update).toHaveLength(2);
  });

  it("changes this and future occurrences only, when that is the scope", () => {
    const plan = planSeriesEdit(
      WEEKS.map((date) => occurrence(date)),
      generatedFor(WEEKS),
      {
        now: NOW,
        changedFields: RETIMING,
        overwriteExceptions: false,
        fromDate: WEEKS[1] as string,
        createMissing: true,
      },
    );

    expect(plan.outOfScope.map((item) => item.serviceDate)).toEqual([WEEKS[0]]);
    expect(plan.update.map((item) => item.serviceDate)).toEqual(WEEKS.slice(1));
  });

  it("never rewrites an occurrence that has already operated", () => {
    const occurrences = [
      occurrence(WEEKS[0] as string, { status: "arrived" }),
      occurrence(WEEKS[1] as string, { status: "airborne" }),
      occurrence(WEEKS[2] as string, { status: "cancelled" }),
      occurrence(WEEKS[3] as string),
    ];

    const plan = planSeriesEdit(occurrences, generatedFor(WEEKS), {
      now: NOW,
      changedFields: RETIMING,
      overwriteExceptions: true,
      fromDate: null,
      createMissing: true,
    });

    expect(plan.historical.map((item) => item.serviceDate)).toEqual(WEEKS.slice(0, 3));
    expect(plan.update.map((item) => item.serviceDate)).toEqual([WEEKS[3]]);
  });

  it("removes dates the new pattern no longer produces, and files the ones it does", () => {
    const plan = planSeriesEdit(
      WEEKS.map((date) => occurrence(date)),
      // The pattern moved from Mondays to Tuesdays.
      generatedFor(["2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"]),
      {
        now: NOW,
        changedFields: RETIMING,
        overwriteExceptions: false,
        fromDate: null,
        createMissing: true,
      },
    );

    expect(plan.remove.map((item) => item.serviceDate)).toEqual(WEEKS);
    expect(plan.create.map((item) => item.serviceDate)).toEqual([
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
      "2026-09-29",
    ]);
  });
});

describe("evaluateSeriesEdit", () => {
  const series = { id: SCHEDULE_ID, flightNumber: "SO412" };

  it("names the exceptions it is leaving alone", () => {
    const plan = planSeriesEdit(
      [
        occurrence(WEEKS[0] as string),
        occurrence(WEEKS[1] as string, { overriddenFields: ["scheduledDeparture"] }),
      ],
      generatedFor(WEEKS.slice(0, 2)),
      {
        now: NOW,
        changedFields: RETIMING,
        overwriteExceptions: false,
        fromDate: null,
        createMissing: true,
      },
    );

    const evaluation = evaluateSeriesEdit({ series, plan, overwriteExceptions: false });
    const finding = evaluation.findings.find(
      (item) => item.code === "FLIGHT_OCCURRENCE_DIVERGED",
    );
    expect(finding?.severity).toBe("warning");
    expect(finding?.title).toMatch(/keep their own values/);
    expect(finding?.detail).toMatch(WEEKS[1] as string);
  });

  it("says plainly when it is about to discard them instead", () => {
    const plan = planSeriesEdit(
      [occurrence(WEEKS[0] as string, { overriddenFields: ["scheduledDeparture"] })],
      generatedFor([WEEKS[0] as string]),
      {
        now: NOW,
        changedFields: RETIMING,
        overwriteExceptions: true,
        fromDate: null,
        createMissing: true,
      },
    );
    // With overwrite on, the occurrence is updated rather than preserved, so
    // the warning comes from the caller's own flag rather than the plan.
    expect(plan.update).toHaveLength(1);

    const evaluation = evaluateSeriesEdit({
      series,
      plan: { ...plan, preserved: [occurrence(WEEKS[0] as string)] },
      overwriteExceptions: true,
    });
    expect(
      evaluation.findings.find((item) => item.code === "FLIGHT_OCCURRENCE_DIVERGED")?.title,
    ).toMatch(/will be overwritten/);
  });

  it("warns when a change would strip aircraft off occurrences it removes", () => {
    const plan = planSeriesEdit(
      [occurrence(WEEKS[0] as string, { aircraftId: "a", aircraftRegistration: "YU-APE" })],
      generatedFor(["2026-09-08"]),
      {
        now: NOW,
        changedFields: RETIMING,
        overwriteExceptions: false,
        fromDate: null,
        createMissing: true,
      },
    );

    const evaluation = evaluateSeriesEdit({ series, plan, overwriteExceptions: false });
    const finding = evaluation.findings.find(
      (item) => item.code === "FLIGHT_BELONGS_TO_SERIES",
    );
    expect(finding?.detail).toMatch(/YU-APE/);
  });

  it("warns rather than staying silent when an edit reaches nothing", () => {
    const plan = planSeriesEdit([], [], {
      now: NOW,
      changedFields: RETIMING,
      overwriteExceptions: false,
      fromDate: null,
      createMissing: true,
    });
    const evaluation = evaluateSeriesEdit({ series, plan, overwriteExceptions: false });
    expect(warningCodes(evaluation.findings)).toContain("SCHEDULE_EDIT_AFFECTS_NOTHING");
  });

  it("counts the occurrences left alone, so the operator can see the whole series", () => {
    const plan = planSeriesEdit(
      WEEKS.map((date) => occurrence(date)),
      generatedFor(WEEKS),
      {
        now: NOW,
        changedFields: RETIMING,
        overwriteExceptions: false,
        fromDate: WEEKS[2] as string,
        createMissing: true,
      },
    );

    const evaluation = evaluateSeriesEdit({ series, plan, overwriteExceptions: false });
    const summaries = evaluation.consequences.map((item) => item.summary);
    expect(
      summaries.some((text) => /2 scheduled occurrences follow the new pattern/.test(text)),
    ).toBe(true);
    expect(
      summaries.some((text) => /2 earlier occurrences are outside this edit/.test(text)),
    ).toBe(true);
  });
});

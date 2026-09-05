import type {
  FlightStatus,
  Id,
  Instant,
  LocalDate,
  LocalTime,
  OverridableField,
} from "@airsoko/contracts";
import { formatOperatingDays } from "@airsoko/contracts";
import { EvaluationBuilder, blocking, consequence, resourceRef, warning } from "../intent.ts";
import type { Evaluation } from "../intent.ts";
import { distanceNm } from "../geo.ts";
import { grouped } from "../format.ts";
import { impliedCruiseKts } from "../network.ts";
import {
  addLocalDays,
  formatLocalTime,
  localDateRange,
  minutesBetween,
  weekdayInZone,
  zonedTimeToInstant,
  type ZoneResolution,
} from "../time.ts";
import { hasDeparted, isTerminal } from "../flights.ts";
import type { OperationalPolicy } from "../policy.ts";
import type { FlightEndpointFacts } from "./flight.ts";

/**
 * Recurring schedules, and the arithmetic that turns one into many flights.
 *
 * The pattern stores airport-local wall-clock times and nothing else. A 07:45
 * Belgrade departure is 05:45Z in winter and 04:45Z in summer, and every
 * occurrence resolves its own instant against the origin's zone on its own
 * date -- which is the only way a published timetable survives a DST change
 * without silently moving by an hour.
 *
 * `expandSchedule` is deliberately pure and separate from the evaluators. It
 * is used three times over: to preview what a new pattern would produce, to
 * generate the flights, and to work out what a series edit would reach. Three
 * copies of that loop would be three chances for the preview to disagree with
 * the write.
 */

// --- Expansion -------------------------------------------------------------

export interface SchedulePattern {
  flightNumber: string;
  validFrom: LocalDate;
  validTo: LocalDate;
  /** Sunday-first, seven entries, matching `Date.prototype.getUTCDay`. */
  operatingDays: readonly boolean[];
  departureLocalTime: LocalTime;
  arrivalLocalTime: LocalTime;
  /** 1 when the flight lands on the next local day. */
  arrivalDayOffset: number;
}

export interface ExpansionContext {
  originTimeZone: string;
  destinationTimeZone: string;
  /** Narrow the expansion to a window. Clamped to the pattern's validity either way. */
  from?: LocalDate;
  to?: LocalDate;
}

export interface ScheduleOccurrence {
  /** The origin's local calendar date this operation belongs to. */
  serviceDate: LocalDate;
  scheduledDeparture: Instant;
  scheduledArrival: Instant;
  /**
   * What the zone conversion had to do with the requested wall-clock time.
   * Reported rather than swallowed: an occurrence shifted out of a DST gap is
   * a real thing for a scheduler to know about.
   */
  departureResolution: ZoneResolution;
  arrivalResolution: ZoneResolution;
}

/**
 * Every dated occurrence a pattern produces, in departure order.
 *
 * The operating day is read at the origin, not in UTC. A Sunday 01:00
 * departure from Belgrade is 23:00Z on Saturday, and a pattern that says
 * "Sundays" means the Sunday the passengers experience.
 */
export function expandSchedule(
  pattern: SchedulePattern,
  context: ExpansionContext,
): ScheduleOccurrence[] {
  const from =
    context.from && context.from > pattern.validFrom ? context.from : pattern.validFrom;
  const to = context.to && context.to < pattern.validTo ? context.to : pattern.validTo;
  if (to < from) return [];

  const occurrences: ScheduleOccurrence[] = [];

  for (const date of localDateRange(from, to)) {
    const departure = zonedTimeToInstant(
      date,
      pattern.departureLocalTime,
      context.originTimeZone,
    );
    if (!pattern.operatingDays[weekdayInZone(departure.instant, context.originTimeZone)]) {
      continue;
    }

    const arrival = zonedTimeToInstant(
      addLocalDays(date, pattern.arrivalDayOffset),
      pattern.arrivalLocalTime,
      context.destinationTimeZone,
    );

    occurrences.push({
      serviceDate: date,
      scheduledDeparture: departure.instant,
      scheduledArrival: arrival.instant,
      departureResolution: departure.resolution,
      arrivalResolution: arrival.resolution,
    });
  }

  return occurrences;
}

/** Block minutes the pattern implies, taken from its first occurrence. */
export function patternBlockMinutes(occurrences: readonly ScheduleOccurrence[]): number {
  const first = occurrences[0];
  if (!first) return 0;
  return Math.round(minutesBetween(first.scheduledDeparture, first.scheduledArrival));
}

// --- Is the pattern coherent? ---------------------------------------------

export interface SchedulePatternDraft extends SchedulePattern {
  /** Null when the pattern is being created. */
  scheduleId: Id | null;
  origin: FlightEndpointFacts;
  destination: FlightEndpointFacts;
}

/** Another pattern already carrying this flight number. */
export interface PatternClash {
  scheduleId: Id;
  flightNumber: string;
  validFrom: LocalDate;
  validTo: LocalDate;
  operatingDays: readonly boolean[];
  active: boolean;
}

export interface ScheduleDefinitionContext {
  now: Instant;
  policy: OperationalPolicy;
  clashes: readonly PatternClash[];
  /** What the pattern would produce. Passed in so the preview and the write agree. */
  occurrences: readonly ScheduleOccurrence[];
  /**
   * Dates among those occurrences where a flight already carries this number.
   *
   * A flight number and a service date identify one operation -- the database
   * says so with a unique index -- so filing the pattern would fail on exactly
   * these dates. Better to name them than to let a constraint violation reach
   * the operator as a five hundred.
   *
   * Empty when nothing is being generated: a collision with a flight that will
   * never be filed is not a conflict.
   */
  occurrenceClashes: readonly { flightId: Id; serviceDate: LocalDate }[];
}

const IMPOSSIBLE_CRUISE_KTS = 700;
const IMPLAUSIBLY_SHORT_BLOCK_MINUTES = 25;

export function evaluateScheduleDefinition(
  draft: SchedulePatternDraft,
  context: ScheduleDefinitionContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = draft.scheduleId
    ? resourceRef("schedule", draft.scheduleId, draft.flightNumber)
    : undefined;
  const extras = subject ? { subject } : {};

  // --- The window ----------------------------------------------------------
  if (draft.validTo < draft.validFrom) {
    builder.add(
      blocking(
        "SCHEDULE_VALIDITY_INVERTED",
        `The season ends before it starts`,
        `${draft.flightNumber} would be valid from ${draft.validFrom} to ${draft.validTo}. Swap the two dates.`,
        extras,
      ),
    );
  }

  if (!draft.operatingDays.some(Boolean)) {
    builder.add(
      blocking(
        "SCHEDULE_NO_OPERATING_DAYS",
        `No operating days selected`,
        `${draft.flightNumber} would never fly. Choose at least one day of the week.`,
        extras,
      ),
    );
  }

  // --- The sector ----------------------------------------------------------
  if (draft.origin.iataCode === draft.destination.iataCode) {
    builder.add(
      blocking(
        "SCHEDULE_SAME_ORIGIN_AND_DESTINATION",
        `${draft.origin.iataCode} to itself`,
        `A pattern needs two different airports.`,
        extras,
      ),
    );
  }

  const block = patternBlockMinutes(context.occurrences);
  const distance = Math.round(distanceNm(draft.origin, draft.destination));

  if (context.occurrences.length > 0 && block <= 0) {
    builder.add(
      blocking(
        "SCHEDULE_INVALID_TIME_ORDER",
        `Arrives before it departs`,
        `${draft.departureLocalTime} local at ${draft.origin.iataCode} to ${draft.arrivalLocalTime} local at ${draft.destination.iataCode}${draft.arrivalDayOffset ? " the next day" : ""} works out at ${block} minutes. Set the next-day flag if this is an overnight sector.`,
        extras,
      ),
    );
  } else if (
    context.occurrences.length > 0 &&
    draft.origin.iataCode !== draft.destination.iataCode
  ) {
    const impliedKts = impliedCruiseKts(distance, block);

    if (block < IMPLAUSIBLY_SHORT_BLOCK_MINUTES || impliedKts > IMPOSSIBLE_CRUISE_KTS) {
      builder.add(
        blocking(
          "SCHEDULE_DURATION_IMPLAUSIBLE",
          `${block} minutes cannot cover ${grouped(distance)} nm`,
          `${draft.origin.iataCode}-${draft.destination.iataCode} is ${grouped(distance)} nm, which a ${block}-minute block would fly at ${Number.isFinite(impliedKts) ? grouped(impliedKts) : "an infinite"} kt. Check the arrival time and the next-day flag.`,
          extras,
        ),
      );
    }
  }

  // --- Is the number already someone else's? ------------------------------
  for (const clash of context.clashes) {
    if (clash.scheduleId === draft.scheduleId || !clash.active) continue;

    const windowsOverlap = clash.validFrom <= draft.validTo && draft.validFrom <= clash.validTo;
    if (!windowsOverlap) continue;

    const sharedDays = draft.operatingDays
      .map((day, index) => day && clash.operatingDays[index])
      .some(Boolean);

    if (sharedDays) {
      builder.add(
        blocking(
          "SCHEDULE_FLIGHT_NUMBER_IN_USE",
          `${draft.flightNumber} already operates on those days`,
          `Another pattern flies ${clash.flightNumber} ${formatOperatingDays(clash.operatingDays)} from ${clash.validFrom} to ${clash.validTo}. Two patterns cannot generate the same flight number on the same date.`,
          {
            ...extras,
            related: [resourceRef("schedule", clash.scheduleId, clash.flightNumber)],
          },
        ),
      );
    } else {
      builder.add(
        warning(
          "SCHEDULE_FLIGHT_NUMBER_IN_USE",
          `${draft.flightNumber} is shared with another pattern`,
          `${clash.flightNumber} also runs ${clash.validFrom} to ${clash.validTo}, on different days (${formatOperatingDays(clash.operatingDays)}). The dates never collide, but two patterns under one number is worth intending.`,
          {
            ...extras,
            related: [resourceRef("schedule", clash.scheduleId, clash.flightNumber)],
          },
        ),
      );
    }
  }

  // --- Would the dated flights collide? -----------------------------------
  if (context.occurrenceClashes.length > 0) {
    const dates = context.occurrenceClashes.map((clash) => clash.serviceDate);
    builder.add(
      blocking(
        "FLIGHT_NUMBER_IN_USE_ON_DATE",
        `${draft.flightNumber} already operates on ${dates.length} of these dates`,
        `A flight already carries ${draft.flightNumber} on ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? ` and ${dates.length - 5} more` : ""}. A flight number and a service date identify one operation, so those occurrences cannot be filed. Renumber the pattern, narrow its season, or remove the flights that hold the number.`,
        {
          ...extras,
          related: context.occurrenceClashes
            .slice(0, 10)
            .map((clash) =>
              resourceRef(
                "flight",
                clash.flightId,
                `${draft.flightNumber} ${clash.serviceDate}`,
              ),
            ),
        },
      ),
    );
  }

  // --- Does it produce anything? ------------------------------------------
  if (context.occurrences.length === 0) {
    builder.add(
      warning(
        "SCHEDULE_EDIT_AFFECTS_NOTHING",
        `This pattern generates no flights`,
        `${draft.flightNumber} operates ${formatOperatingDays(draft.operatingDays)} between ${draft.validFrom} and ${draft.validTo}, and no date in that window falls on one of those days. The pattern would be filed with nothing to fly.`,
        extras,
      ),
    );
  }

  // --- DST edges the scheduler should know about --------------------------
  const shifted = context.occurrences.filter(
    (occurrence) => occurrence.departureResolution === "gap_shifted_forward",
  );
  if (shifted.length > 0) {
    builder.add(
      warning(
        "SCHEDULE_INVALID_TIME_ORDER",
        `${shifted.length} occurrence${shifted.length === 1 ? "" : "s"} fall in a clock change`,
        `${draft.departureLocalTime} does not exist at ${draft.origin.iataCode} on ${shifted
          .slice(0, 3)
          .map((occurrence) => occurrence.serviceDate)
          .join(
            ", ",
          )}${shifted.length > 3 ? ` and ${shifted.length - 3} more` : ""} -- the clocks go forward through it. Those departures are filed at the first valid time after the gap.`,
        extras,
      ),
    );
  }

  // --- Night restrictions --------------------------------------------------
  const sample = context.occurrences[0];
  if (sample) {
    builder
      .add(
        curfewFinding(
          draft.origin,
          sample.scheduledDeparture,
          "departs",
          draft.flightNumber,
          context.policy,
          subject,
        ),
      )
      .add(
        curfewFinding(
          draft.destination,
          sample.scheduledArrival,
          "arrives at",
          draft.flightNumber,
          context.policy,
          subject,
        ),
      );
  }

  if (context.occurrences.length > 0) {
    builder.expect(
      consequence(
        "occurrences_affected",
        `${context.occurrences.length} dated flight${context.occurrences.length === 1 ? "" : "s"} between ${context.occurrences[0]?.serviceDate} and ${context.occurrences.at(-1)?.serviceDate}, ${formatOperatingDays(draft.operatingDays)}`,
        { count: context.occurrences.length },
      ),
    );
  }

  return builder.build();
}

function curfewFinding(
  airport: FlightEndpointFacts,
  at: Instant,
  verb: string,
  flightNumber: string,
  policy: OperationalPolicy,
  subject: ReturnType<typeof resourceRef> | undefined,
) {
  if (airport.isHub && !policy.curfew.appliesToHubs) return null;

  const local = formatLocalTime(at, airport.timeZone);
  const { quietFromLocalTime: from, quietToLocalTime: to } = policy.curfew;
  const inside = from > to ? local >= from || local < to : local >= from && local < to;
  if (!inside) return null;

  return warning(
    "SCHEDULE_AIRPORT_RESTRICTION",
    `${flightNumber} ${verb} ${airport.iataCode} at ${local} local`,
    `${airport.name} is treated as quiet between ${from} and ${to} local. ${policy.disclaimer}`,
    subject ? { subject } : {},
  );
}

// --- Editing a series ------------------------------------------------------

export interface OccurrenceFacts {
  flightId: Id;
  flightNumber: string;
  serviceDate: LocalDate;
  status: FlightStatus;
  /**
   * All six times, not just the departure. A series edit that moves the
   * timetable has to move any delay recorded against the old one with it, and
   * `shiftEstimates` needs the whole set to do that.
   */
  scheduledDeparture: Instant;
  estimatedDeparture: Instant | null;
  actualDeparture: Instant | null;
  scheduledArrival: Instant;
  estimatedArrival: Instant | null;
  actualArrival: Instant | null;
  aircraftId: Id | null;
  aircraftRegistration: string | null;
  /** Fields this occurrence carries independently of its pattern. */
  overriddenFields: readonly OverridableField[];
}

export interface SeriesEditPlan {
  /** Occurrences the edit rewrites. */
  update: OccurrenceFacts[];
  /** Left alone: edited by hand, and overwriting was not asked for. */
  preserved: OccurrenceFacts[];
  /** Left alone: already operated, or cancelled. History is not rewritten. */
  historical: OccurrenceFacts[];
  /** Left alone: earlier than the date the edit starts from. */
  outOfScope: OccurrenceFacts[];
  /** No longer produced by the pattern, and never operated. */
  remove: OccurrenceFacts[];
  /** Dates the new pattern produces that have no flight on file. */
  create: ScheduleOccurrence[];
}

export interface SeriesEditOptions {
  now: Instant;
  /** Which overridable fields this edit would write. */
  changedFields: readonly OverridableField[];
  overwriteExceptions: boolean;
  /** "This and future" starts here. Null means the whole series. */
  fromDate: LocalDate | null;
  /**
   * Whether dates the pattern produces but no flight covers should be filed.
   *
   * Off for an edit, on for a deliberate "generate occurrences". A season runs
   * for months while the board holds a few days of it, so a retiming that also
   * materialised every unfilled date would answer a question nobody asked --
   * with two hundred new flights.
   */
  createMissing: boolean;
}

/**
 * Work out what a change to a pattern reaches, before anything is written.
 *
 * This is Scenario C's mechanism in one function, and the ordering of the
 * buckets is the rule:
 *
 *  1. Anything outside the chosen scope is not touched at all.
 *  2. Anything that has already operated is history, and history is not
 *     rewritten by a plan change.
 *  3. Anything edited by hand on a field this change would write is an
 *     exception. Somebody meant it, so it survives unless overwriting is
 *     explicitly asked for.
 *  4. What is left follows the pattern.
 *
 * Note the third rule reads *which* fields diverged. A series retiming still
 * reaches an occurrence whose gate was moved by hand -- a gate exception and a
 * time exception are different exceptions, and treating any divergence as
 * total would freeze a flight the first time anyone touched it.
 */
export function planSeriesEdit(
  occurrences: readonly OccurrenceFacts[],
  generated: readonly ScheduleOccurrence[],
  options: SeriesEditOptions,
): SeriesEditPlan {
  const plan: SeriesEditPlan = {
    update: [],
    preserved: [],
    historical: [],
    outOfScope: [],
    remove: [],
    create: [],
  };

  const generatedByDate = new Map(
    generated.map((occurrence) => [occurrence.serviceDate, occurrence]),
  );
  const changed = new Set(options.changedFields);

  for (const occurrence of occurrences) {
    if (options.fromDate && occurrence.serviceDate < options.fromDate) {
      plan.outOfScope.push(occurrence);
      continue;
    }

    if (hasDeparted(occurrence.status) || isTerminal(occurrence.status)) {
      plan.historical.push(occurrence);
      continue;
    }

    if (!generatedByDate.has(occurrence.serviceDate)) {
      plan.remove.push(occurrence);
      continue;
    }

    const diverged = occurrence.overriddenFields.some((field) => changed.has(field));
    if (diverged && !options.overwriteExceptions) {
      plan.preserved.push(occurrence);
      continue;
    }

    plan.update.push(occurrence);
  }

  if (options.createMissing) {
    const onFile = new Set(occurrences.map((occurrence) => occurrence.serviceDate));
    for (const occurrence of generated) {
      if (onFile.has(occurrence.serviceDate)) continue;
      if (options.fromDate && occurrence.serviceDate < options.fromDate) continue;
      plan.create.push(occurrence);
    }
  }

  return plan;
}

export interface SeriesEditContext {
  series: { id: Id; flightNumber: string };
  plan: SeriesEditPlan;
  overwriteExceptions: boolean;
}

/** Turn a plan into the findings and consequences an operator confirms against. */
export function evaluateSeriesEdit(context: SeriesEditContext): Evaluation {
  const builder = new EvaluationBuilder();
  const { plan, series } = context;
  const subject = resourceRef("schedule", series.id, series.flightNumber);

  const touches =
    plan.update.length + plan.remove.length + plan.create.length + plan.preserved.length;

  if (touches === 0) {
    builder.add(
      warning(
        "SCHEDULE_EDIT_AFFECTS_NOTHING",
        `No occurrences would change`,
        plan.historical.length > 0
          ? `Every remaining occurrence of ${series.flightNumber} has already operated. The pattern will change; nothing on the board will.`
          : `${series.flightNumber} has no occurrences on file in the scope of this edit.`,
        { subject },
      ),
    );
  }

  if (plan.preserved.length > 0) {
    builder.add(
      warning(
        "FLIGHT_OCCURRENCE_DIVERGED",
        context.overwriteExceptions
          ? `${plan.preserved.length} hand-edited occurrence${plan.preserved.length === 1 ? "" : "s"} will be overwritten`
          : `${plan.preserved.length} hand-edited occurrence${plan.preserved.length === 1 ? "" : "s"} keep their own values`,
        `${plan.preserved
          .slice(0, 5)
          .map((occurrence) => occurrence.serviceDate)
          .join(
            ", ",
          )}${plan.preserved.length > 5 ? ` and ${plan.preserved.length - 5} more` : ""} ${
          context.overwriteExceptions
            ? "were changed individually, and this edit discards those changes."
            : "were changed individually and are left exactly as they are. Re-run with overwrite if the pattern should win."
        }`,
        {
          subject,
          related: plan.preserved
            .slice(0, 10)
            .map((occurrence) =>
              resourceRef("flight", occurrence.flightId, occurrence.flightNumber),
            ),
        },
      ),
    );
  }

  const assignedRemovals = plan.remove.filter((occurrence) => occurrence.aircraftId);
  if (assignedRemovals.length > 0) {
    builder.add(
      warning(
        "FLIGHT_BELONGS_TO_SERIES",
        `${assignedRemovals.length} occurrence${assignedRemovals.length === 1 ? "" : "s"} with an aircraft would be removed`,
        `${assignedRemovals
          .slice(0, 5)
          .map((occurrence) => `${occurrence.serviceDate} (${occurrence.aircraftRegistration})`)
          .join(
            ", ",
          )} no longer fall on an operating day. Removing them frees those airframes and leaves gaps in their rotations.`,
        {
          subject,
          related: assignedRemovals
            .slice(0, 10)
            .map((occurrence) =>
              resourceRef("flight", occurrence.flightId, occurrence.flightNumber),
            ),
        },
      ),
    );
  }

  if (plan.update.length > 0) {
    builder.expect(
      consequence(
        "occurrences_affected",
        `${plan.update.length} scheduled occurrence${plan.update.length === 1 ? "" : "s"} follow the new pattern`,
        { count: plan.update.length },
      ),
    );
  }
  if (plan.create.length > 0) {
    builder.expect(
      consequence(
        "flight_created",
        `${plan.create.length} new dated flight${plan.create.length === 1 ? "" : "s"} are filed`,
        { count: plan.create.length },
      ),
    );
  }
  if (plan.remove.length > 0) {
    builder.expect(
      consequence(
        "flight_deleted",
        `${plan.remove.length} occurrence${plan.remove.length === 1 ? "" : "s"} no longer produced by the pattern are removed`,
        { count: plan.remove.length },
      ),
    );
  }
  if (plan.historical.length > 0) {
    builder.expect(
      consequence(
        "occurrences_affected",
        `${plan.historical.length} occurrence${plan.historical.length === 1 ? "" : "s"} that have already operated are left as flown`,
        { count: plan.historical.length },
      ),
    );
  }
  if (plan.outOfScope.length > 0) {
    builder.expect(
      consequence(
        "occurrences_affected",
        `${plan.outOfScope.length} earlier occurrence${plan.outOfScope.length === 1 ? "" : "s"} are outside this edit and stay as they are`,
        { count: plan.outOfScope.length },
      ),
    );
  }

  return builder.build();
}

// --- Removing a pattern -----------------------------------------------------

/**
 * Deleting a recurring schedule.
 *
 * Permitted only while nothing it produced has operated. A pattern is part of
 * the record of the flights it generated -- the audit trail names it, and the
 * timetable a flown sector came from is a fact about that sector. Removing it
 * afterwards would leave the history pointing at nothing.
 *
 * Occurrences that have *not* operated go with it, in the same transaction.
 * Leaving them behind as ad-hoc flights would be worse than either outcome: a
 * board full of sectors whose timetable nobody can find.
 */
export function evaluateDeleteSchedule(
  series: { id: Id; flightNumber: string },
  occurrences: readonly OccurrenceFacts[],
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("schedule", series.id, series.flightNumber);

  const flown = occurrences.filter(
    (occurrence) => hasDeparted(occurrence.status) || isTerminal(occurrence.status),
  );

  if (flown.length > 0) {
    builder.add(
      blocking(
        "SCHEDULE_HAS_OCCURRENCES",
        `${flown.length} occurrence${flown.length === 1 ? " has" : "s have"} already operated`,
        `${series.flightNumber} produced flights on ${flown
          .slice(0, 5)
          .map((occurrence) => occurrence.serviceDate)
          .join(
            ", ",
          )}${flown.length > 5 ? ` and ${flown.length - 5} more` : ""}. Those sectors are part of the record, and the pattern is part of theirs. End the season instead, by moving its last valid date.`,
        { subject },
      ),
    );
    return builder.build();
  }

  if (occurrences.length > 0) {
    builder.add(
      warning(
        "SCHEDULE_HAS_OCCURRENCES",
        `${occurrences.length} dated flight${occurrences.length === 1 ? "" : "s"} go with it`,
        `${series.flightNumber} still has ${occurrences.length} occurrence${occurrences.length === 1 ? "" : "s"} on the board between ${occurrences[0]?.serviceDate} and ${occurrences.at(-1)?.serviceDate}. They are removed with the pattern rather than left behind as sectors with no timetable.`,
        {
          subject,
          related: occurrences
            .slice(0, 10)
            .map((occurrence) =>
              resourceRef("flight", occurrence.flightId, occurrence.flightNumber),
            ),
        },
      ),
    );

    builder.expect(
      consequence("flight_deleted", `${occurrences.length} scheduled flights are removed`, {
        count: occurrences.length,
      }),
    );

    const assigned = occurrences.filter((occurrence) => occurrence.aircraftId);
    if (assigned.length > 0) {
      builder.expect(
        consequence(
          "aircraft_released",
          `${assigned.length} airframe assignment${assigned.length === 1 ? "" : "s"} are freed`,
          { count: assigned.length },
        ),
      );
    }
  }

  builder.expect(
    consequence("occurrences_affected", `${series.flightNumber} stops being a service`, {
      count: 0,
    }),
  );

  return builder.build();
}

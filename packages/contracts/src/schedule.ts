import { z } from "zod";
import { flightTypeSchema } from "./enums.ts";
import {
  booleanFlagSchema,
  flightNumberSchema,
  iataAirportCodeSchema,
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
} from "./primitives.ts";

/**
 * Recurring schedules: the repeating service, not the flight.
 *
 * "SO412 flies BEG-VIE at 07:45 local, Monday to Friday, from March to
 * October" is one row here and one hundred and fifty rows in
 * `flight_instances`. Keeping them apart is what makes Scenario C expressible
 * at all -- an occurrence can be changed without the pattern moving, and the
 * pattern can be changed without erasing the occurrences that were changed by
 * hand.
 *
 * Times here are airport-local wall clock and nothing else. A 07:45 Belgrade
 * departure is 06:45Z in winter and 05:45Z in summer; storing the instant
 * would silently shift the published timetable by an hour twice a year.
 */

/** Sunday-first, seven entries. An array beats a bitmask for anything a person reads. */
export const operatingDaysSchema = z
  .array(z.boolean())
  .length(7, { message: "Operating days are seven flags, Sunday first" });
export type OperatingDays = z.infer<typeof operatingDaysSchema>;

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Mon-Fri", "Mon, Wed, Sat", "Daily" -- how a timetable prints a pattern. */
export function formatOperatingDays(days: readonly boolean[]): string {
  const on = days.map((day, index) => (day ? index : -1)).filter((index) => index >= 0);
  if (on.length === 0) return "Never";
  if (on.length === 7) return "Daily";

  // Collapse consecutive runs, treating the week as Monday-first for display
  // because that is how a timetable reads, even though the array is Sunday-
  // first to match `Date.prototype.getUTCDay`.
  const mondayFirst = [1, 2, 3, 4, 5, 6, 0].filter((index) => days[index]);
  const runs: number[][] = [];
  for (const index of mondayFirst) {
    const last = runs.at(-1);
    const previous = last?.at(-1);
    const contiguous =
      previous !== undefined && (previous === 6 ? index === 0 : index === previous + 1);
    if (last && contiguous) last.push(index);
    else runs.push([index]);
  }

  return runs
    .map((run) =>
      run.length >= 3
        ? `${WEEKDAY_LABELS[run[0] as number]}-${WEEKDAY_LABELS[run.at(-1) as number]}`
        : run.map((index) => WEEKDAY_LABELS[index]).join(", "),
    )
    .join(", ");
}

// --- Read shapes -----------------------------------------------------------

export const recurringScheduleSchema = z.object({
  id: idSchema,
  flightNumber: flightNumberSchema,
  routeId: idSchema,
  originIata: iataAirportCodeSchema,
  originName: z.string(),
  originTimeZone: z.string(),
  destinationIata: iataAirportCodeSchema,
  destinationName: z.string(),
  destinationTimeZone: z.string(),
  distanceNm: z.number().int(),

  validFrom: localDateSchema,
  validTo: localDateSchema,
  operatingDays: operatingDaysSchema,
  departureLocalTime: localTimeSchema,
  arrivalLocalTime: localTimeSchema,
  arrivalDayOffset: z.number().int(),
  /** Minutes gate to gate, derived from the two local times and their zones. */
  blockMinutes: z.number().int(),

  aircraftTypeId: idSchema,
  icaoTypeCode: z.string(),
  defaultAircraftId: idSchema.nullable(),
  defaultRegistration: z.string().nullable(),
  flightType: flightTypeSchema,
  season: z.string().nullable(),
  active: z.boolean(),

  /** Dated occurrences on file for this pattern, and how many diverge from it. */
  occurrenceCount: z.number().int(),
  exceptionCount: z.number().int(),
  nextOccurrenceAt: instantSchema.nullable(),

  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type RecurringSchedule = z.infer<typeof recurringScheduleSchema>;

// --- Write shapes ----------------------------------------------------------

export const createScheduleSchema = z.object({
  flightNumber: flightNumberSchema,
  routeId: idSchema,
  validFrom: localDateSchema,
  validTo: localDateSchema,
  operatingDays: operatingDaysSchema,
  departureLocalTime: localTimeSchema,
  arrivalLocalTime: localTimeSchema,
  arrivalDayOffset: z.number().int().min(0).max(1).default(0),
  aircraftTypeId: idSchema,
  defaultAircraftId: idSchema.nullish(),
  flightType: flightTypeSchema.default("scheduled_passenger"),
  season: z.string().trim().max(40).nullish(),
  /**
   * Materialise the dated occurrences as part of creating the pattern.
   *
   * A schedule with no flights is a plan nobody can operate, so this defaults
   * on -- but it stays a choice, because a pattern written months ahead of its
   * season is a legitimate thing to file without filling the board with it.
   */
  generateOccurrences: z.boolean().default(true),
});
export type CreateSchedule = z.input<typeof createScheduleSchema>;

export const updateScheduleSchema = z.object({
  validFrom: localDateSchema.optional(),
  validTo: localDateSchema.optional(),
  operatingDays: operatingDaysSchema.optional(),
  departureLocalTime: localTimeSchema.optional(),
  arrivalLocalTime: localTimeSchema.optional(),
  arrivalDayOffset: z.number().int().min(0).max(1).optional(),
  aircraftTypeId: idSchema.optional(),
  defaultAircraftId: idSchema.nullish(),
  flightType: flightTypeSchema.optional(),
  season: z.string().trim().max(40).nullish(),
  active: z.boolean().optional(),
  /**
   * Occurrences already flown are history and are never touched. This is about
   * the ones still ahead: whether the pattern's change reaches them.
   */
  applyToOccurrences: z.boolean().default(true),
  /**
   * Overwrite occurrences that were edited individually.
   *
   * Off by default, which is the whole of Scenario C: an exception exists
   * because somebody meant it, and a series edit must not silently undo that.
   */
  overwriteExceptions: z.boolean().default(false),
});
export type UpdateSchedule = z.input<typeof updateScheduleSchema>;

/** Fill a window with dated occurrences of an existing pattern. */
export const generateOccurrencesSchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
});
export type GenerateOccurrences = z.infer<typeof generateOccurrencesSchema>;

export const scheduleQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  routeId: idSchema.optional(),
  originIata: iataAirportCodeSchema.optional(),
  destinationIata: iataAirportCodeSchema.optional(),
  aircraftTypeId: idSchema.optional(),
  season: z.string().trim().max(40).optional(),
  /** Patterns whose validity window covers this date. */
  onDate: localDateSchema.optional(),
  includeInactive: booleanFlagSchema.default(false),
});
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;

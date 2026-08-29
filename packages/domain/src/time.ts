import type { Instant, LocalDate, LocalTime } from "@airsoko/contracts";

/**
 * Instants, airport-local time, and the conversion between them.
 *
 * The rule this module exists to enforce: an instant is an absolute point on
 * the timeline, and a local time is a rendering of it in some airport's IANA
 * zone. The two are never the same value and never share a variable. Every
 * "07:45" in this system belongs to a named zone or it is a bug.
 *
 * Conversions use the platform's own zone database through `Intl`, so DST
 * rules stay correct as ICU updates -- no hand-maintained offset table.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function epochMs(instant: Instant): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`Not a valid instant: ${instant}`);
  return ms;
}

export function toInstant(epoch: number): Instant {
  return new Date(epoch).toISOString();
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return toInstant(epochMs(instant) + minutes * MINUTE_MS);
}

export function minutesBetween(from: Instant, to: Instant): number {
  return (epochMs(to) - epochMs(from)) / MINUTE_MS;
}

export interface Interval {
  start: Instant;
  end: Instant;
}

/**
 * Half-open overlap: [start, end). Two flights where one ends exactly as the
 * next begins do not overlap -- that is a zero-turnaround problem, which is a
 * different rule with a different message, not a double-booking.
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return epochMs(a.start) < epochMs(b.end) && epochMs(b.start) < epochMs(a.end);
}

/** Gap in minutes between the end of `first` and the start of `second`. Negative if they overlap. */
export function gapMinutes(first: Interval, second: Interval): number {
  return (epochMs(second.start) - epochMs(first.end)) / MINUTE_MS;
}

// --- Zone conversion -------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, matching Date.prototype.getUTCDay. */
  weekday: number;
  /** Minutes east of UTC at this instant in this zone. */
  offsetMinutes: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Break an instant into the wall-clock parts an observer in `timeZone` would read. */
export function partsInZone(instant: Instant, timeZone: string): ZonedParts {
  const utcMs = epochMs(instant);
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));

  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Missing ${type} for zone ${timeZone}`);
    return found.value;
  };

  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  // Some ICU builds render midnight as hour 24 under hour12: false.
  const hour = Number(read("hour")) % 24;
  const minute = Number(read("minute"));
  const second = Number(read("second"));
  const weekday = WEEKDAY_INDEX[read("weekday")] ?? 0;

  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((asIfUtc - utcMs) / MINUTE_MS);

  return { year, month, day, hour, minute, second, weekday, offsetMinutes };
}

export function offsetMinutesInZone(instant: Instant, timeZone: string): number {
  return partsInZone(instant, timeZone).offsetMinutes;
}

/** Day of week (0 = Sunday) as observed at the airport, not in UTC. */
export function weekdayInZone(instant: Instant, timeZone: string): number {
  return partsInZone(instant, timeZone).weekday;
}

export type ZoneResolution = "exact" | "gap_shifted_forward" | "ambiguous_took_earlier";

export interface ZonedInstant {
  instant: Instant;
  /**
   * What happened to the requested wall-clock time:
   *  - `exact`: it exists once in this zone.
   *  - `gap_shifted_forward`: it never happened (spring forward); the result is
   *    the first valid instant after the gap.
   *  - `ambiguous_took_earlier`: it happened twice (autumn back); the result is
   *    the first of the two, which is the convention operational systems use so
   *    that a schedule never appears to run backwards.
   */
  resolution: ZoneResolution;
}

/**
 * Turn an airport-local date and time into an absolute instant.
 *
 * This is the function recurring schedules live or die on. A weekly 07:45
 * departure from Belgrade is 05:45Z in winter and 04:45Z in summer, and a
 * naive implementation silently shifts every generated flight by an hour twice
 * a year. The two-pass offset resolution below handles that, and the
 * `resolution` field reports the DST edge cases rather than hiding them.
 */
export function zonedTimeToInstant(
  date: LocalDate,
  time: LocalTime,
  timeZone: string,
): ZonedInstant {
  const [yearText, monthText, dayText] = date.split("-");
  const [hourText, minuteText] = time.split(":");

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);

  // Bracket any transition by sampling the offset a day either side. A DST
  // change is never more than a day away from the instant it affects, so these
  // two offsets are the only candidates -- and near a transition they differ,
  // which is what makes the gap and overlap cases detectable at all.
  const offsetBefore = offsetMinutesInZone(toInstant(naiveUtc - DAY_MS), timeZone);
  const offsetAfter = offsetMinutesInZone(toInstant(naiveUtc + DAY_MS), timeZone);

  const readsBack = (candidate: number): boolean => {
    const parts = partsInZone(toInstant(candidate), timeZone);
    return (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute
    );
  };

  const usingBefore = naiveUtc - offsetBefore * MINUTE_MS;
  const usingAfter = naiveUtc - offsetAfter * MINUTE_MS;

  const beforeValid = readsBack(usingBefore);
  const afterValid = readsBack(usingAfter);

  // Autumn: the wall clock reads this time twice. Both candidates are real
  // instants. We take the earlier so a generated schedule never appears to run
  // backwards, which is the convention operational systems use.
  if (beforeValid && afterValid && usingBefore !== usingAfter) {
    return {
      instant: toInstant(Math.min(usingBefore, usingAfter)),
      resolution: "ambiguous_took_earlier",
    };
  }

  if (beforeValid) return { instant: toInstant(usingBefore), resolution: "exact" };
  if (afterValid) return { instant: toInstant(usingAfter), resolution: "exact" };

  // Spring: the wall clock never reads this time. Shift forward by the size of
  // the gap -- a 02:30 departure on the day the clocks jump becomes 03:30
  // rather than vanishing from the schedule.
  return {
    instant: toInstant(Math.max(usingBefore, usingAfter)),
    resolution: "gap_shifted_forward",
  };
}

/** Render an instant as the airport would print it: "07:45". */
export function formatLocalTime(instant: Instant, timeZone: string): LocalTime {
  const { hour, minute } = partsInZone(instant, timeZone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Render an instant as the airport's calendar date: "2026-08-29". */
export function formatLocalDate(instant: Instant, timeZone: string): LocalDate {
  const { year, month, day } = partsInZone(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** UTC offset as operations staff write it: "+02:00", "-05:00", "+00:00". */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const total = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Add whole days to a calendar date without touching any zone. */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Inclusive list of calendar dates from `start` to `end`. */
export function localDateRange(start: LocalDate, end: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  let cursor = start;
  // Guard against an inverted range producing an unbounded loop.
  let guard = 0;
  while (cursor <= end && guard < 4000) {
    dates.push(cursor);
    cursor = addLocalDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

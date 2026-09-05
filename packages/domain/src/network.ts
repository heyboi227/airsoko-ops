/**
 * The arithmetic between a distance and a block time.
 *
 * Three places need it and had their own copy of the thirty minutes: the
 * flight rules, the schedule rules and the seed's route builder. It is one
 * allowance about how aeroplanes work, so it is stated once -- and a fourth
 * caller, the route rules, is what made keeping three copies untenable.
 *
 * Not in `policy.ts`, deliberately. The policy holds figures the airline
 * chooses and may override for a demonstration; taxi, climb and descent are
 * not an airline's decision.
 */

/** Taxi, climb and descent, excluded before an implied cruise speed is taken. */
export const GROUND_AND_MANOEUVRE_MINUTES = 30;

/**
 * The cruise speed a block time implies over a distance, in knots.
 *
 * `Infinity` when the block leaves no time to cruise at all, which is the
 * honest answer: no speed covers the distance, and every caller treats an
 * infinite implied speed as impossible rather than as missing data.
 */
export function impliedCruiseKts(distance: number, block: number): number {
  const cruiseMinutes = block - GROUND_AND_MANOEUVRE_MINUTES;
  return cruiseMinutes > 0 ? distance / (cruiseMinutes / 60) : Infinity;
}

/**
 * The grid a published timetable is written to, in minutes.
 *
 * Airlines publish departures and arrivals to the five minutes, so anything
 * that *proposes* a scheduled time -- a suggested block, a seeded slot -- lands
 * on it. An estimate or an actual does not: a delay is as long as it is.
 */
export const TIMETABLE_GRID_MINUTES = 5;

/** `minutes` moved to the nearest point on the timetable grid. */
export function roundToTimetableGrid(minutes: number): number {
  return Math.round(minutes / TIMETABLE_GRID_MINUTES) * TIMETABLE_GRID_MINUTES;
}

/**
 * A starting point for a route's block time: the cruise the distance needs at
 * this type's speed, plus the ground allowance, rounded to the five minutes a
 * timetable publishes -- so an arrival derived from it lands on the grid too.
 *
 * A suggestion and nothing more. What the airline publishes is its own
 * decision -- padded for a congested hub, tightened on a sector it knows --
 * which is why this returns a number for a form to offer rather than a value
 * any rule compares against.
 */
export function suggestedBlockMinutes(distance: number, cruiseSpeedKts: number): number {
  if (!(cruiseSpeedKts > 0)) return 0;
  return roundToTimetableGrid((distance / cruiseSpeedKts) * 60 + GROUND_AND_MANOEUVRE_MINUTES);
}

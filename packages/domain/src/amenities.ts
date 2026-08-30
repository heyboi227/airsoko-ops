import type { AmenityScope, CabinClass } from "@airsoko/contracts";

/**
 * What a passenger actually gets.
 *
 * Amenities attach at four levels and more than one usually applies at once, so
 * the question is never "is Wi-Fi assigned?" but "which assignment wins?". The
 * brief asks for predictable resolution; this is the whole of it, and it is a
 * pure function so the same answer can be shown in the fleet UI, quoted at
 * booking, and printed on a boarding pass without three implementations
 * drifting apart.
 *
 * Two rules, in order:
 *
 * 1. **The narrowest scope wins.** Flight beats fare product beats cabin beats
 *    aircraft. A broader level describes the norm; a narrower one describes
 *    this particular case, and the particular case is the truth.
 * 2. **At equal specificity, exclusion wins.** This is the deliberate half. Two
 *    assignments at the same level are a data problem, but it still has to
 *    resolve to something, and the two possible answers are not equally
 *    harmful: promising a passenger a seat with power that has none is worse
 *    than staying quiet about power that turns out to be there.
 *
 * Because `included` can be false, a narrower level can *remove* what a broader
 * one grants. That is the point: an aircraft with Wi-Fi that is unserviceable
 * today is a flight-level exclusion, not an edit to the airframe's record.
 */

/** Narrowest last -- the index in this array is the specificity. */
const SCOPE_PRECEDENCE: readonly AmenityScope[] = [
  "aircraft",
  "cabin",
  "fare_product",
  "flight",
];

export interface AmenityAssignment {
  id: string;
  amenityCode: string;
  scope: AmenityScope;
  included: boolean;
  note: string | null;

  /** Exactly one of these is set, matching `scope`. */
  aircraftId?: string | null | undefined;
  cabinClass?: CabinClass | null | undefined;
  fareProductId?: string | null | undefined;
  flightInstanceId?: string | null | undefined;
}

/**
 * The situation an amenity set is being resolved for. Every field is optional
 * and an absent one narrows the question rather than defaulting it: asking with
 * only an aircraft answers "what is this airframe fitted with".
 */
export interface AmenityContext {
  aircraftId?: string | null | undefined;
  cabinClass?: CabinClass | null | undefined;
  fareProductId?: string | null | undefined;
  flightInstanceId?: string | null | undefined;
}

export interface ResolvedAmenity {
  amenityCode: string;
  /** False means explicitly withheld, which is not the same as unmentioned. */
  included: boolean;
  /** The level that settled it. */
  decidedBy: AmenityScope;
  decidedByAssignmentId: string;
  note: string | null;
  /**
   * Every assignment that applied, narrowest first. The UI shows this so an
   * operator asking "why does this flight have no Wi-Fi?" can see the answer
   * rather than infer it.
   */
  overridden: {
    scope: AmenityScope;
    included: boolean;
    assignmentId: string;
    note: string | null;
  }[];
}

/** Does this assignment say anything about the situation in `context`? */
function applies(assignment: AmenityAssignment, context: AmenityContext): boolean {
  switch (assignment.scope) {
    case "aircraft":
      return (
        assignment.aircraftId !== null &&
        assignment.aircraftId !== undefined &&
        assignment.aircraftId === context.aircraftId
      );
    case "cabin":
      return (
        assignment.cabinClass !== null &&
        assignment.cabinClass !== undefined &&
        assignment.cabinClass === context.cabinClass
      );
    case "fare_product":
      return (
        assignment.fareProductId !== null &&
        assignment.fareProductId !== undefined &&
        assignment.fareProductId === context.fareProductId
      );
    case "flight":
      return (
        assignment.flightInstanceId !== null &&
        assignment.flightInstanceId !== undefined &&
        assignment.flightInstanceId === context.flightInstanceId
      );
  }
}

/**
 * Resolves the effective amenity set, sorted by code so two calls with the same
 * inputs produce the same list in the same order.
 *
 * Amenities nothing says anything about are simply absent -- silence is not an
 * exclusion, and a resolved list of every amenity in the catalogue marked false
 * would be noise.
 */
export function resolveAmenities(
  assignments: readonly AmenityAssignment[],
  context: AmenityContext,
): ResolvedAmenity[] {
  const byCode = new Map<string, AmenityAssignment[]>();

  for (const assignment of assignments) {
    if (!applies(assignment, context)) continue;
    const existing = byCode.get(assignment.amenityCode);
    if (existing) existing.push(assignment);
    else byCode.set(assignment.amenityCode, [assignment]);
  }

  const resolved: ResolvedAmenity[] = [];

  for (const [amenityCode, candidates] of byCode) {
    const ranked = [...candidates].sort((a, b) => {
      const bySpecificity =
        SCOPE_PRECEDENCE.indexOf(b.scope) - SCOPE_PRECEDENCE.indexOf(a.scope);
      if (bySpecificity !== 0) return bySpecificity;
      // Same level: the exclusion is the safer claim, so it goes first.
      if (a.included !== b.included) return a.included ? 1 : -1;
      // Still tied: order by id, so the result never depends on row order.
      return a.id < b.id ? -1 : 1;
    });

    const winner = ranked[0];
    if (!winner) continue;

    resolved.push({
      amenityCode,
      included: winner.included,
      decidedBy: winner.scope,
      decidedByAssignmentId: winner.id,
      note: winner.note,
      overridden: ranked.slice(1).map((assignment) => ({
        scope: assignment.scope,
        included: assignment.included,
        assignmentId: assignment.id,
        note: assignment.note,
      })),
    });
  }

  return resolved.sort((a, b) => (a.amenityCode < b.amenityCode ? -1 : 1));
}

/** Just the codes a passenger would be told they get. */
export function includedAmenityCodes(
  assignments: readonly AmenityAssignment[],
  context: AmenityContext,
): string[] {
  return resolveAmenities(assignments, context)
    .filter((amenity) => amenity.included)
    .map((amenity) => amenity.amenityCode);
}

/** How the winning level should be described to an operator. */
export const SCOPE_EXPLANATIONS: Readonly<Record<AmenityScope, string>> = {
  aircraft: "fitted to this airframe",
  cabin: "standard for this cabin",
  fare_product: "part of this fare",
  flight: "set for this flight only",
};

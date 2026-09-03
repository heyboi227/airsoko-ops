import type { Id, RouteStatus } from "@airsoko/contracts";
import { EvaluationBuilder, blocking, consequence, resourceRef, warning } from "../intent.ts";
import type { Evaluation } from "../intent.ts";
import { distanceNm } from "../geo.ts";
import { impliedCruiseKts } from "../network.ts";
import type { OperationalPolicy } from "../policy.ts";

/**
 * Route rules.
 *
 * A route is the pair, so these rules ask the questions a pair can be wrong
 * about: has it been filed already, does it go anywhere, are both ends still
 * stations we serve, and could an aeroplane keep the block time the airline
 * is about to publish.
 *
 * The reach check is a warning rather than a refusal, and that is the one
 * judgement here worth defending. Filing a pair the current fleet cannot fly
 * is exactly how a network plan starts -- the route is `planned`, the aircraft
 * is on order -- so refusing it would refuse network planning. Filing it
 * *without noticing* is the mistake, which is what the warning is for.
 */

export interface RouteEndpointFacts {
  id: Id;
  iataCode: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
  /** A withdrawn station is not a place a new service can be filed to. */
  active: boolean;
}

export interface RouteDraft {
  origin: RouteEndpointFacts;
  destination: RouteEndpointFacts;
  /** Gate to gate, in minutes, as the airline intends to publish it. */
  blockMinutes: number;
  status: RouteStatus;
  /** The type the route is planned on, where the operator chose one. */
  typicalType: FleetTypeReach | null;
}

/** A pair already on file, in either direction. */
export interface ExistingRoute {
  id: Id;
  originIata: string;
  destinationIata: string;
  status: RouteStatus;
  /** Active recurring schedules flying it. */
  scheduleCount: number;
}

/** A type on the airline's books, and how far it reaches. */
export interface FleetTypeReach {
  aircraftTypeId: Id;
  typeCode: string;
  rangeNm: number;
  cruiseSpeedKts: number;
}

export interface SaveRouteContext {
  policy: OperationalPolicy;
  /** Every pair already on file. */
  existing: readonly ExistingRoute[];
  /** Every type in the fleet, for the reach check. */
  fleetTypes: readonly FleetTypeReach[];
}

/**
 * Fastest and slowest block speeds this rule will accept without comment.
 * The same brackets the flight and schedule rules use, for the same reason:
 * they say "an aeroplane flew this", not "this is the right block time".
 */
const IMPOSSIBLE_CRUISE_KTS = 700;
const UNUSUALLY_FAST_KTS = 560;
const UNUSUALLY_SLOW_KTS = 140;
/** Below this, nothing has left a gate and arrived anywhere. */
const IMPLAUSIBLY_SHORT_BLOCK_MINUTES = 25;

function pairOf(draft: RouteDraft): string {
  return `${draft.origin.iataCode}-${draft.destination.iataCode}`;
}

export function evaluateSaveRoute(draft: RouteDraft, context: SaveRouteContext): Evaluation {
  const builder = new EvaluationBuilder();
  const pair = pairOf(draft);

  // --- Does it go anywhere? ------------------------------------------------
  if (draft.origin.id === draft.destination.id) {
    builder.add(
      blocking(
        "ROUTE_SAME_ORIGIN_AND_DESTINATION",
        `${draft.origin.iataCode} to itself`,
        `A route is a pair of different airports. Choose a destination other than ${draft.origin.name}.`,
      ),
    );

    // Everything below reads a distance or a speed, and both are meaningless
    // for a sector of zero length. The one refusal is the whole answer.
    return builder.build();
  }

  // --- Is it already on file? ---------------------------------------------
  const clash = context.existing.find(
    (route) =>
      route.originIata === draft.origin.iataCode &&
      route.destinationIata === draft.destination.iataCode,
  );
  if (clash) {
    const flying =
      clash.scheduleCount > 0
        ? ` ${clash.scheduleCount} recurring schedule${clash.scheduleCount === 1 ? "" : "s"} already fly it.`
        : " Nothing is scheduled on it yet, so it can be picked as it stands.";
    builder.add(
      blocking(
        "ROUTE_PAIR_IN_USE",
        `${pair} is already a route`,
        `The airline already holds ${pair} as a ${clash.status} route.${flying}`,
        { subject: resourceRef("route", clash.id, pair) },
      ),
    );
  }

  // --- Are both ends still stations we serve? -----------------------------
  for (const endpoint of [draft.origin, draft.destination]) {
    if (endpoint.active) continue;
    builder.add(
      blocking(
        "ROUTE_ENDPOINT_WITHDRAWN",
        `${endpoint.iataCode} has been withdrawn from service`,
        `${endpoint.name} (${endpoint.city}) is no longer an active station, so no new service can be filed through it. Reinstate the station first.`,
        { subject: resourceRef("airport", endpoint.id, endpoint.iataCode) },
      ),
    );
  }

  // --- Could an aeroplane keep this block time? ---------------------------
  const distance = Math.round(distanceNm(draft.origin, draft.destination));
  const implied = impliedCruiseKts(distance, draft.blockMinutes);
  const impliedLabel = Number.isFinite(implied)
    ? `${Math.round(implied).toLocaleString()} kt`
    : "an infinite speed";

  if (draft.blockMinutes < IMPLAUSIBLY_SHORT_BLOCK_MINUTES || implied > IMPOSSIBLE_CRUISE_KTS) {
    builder.add(
      blocking(
        "ROUTE_BLOCK_IMPLAUSIBLE",
        `${draft.blockMinutes} minutes cannot cover ${distance.toLocaleString()} nm`,
        `${pair} is ${distance.toLocaleString()} nm. Allowing ${IMPLAUSIBLY_SHORT_BLOCK_MINUTES} minutes is short of a gate-to-gate movement of any length, and a ${draft.blockMinutes}-minute block over this distance implies ${impliedLabel} in the cruise. Nothing in commercial service does that.`,
      ),
    );
  } else if (implied > UNUSUALLY_FAST_KTS || implied < UNUSUALLY_SLOW_KTS) {
    builder.add(
      warning(
        "ROUTE_BLOCK_IMPLAUSIBLE",
        `${draft.blockMinutes} minutes is an unusual block for ${distance.toLocaleString()} nm`,
        `It implies ${impliedLabel} in the cruise, outside the ${UNUSUALLY_SLOW_KTS}-${UNUSUALLY_FAST_KTS} kt a scheduled sector normally averages. Every flight filed on this route inherits the figure.`,
      ),
    );
  }

  // --- Can anything the airline flies reach it? ---------------------------
  builder.merge(reachEvaluation(draft, context, distance, pair));

  // --- What filing it does ------------------------------------------------
  if (!clash) {
    builder.expect(
      consequence(
        "map_visibility_changed",
        `${pair} becomes selectable when filing a flight or a pattern, and draws on the network map`,
      ),
    );
  }

  return builder.build();
}

/**
 * The reach check, in the two forms it can take: the type the operator named
 * cannot fly the sector, or nothing on the airline's books can.
 *
 * Never both -- a chosen type that falls short is the specific answer, and
 * repeating it as "no type reaches this" would be one condition rendered as
 * two ticks in the confirmation dialog.
 */
function reachEvaluation(
  draft: RouteDraft,
  context: SaveRouteContext,
  distance: number,
  pair: string,
): Evaluation {
  const builder = new EvaluationBuilder();
  const usable = (type: FleetTypeReach) => type.rangeNm * context.policy.range.usableFraction;
  const usableLabel = `${Math.round(context.policy.range.usableFraction * 100)}% of published range`;

  const chosen = draft.typicalType;
  if (chosen) {
    if (distance > usable(chosen)) {
      builder.add(
        warning(
          "ROUTE_BEYOND_FLEET_RANGE",
          `${chosen.typeCode} does not reach ${pair}`,
          `${distance.toLocaleString()} nm against ${Math.round(usable(chosen)).toLocaleString()} nm usable for a ${chosen.typeCode} (${usableLabel}). Planning the route on this type would leave every flight filed from it unassignable to one.`,
        ),
      );
    }
    return builder.build();
  }

  if (context.fleetTypes.length === 0) return builder.build();

  const furthest = context.fleetTypes.reduce((best, type) =>
    type.rangeNm > best.rangeNm ? type : best,
  );
  if (distance > usable(furthest)) {
    builder.add(
      warning(
        "ROUTE_BEYOND_FLEET_RANGE",
        `Nothing in the fleet reaches ${pair}`,
        `${distance.toLocaleString()} nm is beyond the ${Math.round(usable(furthest)).toLocaleString()} nm usable for a ${furthest.typeCode}, the longest-legged type on the books (${usableLabel}). The route can be filed as a plan; no flight on it can be assigned an aircraft until the fleet can fly it.`,
      ),
    );
  }

  return builder.build();
}

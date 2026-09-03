import { Router } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  createRouteSchema,
  mutationOptionsSchema,
  routeQuerySchema,
  type Route,
} from "@airsoko/contracts";
import {
  DEFAULT_POLICY,
  consequence,
  distanceNm as greatCircleNm,
  evaluateSaveRoute,
  resourceRef,
  type FleetTypeReach,
  type RouteEndpointFacts,
} from "@airsoko/domain";
import { db, type Executor, type Transaction } from "../../db/client.ts";
import { aircraftTypes, airports, recurringSchedules, routes } from "../../db/schema/index.ts";
import { seededId } from "../../db/ids.ts";
import { actorOf, requireAuth, requirePermission } from "../auth.ts";
import { ApiProblem, notFound } from "../errors.ts";
import { runIntent } from "../../pipeline/runIntent.ts";

/**
 * Routes: the reusable airport pairs.
 *
 * Read and create. A route is a network-planning decision rather than
 * something an operations controller edits between flights, which is why this
 * router stayed read-only through Phase 3 -- but "read-only" turned out to
 * mean an operator could file a service only on a pair somebody had seeded,
 * and the airline could not open a destination at all. So creating one is
 * here, through the same pipeline as every other write, guarded by
 * `route:write`: network planning and operations control hold it, a booking
 * administrator does not, and the refusal is the API's rather than a hidden
 * button's.
 *
 * Suspending and retiring a route are still not built, and neither is
 * removing one. They reach into the schedules and the flights already filed
 * on the pair, which is the network screens' work rather than a side effect
 * of a picker -- so what guards a mistyped pair here is the review before it
 * is filed, which names the stations, the distance and the block.
 *
 * Each row carries the count of patterns that fly it, which is what makes the
 * picker useful: an operator filing a new service wants the pairs the airline
 * already serves at the top, not an alphabetical list of everywhere.
 */

export const networkRouter: Router = Router();

const origin = alias(airports, "origin_airport");
const destination = alias(airports, "destination_airport");

const scheduleCount = sql<number>`(
  select count(*)::int from ${recurringSchedules}
  where ${recurringSchedules.routeId} = ${routes.id} and ${recurringSchedules.active}
)`;

const selection = {
  id: routes.id,
  originId: origin.id,
  originIata: origin.iataCode,
  originName: origin.name,
  originCity: origin.city,
  originTimeZone: origin.timeZone,
  destinationId: destination.id,
  destinationIata: destination.iataCode,
  destinationName: destination.name,
  destinationCity: destination.city,
  destinationTimeZone: destination.timeZone,
  distanceNm: routes.distanceNm,
  blockMinutes: routes.blockMinutes,
  status: routes.status,
  typicalTypeCode: aircraftTypes.icaoTypeCode,
  typicalAircraftTypeId: routes.typicalAircraftTypeId,
  scheduleCount,
} as const;

function routeQuery(executor: Executor) {
  return executor
    .select(selection)
    .from(routes)
    .innerJoin(origin, eq(origin.id, routes.originAirportId))
    .innerJoin(destination, eq(destination.id, routes.destinationAirportId))
    .leftJoin(aircraftTypes, eq(aircraftTypes.id, routes.typicalAircraftTypeId));
}

async function findRoute(executor: Executor, id: string): Promise<Route | null> {
  const [row] = await routeQuery(executor).where(eq(routes.id, id)).limit(1);
  return (row as Route | undefined) ?? null;
}

// --- Read ------------------------------------------------------------------

networkRouter.get("/", requireAuth, requirePermission("route:read"), async (req, res) => {
  const query = routeQuerySchema.parse(req.query);

  const conditions = [];
  if (query.originIata) conditions.push(eq(origin.iataCode, query.originIata));
  if (query.destinationIata) conditions.push(eq(destination.iataCode, query.destinationIata));
  if (query.status) conditions.push(eq(routes.status, query.status));
  if (query.search) {
    const needle = `%${query.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${origin.iataCode}) like ${needle}
        or lower(${destination.iataCode}) like ${needle}
        or lower(${origin.city}) like ${needle}
        or lower(${destination.city}) like ${needle}
        or lower(${origin.iataCode} || '-' || ${destination.iataCode}) like ${needle})`,
    );
  }

  const rows = await routeQuery(db)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(origin.iataCode), asc(destination.iataCode));

  const items = query.scheduledOnly ? rows.filter((row) => row.scheduleCount > 0) : rows;

  res.json({ items, total: items.length });
});

// --- Write -----------------------------------------------------------------

/** The endpoint facts the kernel's route rules read, for one station. */
async function loadEndpoint(
  executor: Executor,
  id: string,
): Promise<RouteEndpointFacts | null> {
  const [row] = await executor
    .select({
      id: airports.id,
      iataCode: airports.iataCode,
      name: airports.name,
      city: airports.city,
      latitude: airports.latitude,
      longitude: airports.longitude,
      active: airports.active,
    })
    .from(airports)
    .where(eq(airports.id, id))
    .limit(1);
  return row ?? null;
}

/** Every pair on file, so the kernel can see a duplicate coming. */
async function loadExistingPairs(executor: Executor) {
  return executor
    .select({
      id: routes.id,
      originIata: origin.iataCode,
      destinationIata: destination.iataCode,
      status: routes.status,
      scheduleCount,
    })
    .from(routes)
    .innerJoin(origin, eq(origin.id, routes.originAirportId))
    .innerJoin(destination, eq(destination.id, routes.destinationAirportId));
}

/** The types on the airline's books, for the reach check. */
async function loadFleetReach(executor: Executor): Promise<FleetTypeReach[]> {
  return executor
    .select({
      aircraftTypeId: aircraftTypes.id,
      typeCode: aircraftTypes.icaoTypeCode,
      rangeNm: aircraftTypes.rangeNm,
      cruiseSpeedKts: aircraftTypes.cruiseSpeedKts,
    })
    .from(aircraftTypes)
    .orderBy(asc(aircraftTypes.icaoTypeCode));
}

/**
 * Both legs of one act.
 *
 * A route is directional and a service is not: an airline that starts flying
 * BEG-TGD starts flying TGD-BEG, and the seed's own network builder makes the
 * pair both ways. The return leg inherits the block time and the planned type
 * rather than asking again -- the same figures for the same sector -- and is
 * skipped when it is already on file.
 */
interface Leg {
  id: string;
  pair: string;
  originAirportId: string;
  destinationAirportId: string;
}

function legOf(from: RouteEndpointFacts, to: RouteEndpointFacts): Leg {
  return {
    id: seededId("route", `${from.iataCode}-${to.iataCode}`),
    pair: `${from.iataCode}-${to.iataCode}`,
    originAirportId: from.id,
    destinationAirportId: to.id,
  };
}

networkRouter.post("/", requireAuth, requirePermission("route:write"), async (req, res) => {
  const { mutation: rawOptions, ...body } = req.body ?? {};
  const input = createRouteSchema.parse(body);
  const options = mutationOptionsSchema.parse(rawOptions ?? {});
  const actor = actorOf(req);
  const now = new Date().toISOString();

  const [from, to] = await Promise.all([
    loadEndpoint(db, input.originAirportId),
    loadEndpoint(db, input.destinationAirportId),
  ]);
  if (!from) throw notFound(`Airport ${input.originAirportId}`);
  if (!to) throw notFound(`Airport ${input.destinationAirportId}`);

  const fleetTypes = await loadFleetReach(db);
  const typicalType = input.typicalAircraftTypeId
    ? (fleetTypes.find((type) => type.aircraftTypeId === input.typicalAircraftTypeId) ?? null)
    : null;
  if (input.typicalAircraftTypeId && !typicalType) {
    throw notFound(`Aircraft type ${input.typicalAircraftTypeId}`);
  }

  // The distance is not the caller's to state: it is the great-circle
  // distance between two fixed points, and both points are on file here.
  const distance = Math.round(greatCircleNm(from, to));

  const outbound = legOf(from, to);
  const inbound = legOf(to, from);

  const outcome = await runIntent({
    intent: "route.create",
    actor,
    options,
    now,
    evaluate: async (tx) => {
      const existing = await loadExistingPairs(tx);
      const evaluation = evaluateSaveRoute(
        {
          origin: from,
          destination: to,
          blockMinutes: input.blockMinutes,
          status: input.status,
          typicalType,
        },
        { policy: DEFAULT_POLICY, existing, fleetTypes },
      );

      // The return leg is an effect of this act rather than a second intent,
      // so it is evaluated as one: same distance, same block, same stations,
      // and therefore the same findings the outbound already raised.
      if (willFileReturn(input.includeReturn, existing, inbound.pair)) {
        evaluation.consequences.push(
          consequence(
            "map_visibility_changed",
            `${inbound.pair} is filed alongside it, at the same ${input.blockMinutes}-minute block`,
          ),
        );
      }

      return evaluation;
    },
    apply: async (tx) => {
      const existing = await loadExistingPairs(tx);
      const legs = [outbound];
      if (willFileReturn(input.includeReturn, existing, inbound.pair)) legs.push(inbound);

      await tx.insert(routes).values(
        legs.map((leg) => ({
          id: leg.id,
          originAirportId: leg.originAirportId,
          destinationAirportId: leg.destinationAirportId,
          distanceNm: distance,
          blockMinutes: input.blockMinutes,
          status: input.status,
          typicalAircraftTypeId: input.typicalAircraftTypeId ?? null,
          createdAt: now,
          updatedAt: now,
        })),
      );

      const filed = await loadFiled(tx, legs);

      return {
        value: {
          route: filed[0] as Route,
          returnRoute: (filed[1] as Route | undefined) ?? null,
        },
        audit: legs.map((leg, index) => ({
          action: "route.create",
          resource: resourceRef("route", leg.id, leg.pair),
          newValue: filed[index],
        })),
      };
    },
  });

  if (outcome.status === "preview") {
    res.status(200).json(outcome.preview);
    return;
  }
  res.status(201).json({ ...outcome.value, preview: outcome.preview });
});

/** True when the return leg is wanted and not already a route. */
function willFileReturn(
  wanted: boolean,
  existing: readonly { originIata: string; destinationIata: string }[],
  pair: string,
): boolean {
  return (
    wanted && !existing.some((route) => `${route.originIata}-${route.destinationIata}` === pair)
  );
}

async function loadFiled(tx: Transaction, legs: readonly Leg[]): Promise<Route[]> {
  const filed: Route[] = [];
  for (const leg of legs) {
    const row = await findRoute(tx, leg.id);
    if (!row)
      throw new ApiProblem("INTERNAL", `Route ${leg.pair} vanished immediately after insert.`);
    filed.push(row);
  }
  return filed;
}

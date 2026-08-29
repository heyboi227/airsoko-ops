import { Router } from "express";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { dashboardQuerySchema, type Dashboard } from "@airsoko/contracts";
import { DEFAULT_POLICY, formatLocalDate, partsInZone } from "@airsoko/domain";
import { db } from "../../db/client.ts";
import { aircraft, airports, flightInstances, routes } from "../../db/schema/index.ts";
import { requireAuth, requirePermission } from "../auth.ts";
import { ApiProblem } from "../errors.ts";

/**
 * The dashboard's numbers.
 *
 * Computed in the database rather than by loading a day of flights and
 * counting in JavaScript: this runs on every dashboard open, and the aggregates
 * are exactly what Postgres is for.
 *
 * Every figure here is derived. Nothing about the operation is stored twice, so
 * there is no path by which the dashboard and the flight list can disagree.
 */

export const analyticsRouter: Router = Router();

/**
 * The airline's bases, busiest first.
 *
 * An earlier version took `limit(1)` off an unordered query and assumed exactly
 * one hub. The moment a second airport was marked as one, the dashboard picked
 * between them arbitrarily and reported an operating day in the wrong time zone
 * with no movements in it -- because every flight belonged to the other hub.
 *
 * An airline may have more than one base, so: movements cover all of them, and
 * the busiest defines the operating day, since that is the clock the network is
 * actually run on. Ordering by flight count then by code keeps it deterministic
 * when two bases are level.
 */
async function hubs() {
  const rows = await db
    .select({
      id: airports.id,
      iataCode: airports.iataCode,
      timeZone: airports.timeZone,
      flights: sql<number>`(
        select count(*) from ${flightInstances} f
        where f.origin_airport_id = ${airports.id} or f.destination_airport_id = ${airports.id}
      )::int`,
    })
    .from(airports)
    .where(and(eq(airports.isHub, true), eq(airports.active, true)))
    .orderBy(sql`4 desc`, airports.iataCode);

  if (rows.length === 0) {
    throw new ApiProblem(
      "INTERNAL",
      "No active airport is marked as a hub, so there is no operating day to report on.",
    );
  }
  return rows;
}

analyticsRouter.get(
  "/dashboard",
  requireAuth,
  requirePermission("analytics:read"),
  async (req, res) => {
    const query = dashboardQuerySchema.parse(req.query);
    const bases = await hubs();
    const base = bases[0];
    if (!base) throw new ApiProblem("INTERNAL", "No hub airport is configured.");
    const baseIds = bases.map((entry) => entry.id);

    const now = new Date().toISOString();
    const date = query.date ?? formatLocalDate(now, base.timeZone);

    // --- Flights ------------------------------------------------------------
    // Delay is derived, not stored: estimated later than scheduled by more than
    // the policy threshold. A flight can be boarding and late at the same time,
    // which is why "delayed" was never made a status.
    const threshold = DEFAULT_POLICY.delay.thresholdMinutes;
    const delayExpression = sql<number>`
    extract(epoch from (${flightInstances.estimatedDeparture} - ${flightInstances.scheduledDeparture})) / 60
  `;

    const [flightRow] = await db
      .select({
        total: sql<number>`count(*)::int`,
        scheduled: sql<number>`count(*) filter (where ${flightInstances.status} = 'scheduled')::int`,
        checkInOpen: sql<number>`count(*) filter (where ${flightInstances.status} = 'check_in_open')::int`,
        boarding: sql<number>`count(*) filter (where ${flightInstances.status} = 'boarding')::int`,
        gateClosed: sql<number>`count(*) filter (where ${flightInstances.status} = 'gate_closed')::int`,
        taxiOut: sql<number>`count(*) filter (where ${flightInstances.status} = 'taxi_out')::int`,
        airborne: sql<number>`count(*) filter (where ${flightInstances.status} = 'airborne')::int`,
        taxiIn: sql<number>`count(*) filter (where ${flightInstances.status} = 'taxi_in')::int`,
        arrived: sql<number>`count(*) filter (where ${flightInstances.status} = 'arrived')::int`,
        diverted: sql<number>`count(*) filter (where ${flightInstances.status} = 'diverted')::int`,
        cancelled: sql<number>`count(*) filter (where ${flightInstances.status} = 'cancelled')::int`,
        delayed: sql<number>`count(*) filter (where ${delayExpression} > ${threshold})::int`,
        averageDelayMinutes: sql<number>`
        coalesce(round(avg(${delayExpression}) filter (where ${delayExpression} > ${threshold}))::int, 0)
      `,
        operating: sql<number>`count(*) filter (where ${flightInstances.status} <> 'cancelled')::int`,
        withoutAircraft: sql<number>`
        count(*) filter (where ${flightInstances.aircraftId} is null
          and ${flightInstances.status} <> 'cancelled')::int
      `,
      })
      .from(flightInstances)
      .where(eq(flightInstances.serviceDate, date));

    const operating = flightRow?.operating ?? 0;
    const delayed = flightRow?.delayed ?? 0;

    // --- Fleet --------------------------------------------------------------
    const [fleetRow] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${aircraft.status} = 'active')::int`,
        airborne: sql<number>`count(*) filter (where ${aircraft.status} = 'airborne')::int`,
        onGround: sql<number>`count(*) filter (where ${aircraft.status} = 'on_ground')::int`,
        turnaround: sql<number>`count(*) filter (where ${aircraft.status} = 'turnaround')::int`,
        maintenance: sql<number>`count(*) filter (where ${aircraft.status} = 'maintenance')::int`,
        stored: sql<number>`count(*) filter (where ${aircraft.status} = 'stored')::int`,
        outOfService: sql<number>`count(*) filter (where ${aircraft.status} = 'out_of_service')::int`,
      })
      .from(aircraft);

    const [sectorRow] = await db
      .select({ sectors: sql<number>`count(*)::int` })
      .from(flightInstances)
      .where(
        and(
          eq(flightInstances.serviceDate, date),
          sql`${flightInstances.aircraftId} is not null`,
          sql`${flightInstances.status} <> 'cancelled'`,
        ),
      );

    // Airborne is read from the flights rather than the aircraft row: a flight in
    // the air is the fact, and an aircraft status that disagreed with it would be
    // a second copy of the same truth waiting to drift.
    const airborneNow = flightRow?.airborne ?? 0;
    const availableTails =
      (fleetRow?.total ?? 0) -
      (fleetRow?.maintenance ?? 0) -
      (fleetRow?.stored ?? 0) -
      (fleetRow?.outOfService ?? 0);

    // --- Movements through the day -----------------------------------------
    const movementRows = await db
      .select({
        hour: sql<number>`extract(hour from (${flightInstances.scheduledDeparture} at time zone ${base.timeZone}))::int`,
        departures: sql<number>`count(*) filter (where ${inArray(flightInstances.originAirportId, baseIds)})::int`,
        arrivals: sql<number>`count(*) filter (where ${inArray(flightInstances.destinationAirportId, baseIds)})::int`,
      })
      .from(flightInstances)
      .where(
        and(
          eq(flightInstances.serviceDate, date),
          sql`${flightInstances.status} <> 'cancelled'`,
          sql`(${inArray(flightInstances.originAirportId, baseIds)} or ${inArray(flightInstances.destinationAirportId, baseIds)})`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const byHour = new Map(movementRows.map((row) => [row.hour, row]));
    const movements = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      departures: byHour.get(hour)?.departures ?? 0,
      arrivals: byHour.get(hour)?.arrivals ?? 0,
    }));

    // --- Busiest routes -----------------------------------------------------
    const origin = airports;
    const routeRows = await db
      .select({
        origin: sql<string>`origin_airport.iata_code`,
        destination: sql<string>`destination_airport.iata_code`,
        flights: sql<number>`count(*)::int`,
        distanceNm: sql<number>`max(${routes.distanceNm})::int`,
        delayed: sql<number>`count(*) filter (where ${delayExpression} > ${threshold})::int`,
      })
      .from(flightInstances)
      .innerJoin(routes, eq(routes.id, flightInstances.routeId))
      .innerJoin(
        sql`${origin} as origin_airport`,
        sql`origin_airport.id = ${flightInstances.originAirportId}`,
      )
      .innerJoin(
        sql`${origin} as destination_airport`,
        sql`destination_airport.id = ${flightInstances.destinationAirportId}`,
      )
      .where(
        and(
          gte(flightInstances.serviceDate, sql`${date}::date - interval '6 days'`),
          lte(flightInstances.serviceDate, date),
          sql`${flightInstances.status} <> 'cancelled'`,
        ),
      )
      .groupBy(sql`1, 2`)
      .orderBy(sql`3 desc`)
      .limit(8);

    const payload: Dashboard = {
      date,
      generatedAt: now,
      hubIataCode: base.iataCode,
      hubTimeZone: base.timeZone,
      flights: {
        total: flightRow?.total ?? 0,
        scheduled: flightRow?.scheduled ?? 0,
        checkInOpen: flightRow?.checkInOpen ?? 0,
        boarding: flightRow?.boarding ?? 0,
        gateClosed: flightRow?.gateClosed ?? 0,
        taxiOut: flightRow?.taxiOut ?? 0,
        airborne: airborneNow,
        taxiIn: flightRow?.taxiIn ?? 0,
        arrived: flightRow?.arrived ?? 0,
        diverted: flightRow?.diverted ?? 0,
        cancelled: flightRow?.cancelled ?? 0,
        delayed,
        averageDelayMinutes: flightRow?.averageDelayMinutes ?? 0,
        onTimePerformance: operating === 0 ? 1 : (operating - delayed) / operating,
        withoutAircraft: flightRow?.withoutAircraft ?? 0,
      },
      fleet: {
        total: fleetRow?.total ?? 0,
        active: fleetRow?.active ?? 0,
        airborne: airborneNow,
        onGround: Math.max(0, (fleetRow?.active ?? 0) - airborneNow),
        turnaround: fleetRow?.turnaround ?? 0,
        maintenance: fleetRow?.maintenance ?? 0,
        stored: fleetRow?.stored ?? 0,
        outOfService: fleetRow?.outOfService ?? 0,
        sectorsToday: sectorRow?.sectors ?? 0,
        sectorsPerAvailableAircraft:
          availableTails === 0
            ? 0
            : Math.round(((sectorRow?.sectors ?? 0) / availableTails) * 10) / 10,
      },
      movements,
      routes: routeRows,
      passengers: {
        available: false,
        arrivesInPhase: 6,
        summary:
          "Expected and checked-in passengers, seats sold and load factor by cabin arrive with bookings.",
      },
      crew: {
        available: false,
        arrivesInPhase: 5,
        summary:
          "Crew on duty, assigned, unavailable and approaching duty limits arrive with crew rostering.",
      },
    };

    res.json(payload);
  },
);

/** Local hour at the hub, for the greeting and the operating-day boundary. */
export function hubHour(instant: string, timeZone: string): number {
  return partsInZone(instant, timeZone).hour;
}

import { Router } from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { aircraft, aircraftTypes, airports, flightInstances } from "../../db/schema/index.ts";
import { requireAuth, requirePermission } from "../auth.ts";
import { ACTIVE_FLIGHT_STATUSES } from "@airsoko/contracts";

/**
 * Everything the live map needs for one frame, in one query.
 *
 * Deliberately minimal for the Phase 1 spike: the endpoints, the times, and the
 * airframe. Position is *not* stored or returned -- it is interpolated from
 * departure, arrival and the two airport coordinates, which is both cheaper and
 * more honest than persisting a location that would be stale the moment it was
 * written.
 *
 * Phase 4 replaces this with the telemetry provider contract, where a real feed
 * can supply genuine positions instead. The shape here is the fallback that
 * contract will describe.
 */

export const liveRouter: Router = Router();

liveRouter.get("/", requireAuth, requirePermission("flight:read"), async (_req, res) => {
  const origin = airports;

  const rows = await db
    .select({
      id: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      callsign: flightInstances.callsign,
      status: flightInstances.status,
      phase: flightInstances.phase,
      scheduledDeparture: flightInstances.scheduledDeparture,
      scheduledArrival: flightInstances.scheduledArrival,
      estimatedArrival: flightInstances.estimatedArrival,
      actualDeparture: flightInstances.actualDeparture,
      originIata: sql<string>`origin_airport.iata_code`,
      originLat: sql<number>`origin_airport.latitude`,
      originLon: sql<number>`origin_airport.longitude`,
      destinationIata: sql<string>`destination_airport.iata_code`,
      destinationLat: sql<number>`destination_airport.latitude`,
      destinationLon: sql<number>`destination_airport.longitude`,
      registration: aircraft.registration,
      aircraftName: aircraft.name,
      typeCode: aircraftTypes.icaoTypeCode,
      cruiseSpeedKts: aircraftTypes.cruiseSpeedKts,
      serviceCeilingFt: aircraftTypes.serviceCeilingFt,
    })
    .from(flightInstances)
    .innerJoin(
      sql`${origin} as origin_airport`,
      sql`origin_airport.id = ${flightInstances.originAirportId}`,
    )
    .innerJoin(
      sql`${origin} as destination_airport`,
      sql`destination_airport.id = ${flightInstances.destinationAirportId}`,
    )
    .leftJoin(aircraft, eq(aircraft.id, flightInstances.aircraftId))
    .leftJoin(aircraftTypes, eq(aircraftTypes.id, aircraft.aircraftTypeId))
    .where(inArray(flightInstances.status, [...ACTIVE_FLIGHT_STATUSES]));

  res.json({ items: rows, total: rows.length, generatedAt: new Date().toISOString() });
});

/** Airport positions for the map's station layer. */
liveRouter.get(
  "/stations",
  requireAuth,
  requirePermission("airport:read"),
  async (_req, res) => {
    const rows = await db
      .select({
        iataCode: airports.iataCode,
        name: airports.name,
        latitude: airports.latitude,
        longitude: airports.longitude,
        isHub: airports.isHub,
        isFocusCity: airports.isFocusCity,
      })
      .from(airports)
      .where(eq(airports.active, true));

    res.json({ items: rows, total: rows.length });
  },
);

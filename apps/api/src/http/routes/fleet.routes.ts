import { Router } from "express";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aircraftServiceabilitySchema,
  mutationOptionsSchema,
  SERVICEABILITY_LABELS,
} from "@airsoko/contracts";
import { evaluateWithdrawAircraft, resolveAmenities, resourceRef } from "@airsoko/domain";
import { db, type Executor } from "../../db/client.ts";
import {
  aircraft,
  airports,
  amenities,
  amenityAssignments,
  flightInstances,
} from "../../db/schema/index.ts";
import { loadFleet, loadMaintenanceHistory } from "../../fleet/state.ts";
import { actorOf, requireAuth, requirePermission } from "../auth.ts";
import { ApiProblem, notFound, pathParam } from "../errors.ts";
import { runIntent } from "../../pipeline/runIntent.ts";

/**
 * The fleet.
 *
 * Reads go through `loadFleet`, which is the single place that works out where
 * an aircraft is and what it is doing. Writes go through the mutation pipeline
 * like everything else, so withdrawing an airframe is evaluated, audited and
 * transactional -- and tells the operator which flights it is about to strand
 * before it happens.
 */

export const fleetRouter: Router = Router();

const fleetQuerySchema = z.object({
  search: z.string().trim().max(60).optional(),
  serviceability: aircraftServiceabilitySchema.optional(),
  typeCode: z.string().trim().max(4).optional(),
  state: z.enum(["airborne", "turnaround", "on_ground", "unavailable"]).optional(),
  /** Only airframes with a check approaching or overdue. */
  maintenanceDue: z.coerce.boolean().optional(),
});

fleetRouter.get("/", requireAuth, requirePermission("aircraft:read"), async (req, res) => {
  const query = fleetQuerySchema.parse(req.query);
  const now = new Date().toISOString();

  let fleet = await loadFleet(now);

  if (query.search) {
    const needle = query.search.toLowerCase();
    fleet = fleet.filter(
      (item) =>
        item.registration.toLowerCase().includes(needle) ||
        (item.name?.toLowerCase().includes(needle) ?? false) ||
        item.type.icaoTypeCode.toLowerCase().includes(needle) ||
        `${item.type.manufacturer} ${item.type.model}`.toLowerCase().includes(needle),
    );
  }
  if (query.serviceability) {
    fleet = fleet.filter((item) => item.serviceability === query.serviceability);
  }
  if (query.typeCode) {
    fleet = fleet.filter((item) => item.type.icaoTypeCode === query.typeCode);
  }
  if (query.state) {
    fleet = fleet.filter((item) => item.state.operationalState === query.state);
  }
  if (query.maintenanceDue) {
    fleet = fleet.filter(
      (item) =>
        item.maintenance.urgency === "approaching" || item.maintenance.urgency === "exceeded",
    );
  }

  res.json({
    items: fleet,
    total: fleet.length,
    generatedAt: now,
    /** So the client can offer type filters without a second call. */
    types: [...new Set(fleet.map((item) => item.type.icaoTypeCode))].sort(),
  });
});

fleetRouter.get("/:id", requireAuth, requirePermission("aircraft:read"), async (req, res) => {
  const id = pathParam(req, "id");
  const now = new Date().toISOString();

  const fleet = await loadFleet(now);
  const found = fleet.find((item) => item.id === id);
  if (!found) throw notFound(`Aircraft ${id}`);

  const [maintenance, rotation, amenityList] = await Promise.all([
    loadMaintenanceHistory(id),
    recentAndUpcoming(id),
    fittedAmenities(id),
  ]);

  res.json({
    aircraft: found,
    maintenance,
    rotation,
    amenities: amenityList,
    generatedAt: now,
  });
});

fleetRouter.get(
  "/:id/maintenance",
  requireAuth,
  requirePermission("aircraft:read"),
  async (req, res) => {
    const id = pathParam(req, "id");
    res.json({ items: await loadMaintenanceHistory(id) });
  },
);

/**
 * Change an airframe's serviceability.
 *
 * The Phase 2 gate lives at the other end of this: once an aircraft is not in
 * service, the assignment rules refuse it. Here the operator is told, before
 * committing, exactly which scheduled sectors lose their aircraft.
 */
const serviceabilityBodySchema = z.object({
  serviceability: aircraftServiceabilitySchema,
  notes: z.string().max(500).optional(),
});

fleetRouter.post(
  "/:id/serviceability",
  requireAuth,
  requirePermission("aircraft:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = serviceabilityBodySchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const [current] = await db
      .select({
        id: aircraft.id,
        registration: aircraft.registration,
        serviceability: aircraft.serviceability,
        notes: aircraft.notes,
      })
      .from(aircraft)
      .where(eq(aircraft.id, id))
      .limit(1);

    if (!current) throw notFound(`Aircraft ${id}`);
    if (current.serviceability === input.serviceability) {
      throw new ApiProblem(
        "CONFLICT",
        `${current.registration} is already ${SERVICEABILITY_LABELS[input.serviceability].toLowerCase()}.`,
      );
    }

    const outcome = await runIntent({
      intent: "aircraft.set_serviceability",
      actor,
      options,
      now,
      evaluate: async (tx) => {
        // Only matters when taking an airframe *out* of service; putting one
        // back strands nothing.
        const upcoming =
          input.serviceability === "in_service" ? [] : await upcomingSectors(id, now, tx);
        return evaluateWithdrawAircraft(current, input.serviceability, upcoming);
      },
      apply: async (tx) => {
        await tx
          .update(aircraft)
          .set({
            serviceability: input.serviceability,
            notes: input.notes ?? current.notes,
            updatedAt: now,
          })
          .where(eq(aircraft.id, id));

        const stranded =
          input.serviceability === "in_service" ? [] : await upcomingSectors(id, now, tx);

        return {
          value: {
            id,
            registration: current.registration,
            serviceability: input.serviceability,
          },
          audit: {
            action: "aircraft.set_serviceability",
            resource: resourceRef("aircraft", id, current.registration),
            previousValue: { serviceability: current.serviceability, notes: current.notes },
            newValue: {
              serviceability: input.serviceability,
              notes: input.notes ?? current.notes,
            },
          },
          alerts: stranded.slice(0, 25).map((flight) => ({
            severity: "critical" as const,
            code: "AIRCRAFT_UNAVAILABLE",
            title: `${flight.flightNumber} has no aircraft`,
            detail: `${current.registration} was withdrawn (${SERVICEABILITY_LABELS[input.serviceability].toLowerCase()}) and ${flight.flightNumber} ${flight.originIata}-${flight.destinationIata} needs a replacement airframe.`,
            resource: resourceRef("flight", flight.flightId, flight.flightNumber),
          })),
        };
      },
    });

    if (outcome.status === "preview") {
      res.status(200).json(outcome.preview);
      return;
    }
    res.json({ aircraft: outcome.value, preview: outcome.preview });
  },
);

// --- helpers ---------------------------------------------------------------

/** Sectors this airframe is still due to fly. */
async function upcomingSectors(aircraftId: string, now: string, executor: Executor = db) {
  const origin = airports;
  const rows = await executor
    .select({
      flightId: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      originIata: sql<string>`origin_airport.iata_code`,
      destinationIata: sql<string>`destination_airport.iata_code`,
      departure: flightInstances.scheduledDeparture,
      arrival: flightInstances.scheduledArrival,
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
    .where(
      and(
        eq(flightInstances.aircraftId, aircraftId),
        gte(flightInstances.scheduledDeparture, now),
        ne(flightInstances.status, "cancelled"),
      ),
    )
    .orderBy(flightInstances.scheduledDeparture);

  return rows;
}

/** The airframe's recent and upcoming sectors, for the profile timeline. */
async function recentAndUpcoming(aircraftId: string) {
  const origin = airports;
  return db
    .select({
      id: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      serviceDate: flightInstances.serviceDate,
      status: flightInstances.status,
      originIata: sql<string>`origin_airport.iata_code`,
      destinationIata: sql<string>`destination_airport.iata_code`,
      scheduledDeparture: flightInstances.scheduledDeparture,
      estimatedDeparture: flightInstances.estimatedDeparture,
      actualDeparture: flightInstances.actualDeparture,
      scheduledArrival: flightInstances.scheduledArrival,
      actualArrival: flightInstances.actualArrival,
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
    .where(eq(flightInstances.aircraftId, aircraftId))
    .orderBy(sql`${flightInstances.scheduledDeparture} desc`)
    .limit(25);
}

/**
 * What this airframe is fitted with.
 *
 * Resolved rather than listed: an aircraft-level exclusion has to be able to
 * cancel an aircraft-level inclusion, and `resolveAmenities` is the one place
 * that decides which wins.
 */
async function fittedAmenities(aircraftId: string) {
  const rows = await db
    .select({
      id: amenityAssignments.id,
      amenityCode: amenities.code,
      name: amenities.name,
      category: amenities.category,
      scope: amenityAssignments.scope,
      included: amenityAssignments.included,
      note: amenityAssignments.note,
      aircraftId: amenityAssignments.aircraftId,
      cabinClass: amenityAssignments.cabinClass,
      fareProductId: amenityAssignments.fareProductId,
      flightInstanceId: amenityAssignments.flightInstanceId,
    })
    .from(amenityAssignments)
    .innerJoin(amenities, eq(amenities.id, amenityAssignments.amenityId))
    .where(eq(amenityAssignments.aircraftId, aircraftId));

  const named = new Map(rows.map((row) => [row.amenityCode, row]));

  return resolveAmenities(rows, { aircraftId }).map((entry) => ({
    ...entry,
    name: named.get(entry.amenityCode)?.name ?? entry.amenityCode,
    category: named.get(entry.amenityCode)?.category ?? null,
  }));
}

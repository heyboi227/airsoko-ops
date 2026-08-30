import { Router } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { cabinClassSchema } from "@airsoko/contracts";
import { resolveAmenities, type AmenityAssignment } from "@airsoko/domain";
import { db } from "../../db/client.ts";
import {
  aircraft,
  aircraftCabins,
  amenities,
  amenityAssignments,
  fareProducts,
} from "../../db/schema/index.ts";
import { requireAuth, requirePermission } from "../auth.ts";

/**
 * Amenities, and -- more usefully -- what they resolve to.
 *
 * The catalogue is the easy half. The half that matters is `/resolve`: four
 * levels can each say something about the same amenity, and this endpoint says
 * which one won and what it overrode. The deciding is `resolveAmenities` in the
 * domain package, so the answer here is the same answer a booking or a boarding
 * pass would get.
 */

export const amenitiesRouter: Router = Router();

/** Rows as the domain function wants them. */
async function loadAssignments(): Promise<(AmenityAssignment & { amenityId: string })[]> {
  const rows = await db
    .select({
      id: amenityAssignments.id,
      amenityId: amenityAssignments.amenityId,
      amenityCode: amenities.code,
      scope: amenityAssignments.scope,
      included: amenityAssignments.included,
      note: amenityAssignments.note,
      aircraftId: amenityAssignments.aircraftId,
      cabinClass: amenityAssignments.cabinClass,
      fareProductId: amenityAssignments.fareProductId,
      flightInstanceId: amenityAssignments.flightInstanceId,
    })
    .from(amenityAssignments)
    .innerJoin(amenities, eq(amenities.id, amenityAssignments.amenityId));

  return rows;
}

amenitiesRouter.get(
  "/",
  requireAuth,
  requirePermission("commercial:read"),
  async (_req, res) => {
    const catalogue = await db
      .select({
        id: amenities.id,
        code: amenities.code,
        name: amenities.name,
        category: amenities.category,
        description: amenities.description,
        active: amenities.active,
      })
      .from(amenities)
      .orderBy(asc(amenities.category), asc(amenities.name));

    const assignments = await loadAssignments();

    const byAmenity = new Map<
      string,
      { aircraft: number; cabin: number; fare: number; flight: number; exclusions: number }
    >();
    for (const assignment of assignments) {
      const tally = byAmenity.get(assignment.amenityId) ?? {
        aircraft: 0,
        cabin: 0,
        fare: 0,
        flight: 0,
        exclusions: 0,
      };
      if (assignment.scope === "aircraft") tally.aircraft += 1;
      if (assignment.scope === "cabin") tally.cabin += 1;
      if (assignment.scope === "fare_product") tally.fare += 1;
      if (assignment.scope === "flight") tally.flight += 1;
      if (!assignment.included) tally.exclusions += 1;
      byAmenity.set(assignment.amenityId, tally);
    }

    res.json({
      items: catalogue.map((amenity) => ({
        ...amenity,
        assignments: byAmenity.get(amenity.id) ?? {
          aircraft: 0,
          cabin: 0,
          fare: 0,
          flight: 0,
          exclusions: 0,
        },
      })),
      total: catalogue.length,
    });
  },
);

/**
 * What a passenger in this situation actually gets.
 *
 * Every parameter is optional, and leaving one out genuinely narrows the
 * question rather than defaulting it: asking with only `aircraftId` answers
 * "what is this airframe fitted with", which is a question the fleet page asks.
 */
const resolveQuerySchema = z.object({
  aircraftId: z.uuid().optional(),
  cabinClass: cabinClassSchema.optional(),
  fareProductId: z.uuid().optional(),
  flightInstanceId: z.uuid().optional(),
});

amenitiesRouter.get(
  "/resolve",
  requireAuth,
  requirePermission("commercial:read"),
  async (req, res) => {
    const query = resolveQuerySchema.parse(req.query);
    const assignments = await loadAssignments();

    const resolved = resolveAmenities(assignments, query);
    const catalogue = await amenityLookup(resolved.map((entry) => entry.amenityCode));

    res.json({
      context: query,
      items: resolved.map((entry) => ({
        ...entry,
        name: catalogue.get(entry.amenityCode)?.name ?? entry.amenityCode,
        category: catalogue.get(entry.amenityCode)?.category ?? null,
      })),
    });
  },
);

/**
 * The resolution matrix for one aircraft: every amenity, against every cabin it
 * has. This is the view that makes an override legible -- the same amenity
 * reads differently in Business than in Economy, and seeing the columns side by
 * side is the point.
 */
amenitiesRouter.get(
  "/matrix/:aircraftId",
  requireAuth,
  requirePermission("commercial:read"),
  async (req, res) => {
    const aircraftId = z.uuid().parse(req.params.aircraftId);

    const [airframe] = await db
      .select({ id: aircraft.id, registration: aircraft.registration })
      .from(aircraft)
      .where(eq(aircraft.id, aircraftId))
      .limit(1);

    if (!airframe) {
      res.status(404).json({
        error: { code: "NOT_FOUND", message: `Aircraft ${aircraftId} was not found.` },
      });
      return;
    }

    const cabins = await db
      .select({ cabinClass: aircraftCabins.cabinClass, seatCount: aircraftCabins.seatCount })
      .from(aircraftCabins)
      .where(eq(aircraftCabins.aircraftId, aircraftId));

    const assignments = await loadAssignments();
    const catalogue = await amenityLookup();

    const columns = cabins.map((cabin) => ({
      cabinClass: cabin.cabinClass,
      seatCount: cabin.seatCount,
      amenities: resolveAmenities(assignments, {
        aircraftId,
        cabinClass: cabin.cabinClass,
      }).map((entry) => ({
        ...entry,
        name: catalogue.get(entry.amenityCode)?.name ?? entry.amenityCode,
        category: catalogue.get(entry.amenityCode)?.category ?? null,
      })),
    }));

    res.json({ aircraft: airframe, cabins: columns });
  },
);

/** Fare products, so the resolve view can offer a real fare to resolve against. */
amenitiesRouter.get(
  "/fare-products",
  requireAuth,
  requirePermission("commercial:read"),
  async (_req, res) => {
    const items = await db
      .select({
        id: fareProducts.id,
        code: fareProducts.code,
        name: fareProducts.name,
        cabinClass: fareProducts.cabinClass,
        tier: fareProducts.tier,
      })
      .from(fareProducts)
      .where(eq(fareProducts.active, true))
      .orderBy(asc(fareProducts.cabinClass), asc(fareProducts.tier));

    res.json({ items, total: items.length });
  },
);

async function amenityLookup(codes?: string[]) {
  const rows =
    codes && codes.length === 0
      ? []
      : await db
          .select({ code: amenities.code, name: amenities.name, category: amenities.category })
          .from(amenities)
          .where(codes ? inArray(amenities.code, codes) : undefined);

  return new Map(rows.map((row) => [row.code, row]));
}

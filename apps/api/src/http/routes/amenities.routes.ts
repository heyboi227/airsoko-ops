import { randomUUID } from "node:crypto";
import { Router } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { cabinClassSchema, mutationOptionsSchema, type CabinClass } from "@airsoko/contracts";
import {
  evaluateAmenityAssignment,
  evaluateRemoveAmenityAssignment,
  resolveAmenities,
  resourceRef,
  type AmenityAssignment,
} from "@airsoko/domain";
import { db, type Executor } from "../../db/client.ts";
import {
  aircraft,
  aircraftCabins,
  amenities,
  amenityAssignments,
  fareProducts,
} from "../../db/schema/index.ts";
import { actorOf, requireAuth, requirePermission } from "../auth.ts";
import { ApiProblem, notFound, pathParam } from "../errors.ts";
import { runIntent } from "../../pipeline/runIntent.ts";

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
async function loadAssignments(
  executor: Executor = db,
): Promise<(AmenityAssignment & { amenityId: string })[]> {
  const rows = await executor
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

// --- Changing what is offered ------------------------------------------------

/**
 * Assignments can be created at aircraft and cabin scope.
 *
 * Fare-product scope waits for Phase 6, when fare products exist to attach to,
 * and flight scope for Phase 3, when a flight can be picked. Both are modelled
 * and both resolve correctly today -- what is missing is the thing to point at,
 * not the mechanism. The UI says which, rather than offering a control that
 * would fail.
 */
const assignmentBodySchema = z
  .object({
    amenityId: z.uuid(),
    scope: z.enum(["aircraft", "cabin"]),
    included: z.boolean(),
    aircraftId: z.uuid().optional(),
    cabinClass: cabinClassSchema.optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((body) => (body.scope === "aircraft" ? Boolean(body.aircraftId) : true), {
    message: "An aircraft-scope assignment needs an aircraft.",
    path: ["aircraftId"],
  })
  .refine((body) => (body.scope === "cabin" ? Boolean(body.cabinClass) : true), {
    message: "A cabin-scope assignment needs a cabin class.",
    path: ["cabinClass"],
  });

/**
 * Every cabin the change could reach, so its effect can be counted exactly.
 *
 * An aircraft-scope row reaches that airframe's cabins. A cabin-scope row
 * reaches that class on every airframe that has one -- which is why the count
 * matters: "Economy" sounds like one thing and is twenty.
 */
async function reachableCabins(
  scope: "aircraft" | "cabin",
  target: {
    aircraftId?: string | undefined;
    cabinClass?: CabinClass | undefined;
  },
) {
  const rows = await db
    .select({
      aircraftId: aircraftCabins.aircraftId,
      cabinClass: aircraftCabins.cabinClass,
      registration: aircraft.registration,
    })
    .from(aircraftCabins)
    .innerJoin(aircraft, eq(aircraft.id, aircraftCabins.aircraftId))
    .where(
      scope === "aircraft"
        ? eq(aircraftCabins.aircraftId, target.aircraftId ?? "")
        : eq(aircraftCabins.cabinClass, target.cabinClass ?? "economy"),
    )
    .orderBy(aircraft.registration);

  return rows.map((row) => ({
    label:
      scope === "aircraft"
        ? CABIN_LABELS[row.cabinClass]
        : `${row.registration} ${CABIN_LABELS[row.cabinClass]}`,
    aircraftId: row.aircraftId,
    cabinClass: row.cabinClass,
  }));
}

const CABIN_LABELS: Readonly<Record<CabinClass, string>> = {
  business: "Business",
  premium_economy: "Premium Economy",
  economy: "Economy",
};

amenitiesRouter.post(
  "/assignments",
  requireAuth,
  requirePermission("commercial:write"),
  async (req, res) => {
    const { mutation: rawOptions, ...body } = req.body ?? {};
    const input = assignmentBodySchema.parse(body);
    const options = mutationOptionsSchema.parse(rawOptions ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const [amenity] = await db
      .select({ id: amenities.id, code: amenities.code, name: amenities.name })
      .from(amenities)
      .where(eq(amenities.id, input.amenityId))
      .limit(1);

    if (!amenity) throw notFound(`Amenity ${input.amenityId}`);

    if (input.scope === "aircraft") {
      const [airframe] = await db
        .select({ id: aircraft.id })
        .from(aircraft)
        .where(eq(aircraft.id, input.aircraftId ?? ""))
        .limit(1);
      if (!airframe) throw notFound(`Aircraft ${input.aircraftId}`);
    }

    const affectedContexts = await reachableCabins(input.scope, {
      aircraftId: input.aircraftId,
      cabinClass: input.cabinClass,
    });

    const id = randomUUID();

    const outcome = await runIntent({
      intent: "amenity.assign",
      actor,
      options,
      now,
      evaluate: async (tx) =>
        evaluateAmenityAssignment(
          {
            amenityId: amenity.id,
            amenityCode: amenity.code,
            amenityName: amenity.name,
            scope: input.scope,
            included: input.included,
            aircraftId: input.aircraftId ?? null,
            cabinClass: input.cabinClass ?? null,
            note: input.note ?? null,
          },
          { existing: await loadAssignments(tx), affectedContexts },
        ),
      apply: async (tx) => {
        await tx.insert(amenityAssignments).values({
          id,
          amenityId: amenity.id,
          scope: input.scope,
          included: input.included,
          aircraftId: input.aircraftId ?? null,
          cabinClass: input.cabinClass ?? null,
          fareProductId: null,
          flightInstanceId: null,
          note: input.note?.trim() || null,
          createdAt: now,
          updatedAt: now,
        });

        return {
          value: { id, amenityCode: amenity.code, included: input.included },
          audit: {
            action: "amenity.assign",
            resource: resourceRef("amenity", amenity.id, amenity.name),
            newValue: {
              scope: input.scope,
              included: input.included,
              aircraftId: input.aircraftId ?? null,
              cabinClass: input.cabinClass ?? null,
              note: input.note ?? null,
            },
          },
        };
      },
    });

    if (outcome.status === "preview") {
      res.status(200).json(outcome.preview);
      return;
    }
    res.status(201).json({ assignment: outcome.value, preview: outcome.preview });
  },
);

/**
 * Removing an assignment.
 *
 * POST rather than DELETE, matching the station list: the mutation options --
 * preview, acknowledgements, reason -- travel in the body, and a DELETE with a
 * meaningful body is a fight with every intermediary in the path.
 */
amenitiesRouter.post(
  "/assignments/:id/remove",
  requireAuth,
  requirePermission("commercial:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const options = mutationOptionsSchema.parse(req.body?.mutation ?? req.body ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const [current] = await db
      .select({
        id: amenityAssignments.id,
        amenityId: amenityAssignments.amenityId,
        amenityCode: amenities.code,
        amenityName: amenities.name,
        scope: amenityAssignments.scope,
        included: amenityAssignments.included,
        aircraftId: amenityAssignments.aircraftId,
        cabinClass: amenityAssignments.cabinClass,
        note: amenityAssignments.note,
      })
      .from(amenityAssignments)
      .innerJoin(amenities, eq(amenities.id, amenityAssignments.amenityId))
      .where(eq(amenityAssignments.id, id))
      .limit(1);

    if (!current) throw notFound(`Amenity assignment ${id}`);
    if (current.scope !== "aircraft" && current.scope !== "cabin") {
      throw new ApiProblem(
        "CONFLICT",
        `${current.amenityName} is assigned at ${current.scope.replace(/_/g, " ")} scope, which is edited in a later phase.`,
      );
    }

    const affectedContexts = await reachableCabins(current.scope, {
      aircraftId: current.aircraftId ?? undefined,
      cabinClass: current.cabinClass ?? undefined,
    });

    const outcome = await runIntent({
      intent: "amenity.unassign",
      actor,
      options,
      now,
      evaluate: async (tx) =>
        evaluateRemoveAmenityAssignment(
          {
            id: current.id,
            amenityId: current.amenityId,
            amenityCode: current.amenityCode,
            amenityName: current.amenityName,
            scope: current.scope,
            included: current.included,
          },
          { existing: await loadAssignments(tx), affectedContexts },
        ),
      apply: async (tx) => {
        await tx.delete(amenityAssignments).where(eq(amenityAssignments.id, id));

        return {
          value: { id },
          audit: {
            action: "amenity.unassign",
            resource: resourceRef("amenity", current.amenityId, current.amenityName),
            previousValue: {
              scope: current.scope,
              included: current.included,
              aircraftId: current.aircraftId,
              cabinClass: current.cabinClass,
              note: current.note,
            },
          },
        };
      },
    });

    if (outcome.status === "preview") {
      res.status(200).json(outcome.preview);
      return;
    }
    res.json({ removed: outcome.value, preview: outcome.preview });
  },
);

/** The assignments on one airframe, with their ids, so they can be removed. */
amenitiesRouter.get(
  "/assignments",
  requireAuth,
  requirePermission("commercial:read"),
  async (req, res) => {
    const query = z
      .object({ aircraftId: z.uuid().optional(), cabinClass: cabinClassSchema.optional() })
      .parse(req.query);

    const rows = await db
      .select({
        id: amenityAssignments.id,
        amenityId: amenityAssignments.amenityId,
        amenityCode: amenities.code,
        amenityName: amenities.name,
        category: amenities.category,
        scope: amenityAssignments.scope,
        included: amenityAssignments.included,
        aircraftId: amenityAssignments.aircraftId,
        cabinClass: amenityAssignments.cabinClass,
        note: amenityAssignments.note,
      })
      .from(amenityAssignments)
      .innerJoin(amenities, eq(amenities.id, amenityAssignments.amenityId))
      .orderBy(asc(amenities.name));

    const items = rows.filter((row) => {
      if (query.aircraftId && row.scope === "aircraft")
        return row.aircraftId === query.aircraftId;
      if (query.cabinClass && row.scope === "cabin") return row.cabinClass === query.cabinClass;
      if (query.aircraftId || query.cabinClass) return false;
      return true;
    });

    res.json({ items, total: items.length });
  },
);

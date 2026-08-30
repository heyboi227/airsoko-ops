import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aircraftServiceabilitySchema,
  cabinClassSchema,
  mutationOptionsSchema,
  SERVICEABILITY_LABELS,
} from "@airsoko/contracts";
import {
  cabinSeatCount,
  draftSeatCapacity,
  evaluateRegisterAircraft,
  evaluateRetireAircraft,
  evaluateWithdrawAircraft,
  resolveAmenities,
  resourceRef,
} from "@airsoko/domain";
import { db, type Executor } from "../../db/client.ts";
import {
  aircraft,
  aircraftCabins,
  aircraftTypes,
  airports,
  amenities,
  amenityAssignments,
  flightInstances,
  seats,
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

// --- Registering an airframe ------------------------------------------------

/**
 * A cabin, as the operator describes it.
 *
 * `seatCount` is deliberately absent. It is the product of the rows and the
 * letters, and accepting it as input would let a form disagree with itself
 * before the record even reached the database.
 *
 * The layout is written the way an airline writes it -- "ABC-DEF", "AC-DF",
 * "A-CD-F" -- with the dashes marking aisles. One field then gives three
 * facts: which letters exist, which seats are windows, and which are on an
 * aisle. Only the letters are stored on the cabin; the aisle positions land on
 * the individual seats, which is the only place anything reads them.
 */
const cabinDraftSchema = z.object({
  cabinClass: cabinClassSchema,
  firstRow: z.number().int().min(1).max(99),
  lastRow: z.number().int().min(1).max(99),
  layout: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(
      /^[A-Za-z]+(-[A-Za-z]+)*$/,
      'Write the layout as seat letters with dashes for aisles, e.g. "ABC-DEF".',
    ),
  pitchInches: z.number().int().min(26).max(90),
});

const createAircraftSchema = z.object({
  registration: z
    .string()
    .trim()
    .min(3)
    .max(10)
    .regex(/^[A-Za-z0-9-]+$/, "A registration is letters, digits and hyphens."),
  serialNumber: z.string().trim().min(1).max(20),
  name: z.string().trim().max(60).optional(),
  aircraftTypeId: z.uuid(),
  deliveredOn: z.iso.date(),
  baseAirportId: z.uuid().optional(),
  totalHours: z.number().int().min(0).max(200_000).optional(),
  totalCycles: z.number().int().min(0).max(200_000).optional(),
  notes: z.string().trim().max(500).optional(),
  cabins: z.array(cabinDraftSchema).min(1).max(4),
});

interface ParsedLayout {
  letters: string;
  /** Letters with an aisle on at least one side. */
  aisleLetters: string;
}

function parseLayout(layout: string): ParsedLayout {
  const groups = layout.trim().toUpperCase().split("-");
  const aisle = new Set<string>();

  for (let index = 0; index < groups.length - 1; index += 1) {
    const left = groups[index];
    const right = groups[index + 1];
    if (left) aisle.add(left[left.length - 1] as string);
    if (right) aisle.add(right[0] as string);
  }

  return { letters: groups.join(""), aisleLetters: [...aisle].join("") };
}

fleetRouter.post("/", requireAuth, requirePermission("aircraft:write"), async (req, res) => {
  const { mutation: rawOptions, ...body } = req.body ?? {};
  const input = createAircraftSchema.parse(body);
  const options = mutationOptionsSchema.parse(rawOptions ?? {});
  const actor = actorOf(req);
  const now = new Date().toISOString();

  const [type] = await db
    .select({
      id: aircraftTypes.id,
      icaoTypeCode: aircraftTypes.icaoTypeCode,
      manufacturer: aircraftTypes.manufacturer,
      model: aircraftTypes.model,
    })
    .from(aircraftTypes)
    .where(eq(aircraftTypes.id, input.aircraftTypeId))
    .limit(1);

  if (!type) throw notFound(`Aircraft type ${input.aircraftTypeId}`);

  const registration = input.registration.trim().toUpperCase();
  const layouts = input.cabins.map((cabin) => parseLayout(cabin.layout));
  const draftCabins = input.cabins.map((cabin, index) => ({
    cabinClass: cabin.cabinClass,
    firstRow: cabin.firstRow,
    lastRow: cabin.lastRow,
    seatLetters: layouts[index]?.letters ?? "",
    pitchInches: cabin.pitchInches,
  }));

  const id = randomUUID();

  const outcome = await runIntent({
    intent: "aircraft.create",
    actor,
    options,
    now,
    evaluate: async (tx) =>
      evaluateRegisterAircraft(
        {
          registration,
          serialNumber: input.serialNumber,
          deliveredOn: input.deliveredOn,
          aircraftTypeId: input.aircraftTypeId,
          cabins: draftCabins,
        },
        { existing: await loadAirframes(tx), today: now.slice(0, 10) },
      ),
    apply: async (tx) => {
      await tx.insert(aircraft).values({
        id,
        registration,
        aircraftTypeId: input.aircraftTypeId,
        serialNumber: input.serialNumber.trim(),
        name: input.name?.trim() || null,
        deliveredOn: input.deliveredOn,
        serviceability: "in_service",
        baseAirportId: input.baseAirportId ?? null,
        totalHours: input.totalHours ?? 0,
        totalCycles: input.totalCycles ?? 0,
        notes: input.notes?.trim() || null,
        active: true,
        createdAt: now,
        updatedAt: now,
      });

      // Cabins and their seats in the same transaction as the airframe. A tail
      // that existed for even a moment with no cabins would be an aircraft
      // with no seats, and capacity is summed from exactly these rows.
      const seatRows: (typeof seats.$inferInsert)[] = [];

      for (const [index, cabin] of draftCabins.entries()) {
        const cabinId = randomUUID();
        const layout = layouts[index];
        const letters = [...(layout?.letters ?? "")];

        await tx.insert(aircraftCabins).values({
          id: cabinId,
          aircraftId: id,
          cabinClass: cabin.cabinClass,
          seatCount: cabinSeatCount(cabin),
          firstRow: cabin.firstRow,
          lastRow: cabin.lastRow,
          seatLetters: cabin.seatLetters,
          pitchInches: cabin.pitchInches,
          createdAt: now,
          updatedAt: now,
        });

        for (let row = cabin.firstRow; row <= cabin.lastRow; row += 1) {
          for (const letter of letters) {
            seatRows.push({
              id: randomUUID(),
              aircraftId: id,
              cabinId,
              cabinClass: cabin.cabinClass,
              row,
              letter,
              label: `${row}${letter}`,
              isWindow: letter === letters[0] || letter === letters[letters.length - 1],
              isAisle: (layout?.aisleLetters ?? "").includes(letter),
              // Exit rows are not known at registration; the front row of a
              // cabin always has the legroom, and that much is structural.
              isExitRow: false,
              isExtraLegroom: row === cabin.firstRow,
              isServiceable: true,
            });
          }
        }
      }

      for (const batch of chunk(seatRows, 500)) {
        await tx.insert(seats).values(batch);
      }

      const capacity = draftSeatCapacity(draftCabins);

      return {
        value: { id, registration, seatCapacity: capacity, seats: seatRows.length },
        audit: {
          action: "aircraft.create",
          resource: resourceRef("aircraft", id, registration),
          newValue: {
            registration,
            serialNumber: input.serialNumber.trim(),
            type: type.icaoTypeCode,
            deliveredOn: input.deliveredOn,
            // The layout, not the total: the total is derivable from it, and
            // recording both would put a stale copy in the audit trail too.
            cabins: draftCabins,
          },
        },
      };
    },
  });

  if (outcome.status === "preview") {
    res.status(200).json(outcome.preview);
    return;
  }
  res.status(201).json({ aircraft: outcome.value, preview: outcome.preview });
});

/** Aircraft types, so the registration form can offer the ones on file. */
fleetRouter.get(
  "/types/list",
  requireAuth,
  requirePermission("aircraft:read"),
  async (_req, res) => {
    const items = await db
      .select({
        id: aircraftTypes.id,
        icaoTypeCode: aircraftTypes.icaoTypeCode,
        manufacturer: aircraftTypes.manufacturer,
        model: aircraftTypes.model,
        variant: aircraftTypes.variant,
        bodyType: aircraftTypes.bodyType,
        rangeNm: aircraftTypes.rangeNm,
      })
      .from(aircraftTypes)
      .orderBy(aircraftTypes.manufacturer, aircraftTypes.model);

    res.json({ items, total: items.length });
  },
);

/** Every airframe, in the shape the registration rules read. */
async function loadAirframes(executor: Executor = db) {
  const rows = await executor
    .select({
      id: aircraft.id,
      registration: aircraft.registration,
      serialNumber: aircraft.serialNumber,
      aircraftTypeId: aircraft.aircraftTypeId,
      seatCapacity: sql<number>`coalesce(sum(${aircraftCabins.seatCount}), 0)::int`,
      active: aircraft.active,
    })
    .from(aircraft)
    .leftJoin(aircraftCabins, eq(aircraftCabins.aircraftId, aircraft.id))
    .groupBy(aircraft.id);

  return rows.map((row) => ({ ...row, retired: !row.active }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/**
 * Taking an airframe off the register.
 *
 * Distinct from `out_of_service`, which is still the airline's aircraft and
 * still on the books. Retiring means it has left the fleet -- sold, returned to
 * the lessor, scrapped -- and it stops appearing anywhere. The `active` column
 * has existed since the schema was written and `loadFleet` has always respected
 * it; nothing set it until now.
 *
 * It exists mainly because registering an airframe without it is a trap: a
 * mistyped registration would otherwise be permanent.
 *
 * The record is kept rather than deleted. Flights it flew still reference it,
 * and an audit trail pointing at a row that no longer exists is not a trail.
 */
fleetRouter.post(
  "/:id/retire",
  requireAuth,
  requirePermission("aircraft:write"),
  async (req, res) => {
    const id = pathParam(req, "id");
    const options = mutationOptionsSchema.parse(req.body?.mutation ?? req.body ?? {});
    const actor = actorOf(req);
    const now = new Date().toISOString();

    const [current] = await db
      .select({
        id: aircraft.id,
        registration: aircraft.registration,
        serviceability: aircraft.serviceability,
        active: aircraft.active,
      })
      .from(aircraft)
      .where(eq(aircraft.id, id))
      .limit(1);

    if (!current) throw notFound(`Aircraft ${id}`);
    if (!current.active) {
      throw new ApiProblem("CONFLICT", `${current.registration} has already been retired.`);
    }

    const outcome = await runIntent({
      intent: "aircraft.retire",
      actor,
      options,
      now,
      evaluate: async (tx) => {
        const upcoming = await upcomingSectors(id, now, tx);
        return evaluateRetireAircraft(current, upcoming);
      },
      apply: async (tx) => {
        await tx
          .update(aircraft)
          .set({ active: false, serviceability: "out_of_service", updatedAt: now })
          .where(eq(aircraft.id, id));

        return {
          value: { id, registration: current.registration },
          audit: {
            action: "aircraft.retire",
            resource: resourceRef("aircraft", id, current.registration),
            previousValue: { active: true, serviceability: current.serviceability },
            newValue: { active: false, serviceability: "out_of_service" },
          },
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

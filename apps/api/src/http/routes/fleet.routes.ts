import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aircraftServiceabilitySchema,
  booleanFlagSchema,
  cabinClassSchema,
  idSchema,
  mutationOptionsSchema,
  SERVICEABILITY_LABELS,
  type CabinConfiguration,
  type FleetConfiguration,
  type TypeConfigurations,
} from "@airsoko/contracts";
import {
  cabinSeatCount,
  draftSeatCapacity,
  evaluateRegisterAircraft,
  evaluateRetireAircraft,
  evaluateWithdrawAircraft,
  formatCabinLayout,
  parseCabinLayout,
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
  maintenanceDue: booleanFlagSchema.optional(),
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

/**
 * Sectors this airframe is still due to fly.
 *
 * "Due to fly" as the fleet state reads it: by the departure now expected --
 * actual if it has one, else estimated, else scheduled. A delayed flight past
 * its published time has not gone anywhere, and withdrawing its airframe
 * strands it like any other. Filtering on the scheduled time alone dropped
 * exactly those, so for the minutes between the two times the warning named
 * the sector *after* the one the fleet page showed as next.
 */
async function upcomingSectors(aircraftId: string, now: string, executor: Executor = db) {
  const origin = airports;
  const expectedDeparture = sql`coalesce(
    ${flightInstances.actualDeparture},
    ${flightInstances.estimatedDeparture},
    ${flightInstances.scheduledDeparture}
  )`;
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
        gt(expectedDeparture, now),
        ne(flightInstances.status, "cancelled"),
      ),
    )
    .orderBy(expectedDeparture);

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
  const layouts = input.cabins.map((cabin) => parseCabinLayout(cabin.layout));
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
        // Read by the route form, which offers a block time from the cruise
        // speed of the type a pair is planned on.
        cruiseSpeedKts: aircraftTypes.cruiseSpeedKts,
      })
      .from(aircraftTypes)
      .orderBy(aircraftTypes.manufacturer, aircraftTypes.model);

    res.json({ items, total: items.length });
  },
);

/**
 * How this type is fitted out, and which tails are fitted that way.
 *
 * Autofill for the registration form, and the counterpart to the station
 * lookup -- except that here there is no reference to consult. An airport's
 * coordinates are a fact about the world someone else has already recorded; an
 * aircraft's cabin is the airline's own decision, and the only place it is
 * written down is the fleet already on file. So this asks the fleet. A new
 * tail of an existing type is fitted like its siblings almost every time, and
 * the rare one that is not is exactly what
 * `AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET` exists to notice on save.
 *
 * Retired airframes are excluded, matching that rule: a layout that has left
 * the fleet is not the one to copy.
 *
 * Two things are reconstructed rather than read. The layout string, because
 * only the letters live on the cabin and the aisles on the seats -- decision
 * 22 -- so the notation has to be put back together from both. And the seat
 * count, computed from the layout being offered rather than taken from the
 * stored column, so the number the form shows cannot disagree with the layout
 * it is showing beside it.
 */
fleetRouter.get(
  "/types/:id/configurations",
  requireAuth,
  requirePermission("aircraft:read"),
  async (req, res) => {
    const typeId = idSchema.parse(pathParam(req, "id"));

    const [type] = await db
      .select({ id: aircraftTypes.id, icaoTypeCode: aircraftTypes.icaoTypeCode })
      .from(aircraftTypes)
      .where(eq(aircraftTypes.id, typeId))
      .limit(1);

    if (!type) throw notFound(`Aircraft type ${typeId}`);

    const rows = await db
      .select({
        aircraftId: aircraft.id,
        registration: aircraft.registration,
        baseAirportId: aircraft.baseAirportId,
        baseIata: airports.iataCode,
        baseName: airports.name,
        cabinId: aircraftCabins.id,
        cabinClass: aircraftCabins.cabinClass,
        firstRow: aircraftCabins.firstRow,
        lastRow: aircraftCabins.lastRow,
        seatLetters: aircraftCabins.seatLetters,
        pitchInches: aircraftCabins.pitchInches,
      })
      .from(aircraft)
      .innerJoin(aircraftCabins, eq(aircraftCabins.aircraftId, aircraft.id))
      .leftJoin(airports, eq(airports.id, aircraft.baseAirportId))
      .where(and(eq(aircraft.aircraftTypeId, typeId), eq(aircraft.active, true)))
      .orderBy(asc(aircraft.registration), asc(aircraftCabins.firstRow));

    const aisleLetters = await aisleLettersByCabin(rows.map((row) => row.cabinId));

    const byAirframe = new Map<string, Airframe>();
    for (const row of rows) {
      let entry = byAirframe.get(row.aircraftId);
      if (!entry) {
        entry = {
          registration: row.registration,
          baseAirportId: row.baseAirportId,
          baseIata: row.baseIata,
          baseName: row.baseName,
          cabins: [],
        };
        byAirframe.set(row.aircraftId, entry);
      }
      entry.cabins.push({
        cabinClass: row.cabinClass,
        firstRow: row.firstRow,
        lastRow: row.lastRow,
        layout: formatCabinLayout(row.seatLetters, aisleLetters.get(row.cabinId) ?? ""),
        pitchInches: row.pitchInches,
        seatCount: cabinSeatCount(row),
      });
    }

    // Airframes fitted identically collapse into one offer that names them
    // all. Two A320s with the same cabins are one choice, not two.
    const grouped = new Map<string, FleetConfiguration>();
    for (const [id, airframe] of byAirframe) {
      const key = configurationKey(airframe.cabins);
      const existing = grouped.get(key);
      if (existing) {
        existing.aircraft.push({ id, registration: airframe.registration });
        continue;
      }
      grouped.set(key, {
        cabins: airframe.cabins,
        seatCapacity: airframe.cabins.reduce((total, cabin) => total + cabin.seatCount, 0),
        aircraft: [{ id, registration: airframe.registration }],
      });
    }

    // Most-flown first -- that is the one the form applies. Ties break on
    // capacity and then on registration, so the offer does not reshuffle
    // between two identical requests.
    const configurations = [...grouped.values()].sort(
      (a, b) =>
        b.aircraft.length - a.aircraft.length ||
        b.seatCapacity - a.seatCapacity ||
        (a.aircraft[0]?.registration ?? "").localeCompare(b.aircraft[0]?.registration ?? ""),
    );

    const payload: TypeConfigurations = {
      typeId: type.id,
      icaoTypeCode: type.icaoTypeCode,
      onFile: byAirframe.size,
      configurations,
      base: commonBase([...byAirframe.values()]),
    };

    res.json(payload);
  },
);

interface Airframe {
  registration: string;
  baseAirportId: string | null;
  baseIata: string | null;
  baseName: string | null;
  cabins: CabinConfiguration[];
}

/** Two airframes are fitted the same way when every cabin matches. */
function configurationKey(cabins: readonly CabinConfiguration[]): string {
  return cabins
    .map(
      (cabin) =>
        `${cabin.cabinClass}:${cabin.firstRow}-${cabin.lastRow}:${cabin.layout}@${cabin.pitchInches}`,
    )
    .join("|");
}

/**
 * Which letters sit on an aisle, per cabin.
 *
 * The seats are the only place this is recorded, and one row of any cabin
 * answers it for the whole cabin -- so this asks for the distinct letters
 * flagged, not for three thousand seat rows.
 */
async function aisleLettersByCabin(cabinIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(cabinIds)];
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      cabinId: seats.cabinId,
      letters: sql<string>`string_agg(distinct ${seats.letter}, '' order by ${seats.letter})`,
    })
    .from(seats)
    .where(and(inArray(seats.cabinId, ids), eq(seats.isAisle, true)))
    .groupBy(seats.cabinId);

  return new Map(rows.map((row) => [row.cabinId, row.letters]));
}

/**
 * Where most of this sub-fleet sits.
 *
 * Reported with the count rather than as a bare answer, because a base is a
 * weaker suggestion than a cabin: the ATR sub-fleet is mostly at BEG and one
 * tail is not, and the form should be able to say so instead of quietly
 * choosing for the operator.
 */
function commonBase(airframes: readonly Airframe[]): TypeConfigurations["base"] {
  const counts = new Map<string, { iataCode: string; name: string; sharedBy: number }>();

  for (const airframe of airframes) {
    if (!airframe.baseAirportId || !airframe.baseIata || !airframe.baseName) continue;
    const found = counts.get(airframe.baseAirportId);
    if (found) found.sharedBy += 1;
    else
      counts.set(airframe.baseAirportId, {
        iataCode: airframe.baseIata,
        name: airframe.baseName,
        sharedBy: 1,
      });
  }

  const [top] = [...counts.entries()].sort(
    (a, b) => b[1].sharedBy - a[1].sharedBy || a[1].iataCode.localeCompare(b[1].iataCode),
  );

  return top ? { id: top[0], ...top[1] } : null;
}

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

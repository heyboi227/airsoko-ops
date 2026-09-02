import { and, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import { db } from "../client.ts";
import {
  aircraft,
  aircraftCabins,
  aircraftTypes,
  airlines,
  flightInstances,
  recurringSchedules,
  routes,
  seats,
} from "../schema/index.ts";
import { airportId, seededId } from "../ids.ts";
import { SEED_AIRCRAFT, SEED_AIRCRAFT_TYPES } from "./reference/fleet.ts";
import { MARKETING_CODE } from "./reference/network-plan.ts";
import type { SeedStation } from "./reference/index.ts";
import {
  assignRotations,
  buildFlights,
  buildRoutes,
  buildSchedules,
  type GeneratedFlight,
} from "./generate.ts";
import { unserviceableRegistrations } from "./maintenance.ts";

/**
 * Seeds the operating airline: fleet, network, schedules and today's flights.
 *
 * Everything here derives from two authored sources -- the fleet in
 * `reference/fleet.ts` and the commercial plan in `reference/network-plan.ts`.
 * Change a frequency in the plan and the routes, the schedule, the flights and
 * the aircraft rotations all move together, because none of them is written
 * down twice.
 */

const SEED_EPOCH = "2026-01-01T00:00:00.000Z";

export const AIR_SOKO = {
  id: seededId("airline", MARKETING_CODE),
  iataCode: MARKETING_CODE,
  icaoCode: "ASO",
  name: "Air Soko",
  callsignPrefix: "SOKO",
} as const;

/** Codeshare partners, so marketing-versus-operating has something to show. */
const PARTNER_AIRLINES = [
  { iataCode: "LH", icaoCode: "DLH", name: "Lufthansa", callsignPrefix: "LUFTHANSA" },
  { iataCode: "AF", icaoCode: "AFR", name: "Air France", callsignPrefix: "AIRFRANS" },
  { iataCode: "TK", icaoCode: "THY", name: "Turkish Airlines", callsignPrefix: "TURKISH" },
];

export async function seedAirlines(): Promise<number> {
  const rows = [
    { ...AIR_SOKO, isOperator: true, createdAt: SEED_EPOCH, updatedAt: SEED_EPOCH },
    ...PARTNER_AIRLINES.map((partner) => ({
      id: seededId("airline", partner.iataCode),
      ...partner,
      isOperator: false,
      createdAt: SEED_EPOCH,
      updatedAt: SEED_EPOCH,
    })),
  ];

  await db
    .insert(airlines)
    .values(rows)
    .onConflictDoUpdate({
      target: airlines.id,
      set: {
        name: sql`excluded.name`,
        icaoCode: sql`excluded.icao_code`,
        callsignPrefix: sql`excluded.callsign_prefix`,
        isOperator: sql`excluded.is_operator`,
        updatedAt: SEED_EPOCH,
      },
    });

  return rows.length;
}

export async function seedAircraftTypes(): Promise<number> {
  const rows = SEED_AIRCRAFT_TYPES.map((type) => ({
    id: seededId("aircraft_type", type.icaoTypeCode),
    icaoTypeCode: type.icaoTypeCode,
    iataTypeCode: type.iataTypeCode,
    manufacturer: type.manufacturer,
    model: type.model,
    variant: type.variant,
    bodyType: type.bodyType,
    engineModel: type.engineModel,
    rangeNm: type.rangeNm,
    cruiseSpeedKts: type.cruiseSpeedKts,
    serviceCeilingFt: type.serviceCeilingFt,
    minimumTurnaroundMinutes: type.minimumTurnaroundMinutes,
    createdAt: SEED_EPOCH,
    updatedAt: SEED_EPOCH,
  }));

  await db
    .insert(aircraftTypes)
    .values(rows)
    .onConflictDoUpdate({
      target: aircraftTypes.id,
      set: {
        rangeNm: sql`excluded.range_nm`,
        cruiseSpeedKts: sql`excluded.cruise_speed_kts`,
        minimumTurnaroundMinutes: sql`excluded.minimum_turnaround_minutes`,
        updatedAt: SEED_EPOCH,
      },
    });

  return rows.length;
}

/**
 * Airframes, their cabin layouts and every physical seat.
 *
 * Capacity is never written to the aircraft row: it is the sum of the cabins,
 * so a layout change cannot leave a stale total behind. Scenario F depends on
 * that being true.
 */
export async function seedFleet(): Promise<{ tails: number; cabins: number; seats: number }> {
  const typeByCode = new Map(SEED_AIRCRAFT_TYPES.map((type) => [type.icaoTypeCode, type]));

  const aircraftRows = SEED_AIRCRAFT.map((entry) => {
    const type = typeByCode.get(entry.icaoTypeCode);
    if (!type)
      throw new Error(`${entry.registration} references unknown type ${entry.icaoTypeCode}`);

    return {
      id: seededId("aircraft", entry.registration),
      registration: entry.registration,
      aircraftTypeId: seededId("aircraft_type", entry.icaoTypeCode),
      serialNumber: entry.serialNumber,
      name: entry.name,
      deliveredOn: entry.deliveredOn,
      serviceability: entry.unavailable?.status ?? ("in_service" as const),
      // Where the airline bases the tail. Its actual position comes from the
      // last flight it flew -- see deriveFleetState.
      baseAirportId: airportId(entry.baseIata),
      // Hours and cycles scale with age, so an older tail reads as older.
      totalHours: hoursForAge(entry.deliveredOn, type.icaoTypeCode),
      totalCycles: cyclesForAge(entry.deliveredOn, type.icaoTypeCode),
      notes: entry.unavailable?.note ?? null,
      active: true,
      createdAt: SEED_EPOCH,
      updatedAt: SEED_EPOCH,
    };
  });

  await db
    .insert(aircraft)
    .values(aircraftRows)
    .onConflictDoUpdate({
      target: aircraft.id,
      set: {
        serviceability: sql`excluded.serviceability`,
        baseAirportId: sql`excluded.base_airport_id`,
        totalHours: sql`excluded.total_hours`,
        totalCycles: sql`excluded.total_cycles`,
        notes: sql`excluded.notes`,
        updatedAt: SEED_EPOCH,
      },
    });

  const cabinRows: (typeof aircraftCabins.$inferInsert)[] = [];
  const seatRows: (typeof seats.$inferInsert)[] = [];

  for (const entry of SEED_AIRCRAFT) {
    const type = typeByCode.get(entry.icaoTypeCode);
    if (!type) continue;

    for (const cabin of type.cabins) {
      const cabinId = seededId("cabin", `${entry.registration}:${cabin.cabinClass}`);
      const rowCount = cabin.lastRow - cabin.firstRow + 1;

      cabinRows.push({
        id: cabinId,
        aircraftId: seededId("aircraft", entry.registration),
        cabinClass: cabin.cabinClass,
        seatCount: rowCount * cabin.seatLetters.length,
        firstRow: cabin.firstRow,
        lastRow: cabin.lastRow,
        seatLetters: cabin.seatLetters,
        pitchInches: cabin.pitchInches,
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      });

      const firstLetter = cabin.seatLetters[0];
      const lastLetter = cabin.seatLetters[cabin.seatLetters.length - 1];

      for (let row = cabin.firstRow; row <= cabin.lastRow; row += 1) {
        for (const letter of cabin.seatLetters) {
          const label = `${row}${letter}`;
          const isExitRow = cabin.exitRows?.includes(row) ?? false;
          seatRows.push({
            id: seededId("seat", `${entry.registration}:${label}`),
            aircraftId: seededId("aircraft", entry.registration),
            cabinId,
            cabinClass: cabin.cabinClass,
            row,
            letter,
            label,
            isWindow: letter === firstLetter || letter === lastLetter,
            isAisle: cabin.aisleLetters.includes(letter),
            isExitRow,
            // Exit rows and the front row of a cabin have the legroom.
            isExtraLegroom: isExitRow || row === cabin.firstRow,
            isServiceable: true,
          });
        }
      }
    }
  }

  await db
    .insert(aircraftCabins)
    .values(cabinRows)
    .onConflictDoUpdate({
      target: aircraftCabins.id,
      set: { seatCount: sql`excluded.seat_count`, updatedAt: SEED_EPOCH },
    });

  // Seats go in batches: a single statement with 3,000 rows exceeds what the
  // driver will bind in one go.
  for (const batch of chunk(seatRows, 500)) {
    await db.insert(seats).values(batch).onConflictDoNothing();
  }

  return { tails: aircraftRows.length, cabins: cabinRows.length, seats: seatRows.length };
}

export async function seedNetwork(
  stations: readonly SeedStation[],
  referenceDate: string,
  now: string,
): Promise<{
  routes: number;
  schedules: number;
  flights: number;
  assigned: number;
  unassigned: GeneratedFlight[];
  rotationDelays: number;
}> {
  const generatedRoutes = buildRoutes(stations);

  await db
    .insert(routes)
    .values(
      generatedRoutes.map((route) => ({
        id: route.id,
        originAirportId: airportId(route.originIata),
        destinationAirportId: airportId(route.destinationIata),
        distanceNm: route.distanceNm,
        blockMinutes: route.blockMinutes,
        status: route.season ? ("seasonal" as const) : ("active" as const),
        typicalAircraftTypeId: seededId("aircraft_type", route.plannedTypeCode),
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      })),
    )
    .onConflictDoUpdate({
      target: routes.id,
      set: {
        distanceNm: sql`excluded.distance_nm`,
        blockMinutes: sql`excluded.block_minutes`,
        status: sql`excluded.status`,
        updatedAt: SEED_EPOCH,
      },
    });

  const generatedSchedules = buildSchedules(generatedRoutes, stations, referenceDate);

  // Remove schedules this seed used to generate and no longer does. Same
  // reasoning as the flights below -- upserting alone leaves a retired route or
  // a renumbered service behind for ever -- and the same ownership marker, so
  // only rows this seed created are touched.
  //
  // There is no window to scope this by: a schedule is not dated, so the
  // generated set is the whole of what ought to exist. A stale flight still
  // pointing at one of these loses the link rather than blocking the delete,
  // because `schedule_id` is ON DELETE SET NULL.
  const scheduleIds = generatedSchedules.map((schedule) => schedule.id);
  if (scheduleIds.length > 0) {
    await db
      .delete(recurringSchedules)
      .where(
        and(
          eq(recurringSchedules.createdAt, SEED_EPOCH),
          notInArray(recurringSchedules.id, scheduleIds),
        ),
      );
  }

  await db
    .insert(recurringSchedules)
    .values(
      generatedSchedules.map((schedule) => ({
        id: schedule.id,
        flightNumber: schedule.flightNumber,
        airlineId: AIR_SOKO.id,
        routeId: seededId("route", schedule.routeKey),
        // A season, not a lifetime: the window is what makes "this and future
        // occurrences" a meaningful edit scope in Phase 3.
        validFrom: "2026-03-29",
        validTo: "2026-10-24",
        operatingDays: schedule.operatingDays,
        departureLocalTime: schedule.departureLocalTime,
        arrivalLocalTime: schedule.arrivalLocalTime,
        arrivalDayOffset: schedule.arrivalDayOffset,
        aircraftTypeId: seededId("aircraft_type", schedule.plannedTypeCode),
        defaultAircraftId: null,
        flightType: "scheduled_passenger" as const,
        season: schedule.season,
        active: true,
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      })),
    )
    .onConflictDoUpdate({
      target: recurringSchedules.id,
      // The seed owns every column on a row it generated -- the same rule the
      // flight upsert below states, and for the same reason. An earlier version
      // updated only the times, so a season shortened by a "this and future"
      // edit survived a reseed and the pattern no longer matched the plan it
      // came from.
      set: {
        routeId: sql`excluded.route_id`,
        validFrom: sql`excluded.valid_from`,
        validTo: sql`excluded.valid_to`,
        departureLocalTime: sql`excluded.departure_local_time`,
        arrivalLocalTime: sql`excluded.arrival_local_time`,
        arrivalDayOffset: sql`excluded.arrival_day_offset`,
        operatingDays: sql`excluded.operating_days`,
        aircraftTypeId: sql`excluded.aircraft_type_id`,
        season: sql`excluded.season`,
        active: sql`excluded.active`,
        updatedAt: SEED_EPOCH,
      },
    });

  const generatedFlights = buildFlights(generatedSchedules, stations, referenceDate, now);
  const rotation = assignRotations(
    generatedFlights,
    now,
    unserviceableRegistrations(referenceDate, now),
  );

  const flightRows = generatedFlights.map((flight) => ({
    id: flight.id,
    scheduleId: flight.scheduleId,
    flightNumber: flight.flightNumber,
    callsign: flight.callsign,
    operatingAirlineId: AIR_SOKO.id,
    marketingAirlineId: null,
    marketingFlightNumber: null,
    routeId: seededId("route", flight.routeKey),
    originAirportId: airportId(flight.originIata),
    destinationAirportId: airportId(flight.destinationIata),
    serviceDate: flight.serviceDate,
    scheduledDeparture: flight.scheduledDeparture,
    estimatedDeparture: flight.estimatedDeparture,
    actualDeparture: flight.actualDeparture,
    scheduledArrival: flight.scheduledArrival,
    estimatedArrival: flight.estimatedArrival,
    actualArrival: flight.actualArrival,
    aircraftId: flight.registration ? seededId("aircraft", flight.registration) : null,
    status: flight.status,
    phase: flight.phase,
    flightType: "scheduled_passenger" as const,
    delayReason: flight.delayReason as never,
    delayNote: null,
    cancellationReason: flight.cancellationReason,
    departureTerminal: flight.departureTerminal,
    departureGate: flight.departureGate,
    checkInCounters: null,
    arrivalTerminal: null,
    arrivalGate: flight.arrivalGate,
    baggageCarousel: flight.baggageCarousel,
    notes: null,
    createdAt: SEED_EPOCH,
    updatedAt: SEED_EPOCH,
  }));

  // Remove flights this seed used to generate and no longer does.
  //
  // Upserting alone leaves orphans: change a flight number or a frequency and
  // the old rows stay behind for ever, still carrying whatever status they had
  // when they were last written. That is how "airborne with no aircraft"
  // appeared -- a state no operation can be in, quietly poisoning any metric
  // built on top of it.
  //
  // Only rows this seed created are touched. `created_at` is the marker: seeded
  // rows carry the fixed epoch, anything an operator made through the
  // application does not.
  const generatedIds = flightRows.map((row) => row.id);
  const windowStart = generatedFlights[0]?.serviceDate;
  const windowEnd = generatedFlights.at(-1)?.serviceDate;

  if (windowStart && windowEnd && generatedIds.length > 0) {
    await db
      .delete(flightInstances)
      .where(
        and(
          eq(flightInstances.createdAt, SEED_EPOCH),
          gte(flightInstances.serviceDate, windowStart),
          lte(flightInstances.serviceDate, windowEnd),
          notInArray(flightInstances.id, generatedIds),
        ),
      );
  }

  for (const batch of chunk(flightRows, 300)) {
    await db
      .insert(flightInstances)
      .values(batch)
      .onConflictDoUpdate({
        target: flightInstances.id,
        // The seed owns every column on a row it generated. An earlier version
        // updated only the volatile ones, which meant a changed schedule left
        // the old departure times in place on a reseed -- the fixture and the
        // database quietly disagreed, and the rotation was solving yesterday's
        // timetable.
        set: {
          scheduleId: sql`excluded.schedule_id`,
          callsign: sql`excluded.callsign`,
          routeId: sql`excluded.route_id`,
          originAirportId: sql`excluded.origin_airport_id`,
          destinationAirportId: sql`excluded.destination_airport_id`,
          scheduledDeparture: sql`excluded.scheduled_departure`,
          scheduledArrival: sql`excluded.scheduled_arrival`,
          estimatedDeparture: sql`excluded.estimated_departure`,
          estimatedArrival: sql`excluded.estimated_arrival`,
          actualDeparture: sql`excluded.actual_departure`,
          actualArrival: sql`excluded.actual_arrival`,
          aircraftId: sql`excluded.aircraft_id`,
          status: sql`excluded.status`,
          phase: sql`excluded.phase`,
          delayReason: sql`excluded.delay_reason`,
          cancellationReason: sql`excluded.cancellation_reason`,
          departureTerminal: sql`excluded.departure_terminal`,
          departureGate: sql`excluded.departure_gate`,
          arrivalGate: sql`excluded.arrival_gate`,
          baggageCarousel: sql`excluded.baggage_carousel`,
          updatedAt: SEED_EPOCH,
        },
      });
  }

  return {
    routes: generatedRoutes.length,
    schedules: generatedSchedules.length,
    flights: flightRows.length,
    assigned: rotation.assigned,
    unassigned: rotation.unassigned,
    rotationDelays: rotation.rotationDelays,
  };
}

// --- helpers ---------------------------------------------------------------

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** Airframe hours, scaled from delivery date and typical daily utilisation. */
function hoursForAge(deliveredOn: string, typeCode: string): number {
  const years = yearsSince(deliveredOn);
  const dailyHours = typeCode === "A332" ? 12 : typeCode === "AT76" ? 6 : 9;
  return Math.round(years * 365 * dailyHours * 0.82);
}

function cyclesForAge(deliveredOn: string, typeCode: string): number {
  const years = yearsSince(deliveredOn);
  const dailySectors = typeCode === "A332" ? 1.2 : typeCode === "AT76" ? 6 : 4;
  return Math.round(years * 365 * dailySectors * 0.82);
}

/** Measured against the seed epoch, not the clock, so it stays reproducible. */
function yearsSince(date: string): number {
  const then = Date.parse(`${date}T00:00:00.000Z`);
  return Math.max(0, (Date.parse(SEED_EPOCH) - then) / (365.25 * 24 * 3600 * 1000));
}

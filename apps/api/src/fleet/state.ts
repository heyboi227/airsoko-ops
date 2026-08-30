import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  DEFAULT_POLICY,
  deriveFleetState,
  maintenanceStanding,
  type FleetFlight,
  type FleetState,
  type MaintenanceStanding,
} from "@airsoko/domain";
import type { AircraftServiceability, Instant } from "@airsoko/contracts";
import { db, type Executor } from "../db/client.ts";
import {
  aircraft,
  aircraftCabins,
  aircraftTypes,
  airports,
  flightInstances,
  maintenanceEvents,
} from "../db/schema/index.ts";

/**
 * The fleet, as it actually stands.
 *
 * One place computes this, and both the dashboard and the fleet pages read it.
 * Two independent implementations of "is this aircraft flying" would disagree
 * eventually, which is the failure this whole phase exists to remove.
 *
 * Serviceability is the only stored state. Position, operational state, current
 * and next sector, and utilisation are all derived from the flights each time
 * they are asked for.
 */

/** How far either side of now to load flights when working out state. */
const WINDOW_DAYS_BACK = 2;
const WINDOW_DAYS_FORWARD = 3;

export interface FleetAircraftType {
  id: string;
  icaoTypeCode: string;
  iataTypeCode: string | null;
  manufacturer: string;
  model: string;
  variant: string | null;
  bodyType: string;
  engineModel: string;
  rangeNm: number;
  cruiseSpeedKts: number;
  serviceCeilingFt: number;
  minimumTurnaroundMinutes: number;
}

export interface FleetAircraft {
  id: string;
  registration: string;
  name: string | null;
  serialNumber: string;
  deliveredOn: string;
  ageYears: number;
  type: FleetAircraftType;

  serviceability: AircraftServiceability;
  state: FleetState;
  locationName: string | null;
  baseIata: string | null;

  /** Summed from the cabins. Never a stored figure -- see docs/DECISIONS.md. */
  seatCapacity: number;
  seatsByCabin: Record<string, number>;

  totalHours: number;
  totalCycles: number;
  maintenance: MaintenanceStanding & {
    nextCheckType: string | null;
    nextCheckDueAt: string | null;
    lastCheckType: string | null;
    lastCheckAt: string | null;
  };
  /** Sectors flown on the current operating day. */
  sectorsToday: number;
  notes: string | null;
}

function ageInYears(deliveredOn: string, now: Instant): number {
  const delivered = Date.parse(`${deliveredOn}T00:00:00.000Z`);
  const years = (Date.parse(now) - delivered) / (365.25 * 24 * 3600 * 1000);
  return Math.round(years * 10) / 10;
}

/**
 * Loads every airframe and works out where it is and what it is doing.
 *
 * Three queries rather than one per aircraft: the fleet, its cabin totals, and
 * the flights in the surrounding window. Everything else is arithmetic.
 */
export async function loadFleet(
  now: Instant,
  options: { executor?: Executor; serviceDate?: string } = {},
): Promise<FleetAircraft[]> {
  const executor = options.executor ?? db;

  const rows = await executor
    .select({
      id: aircraft.id,
      registration: aircraft.registration,
      name: aircraft.name,
      serialNumber: aircraft.serialNumber,
      deliveredOn: aircraft.deliveredOn,
      serviceability: aircraft.serviceability,
      baseAirportId: aircraft.baseAirportId,
      baseIata: airports.iataCode,
      totalHours: aircraft.totalHours,
      totalCycles: aircraft.totalCycles,
      lastCheckType: aircraft.lastCheckType,
      lastCheckAt: aircraft.lastCheckAt,
      nextCheckType: aircraft.nextCheckType,
      nextCheckDueAt: aircraft.nextCheckDueAt,
      nextCheckDueHours: aircraft.nextCheckDueHours,
      nextCheckDueCycles: aircraft.nextCheckDueCycles,
      notes: aircraft.notes,
      typeId: aircraftTypes.id,
      icaoTypeCode: aircraftTypes.icaoTypeCode,
      iataTypeCode: aircraftTypes.iataTypeCode,
      manufacturer: aircraftTypes.manufacturer,
      model: aircraftTypes.model,
      variant: aircraftTypes.variant,
      bodyType: aircraftTypes.bodyType,
      engineModel: aircraftTypes.engineModel,
      rangeNm: aircraftTypes.rangeNm,
      cruiseSpeedKts: aircraftTypes.cruiseSpeedKts,
      serviceCeilingFt: aircraftTypes.serviceCeilingFt,
      minimumTurnaroundMinutes: aircraftTypes.minimumTurnaroundMinutes,
    })
    .from(aircraft)
    .innerJoin(aircraftTypes, eq(aircraftTypes.id, aircraft.aircraftTypeId))
    .leftJoin(airports, eq(airports.id, aircraft.baseAirportId))
    .where(eq(aircraft.active, true))
    .orderBy(aircraft.registration);

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const cabinRows = await executor
    .select({
      aircraftId: aircraftCabins.aircraftId,
      cabinClass: aircraftCabins.cabinClass,
      seatCount: aircraftCabins.seatCount,
    })
    .from(aircraftCabins)
    .where(inArray(aircraftCabins.aircraftId, ids));

  const from = shiftDate(now, -WINDOW_DAYS_BACK);
  const to = shiftDate(now, WINDOW_DAYS_FORWARD);

  const origin = airports;
  const flightRows = await executor
    .select({
      aircraftId: flightInstances.aircraftId,
      id: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      serviceDate: flightInstances.serviceDate,
      status: flightInstances.status,
      scheduledDeparture: flightInstances.scheduledDeparture,
      estimatedDeparture: flightInstances.estimatedDeparture,
      actualDeparture: flightInstances.actualDeparture,
      scheduledArrival: flightInstances.scheduledArrival,
      estimatedArrival: flightInstances.estimatedArrival,
      actualArrival: flightInstances.actualArrival,
      originIata: sql<string>`origin_airport.iata_code`,
      destinationIata: sql<string>`destination_airport.iata_code`,
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
        inArray(flightInstances.aircraftId, ids),
        gte(flightInstances.serviceDate, from),
        lte(flightInstances.serviceDate, to),
      ),
    );

  const cabinsByAircraft = new Map<string, Record<string, number>>();
  for (const cabin of cabinRows) {
    const existing = cabinsByAircraft.get(cabin.aircraftId) ?? {};
    existing[cabin.cabinClass] = cabin.seatCount;
    cabinsByAircraft.set(cabin.aircraftId, existing);
  }

  const flightsByAircraft = new Map<string, FleetFlight[]>();
  const sectorsToday = new Map<string, number>();
  const today = options.serviceDate ?? now.slice(0, 10);

  for (const flight of flightRows) {
    if (!flight.aircraftId) continue;

    const list = flightsByAircraft.get(flight.aircraftId) ?? [];
    list.push({
      id: flight.id,
      flightNumber: flight.flightNumber,
      originIata: flight.originIata,
      destinationIata: flight.destinationIata,
      // Estimated where it exists: what is expected, not what was promised.
      departure: flight.estimatedDeparture ?? flight.scheduledDeparture,
      arrival: flight.estimatedArrival ?? flight.scheduledArrival,
      actualDeparture: flight.actualDeparture,
      actualArrival: flight.actualArrival,
      cancelled: flight.status === "cancelled",
    });
    flightsByAircraft.set(flight.aircraftId, list);

    if (flight.serviceDate === today && flight.status !== "cancelled") {
      sectorsToday.set(flight.aircraftId, (sectorsToday.get(flight.aircraftId) ?? 0) + 1);
    }
  }

  const locationNames = new Map(
    (
      await executor.select({ iataCode: airports.iataCode, name: airports.name }).from(airports)
    ).map((row) => [row.iataCode, row.name]),
  );

  return rows.map((row) => {
    const seatsByCabin = cabinsByAircraft.get(row.id) ?? {};
    const seatCapacity = Object.values(seatsByCabin).reduce((sum, seats) => sum + seats, 0);

    const state = deriveFleetState(
      {
        registration: row.registration,
        serviceability: row.serviceability,
        baseIata: row.baseIata,
        flights: flightsByAircraft.get(row.id) ?? [],
      },
      now,
      DEFAULT_POLICY,
    );

    const standing = maintenanceStanding(
      {
        nextCheckType: row.nextCheckType,
        nextCheckDueAt: row.nextCheckDueAt,
        nextCheckDueHours: row.nextCheckDueHours,
        nextCheckDueCycles: row.nextCheckDueCycles,
        totalHours: row.totalHours,
        totalCycles: row.totalCycles,
      },
      now,
      DEFAULT_POLICY,
    );

    return {
      id: row.id,
      registration: row.registration,
      name: row.name,
      serialNumber: row.serialNumber,
      deliveredOn: row.deliveredOn,
      ageYears: ageInYears(row.deliveredOn, now),
      type: {
        id: row.typeId,
        icaoTypeCode: row.icaoTypeCode,
        iataTypeCode: row.iataTypeCode,
        manufacturer: row.manufacturer,
        model: row.model,
        variant: row.variant,
        bodyType: row.bodyType,
        engineModel: row.engineModel,
        rangeNm: row.rangeNm,
        cruiseSpeedKts: row.cruiseSpeedKts,
        serviceCeilingFt: row.serviceCeilingFt,
        minimumTurnaroundMinutes: row.minimumTurnaroundMinutes,
      },
      serviceability: row.serviceability,
      state,
      locationName: state.locationIata ? (locationNames.get(state.locationIata) ?? null) : null,
      baseIata: row.baseIata,
      seatCapacity,
      seatsByCabin,
      totalHours: row.totalHours,
      totalCycles: row.totalCycles,
      maintenance: {
        ...standing,
        nextCheckType: row.nextCheckType,
        nextCheckDueAt: row.nextCheckDueAt,
        lastCheckType: row.lastCheckType,
        lastCheckAt: row.lastCheckAt,
      },
      sectorsToday: sectorsToday.get(row.id) ?? 0,
      notes: row.notes,
    };
  });
}

/** Planned and completed hangar time for one airframe, most recent first. */
export async function loadMaintenanceHistory(aircraftId: string, executor: Executor = db) {
  return executor
    .select({
      id: maintenanceEvents.id,
      checkType: maintenanceEvents.checkType,
      scheduledStart: maintenanceEvents.scheduledStart,
      scheduledEnd: maintenanceEvents.scheduledEnd,
      actualStart: maintenanceEvents.actualStart,
      actualEnd: maintenanceEvents.actualEnd,
      hoursAtCheck: maintenanceEvents.hoursAtCheck,
      cyclesAtCheck: maintenanceEvents.cyclesAtCheck,
      description: maintenanceEvents.description,
      notes: maintenanceEvents.notes,
      airportIata: airports.iataCode,
    })
    .from(maintenanceEvents)
    .leftJoin(airports, eq(airports.id, maintenanceEvents.airportId))
    .where(eq(maintenanceEvents.aircraftId, aircraftId))
    .orderBy(sql`${maintenanceEvents.scheduledStart} desc`);
}

function shiftDate(instant: Instant, days: number): string {
  const [y, m, d] = instant.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

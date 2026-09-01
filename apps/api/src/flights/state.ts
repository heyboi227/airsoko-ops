import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  DEFAULT_POLICY,
  FLIGHT_STATUS_SEQUENCE,
  blockMinutes,
  departureDelayMinutes,
  effectiveArrival,
  effectiveDeparture,
  expectedTimeline,
  flightProgress,
  formatLocalDate,
  formatLocalTime,
  hasDeparted,
  isDelayed,
  partsInZone,
  resolveAmenities,
} from "@airsoko/domain";
import {
  TERMINAL_FLIGHT_STATUSES,
  type CabinClass,
  type FlightAmenity,
  type FlightDetail,
  type FlightEndpoint,
  type FlightQuery,
  type FlightStatus,
  type FlightSummary,
  type FlightTimelineEvent,
  type Instant,
} from "@airsoko/contracts";
import { db, type Executor } from "../db/client.ts";
import {
  aircraft,
  aircraftCabins,
  aircraftTypes,
  airports,
  amenities,
  amenityAssignments,
  flightInstances,
  flightStatusEvents,
  recurringSchedules,
  routes,
  users,
} from "../db/schema/index.ts";

/**
 * The flights, as they actually stand.
 *
 * One place computes this, and the list, the calendar, the control page and
 * the fleet's rotation panel all read it -- the same discipline `loadFleet`
 * applies to aircraft, for the same reason. Two implementations of "is this
 * flight late" would disagree eventually, and the one on the dashboard would
 * disagree with the one a controller is looking at.
 *
 * Nothing derived is stored. Delay, progress, local times and the timeline all
 * come out of the six timestamps and the two airports' zones on every read.
 *
 * The two airport joins use drizzle's `alias` rather than raw SQL fragments.
 * A flight needs seven columns from each end, and aliased tables keep them
 * typed instead of asserting each one by hand.
 */

const origin = alias(airports, "origin_airport");
const destination = alias(airports, "destination_airport");
const plannedType = alias(aircraftTypes, "planned_type");

const flightColumns = {
  id: flightInstances.id,
  scheduleId: flightInstances.scheduleId,
  flightNumber: flightInstances.flightNumber,
  callsign: flightInstances.callsign,
  flightType: flightInstances.flightType,
  serviceDate: flightInstances.serviceDate,

  scheduledDeparture: flightInstances.scheduledDeparture,
  estimatedDeparture: flightInstances.estimatedDeparture,
  actualDeparture: flightInstances.actualDeparture,
  scheduledArrival: flightInstances.scheduledArrival,
  estimatedArrival: flightInstances.estimatedArrival,
  actualArrival: flightInstances.actualArrival,

  status: flightInstances.status,
  phase: flightInstances.phase,
  delayReason: flightInstances.delayReason,
  delayNote: flightInstances.delayNote,
  cancellationReason: flightInstances.cancellationReason,
  notes: flightInstances.notes,
  overriddenFields: flightInstances.overriddenFields,

  departureTerminal: flightInstances.departureTerminal,
  departureGate: flightInstances.departureGate,
  checkInCounters: flightInstances.checkInCounters,
  arrivalTerminal: flightInstances.arrivalTerminal,
  arrivalGate: flightInstances.arrivalGate,
  baggageCarousel: flightInstances.baggageCarousel,

  originId: origin.id,
  originIata: origin.iataCode,
  originName: origin.name,
  originCity: origin.city,
  originTimeZone: origin.timeZone,
  originLatitude: origin.latitude,
  originLongitude: origin.longitude,
  originIsHub: origin.isHub,

  destinationId: destination.id,
  destinationIata: destination.iataCode,
  destinationName: destination.name,
  destinationCity: destination.city,
  destinationTimeZone: destination.timeZone,
  destinationLatitude: destination.latitude,
  destinationLongitude: destination.longitude,
  destinationIsHub: destination.isHub,

  routeId: flightInstances.routeId,
  distanceNm: routes.distanceNm,

  aircraftId: aircraft.id,
  registration: aircraft.registration,
  aircraftName: aircraft.name,
  aircraftTypeId: aircraftTypes.id,
  icaoTypeCode: aircraftTypes.icaoTypeCode,
  manufacturer: aircraftTypes.manufacturer,
  model: aircraftTypes.model,
  bodyType: aircraftTypes.bodyType,
  rangeNm: aircraftTypes.rangeNm,
  minimumTurnaroundMinutes: aircraftTypes.minimumTurnaroundMinutes,

  plannedTypeCode: plannedType.icaoTypeCode,
} as const;

function baseQuery(executor: Executor) {
  return executor
    .select(flightColumns)
    .from(flightInstances)
    .innerJoin(origin, eq(origin.id, flightInstances.originAirportId))
    .innerJoin(destination, eq(destination.id, flightInstances.destinationAirportId))
    .innerJoin(routes, eq(routes.id, flightInstances.routeId))
    .leftJoin(aircraft, eq(aircraft.id, flightInstances.aircraftId))
    .leftJoin(aircraftTypes, eq(aircraftTypes.id, aircraft.aircraftTypeId))
    .leftJoin(recurringSchedules, eq(recurringSchedules.id, flightInstances.scheduleId))
    .leftJoin(plannedType, eq(plannedType.id, recurringSchedules.aircraftTypeId));
}

/**
 * One row of the base query.
 *
 * Taken from the builder rather than written out again: drizzle already knows
 * which of these fifty columns are nullable because it knows which joins are
 * left ones, and restating that by hand is how a `null` reaches the client
 * through a field typed `string`.
 */
type FlightRow = Awaited<ReturnType<typeof baseQuery>>[number];

/** Installed seats per aircraft, summed from the cabins. Never a stored total. */
async function seatsByAircraft(
  aircraftIds: readonly string[],
  executor: Executor,
): Promise<Map<string, { total: number; byCabin: Record<string, number> }>> {
  const ids = [...new Set(aircraftIds)];
  if (ids.length === 0) return new Map();

  const rows = await executor
    .select({
      aircraftId: aircraftCabins.aircraftId,
      cabinClass: aircraftCabins.cabinClass,
      seatCount: aircraftCabins.seatCount,
    })
    .from(aircraftCabins)
    .where(inArray(aircraftCabins.aircraftId, ids));

  const map = new Map<string, { total: number; byCabin: Record<string, number> }>();
  for (const row of rows) {
    const entry = map.get(row.aircraftId) ?? { total: 0, byCabin: {} };
    entry.byCabin[row.cabinClass] = row.seatCount;
    entry.total += row.seatCount;
    map.set(row.aircraftId, entry);
  }
  return map;
}

function endpoint(
  facts: {
    id: string;
    iataCode: string;
    name: string;
    city: string;
    timeZone: string;
    latitude: number;
    longitude: number;
  },
  at: Instant,
  terminal: string | null,
  gate: string | null,
): FlightEndpoint {
  return {
    id: facts.id,
    iataCode: facts.iataCode,
    name: facts.name,
    city: facts.city,
    timeZone: facts.timeZone,
    latitude: facts.latitude,
    longitude: facts.longitude,
    terminal,
    gate,
    localTime: formatLocalTime(at, facts.timeZone),
    localDate: formatLocalDate(at, facts.timeZone),
    offsetMinutes: partsInZone(at, facts.timeZone).offsetMinutes,
  };
}

function toSummary(
  row: FlightRow,
  now: Instant,
  seats: Map<string, { total: number; byCabin: Record<string, number> }>,
): FlightSummary {
  const times = {
    scheduledDeparture: row.scheduledDeparture,
    estimatedDeparture: row.estimatedDeparture,
    actualDeparture: row.actualDeparture,
    scheduledArrival: row.scheduledArrival,
    estimatedArrival: row.estimatedArrival,
    actualArrival: row.actualArrival,
  };

  const delayMinutes = departureDelayMinutes(times);
  const installed = row.aircraftId ? seats.get(row.aircraftId) : undefined;

  return {
    id: row.id,
    scheduleId: row.scheduleId,
    flightNumber: row.flightNumber,
    callsign: row.callsign,
    flightType: row.flightType,
    serviceDate: row.serviceDate,
    routeId: row.routeId,

    // The local clock is shown for what is *expected*, not what was promised.
    // A board that keeps printing 07:45 beside a flight running an hour late is
    // the one thing everyone at the gate already knows is wrong.
    origin: endpoint(
      {
        id: row.originId,
        iataCode: row.originIata,
        name: row.originName,
        city: row.originCity,
        timeZone: row.originTimeZone,
        latitude: row.originLatitude,
        longitude: row.originLongitude,
      },
      effectiveDeparture(times),
      row.departureTerminal,
      row.departureGate,
    ),
    destination: endpoint(
      {
        id: row.destinationId,
        iataCode: row.destinationIata,
        name: row.destinationName,
        city: row.destinationCity,
        timeZone: row.destinationTimeZone,
        latitude: row.destinationLatitude,
        longitude: row.destinationLongitude,
      },
      effectiveArrival(times),
      row.arrivalTerminal,
      row.arrivalGate,
    ),

    ...times,

    status: row.status,
    phase: row.phase,

    delayMinutes,
    delayed: isDelayed(delayMinutes, DEFAULT_POLICY),
    delayReason: row.delayReason,
    delayNote: row.delayNote,

    blockMinutes: blockMinutes(times),
    distanceNm: row.distanceNm,
    progress: flightProgress(times, now),

    aircraft:
      row.aircraftId && row.registration && row.aircraftTypeId
        ? {
            id: row.aircraftId,
            registration: row.registration,
            name: row.aircraftName,
            typeId: row.aircraftTypeId,
            icaoTypeCode: row.icaoTypeCode ?? "",
            manufacturer: row.manufacturer ?? "",
            model: row.model ?? "",
            bodyType: row.bodyType ?? "",
            rangeNm: row.rangeNm ?? 0,
            seatCapacity: installed?.total ?? 0,
            seatsByCabin: installed?.byCabin ?? {},
          }
        : null,
    plannedTypeCode: row.plannedTypeCode,

    baggageCarousel: row.baggageCarousel,
    cancellationReason: row.cancellationReason,
    notes: row.notes,
    overriddenFields: row.overriddenFields,
  };
}

// --- The list --------------------------------------------------------------

export interface FlightListResult {
  items: FlightSummary[];
  total: number;
  /** True when the SQL limit clipped the result before the derived filters ran. */
  truncated: boolean;
  generatedAt: Instant;
}

export async function loadFlights(
  query: FlightQuery,
  now: Instant,
  executor: Executor = db,
): Promise<FlightListResult> {
  // No window asked for means the current operating day. A flight board with
  // nine days on it is not a board.
  const from = query.from ?? now.slice(0, 10);
  const to = query.to ?? from;

  const conditions = [
    gte(flightInstances.serviceDate, from),
    lte(flightInstances.serviceDate, to),
  ];

  if (query.status) conditions.push(eq(flightInstances.status, query.status));
  if (query.routeId) conditions.push(eq(flightInstances.routeId, query.routeId));
  if (query.scheduleId) conditions.push(eq(flightInstances.scheduleId, query.scheduleId));
  if (query.aircraftId) conditions.push(eq(flightInstances.aircraftId, query.aircraftId));
  if (query.originIata) conditions.push(eq(origin.iataCode, query.originIata));
  if (query.destinationIata) conditions.push(eq(destination.iataCode, query.destinationIata));
  if (query.typeCode) conditions.push(eq(aircraftTypes.icaoTypeCode, query.typeCode));
  if (query.unassignedOnly) conditions.push(isNull(flightInstances.aircraftId));
  if (query.activeOnly) {
    conditions.push(notInArray(flightInstances.status, [...TERMINAL_FLIGHT_STATUSES]));
  }

  if (query.airportIata) {
    const touching = or(
      eq(origin.iataCode, query.airportIata),
      eq(destination.iataCode, query.airportIata),
    );
    if (touching) conditions.push(touching);
  }

  if (query.search) {
    const needle = `%${query.search.toLowerCase()}%`;
    const matches = or(
      sql`lower(${flightInstances.flightNumber}) like ${needle}`,
      sql`lower(${flightInstances.callsign}) like ${needle}`,
      sql`lower(coalesce(${aircraft.registration}, '')) like ${needle}`,
      sql`lower(${origin.iataCode}) like ${needle}`,
      sql`lower(${destination.iataCode}) like ${needle}`,
      sql`lower(${origin.city}) like ${needle}`,
      sql`lower(${destination.city}) like ${needle}`,
      sql`lower(${origin.name}) like ${needle}`,
      sql`lower(${destination.name}) like ${needle}`,
      // "BEG-VIE" typed as one string, which is how a controller writes a route.
      sql`lower(${origin.iataCode} || '-' || ${destination.iataCode}) like ${needle}`,
    );
    if (matches) conditions.push(matches);
  }

  const rows = await baseQuery(executor)
    .where(and(...conditions))
    .orderBy(asc(flightInstances.scheduledDeparture), asc(flightInstances.flightNumber))
    .limit(query.limit);

  const seats = await seatsByAircraft(
    rows.map((row) => row.aircraftId).filter((id): id is string => id !== null),
    executor,
  );

  let items = rows.map((row) => toSummary(row, now, seats));

  // Delay is derived, so it cannot be a WHERE clause without duplicating the
  // rule in SQL. Filtering here keeps one definition of "late".
  if (query.delayedOnly) items = items.filter((item) => item.delayed);

  return {
    items,
    total: items.length,
    truncated: rows.length === query.limit,
    generatedAt: now,
  };
}

// --- One flight ------------------------------------------------------------

/**
 * Everything the flight-control page shows.
 *
 * The timeline is the interesting half: the expected steps come from the
 * kernel, the recorded ones from `flight_status_events`, and they are matched
 * on `event_type`. A flight that has not started yet still shows its whole day
 * rather than an empty list -- true, and useless.
 */
export async function loadFlightDetail(
  id: string,
  now: Instant,
  executor: Executor = db,
): Promise<FlightDetail | null> {
  const [row] = await baseQuery(executor).where(eq(flightInstances.id, id)).limit(1);
  if (!row) return null;

  const seats = await seatsByAircraft(row.aircraftId ? [row.aircraftId] : [], executor);
  const summary = toSummary(row, now, seats);

  const [series, events, rotation, amenities] = await Promise.all([
    row.scheduleId ? loadSeries(row.scheduleId, executor) : Promise.resolve(null),
    loadTimeline(id, summary, executor),
    row.aircraftId ? loadRotation(row.aircraftId, id, row.serviceDate, executor) : [],
    loadFlightAmenities(id, row.aircraftId, summary, executor),
  ]);

  return {
    ...summary,
    series,
    timeline: events,
    amenities,
    inventory: {
      seatCapacity: summary.aircraft?.seatCapacity ?? 0,
      seatsByCabin: summary.aircraft?.seatsByCabin ?? {},
      // Bookings arrive in Phase 6. Zero is the honest figure today, and the
      // shape is here now because the assignment rules already read it.
      soldByCabin: {},
      sold: 0,
    },
    rotation,
  };
}

async function loadSeries(scheduleId: string, executor: Executor) {
  const [found] = await executor
    .select({
      id: recurringSchedules.id,
      flightNumber: recurringSchedules.flightNumber,
      validFrom: recurringSchedules.validFrom,
      validTo: recurringSchedules.validTo,
      operatingDays: recurringSchedules.operatingDays,
      departureLocalTime: recurringSchedules.departureLocalTime,
      arrivalLocalTime: recurringSchedules.arrivalLocalTime,
      arrivalDayOffset: recurringSchedules.arrivalDayOffset,
      season: recurringSchedules.season,
      active: recurringSchedules.active,
    })
    .from(recurringSchedules)
    .where(eq(recurringSchedules.id, scheduleId))
    .limit(1);

  return found ?? null;
}

async function loadTimeline(
  flightId: string,
  summary: FlightSummary,
  executor: Executor,
): Promise<FlightTimelineEvent[]> {
  const recorded = await executor
    .select({
      id: flightStatusEvents.id,
      eventType: flightStatusEvents.eventType,
      scheduledAt: flightStatusEvents.scheduledAt,
      occurredAt: flightStatusEvents.occurredAt,
      status: flightStatusEvents.status,
      phase: flightStatusEvents.phase,
      note: flightStatusEvents.note,
      actorLabel: users.displayName,
    })
    .from(flightStatusEvents)
    .leftJoin(users, eq(users.id, flightStatusEvents.actorId))
    .where(eq(flightStatusEvents.flightInstanceId, flightId))
    .orderBy(asc(flightStatusEvents.occurredAt));

  const byType = new Map(recorded.map((event) => [event.eventType, event]));

  // A step is complete when something says so, and the flight's own status says
  // a great deal. `flight_status_events` only holds what this application
  // recorded, so an arrived flight that nobody clicked through would otherwise
  // show nine empty circles under the word "Arrived" -- the page contradicting
  // its own heading.
  //
  // Two inferences, both sound. A step tied to a status has happened once the
  // flight is at or past that status. A step with no status -- crew report,
  // aircraft at gate -- has happened once the aircraft has pushed back, because
  // nothing pushes back without crew or off a stand. Neither invents a *time*:
  // an inferred step carries no `occurredAt`, and the page shows when it was
  // due rather than pretending to know when it happened.
  const reached = (FLIGHT_STATUS_SEQUENCE as readonly FlightStatus[]).indexOf(summary.status);
  const departed = hasDeparted(summary.status);

  const passed = (status: FlightStatus | null): boolean => {
    if (!status) return departed;
    // A cancelled or diverted flight is off the sequence, so nothing is
    // inferred about it: only what was recorded counts.
    if (reached < 0) return false;
    const index = (FLIGHT_STATUS_SEQUENCE as readonly FlightStatus[]).indexOf(status);
    return index >= 0 && index <= reached;
  };

  const steps = expectedTimeline(summary, DEFAULT_POLICY).map((step): FlightTimelineEvent => {
    const actual = byType.get(step.eventType);
    // The two moments the flight row itself timestamps.
    const stamped =
      step.eventType === "pushback"
        ? summary.actualDeparture
        : step.eventType === "on_blocks"
          ? summary.actualArrival
          : null;

    return {
      id: actual?.id ?? `${flightId}:${step.eventType}`,
      eventType: step.eventType,
      label: step.label,
      scheduledAt: step.scheduledAt,
      occurredAt: actual?.occurredAt ?? stamped,
      status: actual?.status ?? step.status,
      phase: actual?.phase ?? null,
      actorLabel: actual?.actorLabel ?? null,
      note: actual?.note ?? null,
      complete: Boolean(actual) || Boolean(stamped) || passed(step.status),
    };
  });

  // Anything recorded that is not one of the expected steps -- a diversion, a
  // return to stand -- belongs on the timeline too, in its own right.
  const expected = new Set(steps.map((step) => step.eventType));
  for (const event of recorded) {
    if (expected.has(event.eventType)) continue;
    steps.push({
      id: event.id,
      eventType: event.eventType,
      label: event.eventType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      scheduledAt: event.scheduledAt,
      occurredAt: event.occurredAt,
      status: event.status,
      phase: event.phase,
      actorLabel: event.actorLabel,
      note: event.note,
      complete: true,
    });
  }

  return steps.sort((a, b) =>
    (a.occurredAt ?? a.scheduledAt ?? "").localeCompare(b.occurredAt ?? b.scheduledAt ?? ""),
  );
}

/**
 * What this flight offers, resolved per cabin.
 *
 * Every level that could apply is loaded and handed to `resolveAmenities`,
 * once per cabin, because the answer differs by cabin: Wi-Fi granted on the
 * airframe and withdrawn in Economy is two different answers for one flight.
 *
 * The rows fetched are deliberately broad -- this airframe's, every cabin-scope
 * row, and this flight's -- because the resolver decides which apply and a
 * query that pre-filtered would be a second, weaker copy of that rule.
 */
async function loadFlightAmenities(
  flightId: string,
  aircraftId: string | null,
  summary: FlightSummary,
  executor: Executor,
): Promise<FlightAmenity[]> {
  // No airframe means no cabins, and an amenity with no cabin to apply in is
  // not something to report as offered.
  if (!aircraftId) return [];

  const rows = await executor
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
    .where(
      or(
        eq(amenityAssignments.aircraftId, aircraftId),
        eq(amenityAssignments.flightInstanceId, flightId),
        eq(amenityAssignments.scope, "cabin"),
      ),
    );

  const named = new Map(rows.map((row) => [row.amenityCode, row]));
  const resolved: FlightAmenity[] = [];

  for (const cabinClass of Object.keys(summary.aircraft?.seatsByCabin ?? {})) {
    for (const entry of resolveAmenities(rows, {
      aircraftId,
      cabinClass: cabinClass as CabinClass,
      flightInstanceId: flightId,
    })) {
      resolved.push({
        ...entry,
        cabinClass: cabinClass as CabinClass,
        name: named.get(entry.amenityCode)?.name ?? entry.amenityCode,
        category: named.get(entry.amenityCode)?.category ?? null,
      });
    }
  }

  return resolved.sort(
    (a, b) =>
      a.amenityCode.localeCompare(b.amenityCode) || a.cabinClass.localeCompare(b.cabinClass),
  );
}

/** What the assigned airframe flies either side of this sector. */
async function loadRotation(
  aircraftId: string,
  flightId: string,
  serviceDate: string,
  executor: Executor,
) {
  return executor
    .select({
      id: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      originIata: origin.iataCode,
      destinationIata: destination.iataCode,
      scheduledDeparture: flightInstances.scheduledDeparture,
      scheduledArrival: flightInstances.scheduledArrival,
      status: flightInstances.status,
    })
    .from(flightInstances)
    .innerJoin(origin, eq(origin.id, flightInstances.originAirportId))
    .innerJoin(destination, eq(destination.id, flightInstances.destinationAirportId))
    .where(
      and(
        eq(flightInstances.aircraftId, aircraftId),
        ne(flightInstances.id, flightId),
        gte(flightInstances.serviceDate, shiftDate(serviceDate, -1)),
        lte(flightInstances.serviceDate, shiftDate(serviceDate, 1)),
      ),
    )
    .orderBy(asc(flightInstances.scheduledDeparture));
}

// --- Facts the rules need --------------------------------------------------

/** One flight in the shape the kernel rules read. */
export async function loadFlightFacts(id: string, executor: Executor = db) {
  const [row] = await executor
    .select({
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
      aircraftId: flightInstances.aircraftId,
      aircraftRegistration: aircraft.registration,
      scheduleId: flightInstances.scheduleId,
      routeId: flightInstances.routeId,
      originAirportId: flightInstances.originAirportId,
      destinationAirportId: flightInstances.destinationAirportId,
      flightType: flightInstances.flightType,
      departureTerminal: flightInstances.departureTerminal,
      departureGate: flightInstances.departureGate,
      arrivalTerminal: flightInstances.arrivalTerminal,
      arrivalGate: flightInstances.arrivalGate,
      checkInCounters: flightInstances.checkInCounters,
      baggageCarousel: flightInstances.baggageCarousel,
      notes: flightInstances.notes,
      overriddenFields: flightInstances.overriddenFields,
      callsign: flightInstances.callsign,
      phase: flightInstances.phase,
    })
    .from(flightInstances)
    .leftJoin(aircraft, eq(aircraft.id, flightInstances.aircraftId))
    .where(eq(flightInstances.id, id))
    .limit(1);

  return row ?? null;
}

/** The two ends of a route, in the shape the rules read. */
export async function loadRouteEndpoints(routeId: string, executor: Executor = db) {
  const [row] = await executor
    .select({
      routeId: routes.id,
      distanceNm: routes.distanceNm,
      blockMinutes: routes.blockMinutes,
      originId: origin.id,
      originIata: origin.iataCode,
      originName: origin.name,
      originTimeZone: origin.timeZone,
      originLatitude: origin.latitude,
      originLongitude: origin.longitude,
      originIsHub: origin.isHub,
      destinationId: destination.id,
      destinationIata: destination.iataCode,
      destinationName: destination.name,
      destinationTimeZone: destination.timeZone,
      destinationLatitude: destination.latitude,
      destinationLongitude: destination.longitude,
      destinationIsHub: destination.isHub,
    })
    .from(routes)
    .innerJoin(origin, eq(origin.id, routes.originAirportId))
    .innerJoin(destination, eq(destination.id, routes.destinationAirportId))
    .where(eq(routes.id, routeId))
    .limit(1);

  if (!row) return null;

  return {
    routeId: row.routeId,
    distanceNm: row.distanceNm,
    blockMinutes: row.blockMinutes,
    origin: {
      id: row.originId,
      iataCode: row.originIata,
      name: row.originName,
      timeZone: row.originTimeZone,
      latitude: row.originLatitude,
      longitude: row.originLongitude,
      isHub: row.originIsHub,
    },
    destination: {
      id: row.destinationId,
      iataCode: row.destinationIata,
      name: row.destinationName,
      timeZone: row.destinationTimeZone,
      latitude: row.destinationLatitude,
      longitude: row.destinationLongitude,
      isHub: row.destinationIsHub,
    },
  };
}

/** Other flights carrying this number on this date. */
export async function loadNumberClashes(
  flightNumber: string,
  serviceDate: string,
  executor: Executor = db,
) {
  return executor
    .select({
      flightId: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      serviceDate: flightInstances.serviceDate,
    })
    .from(flightInstances)
    .where(
      and(
        eq(flightInstances.flightNumber, flightNumber),
        eq(flightInstances.serviceDate, serviceDate),
      ),
    );
}

/** The next sector the same airframe flies after this one. */
export async function loadNextSector(
  aircraftId: string,
  after: Instant,
  executor: Executor = db,
) {
  const [row] = await executor
    .select({
      flightId: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      originIata: origin.iataCode,
      departure: flightInstances.scheduledDeparture,
      minimumTurnaroundMinutes: aircraftTypes.minimumTurnaroundMinutes,
    })
    .from(flightInstances)
    .innerJoin(origin, eq(origin.id, flightInstances.originAirportId))
    .innerJoin(aircraft, eq(aircraft.id, flightInstances.aircraftId))
    .innerJoin(aircraftTypes, eq(aircraftTypes.id, aircraft.aircraftTypeId))
    .where(
      and(
        eq(flightInstances.aircraftId, aircraftId),
        gte(flightInstances.scheduledDeparture, after),
        ne(flightInstances.status, "cancelled"),
      ),
    )
    .orderBy(asc(flightInstances.scheduledDeparture))
    .limit(1);

  return row ?? null;
}

/** Sectors the airframe is committed to, excluding the one being assigned. */
export async function loadCommitments(
  aircraftId: string,
  windowStart: string,
  windowEnd: string,
  excludeFlightId: string,
  executor: Executor = db,
) {
  return executor
    .select({
      flightId: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      originIata: origin.iataCode,
      destinationIata: destination.iataCode,
      departure: flightInstances.scheduledDeparture,
      arrival: flightInstances.scheduledArrival,
    })
    .from(flightInstances)
    .innerJoin(origin, eq(origin.id, flightInstances.originAirportId))
    .innerJoin(destination, eq(destination.id, flightInstances.destinationAirportId))
    .where(
      and(
        eq(flightInstances.aircraftId, aircraftId),
        ne(flightInstances.id, excludeFlightId),
        ne(flightInstances.status, "cancelled"),
        gte(flightInstances.serviceDate, windowStart),
        lte(flightInstances.serviceDate, windowEnd),
      ),
    )
    .orderBy(asc(flightInstances.scheduledDeparture));
}

/** Most recent flights first, for the "what does this pattern fly" panel. */
export async function loadScheduleOccurrences(scheduleId: string, executor: Executor = db) {
  return executor
    .select({
      flightId: flightInstances.id,
      flightNumber: flightInstances.flightNumber,
      serviceDate: flightInstances.serviceDate,
      status: flightInstances.status,
      scheduledDeparture: flightInstances.scheduledDeparture,
      estimatedDeparture: flightInstances.estimatedDeparture,
      actualDeparture: flightInstances.actualDeparture,
      scheduledArrival: flightInstances.scheduledArrival,
      estimatedArrival: flightInstances.estimatedArrival,
      actualArrival: flightInstances.actualArrival,
      aircraftId: flightInstances.aircraftId,
      aircraftRegistration: aircraft.registration,
      overriddenFields: flightInstances.overriddenFields,
    })
    .from(flightInstances)
    .leftJoin(aircraft, eq(aircraft.id, flightInstances.aircraftId))
    .where(eq(flightInstances.scheduleId, scheduleId))
    .orderBy(desc(flightInstances.serviceDate));
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

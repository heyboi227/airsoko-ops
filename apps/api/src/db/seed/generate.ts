import { createHash } from "node:crypto";
import {
  addMinutes,
  distanceNm,
  epochMs,
  formatLocalDate,
  formatLocalTime,
  localDateRange,
  suggestedBlockMinutes,
  toInstant,
  weekdayInZone,
  zonedTimeToInstant,
} from "@airsoko/domain";
import type { FlightPhase, FlightStatus } from "@airsoko/contracts";
import {
  MARKETING_CODE,
  NETWORK_PLAN,
  type Equipment,
  type PlannedRoute,
} from "./reference/network-plan.ts";
import { SEED_AIRCRAFT, SEED_AIRCRAFT_TYPES } from "./reference/fleet.ts";
import type { SeedStation } from "./reference/index.ts";
import { seededId } from "../ids.ts";

/**
 * Turns the commercial plan into a coherent operation: routes, recurring
 * schedules, dated flight instances, and the aircraft rotations that fly them.
 *
 * ---------------------------------------------------------------------------
 * On determinism.
 *
 * Phase 0's seed was byte-identical on every run. Flights cannot be, because
 * an operations console with no flights today is useless -- the window has to
 * follow the calendar. So the guarantee is refined rather than dropped:
 *
 *   deterministic *given a reference date*.
 *
 * Two runs on the same day produce identical rows, including ids, delays and
 * statuses. A run tomorrow shifts the window by a day and produces the same
 * shape. `SEED_REFERENCE_DATE` pins it explicitly when a test needs to.
 *
 * Everything that looks random here -- which flights are delayed, by how long,
 * gate assignments -- is a hash of stable inputs, never `Math.random`.
 */

/** Flights are generated for this many days either side of the reference date. */
const DAYS_BEFORE = 2;
const DAYS_AFTER = 6;

/**
 * Slack built into the ground time on top of the minimum turnaround.
 *
 * A first version scheduled the return leg at exactly arrival plus minimum
 * turnaround, which left the day with no give at all: a single fifteen-minute
 * delay propagated through every remaining sector that tail flew, and 43% of
 * the network ended up running late. Published timetables carry buffer for
 * precisely this reason, and with it most small delays are absorbed on the
 * ground instead of compounding.
 */
const GROUND_BUFFER_MINUTES = 20;

/**
 * The fraction of a departure delay that survives to the arrival.
 *
 * Published block times are padded, so an aircraft leaving late makes part of
 * it up in the air. Without this the model had no recovery at all: a delay
 * entered the rotation and every subsequent sector inherited it undiminished,
 * which is why a 14% primary delay rate was producing a 37% late network with
 * a 69-minute average. Real delays decay along a rotation; these now do too.
 */
const DELAY_RECOVERY_FACTOR = 0.6;

/**
 * The most a rotation delay may push a departure before the flight is left for
 * a controller to resolve instead.
 */
const MAX_ROTATION_KNOCK_ON_MINUTES = 60;

/** How late a flight arrives, given how late it left. */
function arrivalDelayFor(departureDelayMinutes: number): number {
  return Math.round(departureDelayMinutes * DELAY_RECOVERY_FACTOR);
}

// --- Deterministic pseudo-randomness ---------------------------------------

/** A stable 32-bit integer from any string. */
function hashOf(key: string): number {
  return createHash("sha256").update(key).digest().readUInt32BE(0);
}

/** A stable number in [0, 1) for a given key. */
function unit(key: string): number {
  return hashOf(key) / 0x1_0000_0000;
}

/** A stable integer in [min, max]. */
function pick(key: string, min: number, max: number): number {
  return min + Math.floor(unit(key) * (max - min + 1));
}

function choose<T>(key: string, options: readonly T[]): T {
  const value = options[Math.floor(unit(key) * options.length)];
  if (value === undefined) throw new Error("choose() called with an empty list");
  return value;
}

// --- Routes ----------------------------------------------------------------

export interface GeneratedRoute {
  id: string;
  originIata: string;
  destinationIata: string;
  distanceNm: number;
  blockMinutes: number;
  equipment: Equipment;
  plannedTypeCode: string;
  season: string | null;
}

const HUB = "BEG";

function cruiseSpeedFor(equipment: Equipment): number {
  if (equipment === "turboprop") return 275;
  if (equipment === "wide_body") return 470;
  return 447;
}

/**
 * The type a route is *planned* on. Narrow-body routes take the family member
 * that suits the distance; the rotation may still allocate a different tail,
 * which is exactly the sort of planned-versus-actual difference the flight
 * views need to show.
 */
function plannedTypeFor(equipment: Equipment, distance: number): string {
  if (equipment === "turboprop") return "AT76";
  if (equipment === "wide_body") return "A332";
  if (distance < 600) return "A319";
  if (distance < 1100) return "A320";
  return "A20N";
}

export function buildRoutes(stations: readonly SeedStation[]): GeneratedRoute[] {
  const byIata = new Map(stations.map((station) => [station.iataCode, station]));
  const routes = new Map<string, GeneratedRoute>();

  for (const plan of NETWORK_PLAN) {
    const originIata = plan.origin ?? HUB;
    const origin = byIata.get(originIata);
    const destination = byIata.get(plan.destination);
    if (!origin || !destination) {
      throw new Error(
        `The network plan references ${originIata}-${plan.destination}, but one of those is not a station.`,
      );
    }

    const distance = Math.round(distanceNm(origin, destination));
    const block = suggestedBlockMinutes(distance, cruiseSpeedFor(plan.equipment));

    // A route is directional: BEG-VIE and VIE-BEG are two reusable pairs.
    for (const [from, to] of [
      [origin, destination],
      [destination, origin],
    ] as const) {
      const key = `${from.iataCode}-${to.iataCode}`;
      if (routes.has(key)) continue;
      routes.set(key, {
        id: seededId("route", key),
        originIata: from.iataCode,
        destinationIata: to.iataCode,
        distanceNm: distance,
        blockMinutes: block,
        equipment: plan.equipment,
        plannedTypeCode: plannedTypeFor(plan.equipment, distance),
        season: plan.season ?? null,
      });
    }
  }

  return [...routes.values()];
}

// --- Schedules -------------------------------------------------------------

export interface GeneratedSchedule {
  id: string;
  flightNumber: string;
  routeKey: string;
  originIata: string;
  destinationIata: string;
  departureLocalTime: string;
  arrivalLocalTime: string;
  arrivalDayOffset: number;
  operatingDays: boolean[];
  plannedTypeCode: string;
  equipment: Equipment;
  blockMinutes: number;
  season: string | null;
}

function toLocalTime(minutesFromMidnight: number): string {
  const total = ((minutesFromMidnight % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Departure times for one route, spread across the operating day.
 *
 * A first attempt banked everything into a morning and an evening wave, the
 * way a large hub carrier schedules. With nineteen European routes leaving
 * inside the same two hours and thirteen narrow-bodies to fly them, half the
 * network had no aircraft -- the schedule was writing cheques the fleet could
 * not cash.
 *
 * Spreading departures through the day is both what a fleet this size actually
 * does and what lets a tail fly four or five sectors instead of one. The offset
 * is hashed from the flight number, so it is stable and varied rather than
 * every route leaving on the hour.
 */
function departureSlots(frequency: 1 | 2 | 3, flightNumber: number): string[] {
  // Every flight in this network is a round trip from the hub, so the shape of
  // the departure spread decides how many sectors a tail can fly. Two rules
  // matter:
  //
  //   - Fill the whole day. If outbound departures all fall before mid
  //     afternoon, the evening is nothing but arrivals and a tail that lands at
  //     noon has nothing left to do.
  //   - Never pin a slot to a fixed edge. An earlier version spaced slots as
  //     (last - first) / (frequency - 1), which put the final departure of
  //     every multi-frequency route at exactly 21:00 -- fourteen aircraft
  //     wanted at once, and eight of them did not exist.
  //
  // So the first departure is hashed into a window, and later slots follow at a
  // fixed interval. The window shrinks as frequency rises, which keeps the last
  // departure inside the operating day without ever landing on its boundary.
  const FIRST_DEPARTURE = 5 * 60 + 30;

  const startWindow = frequency === 1 ? 13 * 60 : frequency === 2 ? 6 * 60 : 3 * 60;
  const interval = frequency === 2 ? 7 * 60 : 5 * 60 + 30;

  const first = FIRST_DEPARTURE + Math.floor(unit(`slot:${flightNumber}`) * startWindow);
  const rounded = Math.round(first / 5) * 5;

  return Array.from({ length: frequency }, (_, index) =>
    toLocalTime(rounded + index * interval),
  );
}

/**
 * Builds the outbound and return schedule for each planned route.
 *
 * Local times are what a schedule actually publishes, so they are what is
 * stored. The return leg's slot is derived once, on the reference date, from
 * the outbound arrival plus a turnaround -- after which it is a published
 * local time in its own right and flexes across DST like any other.
 */
export function buildSchedules(
  routes: readonly GeneratedRoute[],
  stations: readonly SeedStation[],
  referenceDate: string,
): GeneratedSchedule[] {
  const byIata = new Map(stations.map((station) => [station.iataCode, station]));
  const routeByKey = new Map(
    routes.map((route) => [`${route.originIata}-${route.destinationIata}`, route]),
  );
  const turnaroundByType = new Map(
    SEED_AIRCRAFT_TYPES.map((type) => [type.icaoTypeCode, type.minimumTurnaroundMinutes]),
  );

  const schedules: GeneratedSchedule[] = [];

  NETWORK_PLAN.forEach((plan: PlannedRoute) => {
    const originIata = plan.origin ?? HUB;
    const outKey = `${originIata}-${plan.destination}`;
    const backKey = `${plan.destination}-${originIata}`;
    const outbound = routeByKey.get(outKey);
    const inbound = routeByKey.get(backKey);
    const origin = byIata.get(originIata);
    const destination = byIata.get(plan.destination);
    if (!outbound || !inbound || !origin || !destination) return;

    const operatingDays = [
      ...(plan.operatingDays ?? [true, true, true, true, true, true, true]),
    ];
    const turnaround = turnaroundByType.get(outbound.plannedTypeCode) ?? 40;

    departureSlots(plan.frequency, plan.flightNumber).forEach((departureLocal, slotIndex) => {
      // Resolve once on the reference date to derive the arrival and the
      // return slot; from then on these are published local times.
      const outDeparture = zonedTimeToInstant(referenceDate, departureLocal, origin.timeZone);
      const outArrival = addMinutes(outDeparture.instant, outbound.blockMinutes);
      const returnDeparture = addMinutes(outArrival, turnaround + GROUND_BUFFER_MINUTES);
      const returnArrival = addMinutes(returnDeparture, inbound.blockMinutes);

      const outFlightNumber = `${MARKETING_CODE}${plan.flightNumber + slotIndex * 20}`;
      const backFlightNumber = `${MARKETING_CODE}${plan.flightNumber + 1 + slotIndex * 20}`;

      schedules.push({
        id: seededId("schedule", `${outFlightNumber}:${outKey}`),
        flightNumber: outFlightNumber,
        routeKey: outKey,
        originIata,
        destinationIata: plan.destination,
        departureLocalTime: departureLocal,
        arrivalLocalTime: formatLocalTime(outArrival, destination.timeZone),
        arrivalDayOffset:
          formatLocalDate(outArrival, destination.timeZone) > referenceDate ? 1 : 0,
        operatingDays,
        plannedTypeCode: outbound.plannedTypeCode,
        equipment: plan.equipment,
        blockMinutes: outbound.blockMinutes,
        season: plan.season ?? null,
      });

      schedules.push({
        id: seededId("schedule", `${backFlightNumber}:${backKey}`),
        flightNumber: backFlightNumber,
        routeKey: backKey,
        originIata: plan.destination,
        destinationIata: originIata,
        departureLocalTime: formatLocalTime(returnDeparture, destination.timeZone),
        arrivalLocalTime: formatLocalTime(returnArrival, origin.timeZone),
        arrivalDayOffset:
          formatLocalDate(returnArrival, origin.timeZone) >
          formatLocalDate(returnDeparture, destination.timeZone)
            ? 1
            : 0,
        operatingDays,
        plannedTypeCode: inbound.plannedTypeCode,
        equipment: plan.equipment,
        blockMinutes: inbound.blockMinutes,
        season: plan.season ?? null,
      });
    });
  });

  return schedules;
}

// --- Flight instances ------------------------------------------------------

export interface GeneratedFlight {
  id: string;
  scheduleId: string;
  flightNumber: string;
  callsign: string;
  routeKey: string;
  originIata: string;
  destinationIata: string;
  serviceDate: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  estimatedDeparture: string | null;
  estimatedArrival: string | null;
  actualDeparture: string | null;
  actualArrival: string | null;
  status: FlightStatus;
  phase: FlightPhase;
  delayMinutes: number;
  delayReason: string | null;
  equipment: Equipment;
  plannedTypeCode: string;
  departureGate: string | null;
  departureTerminal: string | null;
  arrivalGate: string | null;
  baggageCarousel: string | null;
  registration: string | null;
  cancellationReason: string | null;
}

const DELAY_REASONS = [
  "rotation",
  "air_traffic_control",
  "weather",
  "ground_handling",
  "technical",
] as const;

/**
 * Status follows from where the flight sits relative to `now`, so the board
 * always looks like a real operating day: last night's flights arrived, this
 * morning's are airborne, this afternoon's are boarding.
 */
function stateFor(
  departure: string,
  arrival: string,
  now: string,
  cancelled: boolean,
): { status: FlightStatus; phase: FlightPhase } {
  if (cancelled) return { status: "cancelled", phase: "preflight" };

  const nowMs = epochMs(now);
  const departureMs = epochMs(departure);
  const arrivalMs = epochMs(arrival);
  const minutesToDeparture = (departureMs - nowMs) / 60_000;

  if (nowMs >= arrivalMs) return { status: "arrived", phase: "arrived" };

  if (nowMs >= departureMs) {
    const progress = (nowMs - departureMs) / (arrivalMs - departureMs);
    if (progress < 0.06) return { status: "taxi_out", phase: "taxi_out" };
    if (progress < 0.18) return { status: "airborne", phase: "climb" };
    if (progress < 0.78) return { status: "airborne", phase: "cruise" };
    if (progress < 0.94) return { status: "airborne", phase: "descent" };
    return { status: "taxi_in", phase: "taxi_in" };
  }

  if (minutesToDeparture <= 20) return { status: "gate_closed", phase: "boarding" };
  if (minutesToDeparture <= 45) return { status: "boarding", phase: "boarding" };
  if (minutesToDeparture <= 150) return { status: "check_in_open", phase: "preflight" };
  return { status: "scheduled", phase: "preflight" };
}

export function buildFlights(
  schedules: readonly GeneratedSchedule[],
  stations: readonly SeedStation[],
  referenceDate: string,
  now: string,
): GeneratedFlight[] {
  const byIata = new Map(stations.map((station) => [station.iataCode, station]));
  const from = addLocalDaysSafe(referenceDate, -DAYS_BEFORE);
  const to = addLocalDaysSafe(referenceDate, DAYS_AFTER);
  const dates = localDateRange(from, to);

  const flights: GeneratedFlight[] = [];

  for (const schedule of schedules) {
    const origin = byIata.get(schedule.originIata);
    const destination = byIata.get(schedule.destinationIata);
    if (!origin || !destination) continue;

    for (const date of dates) {
      const departure = zonedTimeToInstant(date, schedule.departureLocalTime, origin.timeZone);
      const weekday = weekdayInZone(departure.instant, origin.timeZone);
      if (!schedule.operatingDays[weekday]) continue;

      const key = `${schedule.flightNumber}:${date}`;
      const arrival = addMinutes(departure.instant, schedule.blockMinutes);

      // Roughly one flight in forty is cancelled, and one in seven picks up a
      // primary delay. The magnitude is weighted heavily toward small values
      // rather than drawn flat: a uniform 15-95 minutes gives a mean delay of
      // 55, which is nothing like a real operation and cascaded through every
      // rotation. Most delays are a quarter of an hour and vanish into the
      // ground buffer; a few are genuinely disruptive.
      const cancelled = unit(`cancel:${key}`) < 0.025;
      const isDelayed = !cancelled && unit(`delay:${key}`) < 0.14;
      const severity = unit(`delaymin:${key}`) ** 2.5;
      const delayMinutes = isDelayed ? 10 + Math.round(severity * 100) : 0;

      const estimatedDeparture =
        delayMinutes > 0 ? addMinutes(departure.instant, delayMinutes) : null;
      const estimatedArrival =
        delayMinutes > 0 ? addMinutes(arrival, arrivalDelayFor(delayMinutes)) : null;
      const effectiveDeparture = estimatedDeparture ?? departure.instant;
      const effectiveArrival = estimatedArrival ?? arrival;

      const { status, phase } = stateFor(effectiveDeparture, effectiveArrival, now, cancelled);
      const departed = status === "airborne" || status === "taxi_in" || status === "arrived";
      const landed = status === "arrived";

      flights.push({
        id: seededId("flight", key),
        scheduleId: schedule.id,
        flightNumber: schedule.flightNumber,
        callsign: `ASO${schedule.flightNumber.slice(2)}`,
        routeKey: schedule.routeKey,
        originIata: schedule.originIata,
        destinationIata: schedule.destinationIata,
        serviceDate: date,
        scheduledDeparture: departure.instant,
        scheduledArrival: arrival,
        estimatedDeparture,
        estimatedArrival,
        actualDeparture: departed ? effectiveDeparture : null,
        actualArrival: landed ? effectiveArrival : null,
        status,
        phase,
        delayMinutes,
        delayReason: delayMinutes > 0 ? choose(`reason:${key}`, DELAY_REASONS) : null,
        equipment: schedule.equipment,
        plannedTypeCode: schedule.plannedTypeCode,
        departureTerminal: origin.isHub ? choose(`term:${key}`, ["1", "2"]) : null,
        departureGate: `${choose(`gatel:${key}`, ["A", "B", "C"])}${pick(`gaten:${key}`, 1, 24)}`,
        arrivalGate: `${choose(`agatel:${key}`, ["A", "B", "C", "D"])}${pick(`agaten:${key}`, 1, 24)}`,
        baggageCarousel: landed ? String(pick(`belt:${key}`, 1, 8)) : null,
        registration: null,
        cancellationReason: cancelled
          ? choose(`cxr:${key}`, [
              "Aircraft unavailable, no substitute within the window.",
              "Commercial decision: insufficient demand.",
              "Airport restriction at destination.",
            ])
          : null,
      });
    }
  }

  flights.sort((a, b) => a.scheduledDeparture.localeCompare(b.scheduledDeparture));
  return flights;
}

/** `localDateRange` needs a well-ordered pair; this keeps the arithmetic honest. */
function addLocalDaysSafe(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return toInstant(Date.UTC(y, m - 1, d + days)).slice(0, 10);
}

// --- Rotations -------------------------------------------------------------

interface Tail {
  registration: string;
  typeCode: string;
  equipment: Equipment;
  atIata: string;
  freeAt: number;
  turnaround: number;
}

export interface RotationResult {
  assigned: number;
  unassigned: GeneratedFlight[];
  /** Sectors pushed late because the inbound aircraft arrived late. */
  rotationDelays: number;
}

const EQUIPMENT_TYPES: Readonly<Record<Equipment, readonly string[]>> = {
  turboprop: ["AT76"],
  // The A319, A320 and A320neo share a rating, so a rotation may use any of
  // them for a narrow-body sector. Phase 5's crew rules depend on that being
  // true, and it is most of why an all-Airbus fleet was chosen.
  narrow_body: ["A319", "A320", "A20N"],
  wide_body: ["A332"],
};

/**
 * Greedy rotation builder.
 *
 * Walks the day in departure order and gives each flight the airframe that has
 * been sitting at its origin longest, provided the minimum turnaround has
 * elapsed. Hub-and-spoke networks chain naturally under this rule, and where
 * they do not, the flight is left without an aircraft rather than teleporting
 * one -- an unassigned flight is a real operational state, and one the alert
 * feed should be showing.
 *
 * `unserviceable` names the airframes the domain will not allow onto a flight
 * -- see `unserviceableRegistrations`. They are held out of the pool rather
 * than rostered and then flagged, because the rules that refuse an assignment
 * apply to the seed's assignments too.
 */
export function assignRotations(
  flights: GeneratedFlight[],
  now: string,
  unserviceable: ReadonlySet<string>,
): RotationResult {
  const turnaroundByType = new Map(
    SEED_AIRCRAFT_TYPES.map((type) => [type.icaoTypeCode, type.minimumTurnaroundMinutes]),
  );
  const equipmentByType = new Map(
    SEED_AIRCRAFT_TYPES.map((type) => [
      type.icaoTypeCode,
      type.bodyType === "regional"
        ? ("turboprop" as const)
        : type.bodyType === "wide_body"
          ? ("wide_body" as const)
          : ("narrow_body" as const),
    ]),
  );

  const tails: Tail[] = SEED_AIRCRAFT.filter(
    (entry) => !entry.unavailable && !unserviceable.has(entry.registration),
  ).map((entry) => ({
    registration: entry.registration,
    typeCode: entry.icaoTypeCode,
    equipment: equipmentByType.get(entry.icaoTypeCode) ?? "narrow_body",
    atIata: entry.baseIata,
    freeAt: 0,
    turnaround: turnaroundByType.get(entry.icaoTypeCode) ?? 40,
  }));

  const unassigned: GeneratedFlight[] = [];
  let assigned = 0;
  let rotationDelays = 0;

  for (const flight of flights) {
    if (flight.status === "cancelled") continue;

    const departureMs = epochMs(flight.scheduledDeparture);
    const allowedTypes = EQUIPMENT_TYPES[flight.equipment];

    // Only airframes actually standing at the origin. Nothing here teleports.
    const present = tails.filter(
      (tail) => allowedTypes.includes(tail.typeCode) && tail.atIata === flight.originIata,
    );

    // How late each candidate would make this flight, honouring its minimum
    // turnaround. Prefer one that makes it no later at all: a punctual aircraft
    // standing on the ramp should be used ahead of a late one, which an earlier
    // version got wrong by sorting purely on who had waited longest.
    const candidates = present
      .map((candidate) => ({
        tail: candidate,
        knockOn: Math.max(
          0,
          Math.round((candidate.freeAt + candidate.turnaround * 60_000 - departureMs) / 60_000),
        ),
      }))
      // Past about an hour a controller swaps the aircraft or cancels rather
      // than letting the delay ride -- which is the very operation this console
      // exists to perform. Leaving the flight unassigned surfaces it for a
      // person instead of modelling an airline that never intervenes.
      .filter((candidate) => candidate.knockOn <= MAX_ROTATION_KNOCK_ON_MINUTES)
      .sort((a, b) => a.knockOn - b.knockOn || a.tail.freeAt - b.tail.freeAt);

    const chosen = candidates[0];
    if (!chosen) {
      // A flight with no airframe has not departed and is not in the air. The
      // status computed from the schedule assumed one would be found, so it is
      // wound back here -- otherwise the seed produces flights that are
      // "airborne" with no aircraft, which is not a state an operation can be
      // in and would have quietly poisoned every dashboard metric built on it.
      flight.status = "scheduled";
      flight.phase = "preflight";
      flight.actualDeparture = null;
      flight.actualArrival = null;
      flight.baggageCarousel = null;
      unassigned.push(flight);
      continue;
    }

    const tail = chosen.tail;
    const readyAt = tail.freeAt + tail.turnaround * 60_000;

    if (chosen.knockOn > 0) {
      // The inbound ran late. A first version treated this as "no aircraft
      // available" and moved on -- which stranded the tail at an outstation
      // for the rest of the simulation, because the only departure from there
      // was the flight just refused. Losses compounded day over day.
      //
      // What actually happens is the delay propagates: the aircraft flies the
      // sector late. That is what a rotation delay *is*, and it is why the
      // reason code exists.
      const knockOn = Math.round((readyAt - departureMs) / 60_000);
      flight.delayMinutes = Math.max(flight.delayMinutes, knockOn);
      flight.delayReason = "rotation";
      flight.estimatedDeparture = toInstant(readyAt);
      flight.estimatedArrival = addMinutes(
        flight.scheduledArrival,
        arrivalDelayFor(flight.delayMinutes),
      );
      rotationDelays += 1;
    }

    const effectiveDeparture = flight.estimatedDeparture ?? flight.scheduledDeparture;
    const effectiveArrival = flight.estimatedArrival ?? flight.scheduledArrival;

    // Status has to be recomputed: a flight pushed an hour late is in a
    // different place in its day than the schedule alone would suggest.
    const state = stateFor(effectiveDeparture, effectiveArrival, now, false);
    flight.status = state.status;
    flight.phase = state.phase;
    const departed = ["airborne", "taxi_in", "arrived"].includes(state.status);
    flight.actualDeparture = departed ? effectiveDeparture : null;
    flight.actualArrival = state.status === "arrived" ? effectiveArrival : null;

    flight.registration = tail.registration;
    tail.atIata = flight.destinationIata;
    tail.freeAt = epochMs(effectiveArrival);
    assigned += 1;
  }

  return { assigned, unassigned, rotationDelays };
}

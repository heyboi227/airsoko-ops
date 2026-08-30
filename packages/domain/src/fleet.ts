import type {
  AircraftOperationalState,
  AircraftServiceability,
  Instant,
} from "@airsoko/contracts";
import { UNSERVICEABLE } from "@airsoko/contracts";
import { epochMs, minutesBetween } from "./time.ts";
import type { OperationalPolicy } from "./policy.ts";

/**
 * What an aircraft is actually doing, derived rather than stored.
 *
 * The airline decides an airframe's *serviceability* -- in service, in the
 * hangar, parked, withdrawn -- and that is a column, because nothing else
 * knows it. Everything else on this page is computed from the flights: where
 * the aircraft is, whether it is flying, what it does next.
 *
 * Phase 1 stored position and status on the aircraft row and they drifted
 * within a day: a tail was airborne out of Zurich while its row still read
 * "active" at Belgrade. Two copies of one fact will always do that eventually.
 * There is now one copy, and it is the flight.
 */

/** The subset of a flight this module needs. Deliberately not the whole row. */
export interface FleetFlight {
  id: string;
  flightNumber: string;
  originIata: string;
  destinationIata: string;
  /** Estimated where known, scheduled otherwise -- what is actually expected. */
  departure: Instant;
  arrival: Instant;
  actualDeparture: Instant | null;
  actualArrival: Instant | null;
  cancelled: boolean;
}

export interface FleetAircraftInput {
  registration: string;
  serviceability: AircraftServiceability;
  /** Where the airline bases this tail; the fallback when it has not flown. */
  baseIata: string | null;
  /** This airframe's flights, any order. */
  flights: readonly FleetFlight[];
}

export interface FleetState {
  operationalState: AircraftOperationalState;
  /** Where the aircraft is, or null while it is between two airports. */
  locationIata: string | null;
  /** The sector being flown right now, if any. */
  currentFlight: FleetFlight | null;
  /** The next sector not yet departed. */
  nextFlight: FleetFlight | null;
  /** The most recently completed sector. */
  previousFlight: FleetFlight | null;
  /** Minutes until the next departure. Negative if it is already overdue. */
  minutesToNextDeparture: number | null;
  /** Ground time between the last arrival and the next departure. */
  groundMinutes: number | null;
}

const byDeparture = (a: FleetFlight, b: FleetFlight) =>
  epochMs(a.departure) - epochMs(b.departure);

/**
 * Reduce one airframe's flights to its current state at `now`.
 *
 * Pure and deterministic: `now` is an argument, never the clock.
 */
export function deriveFleetState(
  aircraft: FleetAircraftInput,
  now: Instant,
  policy: OperationalPolicy,
): FleetState {
  const flights = aircraft.flights.filter((flight) => !flight.cancelled).sort(byDeparture);
  const nowMs = epochMs(now);

  const airborne =
    flights.find((flight) => {
      const off = flight.actualDeparture ?? flight.departure;
      const on = flight.actualArrival ?? flight.arrival;
      return epochMs(off) <= nowMs && nowMs < epochMs(on);
    }) ?? null;

  const completed = flights.filter((flight) => {
    const on = flight.actualArrival ?? flight.arrival;
    return epochMs(on) <= nowMs;
  });
  const previousFlight = completed.at(-1) ?? null;

  const upcoming = flights.filter((flight) => {
    const off = flight.actualDeparture ?? flight.departure;
    return epochMs(off) > nowMs;
  });
  const nextFlight = upcoming[0] ?? null;

  const minutesToNextDeparture = nextFlight
    ? Math.round(minutesBetween(now, nextFlight.actualDeparture ?? nextFlight.departure))
    : null;

  const groundMinutes =
    previousFlight && nextFlight
      ? Math.round(
          minutesBetween(
            previousFlight.actualArrival ?? previousFlight.arrival,
            nextFlight.actualDeparture ?? nextFlight.departure,
          ),
        )
      : null;

  // Serviceability wins. An airframe in the hangar is unavailable regardless of
  // what the schedule still says about it -- and a schedule that still has it
  // flying is precisely the conflict the assignment rules must catch.
  if (UNSERVICEABLE.includes(aircraft.serviceability as (typeof UNSERVICEABLE)[number])) {
    return {
      operationalState: "unavailable",
      locationIata: previousFlight?.destinationIata ?? aircraft.baseIata,
      currentFlight: null,
      nextFlight,
      previousFlight,
      minutesToNextDeparture,
      groundMinutes,
    };
  }

  if (airborne) {
    return {
      // In the air, an aircraft has no airport. Reporting one would be a
      // small lie that a map or a turnaround check would then act on.
      operationalState: "airborne",
      locationIata: null,
      currentFlight: airborne,
      nextFlight,
      previousFlight,
      minutesToNextDeparture,
      groundMinutes,
    };
  }

  const locationIata = previousFlight?.destinationIata ?? aircraft.baseIata;

  // Turnaround is a short stop between two sectors, not merely "parked". The
  // threshold is the type's minimum plus the warning margin, which is the same
  // figure the assignment rules use -- so an aircraft shown as turning round is
  // exactly one a controller should think twice about re-assigning.
  const turnaroundCeiling =
    policy.turnaround.minimumMinutes.narrow_body + policy.turnaround.warnWithinMinutes * 4;

  const turning =
    previousFlight !== null &&
    nextFlight !== null &&
    groundMinutes !== null &&
    groundMinutes <= turnaroundCeiling &&
    minutesToNextDeparture !== null &&
    minutesToNextDeparture > 0;

  return {
    operationalState: turning ? "turnaround" : "on_ground",
    locationIata,
    currentFlight: null,
    nextFlight,
    previousFlight,
    minutesToNextDeparture,
    groundMinutes,
  };
}

// --- Maintenance ------------------------------------------------------------

export interface MaintenanceLimits {
  nextCheckType: string | null;
  nextCheckDueAt: Instant | null;
  nextCheckDueHours: number | null;
  nextCheckDueCycles: number | null;
  totalHours: number;
  totalCycles: number;
}

export type MaintenanceUrgency = "ok" | "approaching" | "exceeded" | "unknown";

export interface MaintenanceStanding {
  urgency: MaintenanceUrgency;
  /** Days until the next check is due; negative once overdue. */
  daysRemaining: number | null;
  hoursRemaining: number | null;
  cyclesRemaining: number | null;
  /** Which limit bites first, in the operator's words. */
  limitingFactor: "calendar" | "hours" | "cycles" | null;
  summary: string;
}

/**
 * How close an airframe is to its next check, across all three limits.
 *
 * Maintenance intervals run against whichever of calendar time, flight hours or
 * cycles is reached first, so the answer is the tightest of the three -- and
 * saying *which* one is tightest is the part a fleet manager actually acts on.
 */
export function maintenanceStanding(
  limits: MaintenanceLimits,
  now: Instant,
  policy: OperationalPolicy,
): MaintenanceStanding {
  const daysRemaining =
    limits.nextCheckDueAt === null
      ? null
      : Math.floor(minutesBetween(now, limits.nextCheckDueAt) / (60 * 24));

  const hoursRemaining =
    limits.nextCheckDueHours === null ? null : limits.nextCheckDueHours - limits.totalHours;

  const cyclesRemaining =
    limits.nextCheckDueCycles === null ? null : limits.nextCheckDueCycles - limits.totalCycles;

  if (daysRemaining === null && hoursRemaining === null && cyclesRemaining === null) {
    return {
      urgency: "unknown",
      daysRemaining: null,
      hoursRemaining: null,
      cyclesRemaining: null,
      limitingFactor: null,
      summary: "No next check recorded.",
    };
  }

  // Normalise each limit to "fraction of its warning window still left", so
  // three different units can be compared and the tightest one named.
  const candidates: { factor: "calendar" | "hours" | "cycles"; slack: number }[] = [];
  if (daysRemaining !== null) {
    candidates.push({
      factor: "calendar",
      slack: daysRemaining / policy.maintenance.warnWithinDays,
    });
  }
  if (hoursRemaining !== null) {
    candidates.push({
      factor: "hours",
      slack: hoursRemaining / policy.maintenance.warnWithinHours,
    });
  }
  if (cyclesRemaining !== null) {
    candidates.push({
      factor: "cycles",
      slack: cyclesRemaining / policy.maintenance.warnWithinCycles,
    });
  }

  candidates.sort((a, b) => a.slack - b.slack);
  const tightest = candidates[0];
  if (!tightest) {
    return {
      urgency: "unknown",
      daysRemaining,
      hoursRemaining,
      cyclesRemaining,
      limitingFactor: null,
      summary: "No next check recorded.",
    };
  }

  const urgency: MaintenanceUrgency =
    tightest.slack < 0 ? "exceeded" : tightest.slack <= 1 ? "approaching" : "ok";

  const wording: Readonly<Record<"calendar" | "hours" | "cycles", string>> = {
    calendar:
      daysRemaining === null
        ? ""
        : daysRemaining < 0
          ? `${Math.abs(daysRemaining)} days overdue`
          : `${daysRemaining} days remaining`,
    hours:
      hoursRemaining === null
        ? ""
        : hoursRemaining < 0
          ? `${Math.abs(hoursRemaining)} hours past the limit`
          : `${hoursRemaining} flight hours remaining`,
    cycles:
      cyclesRemaining === null
        ? ""
        : cyclesRemaining < 0
          ? `${Math.abs(cyclesRemaining)} cycles past the limit`
          : `${cyclesRemaining} cycles remaining`,
  };

  const check = limits.nextCheckType ? limits.nextCheckType.replace(/_/g, " ") : "next check";

  return {
    urgency,
    daysRemaining,
    hoursRemaining,
    cyclesRemaining,
    limitingFactor: tightest.factor,
    summary:
      urgency === "exceeded"
        ? `${check} overdue: ${wording[tightest.factor]}.`
        : urgency === "approaching"
          ? `${check} approaching: ${wording[tightest.factor]}.`
          : `${check} in ${wording[tightest.factor]}.`,
  };
}

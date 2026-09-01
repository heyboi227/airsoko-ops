import type { FlightPhase, FlightStatus, Instant } from "@airsoko/contracts";
import { TERMINAL_FLIGHT_STATUSES } from "@airsoko/contracts";
import { addMinutes, epochMs, minutesBetween } from "./time.ts";
import type { OperationalPolicy } from "./policy.ts";

/**
 * What a flight *is*, derived from what is stored about it.
 *
 * Six timestamps are stored -- scheduled, estimated and actual for each end --
 * and everything an operator reads off a flight board is a function of those
 * six plus the clock. Delay, progress, whether the day is over: none of it is
 * a column, because a column would be a second copy of a fact the timestamps
 * already state, and the two would disagree within a day. Phase 1 proved that
 * with `aircraft.status`; the lesson generalises.
 *
 * Everything here is pure and takes `now` as an argument.
 */

/** What is actually expected: what happened, else what is expected, else what was promised. */
export function effectiveDeparture(flight: {
  scheduledDeparture: Instant;
  estimatedDeparture: Instant | null;
  actualDeparture: Instant | null;
}): Instant {
  return flight.actualDeparture ?? flight.estimatedDeparture ?? flight.scheduledDeparture;
}

export function effectiveArrival(flight: {
  scheduledArrival: Instant;
  estimatedArrival: Instant | null;
  actualArrival: Instant | null;
}): Instant {
  return flight.actualArrival ?? flight.estimatedArrival ?? flight.scheduledArrival;
}

export interface FlightTimes {
  scheduledDeparture: Instant;
  estimatedDeparture: Instant | null;
  actualDeparture: Instant | null;
  scheduledArrival: Instant;
  estimatedArrival: Instant | null;
  actualArrival: Instant | null;
}

/**
 * Minutes later than scheduled. Negative when the flight is running early.
 *
 * Measured at the departure, because that is the delay an operation manages;
 * arrival delay is a consequence of it and of what the aircraft makes up in
 * the air. Rounded, because a delay expressed in seconds is false precision on
 * a figure that comes from a controller's judgement.
 */
export function departureDelayMinutes(flight: FlightTimes): number {
  return Math.round(minutesBetween(flight.scheduledDeparture, effectiveDeparture(flight)));
}

export function arrivalDelayMinutes(flight: FlightTimes): number {
  return Math.round(minutesBetween(flight.scheduledArrival, effectiveArrival(flight)));
}

/**
 * Delayed is a derived condition, never a status -- decision 4.
 *
 * A flight can be boarding *and* late, and one enum field cannot hold both
 * without erasing one of them. The map legend still gives delay its own
 * treatment; it just reads this flag.
 */
export function isDelayed(delayMinutes: number, policy: OperationalPolicy): boolean {
  return delayMinutes >= policy.delay.thresholdMinutes;
}

export function isSignificantlyDelayed(
  delayMinutes: number,
  policy: OperationalPolicy,
): boolean {
  return delayMinutes >= policy.delay.significantMinutes;
}

/** Planned gate-to-gate minutes for this operation. */
export function blockMinutes(flight: FlightTimes): number {
  return Math.round(minutesBetween(flight.scheduledDeparture, flight.scheduledArrival));
}

/**
 * How far through its sector a flight is, from 0 to 1.
 *
 * Measured against the expected times rather than the scheduled ones: a flight
 * that left forty minutes late is not forty minutes further along than it is.
 * Clamped at both ends so a late-running arrival never reports more than 1,
 * which would put a marker past its destination.
 */
export function flightProgress(flight: FlightTimes, now: Instant): number {
  const off = epochMs(effectiveDeparture(flight));
  const on = epochMs(effectiveArrival(flight));
  const at = epochMs(now);

  if (on <= off) return at >= on ? 1 : 0;
  if (at <= off) return 0;
  if (at >= on) return 1;
  return (at - off) / (on - off);
}

/**
 * What a flight's estimates become when its scheduled times move.
 *
 * A delay is measured against the timetable, so moving the timetable without
 * moving the estimate leaves a flight reporting an expected departure *before*
 * its own scheduled one. That is not "early", it is a stale number from a
 * schedule that no longer exists -- and it is what a series retiming produced
 * the first time one ran against seeded delays.
 *
 * The delay is still a fact about the operation, so it travels with the
 * change: the same minutes late, against the new time. A flight with no
 * estimate keeps none.
 */
export function shiftEstimates(
  current: FlightTimes,
  scheduledDeparture: Instant,
  scheduledArrival: Instant,
): { estimatedDeparture: Instant | null; estimatedArrival: Instant | null } {
  return {
    estimatedDeparture: current.estimatedDeparture
      ? addMinutes(
          scheduledDeparture,
          minutesBetween(current.scheduledDeparture, current.estimatedDeparture),
        )
      : null,
    estimatedArrival: current.estimatedArrival
      ? addMinutes(
          scheduledArrival,
          minutesBetween(current.scheduledArrival, current.estimatedArrival),
        )
      : null,
  };
}

// --- Status lifecycle ------------------------------------------------------

/**
 * The order an ordinary flight moves through.
 *
 * `diverted` and `cancelled` are deliberately absent: neither is a step along
 * this chain, they are departures from it, and the transition rules below
 * treat them as such.
 */
export const FLIGHT_STATUS_SEQUENCE = [
  "scheduled",
  "check_in_open",
  "boarding",
  "gate_closed",
  "taxi_out",
  "airborne",
  "taxi_in",
  "arrived",
] as const satisfies readonly FlightStatus[];

export const FLIGHT_STATUS_LABELS: Readonly<Record<FlightStatus, string>> = {
  scheduled: "Scheduled",
  check_in_open: "Check-in open",
  boarding: "Boarding",
  gate_closed: "Gate closed",
  taxi_out: "Taxiing out",
  airborne: "Airborne",
  taxi_in: "Taxiing in",
  arrived: "Arrived",
  diverted: "Diverted",
  cancelled: "Cancelled",
};

/** The phase an airframe is in when a controller sets a given status. */
export const PHASE_FOR_STATUS: Readonly<Record<FlightStatus, FlightPhase>> = {
  scheduled: "preflight",
  check_in_open: "preflight",
  boarding: "boarding",
  gate_closed: "boarding",
  taxi_out: "taxi_out",
  airborne: "climb",
  taxi_in: "taxi_in",
  arrived: "arrived",
  diverted: "descent",
  cancelled: "preflight",
};

/** Statuses at or beyond pushback: the aircraft is committed to the sector. */
export const DEPARTED_STATUSES = [
  "taxi_out",
  "airborne",
  "taxi_in",
  "arrived",
  "diverted",
] as const satisfies readonly FlightStatus[];

export function hasDeparted(status: FlightStatus): boolean {
  return (DEPARTED_STATUSES as readonly FlightStatus[]).includes(status);
}

export function isTerminal(status: FlightStatus): boolean {
  return (TERMINAL_FLIGHT_STATUSES as readonly FlightStatus[]).includes(status);
}

/**
 * Where a flight may go from where it is.
 *
 * Forward one step along the chain; backwards one step too, but only while the
 * aircraft is still on stand -- a mis-click that opens boarding early has to be
 * correctable, and nothing has physically happened yet. Once the aircraft has
 * pushed back the chain is one-way: a return to stand is a different operation
 * with different consequences, and pretending it is "boarding again" would put
 * the flight in a state its own timeline contradicts.
 *
 * `cancelled` is reachable only before pushback, for the same reason. An
 * airborne flight is not cancelled; it is diverted, or it lands.
 */
export function allowedNextStatuses(current: FlightStatus): FlightStatus[] {
  if (isTerminal(current)) return [];
  if (current === "diverted") return ["taxi_in", "arrived"];

  const index = (FLIGHT_STATUS_SEQUENCE as readonly FlightStatus[]).indexOf(current);
  if (index < 0) return [];

  const allowed: FlightStatus[] = [];
  const next = FLIGHT_STATUS_SEQUENCE[index + 1];
  if (next) allowed.push(next);

  const pushbackIndex = (FLIGHT_STATUS_SEQUENCE as readonly FlightStatus[]).indexOf("taxi_out");
  const onStand = index < pushbackIndex;

  if (onStand) {
    const previous = FLIGHT_STATUS_SEQUENCE[index - 1];
    if (previous) allowed.push(previous);
    allowed.push("cancelled");
  }

  if (current === "airborne") allowed.push("diverted");

  return allowed;
}

// --- The operational timeline ----------------------------------------------

export interface TimelineStep {
  /** Stable key, matched against `flight_status_events.event_type`. */
  eventType: string;
  label: string;
  /** When this step is due, from the flight's own times and the duty policy. */
  scheduledAt: Instant;
  /** The status this step corresponds to, where one does. */
  status: FlightStatus | null;
}

/**
 * The steps every flight is expected to pass through, and when each is due.
 *
 * The brief asks for "crew report, aircraft at gate, check-in open, boarding,
 * pushback, take-off, landing, gate arrival". They are derived here rather
 * than seeded as rows so that a flight which has not started yet still shows
 * its whole day -- an empty timeline for tomorrow's departure would be
 * technically true and operationally useless.
 *
 * Actual events, when they exist, are matched onto these by `eventType` at the
 * edge. This function states what *ought* to happen; the events table records
 * what did.
 */
export function expectedTimeline(
  flight: Pick<FlightTimes, "scheduledDeparture" | "scheduledArrival">,
  policy: OperationalPolicy,
): TimelineStep[] {
  const departure = flight.scheduledDeparture;
  const arrival = flight.scheduledArrival;

  const steps: TimelineStep[] = [
    {
      eventType: "crew_report",
      label: "Crew report",
      scheduledAt: addMinutes(departure, -policy.duty.reportBeforeDepartureMinutes),
      status: null,
    },
    {
      eventType: "aircraft_at_gate",
      label: "Aircraft at gate",
      scheduledAt: addMinutes(departure, -50),
      status: null,
    },
    {
      eventType: "check_in_open",
      label: "Check-in open",
      scheduledAt: addMinutes(departure, -120),
      status: "check_in_open",
    },
    {
      eventType: "boarding_started",
      label: "Boarding",
      scheduledAt: addMinutes(departure, -40),
      status: "boarding",
    },
    {
      eventType: "gate_closed",
      label: "Gate closed",
      scheduledAt: addMinutes(departure, -10),
      status: "gate_closed",
    },
    {
      eventType: "pushback",
      label: "Pushback",
      scheduledAt: departure,
      status: "taxi_out",
    },
    {
      eventType: "airborne",
      label: "Take-off",
      scheduledAt: addMinutes(departure, 12),
      status: "airborne",
    },
    {
      eventType: "landed",
      label: "Landing",
      scheduledAt: addMinutes(arrival, -8),
      status: "taxi_in",
    },
    {
      eventType: "on_blocks",
      label: "On blocks",
      scheduledAt: arrival,
      status: "arrived",
    },
  ];

  return steps.sort((a, b) => epochMs(a.scheduledAt) - epochMs(b.scheduledAt));
}

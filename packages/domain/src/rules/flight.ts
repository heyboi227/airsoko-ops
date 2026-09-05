import type { FlightStatus, Id, Instant, LocalDate } from "@airsoko/contracts";
import { ACTIVE_FLIGHT_STATUSES } from "@airsoko/contracts";
import { EvaluationBuilder, blocking, consequence, resourceRef, warning } from "../intent.ts";
import type { Evaluation } from "../intent.ts";
import { distanceNm } from "../geo.ts";
import { grouped } from "../format.ts";
import { GROUND_AND_MANOEUVRE_MINUTES, impliedCruiseKts } from "../network.ts";
import { addMinutes, formatLocalTime, minutesBetween } from "../time.ts";
import {
  FLIGHT_STATUS_LABELS,
  allowedNextStatuses,
  blockMinutes,
  hasDeparted,
  isSignificantlyDelayed,
  isTerminal,
} from "../flights.ts";
import type { OperationalPolicy } from "../policy.ts";

/**
 * The rules that guard a flight.
 *
 * Phase 3's gate is that "a conflicting change is refused with a precise
 * reason, and nothing invalid is persisted". Precise is the operative word:
 * every finding below names the flight, the figure and the fix, because a
 * controller reading "invalid schedule" learns nothing they can act on.
 *
 * The aircraft-assignment rules are not here. They were written in Phase 2 and
 * live in `./aircraft.ts`, which is where they belong -- the question "may this
 * airframe fly that sector" is about the airframe. This file asks the other
 * questions: is the sector itself coherent, may the flight move to this state,
 * and what breaks if it does.
 */

// --- Shared shapes ---------------------------------------------------------

export interface FlightEndpointFacts {
  iataCode: string;
  name: string;
  timeZone: string;
  latitude: number;
  longitude: number;
  isHub: boolean;
}

export interface FlightFacts {
  id: Id;
  flightNumber: string;
  serviceDate: LocalDate;
  status: FlightStatus;
  scheduledDeparture: Instant;
  estimatedDeparture: Instant | null;
  actualDeparture: Instant | null;
  scheduledArrival: Instant;
  estimatedArrival: Instant | null;
  actualArrival: Instant | null;
  aircraftId: Id | null;
  aircraftRegistration: string | null;
  scheduleId: Id | null;
}

/** The pattern a flight came from, where it came from one. */
export interface SeriesFacts {
  id: Id;
  flightNumber: string;
  validFrom: LocalDate;
  validTo: LocalDate;
  /** Sunday-first. */
  operatingDays: readonly boolean[];
}

/** Another flight already carrying this number on this date. */
export interface NumberClash {
  flightId: Id;
  flightNumber: string;
  serviceDate: LocalDate;
}

// --- Is the sector itself coherent? ---------------------------------------

export interface FlightScheduleDraft {
  /** Null when the flight is being created. */
  flightId: Id | null;
  flightNumber: string;
  serviceDate: LocalDate;
  origin: FlightEndpointFacts;
  destination: FlightEndpointFacts;
  scheduledDeparture: Instant;
  scheduledArrival: Instant;
}

export interface FlightScheduleContext {
  now: Instant;
  policy: OperationalPolicy;
  /** Flights on this number and date other than the one being changed. */
  numberClashes: readonly NumberClash[];
  series: SeriesFacts | null;
  /** The flight as it stands, when one is being changed rather than created. */
  current: FlightFacts | null;
}

/**
 * Fastest and slowest plausible block speeds, in knots.
 *
 * These bracket "an aeroplane flew this", not "this is the right block time".
 * Nothing in commercial service cruises past 700 kts, and a scheduled sector
 * averaging under 140 kts over the ground is either a typo or a different unit.
 * The warning band is tighter and only says the figure looks unusual.
 */
const IMPOSSIBLE_CRUISE_KTS = 700;
const UNUSUALLY_FAST_KTS = 560;
const UNUSUALLY_SLOW_KTS = 140;
/** Below this, nothing has left a gate and arrived anywhere. */
const IMPLAUSIBLY_SHORT_BLOCK_MINUTES = 25;
const IMPLAUSIBLY_LONG_BLOCK_MINUTES = 20 * 60;

export function evaluateFlightSchedule(
  draft: FlightScheduleDraft,
  context: FlightScheduleContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const { policy } = context;
  const subject = draft.flightId
    ? resourceRef("flight", draft.flightId, draft.flightNumber)
    : undefined;
  const extras = subject ? { subject } : {};

  // --- A flight that has gone is not a plan any more -----------------------
  if (context.current && hasDeparted(context.current.status)) {
    builder.add(
      blocking(
        "FLIGHT_ALREADY_DEPARTED",
        `${draft.flightNumber} has already departed`,
        `${draft.flightNumber} is ${FLIGHT_STATUS_LABELS[context.current.status].toLowerCase()} and its times are now a record of what happened. Record a delay or a diversion instead of retiming it.`,
        extras,
      ),
    );
  }
  if (context.current && context.current.status === "cancelled") {
    builder.add(
      blocking(
        "FLIGHT_ALREADY_DEPARTED",
        `${draft.flightNumber} is cancelled`,
        `A cancelled flight is not rescheduled. Create the replacement sector instead, so the cancellation stays in the record.`,
        extras,
      ),
    );
  }

  // --- Endpoints -----------------------------------------------------------
  if (draft.origin.iataCode === draft.destination.iataCode) {
    builder.add(
      blocking(
        "SCHEDULE_SAME_ORIGIN_AND_DESTINATION",
        `${draft.origin.iataCode} to itself`,
        `${draft.flightNumber} would depart and arrive at ${draft.origin.iataCode}. A sector needs two different airports.`,
        extras,
      ),
    );
  }

  // --- Time ordering -------------------------------------------------------
  const block = blockMinutes({
    scheduledDeparture: draft.scheduledDeparture,
    scheduledArrival: draft.scheduledArrival,
    estimatedDeparture: null,
    actualDeparture: null,
    estimatedArrival: null,
    actualArrival: null,
  });

  if (block <= 0) {
    builder.add(
      blocking(
        "SCHEDULE_INVALID_TIME_ORDER",
        `Arrives before it departs`,
        `${draft.flightNumber} is scheduled to arrive at ${draft.destination.iataCode} ${Math.abs(block)} minutes ${block === 0 ? "at the same moment it" : "before it"} departs ${draft.origin.iataCode}. Check the arrival time, and the next-day flag if this is an overnight sector.`,
        extras,
      ),
    );
  }

  // --- Is the block time possible? ----------------------------------------
  const distance = Math.round(distanceNm(draft.origin, draft.destination));

  if (block > 0 && draft.origin.iataCode !== draft.destination.iataCode) {
    const impliedKts = impliedCruiseKts(distance, block);

    if (block < IMPLAUSIBLY_SHORT_BLOCK_MINUTES || impliedKts > IMPOSSIBLE_CRUISE_KTS) {
      builder.add(
        blocking(
          "SCHEDULE_DURATION_IMPLAUSIBLE",
          `${block} minutes cannot cover ${grouped(distance)} nm`,
          `${draft.origin.iataCode}-${draft.destination.iataCode} is ${grouped(distance)} nm. Allowing ${GROUND_AND_MANOEUVRE_MINUTES} minutes for taxi, climb and descent, a ${block}-minute block implies ${Number.isFinite(impliedKts) ? grouped(impliedKts) : "an infinite"} kt cruise. Nothing in the fleet does that.`,
          extras,
        ),
      );
    } else if (block > IMPLAUSIBLY_LONG_BLOCK_MINUTES) {
      builder.add(
        blocking(
          "SCHEDULE_DURATION_IMPLAUSIBLE",
          `${Math.round(block / 60)} hours gate to gate`,
          `${draft.flightNumber} would block ${Math.round(block / 60)} hours for ${grouped(distance)} nm. Check the arrival time and the next-day flag.`,
          extras,
        ),
      );
    } else if (impliedKts > UNUSUALLY_FAST_KTS) {
      builder.add(
        warning(
          "SCHEDULE_DURATION_IMPLAUSIBLE",
          `Tight block for ${grouped(distance)} nm`,
          `${block} minutes implies a ${grouped(impliedKts)} kt cruise over ${draft.origin.iataCode}-${draft.destination.iataCode}. Only the widebody comes close, and not against a headwind.`,
          extras,
        ),
      );
    } else if (impliedKts < UNUSUALLY_SLOW_KTS) {
      builder.add(
        warning(
          "SCHEDULE_DURATION_IMPLAUSIBLE",
          `Generous block for ${grouped(distance)} nm`,
          `${block} minutes implies a ${grouped(impliedKts)} kt cruise. That is a lot of padding for ${draft.origin.iataCode}-${draft.destination.iataCode}, and it holds an airframe on the ground at the far end.`,
          extras,
        ),
      );
    }
  }

  // --- Is the number free on that date? -----------------------------------
  for (const clash of context.numberClashes) {
    if (clash.flightId === draft.flightId) continue;
    builder.add(
      blocking(
        "FLIGHT_NUMBER_IN_USE_ON_DATE",
        `${draft.flightNumber} already operates on ${draft.serviceDate}`,
        `Another flight already carries ${draft.flightNumber} on ${draft.serviceDate}. A flight number and a service date identify one operation; renumber this sector or move it to another date.`,
        {
          ...extras,
          related: [resourceRef("flight", clash.flightId, clash.flightNumber)],
        },
      ),
    );
  }

  // --- Does it sit inside its own pattern? --------------------------------
  if (context.series) {
    const { series } = context;
    if (draft.serviceDate < series.validFrom || draft.serviceDate > series.validTo) {
      builder.add(
        warning(
          "SCHEDULE_OUTSIDE_VALIDITY_WINDOW",
          `Outside the ${series.flightNumber} season`,
          `${series.flightNumber} is valid from ${series.validFrom} to ${series.validTo}, and this occurrence would sit on ${draft.serviceDate}. It becomes an exception the pattern will not regenerate.`,
          {
            ...extras,
            related: [resourceRef("schedule", series.id, series.flightNumber)],
          },
        ),
      );
    }
  }

  // --- Night restrictions --------------------------------------------------
  builder
    .add(
      curfewFinding(
        draft.origin,
        draft.scheduledDeparture,
        "departs",
        draft.flightNumber,
        policy,
        subject,
      ),
    )
    .add(
      curfewFinding(
        draft.destination,
        draft.scheduledArrival,
        "arrives at",
        draft.flightNumber,
        policy,
        subject,
      ),
    );

  // --- Backdating ----------------------------------------------------------
  if (minutesBetween(context.now, draft.scheduledDeparture) < 0) {
    builder.add(
      warning(
        "SCHEDULE_INVALID_TIME_ORDER",
        `Departure is in the past`,
        `${draft.flightNumber} would be scheduled to depart ${Math.abs(Math.round(minutesBetween(context.now, draft.scheduledDeparture) / 60))} hours ago. That is legitimate when backfilling a day that already happened, and a mistake otherwise.`,
        extras,
      ),
    );
  }

  builder.expect(
    consequence(
      draft.flightId ? "flight_rescheduled" : "flight_created",
      `${draft.flightNumber} ${draft.origin.iataCode}-${draft.destination.iataCode} on ${draft.serviceDate}, ${formatLocalTime(draft.scheduledDeparture, draft.origin.timeZone)} local to ${formatLocalTime(draft.scheduledArrival, draft.destination.timeZone)} local (${block} minutes block, ${grouped(distance)} nm)`,
    ),
  );

  return builder.build();
}

/**
 * A movement inside the station's quiet hours.
 *
 * Warning rather than blocking on purpose: a genuine curfew is a legal
 * restriction we do not hold data for, and refusing a sector on a
 * demonstration threshold would be claiming an authority this system does not
 * have. Telling the operator, and recording what they accepted, is the honest
 * version of the same check.
 */
function curfewFinding(
  airport: FlightEndpointFacts,
  at: Instant,
  verb: string,
  flightNumber: string,
  policy: OperationalPolicy,
  subject: ReturnType<typeof resourceRef> | undefined,
) {
  if (airport.isHub && !policy.curfew.appliesToHubs) return null;

  const local = formatLocalTime(at, airport.timeZone);
  const { quietFromLocalTime: from, quietToLocalTime: to } = policy.curfew;
  // The window wraps midnight, so "inside" is either side of the wrap.
  const inside = from > to ? local >= from || local < to : local >= from && local < to;
  if (!inside) return null;

  return warning(
    "SCHEDULE_AIRPORT_RESTRICTION",
    `${flightNumber} ${verb} ${airport.iataCode} at ${local} local`,
    `${airport.name} is treated as quiet between ${from} and ${to} local. ${policy.disclaimer}`,
    subject ? { subject } : {},
  );
}

// --- May the flight move to this state? -----------------------------------

export interface StatusChangeContext {
  now: Instant;
  policy: OperationalPolicy;
}

export function evaluateStatusChange(
  flight: FlightFacts,
  next: FlightStatus,
  context: StatusChangeContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("flight", flight.id, flight.flightNumber);
  const allowed = allowedNextStatuses(flight.status);

  if (next === flight.status) {
    builder.add(
      blocking(
        "FLIGHT_STATUS_TRANSITION_INVALID",
        `${flight.flightNumber} is already ${FLIGHT_STATUS_LABELS[next].toLowerCase()}`,
        `Nothing would change. Pick the state the flight is moving to.`,
        { subject },
      ),
    );
    return builder.build();
  }

  if (!allowed.includes(next)) {
    builder.add(
      blocking(
        "FLIGHT_STATUS_TRANSITION_INVALID",
        `${FLIGHT_STATUS_LABELS[flight.status]} cannot become ${FLIGHT_STATUS_LABELS[next].toLowerCase()}`,
        isTerminal(flight.status)
          ? `${flight.flightNumber} is ${FLIGHT_STATUS_LABELS[flight.status].toLowerCase()} and its day is over. Nothing moves it from here.`
          : `From ${FLIGHT_STATUS_LABELS[flight.status].toLowerCase()}, ${flight.flightNumber} can move to ${allowed.map((status) => FLIGHT_STATUS_LABELS[status].toLowerCase()).join(", ")}. Anything else would put the flight in a state its own timeline contradicts.`,
        { subject },
      ),
    );
    return builder.build();
  }

  // --- An operation needs an aeroplane ------------------------------------
  if (!flight.aircraftId) {
    if (next === "taxi_out" || next === "airborne") {
      builder.add(
        blocking(
          "FLIGHT_NO_AIRCRAFT_ASSIGNED",
          `${flight.flightNumber} has no aircraft`,
          `Nothing can push back without an airframe. Assign one to ${flight.flightNumber} first.`,
          { subject },
        ),
      );
    } else if (next === "boarding" || next === "gate_closed" || next === "check_in_open") {
      builder.add(
        warning(
          "FLIGHT_NO_AIRCRAFT_ASSIGNED",
          `${flight.flightNumber} still has no aircraft`,
          `Opening ${FLIGHT_STATUS_LABELS[next].toLowerCase()} on an unassigned sector commits passengers to a flight with no airframe. It can be assigned later, but the clock is now running.`,
          { subject },
        ),
      );
    }
  }

  // --- Late in the sequence, early on the clock ---------------------------
  const minutesToDeparture = minutesBetween(
    context.now,
    flight.estimatedDeparture ?? flight.scheduledDeparture,
  );
  if (next === "boarding" && minutesToDeparture > 120) {
    builder.add(
      warning(
        "FLIGHT_STATUS_TRANSITION_INVALID",
        `Boarding ${Math.round(minutesToDeparture / 60)} hours before departure`,
        `${flight.flightNumber} is not due off for ${Math.round(minutesToDeparture)} minutes. Boarding this early is unusual enough to be worth confirming.`,
        { subject },
      ),
    );
  }

  const wasActive = (ACTIVE_FLIGHT_STATUSES as readonly FlightStatus[]).includes(flight.status);
  const isActive = (ACTIVE_FLIGHT_STATUSES as readonly FlightStatus[]).includes(next);

  builder.expect(
    consequence(
      "flight_status_changed",
      `${flight.flightNumber} becomes ${FLIGHT_STATUS_LABELS[next].toLowerCase()}, and the change is recorded on its timeline`,
    ),
  );

  if (wasActive !== isActive) {
    builder.expect(
      consequence(
        "map_visibility_changed",
        isActive
          ? `${flight.flightNumber} starts appearing on live operations`
          : `${flight.flightNumber} leaves live operations`,
      ),
    );
  }

  if (next === "diverted") {
    builder.expect(
      consequence("alerts_raised", `A critical alert is raised for the diversion`, {
        count: 1,
      }),
    );
  }

  return builder.build();
}

// --- Recording a delay -----------------------------------------------------

/** The next sector the same airframe flies, if any. */
export interface NextSector {
  flightId: Id;
  flightNumber: string;
  originIata: string;
  departure: Instant;
  minimumTurnaroundMinutes: number;
}

export interface RecordDelayContext {
  now: Instant;
  policy: OperationalPolicy;
  /** What the same airframe does after this sector. */
  nextSector: NextSector | null;
}

export function evaluateRecordDelay(
  flight: FlightFacts,
  delay: { delayMinutes: number; arrivalDelayMinutes: number; reason: string },
  context: RecordDelayContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("flight", flight.id, flight.flightNumber);
  const { policy } = context;

  if (isTerminal(flight.status)) {
    builder.add(
      blocking(
        "FLIGHT_ALREADY_DEPARTED",
        `${flight.flightNumber} is ${FLIGHT_STATUS_LABELS[flight.status].toLowerCase()}`,
        `Its times are a record of what happened. A delay cannot be recorded against a flight whose day is over.`,
        { subject },
      ),
    );
    return builder.build();
  }

  if (isSignificantlyDelayed(delay.delayMinutes, policy)) {
    builder.add(
      warning(
        "FLIGHT_DELAY_SIGNIFICANT",
        `${delay.delayMinutes} minutes is a significant delay`,
        `Past ${policy.delay.significantMinutes} minutes ${flight.flightNumber} counts against on-time performance and raises an alert that stays in the feed until someone resolves it.`,
        { subject },
      ),
    );
  }

  // --- Does it eat the next turnaround? -----------------------------------
  const nextSector = context.nextSector;
  if (nextSector) {
    const arrival = addMinutes(flight.scheduledArrival, delay.arrivalDelayMinutes);
    const ground = minutesBetween(arrival, nextSector.departure);

    if (ground < nextSector.minimumTurnaroundMinutes) {
      builder.add(
        warning(
          "AIRCRAFT_INSUFFICIENT_TURNAROUND",
          `${nextSector.flightNumber} loses its turnaround`,
          `${flight.aircraftRegistration ?? "The airframe"} would be on the ground at ${nextSector.originIata} for ${Math.round(ground)} minutes against a ${nextSector.minimumTurnaroundMinutes}-minute minimum. ${nextSector.flightNumber} will go late unless it is re-timed or re-assigned.`,
          {
            subject,
            related: [resourceRef("flight", nextSector.flightId, nextSector.flightNumber)],
          },
        ),
      );
      builder.expect(
        consequence(
          "alerts_raised",
          `${nextSector.flightNumber} raises a low-turnaround alert`,
          { count: 1 },
        ),
      );
    }
  }

  builder.expect(
    consequence(
      "delay_recorded",
      delay.delayMinutes === 0
        ? `${flight.flightNumber} returns to its scheduled times`
        : `${flight.flightNumber} is estimated ${delay.delayMinutes} minutes late off and ${delay.arrivalDelayMinutes} minutes late on, reason "${delay.reason.replace(/_/g, " ")}"`,
    ),
  );

  return builder.build();
}

// --- Gates and terminals ---------------------------------------------------

export function evaluateChangeGate(
  flight: FlightFacts,
  gate: { departureGate?: string | null | undefined; arrivalGate?: string | null | undefined },
  origin: { iataCode: string },
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("flight", flight.id, flight.flightNumber);

  if (flight.status === "cancelled") {
    builder.add(
      blocking(
        "FLIGHT_STATUS_TRANSITION_INVALID",
        `${flight.flightNumber} is cancelled`,
        `A cancelled flight has no gate to move.`,
        { subject },
      ),
    );
    return builder.build();
  }

  if (gate.departureGate !== undefined && hasDeparted(flight.status)) {
    builder.add(
      warning(
        "FLIGHT_ALREADY_DEPARTED",
        `${flight.flightNumber} has already left the gate`,
        `Changing the departure gate now edits the record of where it pushed back from rather than telling anybody anything. The arrival gate is still worth setting.`,
        { subject },
      ),
    );
  }

  const parts: string[] = [];
  if (gate.departureGate !== undefined) {
    parts.push(`departure gate ${gate.departureGate ?? "cleared"} at ${origin.iataCode}`);
  }
  if (gate.arrivalGate !== undefined)
    parts.push(`arrival gate ${gate.arrivalGate ?? "cleared"}`);

  builder.expect(
    consequence(
      "gate_changed",
      parts.length > 0
        ? `${flight.flightNumber}: ${parts.join(", ")}`
        : `${flight.flightNumber} terminal and counter details updated`,
    ),
  );

  return builder.build();
}

// --- Releasing the airframe -----------------------------------------------

/**
 * Taking the aircraft off a flight without putting another on.
 *
 * The mirror of `evaluateAircraftAssignment`, and a real operation: a
 * controller robs a tail for a more important sector and leaves this one to be
 * solved. It is a warning rather than a block precisely because it is a
 * decision somebody is entitled to make -- but it leaves a flight nobody can
 * operate, so it raises an alert that outlives the dialog.
 */
export function evaluateReleaseAircraft(
  flight: FlightFacts,
  context: { now: Instant },
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("flight", flight.id, flight.flightNumber);

  if (!flight.aircraftId) {
    return new EvaluationBuilder()
      .add(
        blocking(
          "FLIGHT_NO_AIRCRAFT_ASSIGNED",
          `${flight.flightNumber} has no aircraft to release`,
          `Nothing is assigned to it.`,
          { subject },
        ),
      )
      .build();
  }

  if (hasDeparted(flight.status)) {
    builder.add(
      blocking(
        "FLIGHT_ALREADY_DEPARTED",
        `${flight.flightNumber} is airborne on this airframe`,
        `${flight.aircraftRegistration} is flying ${flight.flightNumber} now. Releasing it would make the fleet claim the aeroplane is somewhere it is not.`,
        { subject },
      ),
    );
    return builder.build();
  }

  const minutesOut = Math.round(
    minutesBetween(context.now, flight.estimatedDeparture ?? flight.scheduledDeparture),
  );

  builder.add(
    warning(
      "FLIGHT_NO_AIRCRAFT_ASSIGNED",
      `${flight.flightNumber} is left without an aircraft`,
      `${flight.aircraftRegistration} comes off ${flight.flightNumber}, which is due off in ${minutesOut} minutes. The sector cannot operate until another airframe is assigned.`,
      { subject },
    ),
  );

  builder.expect(
    consequence(
      "aircraft_released",
      `${flight.aircraftRegistration} is free from ${flight.flightNumber}`,
    ),
    consequence("alerts_raised", `${flight.flightNumber} raises an unassigned-aircraft alert`, {
      count: 1,
    }),
  );

  return builder.build();
}

// --- Deleting a flight -----------------------------------------------------

export interface DeleteFlightContext {
  now: Instant;
  /** Bookings still attached to this flight. Zero until Phase 6. */
  bookingCount: number;
  series: SeriesFacts | null;
}

/**
 * Removal, as distinct from cancellation.
 *
 * Cancelling is an operational act with consequences a passenger sees;
 * deleting is admitting the flight should never have been filed. So it is
 * permitted only where there is nothing to cancel: the sector has not
 * departed, and nobody has bought a seat on it.
 */
export function evaluateDeleteFlight(
  flight: FlightFacts,
  context: DeleteFlightContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("flight", flight.id, flight.flightNumber);

  if (hasDeparted(flight.status) || flight.status === "cancelled") {
    builder.add(
      blocking(
        "FLIGHT_ALREADY_DEPARTED",
        `${flight.flightNumber} is ${FLIGHT_STATUS_LABELS[flight.status].toLowerCase()}`,
        `A flight that has operated, or that was cancelled, is part of the record. Deleting it would remove the history rather than correct it.`,
        { subject },
      ),
    );
  }

  if (context.bookingCount > 0) {
    builder.add(
      blocking(
        "FLIGHT_HAS_BOOKINGS",
        `${context.bookingCount} booking${context.bookingCount === 1 ? "" : "s"} on this flight`,
        `Passengers are ticketed on ${flight.flightNumber}. Cancel it, which flags their bookings and tells them, rather than deleting the flight out from under them.`,
        { subject },
      ),
    );
  }

  if (context.series) {
    builder.add(
      warning(
        "FLIGHT_BELONGS_TO_SERIES",
        `${flight.flightNumber} is an occurrence of a pattern`,
        `${context.series.flightNumber} still operates ${context.series.validFrom} to ${context.series.validTo}. Deleting this date removes the flight, not the pattern -- regenerating the series will file it again. Change the operating days if the intention is to stop flying it.`,
        {
          subject,
          related: [resourceRef("schedule", context.series.id, context.series.flightNumber)],
        },
      ),
    );
  }

  builder.expect(
    consequence("flight_deleted", `${flight.flightNumber} on ${flight.serviceDate} is removed`),
  );

  if (flight.aircraftId) {
    builder.expect(
      consequence(
        "aircraft_released",
        `${flight.aircraftRegistration} is free for the sector's window`,
      ),
    );
  }

  return builder.build();
}

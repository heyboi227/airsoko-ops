import type { AircraftServiceability, Id, Instant } from "@airsoko/contracts";
import { SERVICEABILITY_LABELS, UNSERVICEABLE } from "@airsoko/contracts";
import { EvaluationBuilder, blocking, consequence, resourceRef, warning } from "../intent.ts";
import type { Evaluation } from "../intent.ts";
import { distanceNm } from "../geo.ts";
import { grouped } from "../format.ts";
import { epochMs, gapMinutes, intervalsOverlap, minutesBetween } from "../time.ts";
import { maintenanceStanding, type MaintenanceLimits } from "../fleet.ts";
import type { OperationalPolicy } from "../policy.ts";

/**
 * Whether a given airframe may fly a given sector.
 *
 * Phase 2's gate is that an unavailable aircraft is never *silently*
 * assignable, so the rule lands here now, tested, ahead of the Phase 3 screens
 * that will call it. Everything is pure: the caller gathers the facts, this
 * decides, and nothing is written.
 *
 * The order below is the order a controller would think in -- can it fly at
 * all, is it already busy, can it physically get there, will it hold the
 * passengers.
 */

export interface CandidateAircraft {
  id: Id;
  registration: string;
  serviceability: AircraftServiceability;
  typeCode: string;
  rangeNm: number;
  minimumTurnaroundMinutes: number;
  /** Total installed seats, summed from the cabins. Never a stored figure. */
  seatCapacity: number;
  seatsByCabin: Readonly<Record<string, number>>;
  totalHours: number;
  totalCycles: number;
  maintenance: MaintenanceLimits;
}

export interface SectorToFly {
  flightId: Id;
  flightNumber: string;
  originIata: string;
  destinationIata: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  scheduledDeparture: Instant;
  scheduledArrival: Instant;
  /** Seats already sold, by cabin. Empty until bookings exist in Phase 6. */
  soldByCabin: Readonly<Record<string, number>>;
  /**
   * The type the recurring schedule plans this sector on, when it came from
   * one. Absent for an ad-hoc flight, which is planned on nothing.
   */
  plannedTypeCode?: string;
}

/** Another sector the same airframe is already committed to. */
export interface ExistingCommitment {
  flightId: Id;
  flightNumber: string;
  originIata: string;
  destinationIata: string;
  departure: Instant;
  arrival: Instant;
}

export interface MaintenanceWindow {
  id: Id;
  checkType: string;
  start: Instant;
  end: Instant;
}

export interface AssignAircraftContext {
  now: Instant;
  policy: OperationalPolicy;
  /** Sectors this airframe already flies, excluding the one being assigned. */
  commitments: readonly ExistingCommitment[];
  /** Planned hangar time for this airframe. */
  maintenanceWindows: readonly MaintenanceWindow[];
}

export function evaluateAircraftAssignment(
  aircraft: CandidateAircraft,
  sector: SectorToFly,
  context: AssignAircraftContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("aircraft", aircraft.id, aircraft.registration);
  const { policy } = context;

  // --- Can it fly at all? --------------------------------------------------
  if (UNSERVICEABLE.includes(aircraft.serviceability as (typeof UNSERVICEABLE)[number])) {
    builder.add(
      blocking(
        "AIRCRAFT_UNAVAILABLE",
        `${aircraft.registration} is ${SERVICEABILITY_LABELS[aircraft.serviceability].toLowerCase()}`,
        `${aircraft.registration} is marked ${SERVICEABILITY_LABELS[aircraft.serviceability].toLowerCase()} and cannot be assigned to ${sector.flightNumber}. Return it to service first, or choose another airframe.`,
        { subject },
      ),
    );
  }

  // --- Is it already busy? -------------------------------------------------
  const sectorWindow = { start: sector.scheduledDeparture, end: sector.scheduledArrival };

  const overlapping: ExistingCommitment[] = [];
  const clear: ExistingCommitment[] = [];

  for (const commitment of context.commitments) {
    if (
      intervalsOverlap(sectorWindow, { start: commitment.departure, end: commitment.arrival })
    ) {
      overlapping.push(commitment);
    } else {
      clear.push(commitment);
    }
  }

  for (const commitment of overlapping) {
    builder.add(
      blocking(
        "AIRCRAFT_OVERLAPPING_ASSIGNMENT",
        `Already flying ${commitment.flightNumber}`,
        `${aircraft.registration} is committed to ${commitment.flightNumber} (${commitment.originIata}-${commitment.destinationIata}) between ${commitment.departure.slice(11, 16)}Z and ${commitment.arrival.slice(11, 16)}Z, which overlaps ${sector.flightNumber}.`,
        {
          subject,
          related: [resourceRef("flight", commitment.flightId, commitment.flightNumber)],
        },
      ),
    );
  }

  // Touching intervals are not an overlap -- they are a turnaround question,
  // which is a different finding with a different fix.
  //
  // Only the two *adjacent* sectors can answer it. An earlier version compared
  // the new sector against every commitment in the window, which meant a tail
  // flying a normal day raised "cannot be in two places" against each of its
  // own sectors eighteen hours away -- and no aircraft in a rotation could ever
  // be assigned to anything. Where the aeroplane is when this sector starts is
  // decided by the last flight before it, and where it needs to be afterwards
  // by the first flight after it; everything else is downstream of those two.
  const before = clear
    .filter((commitment) => epochOrder(commitment.arrival, sector.scheduledDeparture))
    .sort((a, b) => epochMs(a.arrival) - epochMs(b.arrival))
    .at(-1);

  const after = clear
    .filter((commitment) => !epochOrder(commitment.arrival, sector.scheduledDeparture))
    .sort((a, b) => epochMs(a.departure) - epochMs(b.departure))
    .at(0);

  for (const [commitment, isBefore] of [
    [before, true],
    [after, false],
  ] as const) {
    if (!commitment) continue;

    const commitmentWindow = { start: commitment.departure, end: commitment.arrival };
    const gap = isBefore
      ? gapMinutes(commitmentWindow, sectorWindow)
      : gapMinutes(sectorWindow, commitmentWindow);

    const arrivesAt = isBefore ? commitment.destinationIata : sector.destinationIata;
    const departsFrom = isBefore ? sector.originIata : commitment.originIata;

    if (arrivesAt !== departsFrom) {
      builder.add(
        blocking(
          "AIRCRAFT_IMPOSSIBLE_REPOSITIONING",
          `Cannot be in two places`,
          `${aircraft.registration} is at ${arrivesAt} after ${isBefore ? commitment.flightNumber : sector.flightNumber}, but ${isBefore ? sector.flightNumber : commitment.flightNumber} departs from ${departsFrom} ${Math.round(gap)} minutes later. Add a positioning sector or choose another airframe.`,
          {
            subject,
            related: [resourceRef("flight", commitment.flightId, commitment.flightNumber)],
          },
        ),
      );
      continue;
    }

    const minimum = aircraft.minimumTurnaroundMinutes;
    if (gap < minimum) {
      builder.add(
        blocking(
          "AIRCRAFT_INSUFFICIENT_TURNAROUND",
          `Only ${Math.round(gap)} minutes on the ground`,
          `A ${aircraft.typeCode} needs ${minimum} minutes between sectors at ${arrivesAt}. This leaves ${Math.round(gap)}.`,
          {
            subject,
            related: [resourceRef("flight", commitment.flightId, commitment.flightNumber)],
          },
        ),
      );
    } else if (gap < minimum + policy.turnaround.warnWithinMinutes) {
      builder.add(
        warning(
          "AIRCRAFT_INSUFFICIENT_TURNAROUND",
          `Tight turnaround at ${arrivesAt}`,
          `${Math.round(gap)} minutes on the ground against a ${minimum}-minute minimum. Any inbound delay will push ${sector.flightNumber}.`,
          {
            subject,
            related: [resourceRef("flight", commitment.flightId, commitment.flightNumber)],
          },
        ),
      );
    }
  }

  // --- Is it in the hangar when this flies? --------------------------------
  for (const window of context.maintenanceWindows) {
    if (intervalsOverlap(sectorWindow, { start: window.start, end: window.end })) {
      builder.add(
        blocking(
          "MAINTENANCE_LIMIT_EXCEEDED",
          `In maintenance during this sector`,
          `${aircraft.registration} has a ${window.checkType.replace(/_/g, " ")} scheduled from ${window.start.slice(0, 16).replace("T", " ")}Z to ${window.end.slice(0, 16).replace("T", " ")}Z, which covers ${sector.flightNumber}.`,
          { subject },
        ),
      );
    }
  }

  // --- Will the airframe reach the destination? ----------------------------
  const distance = distanceNm(sector.origin, sector.destination);
  const usableRange = aircraft.rangeNm * policy.range.usableFraction;

  if (distance > usableRange) {
    builder.add(
      blocking(
        "AIRCRAFT_RANGE_INSUFFICIENT",
        `${sector.originIata}-${sector.destinationIata} is beyond this type's range`,
        `${grouped(distance)} nm against ${grouped(usableRange)} nm usable for a ${aircraft.typeCode} (${Math.round(policy.range.usableFraction * 100)}% of a published ${grouped(aircraft.rangeNm)} nm).`,
        { subject },
      ),
    );
  } else if (
    distance >
    aircraft.rangeNm * policy.range.warnWithinFraction * policy.range.usableFraction
  ) {
    builder.add(
      warning(
        "AIRCRAFT_RANGE_INSUFFICIENT",
        `Close to the range limit`,
        `${grouped(distance)} nm leaves little margin against ${grouped(usableRange)} nm usable. Headwinds or a diversion would make this marginal.`,
        { subject },
      ),
    );
  }

  // --- Will it hold the passengers already sold? ---------------------------
  const totalSold = Object.values(sector.soldByCabin).reduce((sum, seats) => sum + seats, 0);

  if (totalSold > aircraft.seatCapacity) {
    builder.add(
      blocking(
        "AIRCRAFT_CAPACITY_BELOW_SOLD",
        `${totalSold - aircraft.seatCapacity} passengers more than seats`,
        `${sector.flightNumber} has ${totalSold} seats sold; ${aircraft.registration} has ${aircraft.seatCapacity}. Offloading passengers is not something this system will do implicitly.`,
        { subject },
      ),
    );
  }

  for (const [cabin, sold] of Object.entries(sector.soldByCabin)) {
    const available = aircraft.seatsByCabin[cabin] ?? 0;
    if (sold > available) {
      builder.add(
        blocking(
          "AIRCRAFT_CABIN_CAPACITY_BELOW_SOLD",
          `${cabin.replace(/_/g, " ")}: ${sold} sold, ${available} seats`,
          `${aircraft.registration} has ${available} ${cabin.replace(/_/g, " ")} seats against ${sold} sold on ${sector.flightNumber}. Those passengers need re-accommodating before this change can stand.`,
          { subject },
        ),
      );
    }
  }

  // --- Is it the type the schedule was planned on? -------------------------
  // A warning, never a block. Substituting an A319 for an A320 is an ordinary
  // day's work; it is worth saying because capacity, crew complement and the
  // published cabin all move with it.
  if (sector.plannedTypeCode && sector.plannedTypeCode !== aircraft.typeCode) {
    builder.add(
      warning(
        "AIRCRAFT_TYPE_MISMATCH_WITH_SCHEDULE",
        `${sector.flightNumber} is planned on a ${sector.plannedTypeCode}`,
        `${aircraft.registration} is a ${aircraft.typeCode}. The sector still operates, but its capacity becomes ${aircraft.seatCapacity} seats and the crew complement is worked out against the substitute rather than the plan.`,
        { subject },
      ),
    );
  }

  // --- Is a check about to come due? ---------------------------------------
  const standing = maintenanceStanding(aircraft.maintenance, context.now, policy);
  if (standing.urgency === "exceeded") {
    builder.add(
      blocking(
        "MAINTENANCE_LIMIT_EXCEEDED",
        `Maintenance limit passed`,
        `${aircraft.registration}: ${standing.summary}`,
        { subject },
      ),
    );
  } else if (standing.urgency === "approaching") {
    builder.add(
      warning(
        "MAINTENANCE_LIMIT_APPROACHING",
        `Maintenance due soon`,
        `${aircraft.registration}: ${standing.summary} Flying this sector brings it closer.`,
        { subject },
      ),
    );
  }

  builder.expect(
    consequence(
      "aircraft_assigned",
      `${aircraft.registration} operates ${sector.flightNumber} (${sector.originIata}-${sector.destinationIata})`,
    ),
    consequence(
      "capacity_changed",
      `Capacity becomes ${aircraft.seatCapacity} seats: ${describeCabins(aircraft.seatsByCabin)}`,
    ),
  );

  return builder.build();
}

/**
 * The other half of an out-and-back, as the assignment reads it.
 *
 * `context.commitments` is the caller's to assemble, and it must already carry
 * the outbound sector: the whole point of pairing the legs is that the rule
 * sees the turnaround between them, and the outbound is not yet a commitment
 * of this airframe in any table when the question is asked.
 */
export interface ReturnLegToFly {
  sector: SectorToFly;
  context: AssignAircraftContext;
  /** The airframe standing on the return leg now, when it is not this one. */
  displacing: { id: Id; registration: string } | null;
}

/**
 * One airframe, both legs of the turn.
 *
 * An out-and-back is two sectors and one aeroplane. Re-equipping only the
 * outbound is how a rotation ends up split between two tails -- the aeroplane
 * flies out and something else has to bring the service home -- so assigning
 * the outbound offers the return leg alongside, the way filing a route files
 * its pair (decision 33).
 *
 * The second sector is judged on its own terms rather than assumed to inherit
 * the first's verdict: the return leg has its own timing, its own turnaround
 * either side, and its own hangar time to miss. A finding the two sectors word
 * identically -- a check coming due, which is a fact about the aeroplane -- is
 * said once. A finding that names its sector is said about each, because those
 * are two statements about two flights, and an operator reading "refused on the
 * outbound" should not have to assume the return leg was refused too.
 *
 * With no return leg, or with the operator declining it, this is the single
 * sector's evaluation and nothing more.
 */
export function evaluateRotationAssignment(
  aircraft: CandidateAircraft,
  outbound: { sector: SectorToFly; context: AssignAircraftContext },
  returnLeg: ReturnLegToFly | null,
): Evaluation {
  const first = evaluateAircraftAssignment(aircraft, outbound.sector, outbound.context);
  if (!returnLeg) return first;

  const second = evaluateAircraftAssignment(aircraft, returnLeg.sector, returnLeg.context);
  const builder = new EvaluationBuilder().merge(first);

  const said = new Set(first.findings.map(findingPrint));
  builder.add(...second.findings.filter((finding) => !said.has(findingPrint(finding))));

  const expected = new Set(first.consequences.map((item) => `${item.kind}|${item.summary}`));
  builder.expect(
    ...second.consequences.filter((item) => !expected.has(`${item.kind}|${item.summary}`)),
  );

  // Taking the return leg off another tail is a second aeroplane's day
  // changing, which is exactly the kind of thing an operator acknowledges
  // rather than discovers afterwards.
  if (returnLeg.displacing) {
    const leg = returnLeg.sector;
    builder
      .add(
        warning(
          "AIRCRAFT_RETURN_LEG_DISPLACED",
          `${returnLeg.displacing.registration} comes off ${leg.flightNumber}`,
          `${leg.flightNumber} (${leg.originIata}-${leg.destinationIata}) is flown by ${returnLeg.displacing.registration}. Carrying ${aircraft.registration} onto the return leg takes it off, and that sector has no airframe until one is assigned.`,
          {
            subject: resourceRef("flight", leg.flightId, leg.flightNumber),
            related: [
              resourceRef(
                "aircraft",
                returnLeg.displacing.id,
                returnLeg.displacing.registration,
              ),
            ],
          },
        ),
      )
      .expect(
        consequence(
          "aircraft_released",
          `${returnLeg.displacing.registration} needs another sector or none: it no longer flies ${leg.flightNumber}`,
          {
            related: [
              resourceRef(
                "aircraft",
                returnLeg.displacing.id,
                returnLeg.displacing.registration,
              ),
            ],
          },
        ),
      );
  }

  return builder.build();
}

/** Two findings are the same finding when they say the same thing. */
function findingPrint(finding: {
  code: string;
  severity: string;
  title: string;
  detail: string;
}) {
  return `${finding.code}|${finding.severity}|${finding.title}|${finding.detail}`;
}

function describeCabins(seatsByCabin: Readonly<Record<string, number>>): string {
  return Object.entries(seatsByCabin)
    .map(([cabin, seats]) => `${seats} ${cabin.replace(/_/g, " ")}`)
    .join(", ");
}

/** True when `first` is at or before `second`. */
function epochOrder(first: Instant, second: Instant): boolean {
  return minutesBetween(first, second) >= 0;
}

/**
 * Withdrawing an airframe from service.
 *
 * Separate from assignment because the question is the mirror image: not "may
 * this aircraft fly that sector" but "what breaks if it flies nothing".
 */
export function evaluateWithdrawAircraft(
  aircraft: Pick<CandidateAircraft, "id" | "registration">,
  serviceability: AircraftServiceability,
  upcoming: readonly ExistingCommitment[],
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("aircraft", aircraft.id, aircraft.registration);

  if (upcoming.length > 0) {
    builder.add(
      warning(
        "AIRCRAFT_UNAVAILABLE",
        `${upcoming.length} scheduled sector${upcoming.length === 1 ? "" : "s"} lose their aircraft`,
        `${aircraft.registration} is assigned to ${upcoming
          .slice(0, 3)
          .map((flight) => flight.flightNumber)
          .join(
            ", ",
          )}${upcoming.length > 3 ? ` and ${upcoming.length - 3} more` : ""}. Marking it ${SERVICEABILITY_LABELS[serviceability].toLowerCase()} leaves those flights without an airframe until one is re-assigned.`,
        {
          subject,
          related: upcoming
            .slice(0, 10)
            .map((flight) => resourceRef("flight", flight.flightId, flight.flightNumber)),
        },
      ),
    );

    builder.expect(
      consequence(
        "aircraft_released",
        `${upcoming.length} sectors need a replacement airframe`,
        {
          count: upcoming.length,
        },
      ),
      consequence("alerts_raised", "Each affected flight raises an unassigned-aircraft alert", {
        count: upcoming.length,
      }),
    );
  }

  builder.expect(
    consequence(
      "map_visibility_changed",
      `${aircraft.registration} stops appearing as available in assignment pickers`,
    ),
  );

  return builder.build();
}

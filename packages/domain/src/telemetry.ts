import type {
  Coordinates,
  FlightPhase,
  FlightStatus,
  Instant,
  TelemetryFix,
} from "@airsoko/contracts";
import { distanceNm, initialBearing, interpolateGreatCircle } from "./geo.ts";
import {
  effectiveArrival,
  effectiveDeparture,
  PHASE_FOR_STATUS,
  type FlightTimes,
} from "./flights.ts";
import { epochMs, MINUTE_MS } from "./time.ts";

export interface SimulationFlight extends FlightTimes {
  status: FlightStatus;
  origin: Coordinates;
  destination: Coordinates;
  aircraft: { id: string } | null;
}

export function unavailableTelemetry(
  now: Instant,
  reason: string,
  quality: "stale" | "unavailable" = "unavailable",
): TelemetryFix {
  return {
    observedAt: now,
    quality,
    reason,
    position: null,
    heading: null,
    altitudeFt: null,
    groundSpeedKts: null,
    phase: null,
    routeProgress: null,
    remainingDistanceNm: null,
    remainingMinutes: null,
  };
}

/**
 * Read-only schedule simulation. Controllers own status. An overdue airborne
 * record does not become an invented arrival, nor a diversion a straight line
 * to the old destination. Contradictory facts have no position to plot.
 * Normal sectors use the timeline's 12-minute taxi out and 8-minute taxi in;
 * exceptionally short blocks scale those intervals to leave time airborne.
 */
export function simulateTelemetry(
  flight: SimulationFlight,
  now: Instant,
  ceilingFt = 35_000,
): TelemetryFix {
  if (flight.status === "cancelled")
    return unavailableTelemetry(now, "Cancelled flight; tracking ended.");
  if (!flight.aircraft) return unavailableTelemetry(now, "No aircraft assigned.");
  if (flight.status === "diverted")
    return unavailableTelemetry(
      now,
      "Diversion requires a confirmed destination or an external position.",
    );
  const at = epochMs(now);
  const off = epochMs(effectiveDeparture(flight));
  const on = epochMs(effectiveArrival(flight));
  if (on <= off) return unavailableTelemetry(now, "Arrival must follow departure.");
  const duration = on - off;
  const takeoff = off + Math.min(12 * MINUTE_MS, duration * 0.15);
  const landing = on - Math.min(8 * MINUTE_MS, duration * 0.1);
  const departed = flight.status === "taxi_out" || flight.status === "airborne";
  if (departed && (at < off || at >= on)) {
    return unavailableTelemetry(
      now,
      "Recorded status and effective flight times disagree; update the flight record.",
      "stale",
    );
  }

  let phase: FlightPhase = PHASE_FOR_STATUS[flight.status];
  let progress = 0;
  let altitude = 0;
  let speed = 0;
  if (flight.status === "arrived" || flight.status === "taxi_in") {
    progress = 1;
  } else if (departed) {
    progress = Math.max(0, Math.min(1, (at - takeoff) / (landing - takeoff)));
    if (at < takeoff) phase = "taxi_out";
    else if (at >= landing) phase = "taxi_in";
    else {
      phase =
        progress < 0.02
          ? "takeoff"
          : progress < 0.18
            ? "climb"
            : progress < 0.75
              ? "cruise"
              : progress < 0.93
                ? "descent"
                : progress < 0.985
                  ? "approach"
                  : "landing";
      const profile = Math.min(1, progress / 0.18, (1 - progress) / 0.25);
      altitude = Math.round(Math.min(35_000, Math.max(0, ceilingFt)) * profile);
      // Distance and time drive speed as well as position, so those values agree.
      speed = distanceNm(flight.origin, flight.destination) / ((landing - takeoff) / 3_600_000);
    }
  }
  const position =
    progress === 0
      ? flight.origin
      : progress === 1
        ? flight.destination
        : interpolateGreatCircle(flight.origin, flight.destination, progress);
  return {
    observedAt: now,
    quality: "current",
    reason: null,
    position,
    heading: initialBearing(progress < 1 ? position : flight.origin, flight.destination),
    altitudeFt: altitude,
    groundSpeedKts: Math.round(speed),
    phase,
    routeProgress: progress,
    remainingDistanceNm: distanceNm(position, flight.destination),
    remainingMinutes: flight.status === "arrived" ? 0 : Math.max(0, (on - at) / MINUTE_MS),
  };
}

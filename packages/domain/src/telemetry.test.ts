import { describe, expect, it } from "vitest";
import { telemetryFixSchema, type FlightStatus } from "@airsoko/contracts";
import { simulateTelemetry, type SimulationFlight } from "./telemetry.ts";
import { addMinutes } from "./time.ts";
import { distanceNm } from "./geo.ts";

const FLIGHT: SimulationFlight = {
  scheduledDeparture: "2026-09-06T10:00:00.000Z",
  scheduledArrival: "2026-09-06T12:00:00.000Z",
  estimatedDeparture: null,
  estimatedArrival: null,
  actualDeparture: null,
  actualArrival: null,
  origin: { latitude: 44.8184, longitude: 20.3091 },
  destination: { latitude: 51.4706, longitude: -0.4619 },
  status: "airborne",
  aircraft: { id: "tail" },
};

describe("schedule telemetry", () => {
  it("moves forward along the route with a speed consistent with the distance travelled", () => {
    const first = simulateTelemetry(FLIGHT, "2026-09-06T10:40:00.000Z");
    const second = simulateTelemetry(FLIGHT, "2026-09-06T10:41:00.000Z");
    expect(first.position).not.toEqual(second.position);
    expect(second.routeProgress).toBeGreaterThan(first.routeProgress!);
    expect(second.remainingDistanceNm).toBeLessThan(first.remainingDistanceNm!);
    expect(distanceNm(first.position!, second.position!) * 60).toBeCloseTo(
      second.groundSpeedKts!,
      0,
    );
    expect(telemetryFixSchema.safeParse(first).success).toBe(true);
    expect(simulateTelemetry(FLIGHT, "2026-09-06T10:40:00.000Z")).toEqual(first);
  });

  it("uses the actual departure before the estimate and schedule", () => {
    const delayed = {
      ...FLIGHT,
      estimatedDeparture: addMinutes(FLIGHT.scheduledDeparture, 10),
      actualDeparture: addMinutes(FLIGHT.scheduledDeparture, 20),
      estimatedArrival: addMinutes(FLIGHT.scheduledArrival, 20),
    };
    expect(simulateTelemetry(delayed, "2026-09-06T11:00:00.000Z").routeProgress).toBeCloseTo(
      simulateTelemetry(FLIGHT, "2026-09-06T10:40:00.000Z").routeProgress!,
      6,
    );
  });

  it.each([
    [5, "taxi_out"],
    [12.5, "takeoff"],
    [20, "climb"],
    [55, "cruise"],
    [95, "descent"],
    [107, "approach"],
    [111, "landing"],
    [115, "taxi_in"],
  ])(
    "moves through the physical phase at minute %s without writing status",
    (minute, phase) => {
      const before = JSON.stringify(FLIGHT);
      const fix = simulateTelemetry(
        FLIGHT,
        addMinutes(FLIGHT.scheduledDeparture, Number(minute)),
      );
      expect(fix.phase).toBe(phase);
      expect(JSON.stringify(FLIGHT)).toBe(before);
    },
  );

  it.each(["scheduled", "check_in_open", "boarding", "gate_closed"] as FlightStatus[])(
    "keeps %s on stand even after its planned departure",
    (status) => {
      const fix = simulateTelemetry({ ...FLIGHT, status }, "2026-09-06T10:50:00.000Z");
      expect(fix.position).toEqual(FLIGHT.origin);
      expect(fix.groundSpeedKts).toBe(0);
      expect(fix.routeProgress).toBe(0);
    },
  );

  it("does not invent a diversion, a cancelled track, or an unassigned aircraft", () => {
    for (const flight of [
      { ...FLIGHT, status: "diverted" as const },
      { ...FLIGHT, status: "cancelled" as const },
      { ...FLIGHT, aircraft: null },
    ]) {
      const fix = simulateTelemetry(flight, "2026-09-06T11:00:00.000Z");
      expect(fix.quality).toBe("unavailable");
      expect(fix.position).toBeNull();
      expect(fix.reason).toBeTruthy();
    }
  });

  it("marks an overdue or premature airborne record stale instead of reporting an arrival", () => {
    for (const now of [
      "2026-09-06T09:59:00.000Z",
      "2026-09-06T12:00:00.000Z",
      "2026-09-07T10:00:00.000Z",
    ]) {
      const fix = simulateTelemetry(FLIGHT, now);
      expect(fix.quality).toBe("stale");
      expect(fix.position).toBeNull();
    }
  });

  it("places an actual arrival at its endpoint at rest", () => {
    const fix = simulateTelemetry({ ...FLIGHT, status: "arrived" }, "2026-09-06T12:05:00.000Z");
    expect(fix.position!.latitude).toBeCloseTo(FLIGHT.destination.latitude, 8);
    expect(fix.phase).toBe("arrived");
    expect(fix.remainingMinutes).toBe(0);
    expect(fix.groundSpeedKts).toBe(0);
  });

  it("handles short sectors, coincident airports and the antimeridian without invalid figures", () => {
    const cases = [
      { ...FLIGHT, scheduledArrival: addMinutes(FLIGHT.scheduledDeparture, 5) },
      { ...FLIGHT, destination: FLIGHT.origin },
      {
        ...FLIGHT,
        origin: { latitude: 50, longitude: 179 },
        destination: { latitude: 51, longitude: -179 },
      },
    ];
    for (const flight of cases)
      for (const fraction of [0.01, 0.3, 0.6, 0.99]) {
        const now = new Date(
          Date.parse(flight.scheduledDeparture) +
            (Date.parse(flight.scheduledArrival) - Date.parse(flight.scheduledDeparture)) *
              fraction,
        ).toISOString();
        const fix = simulateTelemetry(flight, now, 25_000);
        expect(telemetryFixSchema.safeParse(fix).success).toBe(true);
        expect(fix.altitudeFt).toBeLessThanOrEqual(25_000);
      }
    const dateline = simulateTelemetry(cases[2]!, "2026-09-06T11:02:00.000Z");
    expect(Math.abs(dateline.position!.longitude)).toBeGreaterThan(179);
  });

  it("refuses a reversed interval", () => {
    expect(
      simulateTelemetry(
        { ...FLIGHT, scheduledArrival: FLIGHT.scheduledDeparture },
        FLIGHT.scheduledDeparture,
      ).quality,
    ).toBe("unavailable");
  });
});

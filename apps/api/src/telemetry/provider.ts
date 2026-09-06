import type { FlightSummary, Instant, LiveSnapshot, TelemetryFix } from "@airsoko/contracts";
import { simulateTelemetry, unavailableTelemetry } from "@airsoko/domain";

/** Replace the provider without teaching the browser how to simulate a flight.
 * A future external provider can batch observations by the shared flight id.
 */
export interface TelemetryProvider {
  description: LiveSnapshot["provider"];
  observe(
    flights: readonly { flight: FlightSummary; serviceCeilingFt: number }[],
    now: Instant,
  ): Promise<Map<string, TelemetryFix>>;
}

export function createTelemetryProvider(kind: "simulation" | "external"): TelemetryProvider {
  return {
    description:
      kind === "simulation"
        ? {
            id: "simulation",
            simulated: true,
            available: true,
            message:
              "Simulated positions from flight times. Operational status remains controller-managed.",
          }
        : {
            id: "external",
            simulated: false,
            available: false,
            message: "External telemetry is not configured. Flight records remain available.",
          },
    async observe(flights, now) {
      return new Map(
        flights.map(({ flight, serviceCeilingFt }) => [
          flight.id,
          kind === "simulation"
            ? simulateTelemetry(flight, now, serviceCeilingFt)
            : unavailableTelemetry(now, "External telemetry is not configured."),
        ]),
      );
    },
  };
}

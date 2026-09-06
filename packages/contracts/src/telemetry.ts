import { z } from "zod";
import { flightSummarySchema } from "./flight.ts";
import { flightPhaseSchema } from "./enums.ts";
import { coordinatesSchema, headingSchema, instantSchema } from "./primitives.ts";

/** A position is an observation, never a second flight record. */
export const telemetryFixSchema = z.object({
  observedAt: instantSchema,
  quality: z.enum(["current", "stale", "unavailable"]),
  reason: z.string().nullable(),
  position: coordinatesSchema.nullable(),
  heading: headingSchema.nullable(),
  altitudeFt: z.number().nonnegative().nullable(),
  groundSpeedKts: z.number().nonnegative().nullable(),
  phase: flightPhaseSchema.nullable(),
  /** Geographic progress; flight.progress remains the shared block-time progress. */
  routeProgress: z.number().min(0).max(1).nullable(),
  remainingDistanceNm: z.number().nonnegative().nullable(),
  remainingMinutes: z.number().nonnegative().nullable(),
});
export type TelemetryFix = z.infer<typeof telemetryFixSchema>;

export const liveFlightSchema = z.object({
  flight: flightSummarySchema,
  domestic: z.boolean(),
  telemetry: telemetryFixSchema,
});
export type LiveFlight = z.infer<typeof liveFlightSchema>;

export const liveSnapshotSchema = z.object({
  generatedAt: instantSchema,
  window: z.object({ from: instantSchema, to: instantSchema }),
  provider: z.object({
    id: z.string(),
    simulated: z.boolean(),
    available: z.boolean(),
    message: z.string(),
  }),
  refreshAfterMs: z.number().int().positive(),
  staleAfterMs: z.number().int().positive(),
  items: z.array(liveFlightSchema),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;

/** The window selects records; it does not move the simulation clock. */
export const liveQuerySchema = z
  .object({
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  })
  .refine((value) => Boolean(value.from) === Boolean(value.to), {
    message: "Supply both ends of the time window.",
  })
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      (Date.parse(value.to) > Date.parse(value.from) &&
        Date.parse(value.to) - Date.parse(value.from) <= 48 * 60 * 60 * 1000),
    { message: "The time window must be positive and no longer than 48 hours." },
  );

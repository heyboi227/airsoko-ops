import { z } from "zod";
import { routeStatusSchema } from "./enums.ts";
import { booleanFlagSchema, iataAirportCodeSchema, idSchema } from "./primitives.ts";
import { mutationPreviewSchema } from "./rules.ts";

/**
 * Routes: the reusable airport pairs a schedule is filed on.
 *
 * A route is commercial intent -- "we serve Belgrade to Vienna, in an hour and
 * five" -- and a flight instance is one dated operation of it. Two things
 * about the shape follow from that and are worth stating here rather than
 * discovering later:
 *
 * 1. A route is **directional**. BEG-VIE and VIE-BEG are two rows, because
 *    the block time, the planned equipment and the season are properties of a
 *    leg rather than of a city pair. The unique index is on the ordered pair.
 *
 * 2. The distance is **not** an input. It is the great-circle distance between
 *    two fixed points, so the server derives it from the endpoints' own
 *    coordinates -- decision 13, the same reason airport facts are sourced
 *    rather than authored. Block time *is* an input: how long the airline
 *    allows for the sector is its own decision, not a fact about geometry.
 */

export const routeSchema = z.object({
  id: idSchema,

  originId: idSchema,
  originIata: iataAirportCodeSchema,
  originName: z.string(),
  originCity: z.string(),
  originTimeZone: z.string(),

  destinationId: idSchema,
  destinationIata: iataAirportCodeSchema,
  destinationName: z.string(),
  destinationCity: z.string(),
  destinationTimeZone: z.string(),

  /** Great-circle nautical miles, derived from the two endpoints. */
  distanceNm: z.number().int(),
  /** Planned block time in minutes, gate to gate. */
  blockMinutes: z.number().int(),
  status: routeStatusSchema,

  /** The type the route is planned on, where one is set. */
  typicalAircraftTypeId: idSchema.nullable(),
  typicalTypeCode: z.string().nullable(),

  /** Active recurring schedules flying this pair. Sorts the picker. */
  scheduleCount: z.number().int(),
});
export type Route = z.infer<typeof routeSchema>;

/**
 * Filing a pair the airline does not serve yet.
 *
 * The endpoints arrive as ids rather than codes: the operator picks two
 * stations that are already on file, and a route to somewhere that is not a
 * station is a station to add first.
 */
export const createRouteSchema = z.object({
  originAirportId: idSchema,
  destinationAirportId: idSchema,
  /**
   * Gate to gate, in minutes. Bounded only where a figure stops being a block
   * time at all; whether it is a *plausible* one for the distance is the
   * kernel's judgement, and it says so with a rule the operator can read.
   */
  blockMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  status: routeStatusSchema.default("active"),
  typicalAircraftTypeId: idSchema.nullish(),
  /**
   * File the return leg in the same act.
   *
   * A route is directional and a service is not: an airline that starts
   * flying BEG-TGD starts flying TGD-BEG the same week, and the seed's own
   * network builder makes both. On by default for that reason, and ignored
   * when the return pair is already on file.
   */
  includeReturn: z.boolean().default(true),
});
export type CreateRoute = z.input<typeof createRouteSchema>;

export const routeQuerySchema = z.object({
  /** Matches either code, either city, or the pair written as "BEG-VIE". */
  search: z.string().trim().max(80).optional(),
  originIata: iataAirportCodeSchema.optional(),
  destinationIata: iataAirportCodeSchema.optional(),
  status: routeStatusSchema.optional(),
  /** Only pairs a recurring schedule already flies. */
  scheduledOnly: booleanFlagSchema.optional(),
});
export type RouteQuery = z.infer<typeof routeQuerySchema>;

/** What `POST /api/routes` answers with once the pair is on file. */
export const createRouteResultSchema = z.object({
  route: routeSchema,
  /** The return leg, when this act filed one too, and null when it did not. */
  returnRoute: routeSchema.nullable(),
  preview: mutationPreviewSchema,
});
export type CreateRouteResult = z.infer<typeof createRouteResultSchema>;

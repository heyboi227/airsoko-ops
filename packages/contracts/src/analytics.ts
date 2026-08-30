import { z } from "zod";
import { instantSchema, localDateSchema } from "./primitives.ts";

/**
 * The operational overview behind the dashboard.
 *
 * One deliberate choice runs through this shape: a section the system cannot
 * yet answer is `null`, never zero. "0 passengers checked in" and "we do not
 * track passengers yet" are different claims, and a dashboard that renders the
 * second as the first is lying to a controller. The client reads null and shows
 * what is missing and which phase supplies it.
 */

export const flightSummarySchema = z.object({
  total: z.number().int(),
  scheduled: z.number().int(),
  checkInOpen: z.number().int(),
  boarding: z.number().int(),
  gateClosed: z.number().int(),
  taxiOut: z.number().int(),
  airborne: z.number().int(),
  taxiIn: z.number().int(),
  arrived: z.number().int(),
  diverted: z.number().int(),
  cancelled: z.number().int(),

  /** Estimated departure later than scheduled by more than the policy threshold. */
  delayed: z.number().int(),
  /** Mean delay across delayed flights only -- averaging in the on-time ones hides it. */
  averageDelayMinutes: z.number(),
  /** Share of non-cancelled flights not delayed, 0 to 1. */
  onTimePerformance: z.number().min(0).max(1),
  /** Flights with no airframe allocated. Each one needs a controller. */
  withoutAircraft: z.number().int(),
});
export type FlightSummary = z.infer<typeof flightSummarySchema>;

export const fleetSummarySchema = z.object({
  total: z.number().int(),
  /** Airframes the airline considers available. Stored state. */
  inService: z.number().int(),
  /** Derived from the flights, never stored -- see docs/DECISIONS.md. */
  airborne: z.number().int(),
  onGround: z.number().int(),
  turnaround: z.number().int(),
  maintenance: z.number().int(),
  stored: z.number().int(),
  outOfService: z.number().int(),
  /** Airframes with a check approaching or already overdue. */
  maintenanceDue: z.number().int(),
  /** Sectors flown today across the fleet. */
  sectorsToday: z.number().int(),
  /** Sectors per available airframe -- the usual short-haul utilisation figure. */
  sectorsPerAvailableAircraft: z.number(),
});
export type FleetSummary = z.infer<typeof fleetSummarySchema>;

/** Movements by hour, in the hub's local time. */
export const movementSchema = z.object({
  hour: z.number().int().min(0).max(23),
  departures: z.number().int(),
  arrivals: z.number().int(),
});
export type Movement = z.infer<typeof movementSchema>;

export const routePerformanceSchema = z.object({
  origin: z.string(),
  destination: z.string(),
  flights: z.number().int(),
  distanceNm: z.number().int(),
  delayed: z.number().int(),
});
export type RoutePerformance = z.infer<typeof routePerformanceSchema>;

/**
 * A section that does not exist yet, and the phase that builds it. Rendered as
 * an explanation rather than an empty chart.
 */
export const pendingSectionSchema = z.object({
  available: z.literal(false),
  arrivesInPhase: z.number().int(),
  summary: z.string(),
});
export type PendingSection = z.infer<typeof pendingSectionSchema>;

export const dashboardSchema = z.object({
  /** The operating day this describes, in the hub's local calendar. */
  date: localDateSchema,
  generatedAt: instantSchema,
  hubIataCode: z.string(),
  hubTimeZone: z.string(),

  flights: flightSummarySchema,
  fleet: fleetSummarySchema,
  movements: z.array(movementSchema),
  routes: z.array(routePerformanceSchema),

  /** Null once Phase 6 lands bookings. */
  passengers: pendingSectionSchema,
  /** Null once Phase 5 lands crew. */
  crew: pendingSectionSchema,
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const dashboardQuerySchema = z.object({
  /** Defaults to the hub's today. */
  date: localDateSchema.optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

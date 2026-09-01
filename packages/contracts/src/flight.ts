import { z } from "zod";
import {
  amenityScopeSchema,
  cabinClassSchema,
  delayReasonSchema,
  flightPhaseSchema,
  flightStatusSchema,
  flightTypeSchema,
} from "./enums.ts";
import {
  booleanFlagSchema,
  flightNumberSchema,
  iataAirportCodeSchema,
  idSchema,
  ianaTimeZoneSchema,
  instantSchema,
  latitudeSchema,
  localDateSchema,
  localTimeSchema,
  longitudeSchema,
} from "./primitives.ts";

/**
 * Flight instances: the dated operations, as both ends agree to describe them.
 *
 * Unlike the fleet -- whose response shape is declared at its route because one
 * caller reads it -- a flight is read by the list, the calendar, the control
 * page, the fleet's rotation panel and, in Phase 4, the map. Five consumers is
 * past the point where a shape should be written down once.
 *
 * Three things here are computed at the edge and never stored, and each has a
 * decision behind it:
 *
 *  - **Local times.** An instant is absolute; "07:45" belongs to an airport's
 *    IANA zone. Both are sent, because a controller reads the local clock and
 *    every calculation uses the instant.
 *  - **Delay.** Not a status. It is the estimated time minus the scheduled
 *    time, compared against `policy.delay.thresholdMinutes`, so a flight can be
 *    boarding *and* late -- see decision 4.
 *  - **Progress.** Where the flight is through its block, so the list and the
 *    map agree without either of them owning the arithmetic.
 */

// --- Edit scope ------------------------------------------------------------

/**
 * How far an edit to a generated occurrence reaches.
 *
 * Scenario C in one type. The default is deliberately the narrowest: a
 * scheduler editing the flight in front of them means that flight, and a
 * broader reach has to be asked for rather than inherited.
 */
export const EDIT_SCOPES = ["occurrence", "this_and_future", "series"] as const;
export const editScopeSchema = z.enum(EDIT_SCOPES);
export type EditScope = z.infer<typeof editScopeSchema>;

export const EDIT_SCOPE_LABELS: Readonly<Record<EditScope, string>> = {
  occurrence: "This occurrence only",
  this_and_future: "This and future occurrences",
  series: "The entire series",
};

/**
 * Fields an occurrence can be changed on independently of its pattern.
 *
 * Recorded on the flight when it is edited at occurrence scope, so a later
 * series edit knows what it must not overwrite. A time exception and a gate
 * exception are different exceptions: a series retiming should still reach an
 * occurrence whose gate was moved by hand.
 */
export const OVERRIDABLE_FIELDS = [
  "scheduledDeparture",
  "scheduledArrival",
  "aircraftId",
  "departureGate",
  "departureTerminal",
  "arrivalGate",
  "flightType",
  "notes",
] as const;
export const overridableFieldSchema = z.enum(OVERRIDABLE_FIELDS);
export type OverridableField = z.infer<typeof overridableFieldSchema>;

// --- Read shapes -----------------------------------------------------------

/** An airport as a flight carries it: enough to render and to position. */
export const flightEndpointSchema = z.object({
  id: idSchema,
  iataCode: iataAirportCodeSchema,
  name: z.string(),
  city: z.string(),
  timeZone: ianaTimeZoneSchema,
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  terminal: z.string().nullable(),
  gate: z.string().nullable(),
  /** Airport-local wall clock for the operative time, e.g. "07:45". */
  localTime: localTimeSchema,
  /** The airport's own calendar date for that time. */
  localDate: localDateSchema,
  /** Minutes east of UTC at that instant, so the UI can print the offset. */
  offsetMinutes: z.number().int(),
});
export type FlightEndpoint = z.infer<typeof flightEndpointSchema>;

/** The airframe on the flight. Null is a real operational state, not missing data. */
export const flightAircraftSchema = z.object({
  id: idSchema,
  registration: z.string(),
  name: z.string().nullable(),
  typeId: idSchema,
  icaoTypeCode: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  bodyType: z.string(),
  rangeNm: z.number().int(),
  /** Summed from the cabins, here as everywhere else. */
  seatCapacity: z.number().int(),
  seatsByCabin: z.record(z.string(), z.number().int()),
});
export type FlightAircraft = z.infer<typeof flightAircraftSchema>;

export const flightSummarySchema = z.object({
  id: idSchema,
  /** Null for an ad-hoc flight no pattern produced. */
  scheduleId: idSchema.nullable(),
  flightNumber: flightNumberSchema,
  callsign: z.string(),
  flightType: flightTypeSchema,
  serviceDate: localDateSchema,

  /** The reusable airport pair this dated operation belongs to. */
  routeId: idSchema,
  origin: flightEndpointSchema,
  destination: flightEndpointSchema,

  scheduledDeparture: instantSchema,
  estimatedDeparture: instantSchema.nullable(),
  actualDeparture: instantSchema.nullable(),
  scheduledArrival: instantSchema,
  estimatedArrival: instantSchema.nullable(),
  actualArrival: instantSchema.nullable(),

  status: flightStatusSchema,
  phase: flightPhaseSchema,

  /** Estimated (or actual) departure minus scheduled. Negative means early. */
  delayMinutes: z.number().int(),
  /** Past `policy.delay.thresholdMinutes`. A derived flag, never a status. */
  delayed: z.boolean(),
  delayReason: delayReasonSchema.nullable(),
  delayNote: z.string().nullable(),

  /** Gate-to-gate minutes actually planned for this operation. */
  blockMinutes: z.number().int(),
  distanceNm: z.number().int(),
  /** 0 before pushback, 1 after arrival. */
  progress: z.number().min(0).max(1),

  aircraft: flightAircraftSchema.nullable(),
  /** The type the pattern plans on, when the flight came from one. */
  plannedTypeCode: z.string().nullable(),

  baggageCarousel: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  notes: z.string().nullable(),

  /** Fields this occurrence carries independently of its series. */
  overriddenFields: z.array(overridableFieldSchema),
});
export type FlightSummary = z.infer<typeof flightSummarySchema>;

/** One entry on the operational timeline: what happened, and when it was due. */
export const flightTimelineEventSchema = z.object({
  id: idSchema,
  eventType: z.string(),
  label: z.string(),
  scheduledAt: instantSchema.nullable(),
  occurredAt: instantSchema.nullable(),
  status: flightStatusSchema.nullable(),
  phase: flightPhaseSchema.nullable(),
  actorLabel: z.string().nullable(),
  note: z.string().nullable(),
  /** False for a step still ahead of the flight. */
  complete: z.boolean(),
});
export type FlightTimelineEvent = z.infer<typeof flightTimelineEventSchema>;

/** The pattern behind a generated occurrence, as the control page shows it. */
export const flightSeriesSchema = z.object({
  id: idSchema,
  flightNumber: flightNumberSchema,
  validFrom: localDateSchema,
  validTo: localDateSchema,
  operatingDays: z.array(z.boolean()).length(7),
  departureLocalTime: localTimeSchema,
  arrivalLocalTime: localTimeSchema,
  arrivalDayOffset: z.number().int(),
  season: z.string().nullable(),
  active: z.boolean(),
});
export type FlightSeries = z.infer<typeof flightSeriesSchema>;

/**
 * What this flight offers, per cabin, after every level has been resolved.
 *
 * Resolved rather than listed: an aircraft fitted with Wi-Fi that is
 * unserviceable today is a flight-level exclusion, and only the resolver knows
 * which level won. `decidedBy` says which one did, and `overridden` carries
 * the ones that applied and lost -- so an operator asking why a cabin shows no
 * Wi-Fi reads the answer instead of inferring it.
 */
export const flightAmenitySchema = z.object({
  amenityCode: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  cabinClass: cabinClassSchema,
  included: z.boolean(),
  decidedBy: amenityScopeSchema,
  decidedByAssignmentId: idSchema,
  note: z.string().nullable(),
  overridden: z.array(
    z.object({
      scope: amenityScopeSchema,
      included: z.boolean(),
      assignmentId: idSchema,
    }),
  ),
});
export type FlightAmenity = z.infer<typeof flightAmenitySchema>;

export const flightDetailSchema = flightSummarySchema.extend({
  series: flightSeriesSchema.nullable(),
  timeline: z.array(flightTimelineEventSchema),
  /** Empty when no aircraft is assigned: there are no cabins to offer it in. */
  amenities: z.array(flightAmenitySchema),
  /**
   * Seats installed against seats sold. Sold is zero until Phase 6 puts
   * bookings behind it; the shape is here now because the aircraft-assignment
   * rules already read it and Scenario F is decided on these numbers.
   */
  inventory: z.object({
    seatCapacity: z.number().int(),
    seatsByCabin: z.record(z.string(), z.number().int()),
    soldByCabin: z.record(z.string(), z.number().int()),
    sold: z.number().int(),
  }),
  /** Sectors the assigned airframe flies either side of this one. */
  rotation: z.array(
    z.object({
      id: idSchema,
      flightNumber: flightNumberSchema,
      originIata: iataAirportCodeSchema,
      destinationIata: iataAirportCodeSchema,
      scheduledDeparture: instantSchema,
      scheduledArrival: instantSchema,
      status: flightStatusSchema,
    }),
  ),
});
export type FlightDetail = z.infer<typeof flightDetailSchema>;

// --- Query -----------------------------------------------------------------

export const flightQuerySchema = z.object({
  /** Inclusive service-date window. Defaults to the current operating day. */
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  /** Flight number, callsign, registration, airport code, city or route. */
  search: z.string().trim().max(80).optional(),
  status: flightStatusSchema.optional(),
  originIata: iataAirportCodeSchema.optional(),
  destinationIata: iataAirportCodeSchema.optional(),
  /** Either endpoint, for "everything touching BEG". */
  airportIata: iataAirportCodeSchema.optional(),
  routeId: idSchema.optional(),
  aircraftId: idSchema.optional(),
  scheduleId: idSchema.optional(),
  typeCode: z.string().trim().max(4).optional(),
  delayedOnly: booleanFlagSchema.optional(),
  unassignedOnly: booleanFlagSchema.optional(),
  /** Hide the flights whose day is over. */
  activeOnly: booleanFlagSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(400),
});
export type FlightQuery = z.infer<typeof flightQuerySchema>;

// --- Write shapes ----------------------------------------------------------

/**
 * A new flight, described the way a scheduler describes one.
 *
 * Times are airport-local, because that is what a timetable states; the API
 * resolves them against each endpoint's zone. Arrival is given as a local time
 * plus a day offset rather than a second date, which is how a timetable prints
 * an overnight sector and removes the class of error where the two dates
 * disagree with the times.
 */
export const createFlightSchema = z.object({
  flightNumber: flightNumberSchema,
  routeId: idSchema,
  serviceDate: localDateSchema,
  departureLocalTime: localTimeSchema,
  arrivalLocalTime: localTimeSchema,
  arrivalDayOffset: z.number().int().min(0).max(1).default(0),
  flightType: flightTypeSchema.default("scheduled_passenger"),
  aircraftId: idSchema.nullish(),
  departureTerminal: z.string().trim().max(8).nullish(),
  departureGate: z.string().trim().max(8).nullish(),
  arrivalGate: z.string().trim().max(8).nullish(),
  notes: z.string().trim().max(500).nullish(),
});
export type CreateFlight = z.input<typeof createFlightSchema>;

/** A change to one flight, and how far it reaches. */
export const updateFlightSchema = z.object({
  serviceDate: localDateSchema.optional(),
  departureLocalTime: localTimeSchema.optional(),
  arrivalLocalTime: localTimeSchema.optional(),
  arrivalDayOffset: z.number().int().min(0).max(1).optional(),
  flightType: flightTypeSchema.optional(),
  departureTerminal: z.string().trim().max(8).nullish(),
  departureGate: z.string().trim().max(8).nullish(),
  arrivalGate: z.string().trim().max(8).nullish(),
  notes: z.string().trim().max(500).nullish(),
  scope: editScopeSchema.default("occurrence"),
});
export type UpdateFlight = z.input<typeof updateFlightSchema>;

/** Copy a flight onto another date, optionally under another number. */
export const duplicateFlightSchema = z.object({
  serviceDate: localDateSchema,
  flightNumber: flightNumberSchema.optional(),
  /** The copy starts clean unless the operator asks for the airframe too. */
  keepAircraft: z.boolean().default(false),
});
export type DuplicateFlight = z.input<typeof duplicateFlightSchema>;

export const assignAircraftSchema = z.object({
  /** Null releases the airframe and leaves the sector unassigned. */
  aircraftId: idSchema.nullable(),
});
export type AssignAircraft = z.infer<typeof assignAircraftSchema>;

export const recordDelaySchema = z.object({
  /** Minutes later than scheduled. Zero clears the delay. */
  delayMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
  reason: delayReasonSchema,
  note: z.string().trim().max(500).optional(),
  /** Push the arrival by the same amount unless told otherwise. */
  arrivalDelayMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .optional(),
});
export type RecordDelay = z.infer<typeof recordDelaySchema>;

export const changeGateSchema = z.object({
  departureTerminal: z.string().trim().max(8).nullish(),
  departureGate: z.string().trim().max(8).nullish(),
  checkInCounters: z.string().trim().max(32).nullish(),
  arrivalTerminal: z.string().trim().max(8).nullish(),
  arrivalGate: z.string().trim().max(8).nullish(),
  baggageCarousel: z.string().trim().max(8).nullish(),
});
export type ChangeGate = z.infer<typeof changeGateSchema>;

export const changeStatusSchema = z.object({
  status: flightStatusSchema,
  note: z.string().trim().max(500).optional(),
});
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

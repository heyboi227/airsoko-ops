import { z } from "zod";

/**
 * Operational vocabulary for the whole system.
 *
 * Two deliberate modelling decisions are encoded here, both places where the
 * brief's plain-language list would produce a worse model if taken literally:
 *
 * 1. `delayed` is NOT a flight status. It is a derived condition -- an
 *    estimated time later than the scheduled time by more than a configured
 *    threshold. A flight can be boarding AND delayed; making them the same
 *    field would force one to erase the other. The map legend still shows
 *    delay as its own visual treatment; it just reads a computed flag.
 *
 * 2. Status and phase are separate axes. Status is the operational state the
 *    airline manages ("boarding"). Phase is where the airframe physically is
 *    ("descent"). Telemetry moves phase; controllers move status.
 */

// --- Flights ---------------------------------------------------------------

export const FLIGHT_STATUSES = [
  "scheduled",
  "check_in_open",
  "boarding",
  "gate_closed",
  "taxi_out",
  "airborne",
  "taxi_in",
  "arrived",
  "diverted",
  "cancelled",
] as const;
export const flightStatusSchema = z.enum(FLIGHT_STATUSES);
export type FlightStatus = z.infer<typeof flightStatusSchema>;

/** Statuses that put a flight on the live map. */
export const ACTIVE_FLIGHT_STATUSES = [
  "check_in_open",
  "boarding",
  "gate_closed",
  "taxi_out",
  "airborne",
  "taxi_in",
  "diverted",
] as const satisfies readonly FlightStatus[];

/** Statuses after which no further operational action is expected. */
export const TERMINAL_FLIGHT_STATUSES = [
  "arrived",
  "cancelled",
] as const satisfies readonly FlightStatus[];

export const FLIGHT_PHASES = [
  "preflight",
  "boarding",
  "taxi_out",
  "takeoff",
  "climb",
  "cruise",
  "descent",
  "approach",
  "landing",
  "taxi_in",
  "arrived",
] as const;
export const flightPhaseSchema = z.enum(FLIGHT_PHASES);
export type FlightPhase = z.infer<typeof flightPhaseSchema>;

export const FLIGHT_TYPES = [
  "scheduled_passenger",
  "charter",
  "positioning",
  "cargo",
  "maintenance_ferry",
] as const;
export const flightTypeSchema = z.enum(FLIGHT_TYPES);
export type FlightType = z.infer<typeof flightTypeSchema>;

/** Delay reason groups, loosely following IATA delay coding families. */
export const DELAY_REASONS = [
  "weather",
  "technical",
  "air_traffic_control",
  "crew",
  "rotation",
  "security",
  "ground_handling",
  "airport_restriction",
  "commercial",
  "other",
] as const;
export const delayReasonSchema = z.enum(DELAY_REASONS);
export type DelayReason = z.infer<typeof delayReasonSchema>;

// --- Fleet -----------------------------------------------------------------

/**
 * An airframe has two states, and conflating them is a mistake this codebase
 * made once already.
 *
 * **Serviceability** is what the airline has decided about the aircraft: it is
 * available for service, or it is in the hangar, or parked, or withdrawn. It is
 * stored, because nothing else can tell you it.
 *
 * **Operational state** is what the aircraft is doing right now: flying,
 * turning round, sitting on a stand. It is *derived* from the flights, never
 * stored -- a flight in the air is the fact, and a column claiming otherwise is
 * a second copy of the truth waiting to drift. It drifted within a day: a tail
 * was airborne out of Zurich while its row still read "active" at Belgrade.
 */
export const AIRCRAFT_SERVICEABILITY = [
  "in_service",
  "maintenance",
  "stored",
  "out_of_service",
] as const;
export const aircraftServiceabilitySchema = z.enum(AIRCRAFT_SERVICEABILITY);
export type AircraftServiceability = z.infer<typeof aircraftServiceabilitySchema>;

/** Serviceability states in which an aircraft may not be assigned to a flight. */
export const UNSERVICEABLE = [
  "maintenance",
  "stored",
  "out_of_service",
] as const satisfies readonly AircraftServiceability[];

export const AIRCRAFT_OPERATIONAL_STATES = [
  "airborne",
  "turnaround",
  "on_ground",
  /** Not available for service at all -- the serviceability says so. */
  "unavailable",
] as const;
export const aircraftOperationalStateSchema = z.enum(AIRCRAFT_OPERATIONAL_STATES);
export type AircraftOperationalState = z.infer<typeof aircraftOperationalStateSchema>;

export const SERVICEABILITY_LABELS: Readonly<Record<AircraftServiceability, string>> = {
  in_service: "In service",
  maintenance: "Maintenance",
  stored: "Stored",
  out_of_service: "Out of service",
};

export const OPERATIONAL_STATE_LABELS: Readonly<Record<AircraftOperationalState, string>> = {
  airborne: "Airborne",
  turnaround: "Turnaround",
  on_ground: "On ground",
  unavailable: "Unavailable",
};

export const AIRCRAFT_BODY_TYPES = ["narrow_body", "wide_body", "regional"] as const;
export const aircraftBodyTypeSchema = z.enum(AIRCRAFT_BODY_TYPES);
export type AircraftBodyType = z.infer<typeof aircraftBodyTypeSchema>;

export const MAINTENANCE_CHECK_TYPES = [
  "line",
  "a_check",
  "b_check",
  "c_check",
  "d_check",
  "unscheduled",
] as const;
export const maintenanceCheckTypeSchema = z.enum(MAINTENANCE_CHECK_TYPES);
export type MaintenanceCheckType = z.infer<typeof maintenanceCheckTypeSchema>;

// --- Cabins and commercial -------------------------------------------------

export const CABIN_CLASSES = ["business", "premium_economy", "economy"] as const;
export const cabinClassSchema = z.enum(CABIN_CLASSES);
export type CabinClass = z.infer<typeof cabinClassSchema>;

export const SEAT_STATUSES = [
  "available",
  "sold",
  "blocked",
  "checked_in",
  "standby",
  "unserviceable",
] as const;
export const seatStatusSchema = z.enum(SEAT_STATUSES);
export type SeatStatus = z.infer<typeof seatStatusSchema>;

export const AMENITY_SCOPES = ["aircraft", "cabin", "fare_product", "flight"] as const;
export const amenityScopeSchema = z.enum(AMENITY_SCOPES);
export type AmenityScope = z.infer<typeof amenityScopeSchema>;

// --- Crew ------------------------------------------------------------------

export const CREW_RANKS = [
  "captain",
  "first_officer",
  "relief_pilot",
  "purser",
  "senior_cabin_crew",
  "cabin_crew",
] as const;
export const crewRankSchema = z.enum(CREW_RANKS);
export type CrewRank = z.infer<typeof crewRankSchema>;

export const COCKPIT_RANKS = [
  "captain",
  "first_officer",
  "relief_pilot",
] as const satisfies readonly CrewRank[];

export const CABIN_RANKS = [
  "purser",
  "senior_cabin_crew",
  "cabin_crew",
] as const satisfies readonly CrewRank[];

export const CREW_DUTY_STATUSES = [
  "available",
  "on_duty",
  "resting",
  "leave",
  "sick",
  "training",
  "unavailable",
] as const;
export const crewDutyStatusSchema = z.enum(CREW_DUTY_STATUSES);
export type CrewDutyStatus = z.infer<typeof crewDutyStatusSchema>;

// --- Bookings --------------------------------------------------------------

export const BOOKING_STATUSES = [
  "held",
  "confirmed",
  "checked_in",
  "flown",
  "cancelled",
  "disrupted",
] as const;
export const bookingStatusSchema = z.enum(BOOKING_STATUSES);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export const PAYMENT_STATUSES = ["unpaid", "authorised", "paid", "refunded"] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const SSR_CODES = [
  "wheelchair",
  "special_meal",
  "infant",
  "unaccompanied_minor",
  "medical_assistance",
  "extra_baggage",
  "service_animal",
] as const;
export const ssrCodeSchema = z.enum(SSR_CODES);
export type SsrCode = z.infer<typeof ssrCodeSchema>;

// --- Routes ----------------------------------------------------------------

export const ROUTE_STATUSES = [
  "active",
  "seasonal",
  "planned",
  "suspended",
  "discontinued",
] as const;
export const routeStatusSchema = z.enum(ROUTE_STATUSES);
export type RouteStatus = z.infer<typeof routeStatusSchema>;

// --- Alerts and audit ------------------------------------------------------

export const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
export const alertSeveritySchema = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

export const ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export const alertStatusSchema = z.enum(ALERT_STATUSES);
export type AlertStatus = z.infer<typeof alertStatusSchema>;

export const RESOURCE_KINDS = [
  "flight",
  "aircraft",
  "crew_member",
  "booking",
  "airport",
  "route",
  "schedule",
  "fare_product",
  "amenity",
  "user",
] as const;
export const resourceKindSchema = z.enum(RESOURCE_KINDS);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

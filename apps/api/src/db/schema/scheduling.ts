import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { OverridableField } from "@airsoko/contracts";
import { instant, lifecycle } from "./common.ts";
import { delayReasonEnum, flightPhaseEnum, flightStatusEnum, flightTypeEnum } from "./enums.ts";
import { aircraft, aircraftTypes } from "./fleet.ts";
import { airlines, airports, routes } from "./network.ts";
import { users } from "./identity.ts";

/**
 * A repeating service: "SO412 flies BEG-VIE at 07:45 local, Monday to Friday,
 * from March to October."
 *
 * The pattern is not a flight. Dated occurrences are generated from it into
 * `flightInstances`, and an occurrence can then be changed without touching
 * the series -- which is Scenario C.
 *
 * Departure and arrival are stored as local wall-clock times, deliberately.
 * A 07:45 Belgrade departure is 06:45Z in winter and 05:45Z in summer; storing
 * the instant would mean the schedule silently shifted by an hour twice a year.
 * `zonedTimeToInstant` resolves them per occurrence.
 */
export const recurringSchedules = pgTable(
  "recurring_schedules",
  {
    id: uuid("id").primaryKey(),
    flightNumber: varchar("flight_number", { length: 8 }).notNull(),
    airlineId: uuid("airline_id")
      .notNull()
      .references(() => airlines.id),
    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id),

    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    /** Sunday-first, index 0..6. A seven-element array beats a bitmask to read. */
    operatingDays: boolean("operating_days").array().notNull(),

    /** Airport-local, "HH:MM". Never an instant -- see the note above. */
    departureLocalTime: varchar("departure_local_time", { length: 5 }).notNull(),
    arrivalLocalTime: varchar("arrival_local_time", { length: 5 }).notNull(),
    /** 1 when the flight lands the next local day, 0 otherwise. */
    arrivalDayOffset: integer("arrival_day_offset").notNull().default(0),

    aircraftTypeId: uuid("aircraft_type_id")
      .notNull()
      .references(() => aircraftTypes.id),
    defaultAircraftId: uuid("default_aircraft_id").references(() => aircraft.id),
    flightType: flightTypeEnum("flight_type").notNull().default("scheduled_passenger"),
    season: text("season"),
    active: boolean("active").notNull().default(true),
    ...lifecycle,
  },
  (table) => [
    index("recurring_schedules_flight_number_idx").on(table.flightNumber),
    index("recurring_schedules_route_idx").on(table.routeId),
    index("recurring_schedules_validity_idx").on(table.validFrom, table.validTo),
  ],
);

/**
 * One dated operation.
 *
 * Six timestamps, not two. Scheduled is the commitment, estimated is the
 * current expectation, actual is what happened -- and the brief is explicit
 * that they stay distinct. Delay is derived from scheduled versus estimated
 * rather than stored as a status, so a flight can be boarding *and* late.
 *
 * Origin and destination are denormalised off the route because a diversion
 * changes the destination of one flight without changing the route.
 */
export const flightInstances = pgTable(
  "flight_instances",
  {
    id: uuid("id").primaryKey(),
    /** Null for ad-hoc flights that no pattern produced. */
    scheduleId: uuid("schedule_id").references(() => recurringSchedules.id, {
      onDelete: "set null",
    }),
    flightNumber: varchar("flight_number", { length: 8 }).notNull(),
    /** What ATC hears, e.g. "ASO412". */
    callsign: varchar("callsign", { length: 12 }).notNull(),
    operatingAirlineId: uuid("operating_airline_id")
      .notNull()
      .references(() => airlines.id),
    /** Set when another carrier sells this flight under its own number. */
    marketingAirlineId: uuid("marketing_airline_id").references(() => airlines.id),
    marketingFlightNumber: varchar("marketing_flight_number", { length: 8 }),

    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id),
    originAirportId: uuid("origin_airport_id")
      .notNull()
      .references(() => airports.id),
    destinationAirportId: uuid("destination_airport_id")
      .notNull()
      .references(() => airports.id),
    /** The local calendar date at the origin this flight belongs to. */
    serviceDate: date("service_date").notNull(),

    scheduledDeparture: instant("scheduled_departure").notNull(),
    estimatedDeparture: instant("estimated_departure"),
    actualDeparture: instant("actual_departure"),
    scheduledArrival: instant("scheduled_arrival").notNull(),
    estimatedArrival: instant("estimated_arrival"),
    actualArrival: instant("actual_arrival"),

    aircraftId: uuid("aircraft_id").references(() => aircraft.id),
    status: flightStatusEnum("status").notNull().default("scheduled"),
    /** Where the airframe physically is. Telemetry moves this; controllers move status. */
    phase: flightPhaseEnum("phase").notNull().default("preflight"),
    flightType: flightTypeEnum("flight_type").notNull().default("scheduled_passenger"),
    delayReason: delayReasonEnum("delay_reason"),
    delayNote: text("delay_note"),
    cancellationReason: text("cancellation_reason"),

    departureTerminal: varchar("departure_terminal", { length: 8 }),
    departureGate: varchar("departure_gate", { length: 8 }),
    checkInCounters: varchar("check_in_counters", { length: 32 }),
    arrivalTerminal: varchar("arrival_terminal", { length: 8 }),
    arrivalGate: varchar("arrival_gate", { length: 8 }),
    baggageCarousel: varchar("baggage_carousel", { length: 8 }),

    notes: text("notes"),

    /**
     * Which fields this occurrence carries independently of its pattern.
     *
     * Scenario C's mechanism. A generated occurrence normally follows its
     * schedule; the moment somebody edits one by hand, the fields they changed
     * are recorded here, and a later edit to the series leaves exactly those
     * alone. Storing the field names rather than a single `is_exception` flag
     * is what lets a series retiming still reach an occurrence whose gate was
     * moved -- a gate exception and a time exception are different exceptions.
     *
     * Empty on an ad-hoc flight, which has no pattern to diverge from.
     */
    overriddenFields: text("overridden_fields")
      .array()
      .$type<OverridableField[]>()
      .notNull()
      .default([]),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("flight_instances_number_date_key").on(table.flightNumber, table.serviceDate),
    index("flight_instances_departure_idx").on(table.scheduledDeparture),
    index("flight_instances_status_idx").on(table.status),
    index("flight_instances_aircraft_idx").on(table.aircraftId),
    index("flight_instances_route_idx").on(table.routeId),
    index("flight_instances_service_date_idx").on(table.serviceDate),
    // The live map's query: everything airborne or about to be.
    index("flight_instances_active_idx").on(table.status, table.scheduledDeparture),
  ],
);

/**
 * The operational timeline: crew report, aircraft at gate, boarding, pushback,
 * take-off, landing, on blocks.
 *
 * Append-only, like the audit trail but operational rather than administrative
 * -- this is what happened to the flight, not who changed what in the system.
 */
export const flightStatusEvents = pgTable(
  "flight_status_events",
  {
    id: uuid("id").primaryKey(),
    flightInstanceId: uuid("flight_instance_id")
      .notNull()
      .references(() => flightInstances.id, { onDelete: "cascade" }),
    /** "crew_report", "boarding_started", "pushback", "airborne", "on_blocks". */
    eventType: text("event_type").notNull(),
    /** When it was meant to happen, where that is meaningful. */
    scheduledAt: instant("scheduled_at"),
    occurredAt: instant("occurred_at").notNull(),
    status: flightStatusEnum("status"),
    phase: flightPhaseEnum("phase"),
    /** Null when the simulation or a rule produced it rather than a person. */
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
  },
  (table) => [
    index("flight_status_events_flight_idx").on(table.flightInstanceId, table.occurredAt),
    index("flight_status_events_occurred_idx").on(table.occurredAt),
  ],
);

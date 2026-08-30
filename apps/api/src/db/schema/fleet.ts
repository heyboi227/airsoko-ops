import { sql } from "drizzle-orm";
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
import { instant, lifecycle } from "./common.ts";
import {
  aircraftBodyTypeEnum,
  aircraftServiceabilityEnum,
  cabinClassEnum,
  maintenanceCheckTypeEnum,
} from "./enums.ts";
import { airports } from "./network.ts";

/**
 * A model, not a machine.
 *
 * The brief is explicit that an aircraft type describes a model while an
 * aircraft is a registered physical airframe, and the reference project
 * collapsed both into a single row reading `Narrow-body | Wide-body`. Range,
 * cruise speed and complement requirements belong to the type; hours, cycles
 * and location belong to the tail.
 */
export const aircraftTypes = pgTable(
  "aircraft_types",
  {
    id: uuid("id").primaryKey(),
    /** ICAO type designator, e.g. "A20N", "B38M", "A339". */
    icaoTypeCode: varchar("icao_type_code", { length: 4 }).notNull(),
    /** IATA type code, e.g. "32N". Used on commercial documents. */
    iataTypeCode: varchar("iata_type_code", { length: 3 }),
    manufacturer: text("manufacturer").notNull(),
    model: text("model").notNull(),
    variant: text("variant"),
    bodyType: aircraftBodyTypeEnum("body_type").notNull(),
    engineModel: text("engine_model").notNull(),
    /** Published maximum range. The planning limit is a fraction of this -- see policy.ts. */
    rangeNm: integer("range_nm").notNull(),
    cruiseSpeedKts: integer("cruise_speed_kts").notNull(),
    serviceCeilingFt: integer("service_ceiling_ft").notNull(),
    /** Minutes on the ground before this type can turn around. */
    minimumTurnaroundMinutes: integer("minimum_turnaround_minutes").notNull(),
    ...lifecycle,
  },
  (table) => [uniqueIndex("aircraft_types_icao_type_code_key").on(table.icaoTypeCode)],
);

export const aircraft = pgTable(
  "aircraft",
  {
    id: uuid("id").primaryKey(),
    /** Tail number as painted, e.g. "YU-ASA". */
    registration: varchar("registration", { length: 10 }).notNull(),
    aircraftTypeId: uuid("aircraft_type_id")
      .notNull()
      .references(() => aircraftTypes.id),
    serialNumber: text("serial_number").notNull(),
    /** Air Soko names its aircraft after Serbian rivers. */
    name: text("name"),
    deliveredOn: date("delivered_on").notNull(),
    /**
     * What the airline has decided about this airframe. Stored, because
     * nothing else can tell you it.
     *
     * What the aircraft is *doing* -- flying, turning round, parked -- is
     * derived from its flights and deliberately not a column here. See
     * `deriveFleetState` in the domain package.
     */
    serviceability: aircraftServiceabilityEnum("serviceability")
      .notNull()
      .default("in_service"),
    /**
     * Where the airline plans this tail to be based. Its *actual* position
     * comes from the last flight it flew, which is the only thing that knows.
     */
    baseAirportId: uuid("base_airport_id").references(() => airports.id),
    totalHours: integer("total_hours").notNull().default(0),
    totalCycles: integer("total_cycles").notNull().default(0),

    // --- Light maintenance state ------------------------------------------
    // Not an MRO system. Enough to answer "may this airframe fly tomorrow?"
    // and to warn before the answer becomes no.
    lastCheckType: maintenanceCheckTypeEnum("last_check_type"),
    lastCheckAt: instant("last_check_at"),
    nextCheckType: maintenanceCheckTypeEnum("next_check_type"),
    nextCheckDueAt: instant("next_check_due_at"),
    nextCheckDueHours: integer("next_check_due_hours"),
    nextCheckDueCycles: integer("next_check_due_cycles"),

    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    ...lifecycle,
  },
  (table) => [
    // Unique among aircraft the airline still has. Registrations are recycled
    // when a tail leaves the fleet -- see migration 0004.
    uniqueIndex("aircraft_registration_active_key")
      .on(table.registration)
      .where(sql`${table.active}`),
    index("aircraft_type_idx").on(table.aircraftTypeId),
    index("aircraft_serviceability_idx").on(table.serviceability),
    index("aircraft_base_idx").on(table.baseAirportId),
  ],
);

/**
 * The cabin breakdown of one airframe.
 *
 * Capacity is never stored on the aircraft: it is the sum of these rows, so it
 * cannot drift out of step with the layout. Scenario F -- a replacement
 * aircraft with fewer seats than tickets sold -- depends on that being true.
 */
export const aircraftCabins = pgTable(
  "aircraft_cabins",
  {
    id: uuid("id").primaryKey(),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    cabinClass: cabinClassEnum("cabin_class").notNull(),
    seatCount: integer("seat_count").notNull(),
    firstRow: integer("first_row").notNull(),
    lastRow: integer("last_row").notNull(),
    /** Seat letters in this cabin, in order, e.g. "ABCDEF" or "ACDF". */
    seatLetters: varchar("seat_letters", { length: 12 }).notNull(),
    pitchInches: integer("pitch_inches").notNull(),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("aircraft_cabins_class_key").on(table.aircraftId, table.cabinClass),
    index("aircraft_cabins_aircraft_idx").on(table.aircraftId),
  ],
);

/**
 * Physical seats, one row each.
 *
 * They belong to the airframe rather than to a flight: 4B is 4B on every
 * sector this tail flies. What varies by flight is a seat's *status*, which
 * lives with the flight in Phase 6.
 */
export const seats = pgTable(
  "seats",
  {
    id: uuid("id").primaryKey(),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    cabinId: uuid("cabin_id")
      .notNull()
      .references(() => aircraftCabins.id, { onDelete: "cascade" }),
    cabinClass: cabinClassEnum("cabin_class").notNull(),
    row: integer("row").notNull(),
    letter: varchar("letter", { length: 1 }).notNull(),
    /** "12A" -- what a passenger reads on a boarding pass. */
    label: varchar("label", { length: 4 }).notNull(),
    isWindow: boolean("is_window").notNull().default(false),
    isAisle: boolean("is_aisle").notNull().default(false),
    isExitRow: boolean("is_exit_row").notNull().default(false),
    isExtraLegroom: boolean("is_extra_legroom").notNull().default(false),
    /** Broken seats exist. They are not sellable and not a data error. */
    isServiceable: boolean("is_serviceable").notNull().default(true),
  },
  (table) => [
    uniqueIndex("seats_label_key").on(table.aircraftId, table.label),
    index("seats_aircraft_idx").on(table.aircraftId),
    index("seats_cabin_idx").on(table.cabinId),
  ],
);

/**
 * Maintenance history and planned work.
 *
 * Deliberately shallow -- the brief says this need not be a full MRO system.
 * What it must do is stop an airframe being assigned while it is in the hangar,
 * and warn before a limit is reached rather than after.
 */
export const maintenanceEvents = pgTable(
  "maintenance_events",
  {
    id: uuid("id").primaryKey(),
    aircraftId: uuid("aircraft_id")
      .notNull()
      .references(() => aircraft.id, { onDelete: "cascade" }),
    checkType: maintenanceCheckTypeEnum("check_type").notNull(),
    airportId: uuid("airport_id").references(() => airports.id),
    scheduledStart: instant("scheduled_start").notNull(),
    scheduledEnd: instant("scheduled_end").notNull(),
    actualStart: instant("actual_start"),
    actualEnd: instant("actual_end"),
    hoursAtCheck: integer("hours_at_check"),
    cyclesAtCheck: integer("cycles_at_check"),
    description: text("description").notNull(),
    notes: text("notes"),
    ...lifecycle,
  },
  (table) => [
    index("maintenance_events_aircraft_idx").on(table.aircraftId),
    index("maintenance_events_window_idx").on(table.scheduledStart, table.scheduledEnd),
  ],
);

import {
  boolean,
  date,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { instant, lifecycle } from "./common.ts";
import { crewDutyStatusEnum, crewRankEnum } from "./enums.ts";
import { aircraftTypes } from "./fleet.ts";
import { airports } from "./network.ts";
import { flightInstances } from "./scheduling.ts";

export const crewMembers = pgTable(
  "crew_members",
  {
    id: uuid("id").primaryKey(),
    employeeId: varchar("employee_id", { length: 12 }).notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    rank: crewRankEnum("rank").notNull(),
    baseAirportId: uuid("base_airport_id")
      .notNull()
      .references(() => airports.id),
    email: text("email").notNull(),
    phone: text("phone"),
    hiredOn: date("hired_on").notNull(),
    /** Where this person is right now, for the assignment board. */
    dutyStatus: crewDutyStatusEnum("duty_status").notNull().default("available"),
    /** ISO 639-1 codes. Cabin crew language cover is a real rostering constraint. */
    languages: varchar("languages", { length: 2 }).array().notNull().default([]),
    active: boolean("active").notNull().default(true),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("crew_members_employee_id_key").on(table.employeeId),
    index("crew_members_rank_idx").on(table.rank),
    index("crew_members_base_idx").on(table.baseAirportId),
    index("crew_members_duty_status_idx").on(table.dutyStatus),
  ],
);

/**
 * Which airframes a pilot may command.
 *
 * Scenario D turns on this table: assigning a captain to a type they are not
 * rated on must be refused with a precise reason, not a generic error.
 */
export const crewTypeRatings = pgTable(
  "crew_type_ratings",
  {
    id: uuid("id").primaryKey(),
    crewMemberId: uuid("crew_member_id")
      .notNull()
      .references(() => crewMembers.id, { onDelete: "cascade" }),
    aircraftTypeId: uuid("aircraft_type_id")
      .notNull()
      .references(() => aircraftTypes.id, { onDelete: "cascade" }),
    issuedOn: date("issued_on").notNull(),
    /** Ratings lapse. A rating that expired yesterday is not a rating. */
    expiresOn: date("expires_on").notNull(),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("crew_type_ratings_key").on(table.crewMemberId, table.aircraftTypeId),
    index("crew_type_ratings_crew_idx").on(table.crewMemberId),
    index("crew_type_ratings_type_idx").on(table.aircraftTypeId),
  ],
);

/** Non-type qualifications: dangerous goods, CRM, medical, line check. */
export const crewQualifications = pgTable(
  "crew_qualifications",
  {
    id: uuid("id").primaryKey(),
    crewMemberId: uuid("crew_member_id")
      .notNull()
      .references(() => crewMembers.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 16 }).notNull(),
    name: text("name").notNull(),
    issuedOn: date("issued_on").notNull(),
    expiresOn: date("expires_on"),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("crew_qualifications_key").on(table.crewMemberId, table.code),
    index("crew_qualifications_expiry_idx").on(table.expiresOn),
  ],
);

/**
 * One person, one position, one flight.
 *
 * Report and release bracket the duty period rather than the flight: duty
 * starts before the doors and ends after them, which is what the overlap and
 * duty-limit rules actually measure.
 */
export const crewAssignments = pgTable(
  "crew_assignments",
  {
    id: uuid("id").primaryKey(),
    flightInstanceId: uuid("flight_instance_id")
      .notNull()
      .references(() => flightInstances.id, { onDelete: "cascade" }),
    crewMemberId: uuid("crew_member_id")
      .notNull()
      .references(() => crewMembers.id, { onDelete: "cascade" }),
    /** The position filled, which need not equal the person's substantive rank. */
    position: crewRankEnum("position").notNull(),
    reportAt: instant("report_at").notNull(),
    releaseAt: instant("release_at").notNull(),
    notes: text("notes"),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("crew_assignments_key").on(table.flightInstanceId, table.crewMemberId),
    index("crew_assignments_flight_idx").on(table.flightInstanceId),
    index("crew_assignments_crew_idx").on(table.crewMemberId),
    // The overlap query: this person's duty periods around a given window.
    index("crew_assignments_duty_window_idx").on(
      table.crewMemberId,
      table.reportAt,
      table.releaseAt,
    ),
  ],
);

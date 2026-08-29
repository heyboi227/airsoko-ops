import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { lifecycle } from "./common.ts";
import { amenityScopeEnum, cabinClassEnum } from "./enums.ts";
import { aircraft } from "./fleet.ts";
import { flightInstances } from "./scheduling.ts";

/**
 * A fare product is what was sold; a cabin is where the passenger sits.
 *
 * The brief calls this out specifically, and the reference project conflated
 * them into one `travel_class` enum of Business and Economy. Economy Light,
 * Economy Standard and Economy Flex are three products in one cabin: same
 * seat, different baggage, different change rights.
 */
export const fareProducts = pgTable(
  "fare_products",
  {
    id: uuid("id").primaryKey(),
    /** Fare basis style, e.g. "ECOLGT". */
    code: varchar("code", { length: 12 }).notNull(),
    name: text("name").notNull(),
    cabinClass: cabinClassEnum("cabin_class").notNull(),
    /** Display order within a cabin, cheapest first. */
    tier: integer("tier").notNull(),

    checkedBags: integer("checked_bags").notNull().default(0),
    checkedBagKg: integer("checked_bag_kg").notNull().default(23),
    cabinBags: integer("cabin_bags").notNull().default(1),
    cabinBagKg: integer("cabin_bag_kg").notNull().default(8),

    seatSelection: boolean("seat_selection").notNull().default(false),
    changeable: boolean("changeable").notNull().default(false),
    changeFee: numeric("change_fee", { precision: 10, scale: 2 }),
    refundable: boolean("refundable").notNull().default(false),
    refundFee: numeric("refund_fee", { precision: 10, scale: 2 }),

    priorityBoarding: boolean("priority_boarding").notNull().default(false),
    loungeAccess: boolean("lounge_access").notNull().default(false),
    mealIncluded: boolean("meal_included").notNull().default(false),
    /** Frequent-flyer miles per mile flown. */
    milesEarningRate: numeric("miles_earning_rate", { precision: 4, scale: 2 })
      .notNull()
      .default("1.00"),

    active: boolean("active").notNull().default(true),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("fare_products_code_key").on(table.code),
    index("fare_products_cabin_idx").on(table.cabinClass, table.tier),
  ],
);

export const amenities = pgTable(
  "amenities",
  {
    id: uuid("id").primaryKey(),
    code: varchar("code", { length: 24 }).notNull(),
    name: text("name").notNull(),
    /** "connectivity", "power", "entertainment", "catering", "comfort". */
    category: varchar("category", { length: 24 }).notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    ...lifecycle,
  },
  (table) => [uniqueIndex("amenities_code_key").on(table.code)],
);

/**
 * Amenities attach at four levels, and the effective set for a passenger is
 * resolved by specificity: flight beats fare product beats cabin beats
 * aircraft. `included` can be false, so a narrower level can *remove* something
 * a broader one grants -- an aircraft with Wi-Fi that is unserviceable today
 * is a flight-level exclusion, not a fleet-wide edit.
 */
export const amenityAssignments = pgTable(
  "amenity_assignments",
  {
    id: uuid("id").primaryKey(),
    amenityId: uuid("amenity_id")
      .notNull()
      .references(() => amenities.id, { onDelete: "cascade" }),
    scope: amenityScopeEnum("scope").notNull(),
    included: boolean("included").notNull().default(true),

    // Exactly one of these is set, matching `scope`.
    aircraftId: uuid("aircraft_id").references(() => aircraft.id, { onDelete: "cascade" }),
    cabinClass: cabinClassEnum("cabin_class"),
    fareProductId: uuid("fare_product_id").references(() => fareProducts.id, {
      onDelete: "cascade",
    }),
    flightInstanceId: uuid("flight_instance_id").references(() => flightInstances.id, {
      onDelete: "cascade",
    }),

    note: text("note"),
    ...lifecycle,
  },
  (table) => [
    index("amenity_assignments_amenity_idx").on(table.amenityId),
    index("amenity_assignments_aircraft_idx").on(table.aircraftId),
    index("amenity_assignments_fare_idx").on(table.fareProductId),
    index("amenity_assignments_flight_idx").on(table.flightInstanceId),
  ],
);

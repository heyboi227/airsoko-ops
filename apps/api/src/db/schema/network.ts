import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { instant, lifecycle } from "./common.ts";
import { aircraftTypes } from "./fleet.ts";
import { routeStatusEnum } from "./enums.ts";

/**
 * Only the countries the network touches. A row is added when a station needs
 * one, rather than loading a world list -- an airline's reference data covers
 * where it flies. See docs/DECISIONS.md.
 *
 * There is no alpha-3 column yet: nothing reads one, and shipping 249 codes
 * that could not be verified from a source would be worse than not having
 * them. It returns in Phase 6 if travel documents need it.
 */
export const countries = pgTable("countries", {
  /** ISO 3166-1 alpha-2, the natural key. */
  code: varchar("code", { length: 2 }).primaryKey(),
  name: text("name").notNull(),
});

export const airports = pgTable(
  "airports",
  {
    id: uuid("id").primaryKey(),
    iataCode: varchar("iata_code", { length: 3 }).notNull(),
    icaoCode: varchar("icao_code", { length: 4 }).notNull(),
    name: text("name").notNull(),
    city: text("city").notNull(),
    countryCode: varchar("country_code", { length: 2 })
      .notNull()
      .references(() => countries.code),
    // Double precision rather than numeric: these are read on every map tick
    // and the extra places numeric would keep are below what we ever draw.
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    elevationFt: integer("elevation_ft").notNull().default(0),
    /** IANA identifier, e.g. "Europe/Belgrade". Drives every local time shown. */
    timeZone: text("time_zone").notNull(),
    isHub: boolean("is_hub").notNull().default(false),
    isFocusCity: boolean("is_focus_city").notNull().default(false),
    active: boolean("active").notNull().default(true),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("airports_iata_code_key").on(table.iataCode),
    uniqueIndex("airports_icao_code_key").on(table.icaoCode),
    index("airports_country_code_idx").on(table.countryCode),
    index("airports_active_idx").on(table.active),
  ],
);

/**
 * Airlines other than Air Soko exist here for codeshares and marketing flight
 * numbers: the brief distinguishes the airline that operates a flight from the
 * one that sells it.
 */
export const airlines = pgTable(
  "airlines",
  {
    id: uuid("id").primaryKey(),
    iataCode: varchar("iata_code", { length: 2 }).notNull(),
    icaoCode: varchar("icao_code", { length: 3 }).notNull(),
    name: text("name").notNull(),
    callsignPrefix: text("callsign_prefix").notNull(),
    /** True for Air Soko itself. Exactly one row should have this. */
    isOperator: boolean("is_operator").notNull().default(false),
    ...lifecycle,
  },
  (table) => [uniqueIndex("airlines_iata_code_key").on(table.iataCode)],
);

/**
 * A reusable airport pair. A route is commercial intent; a flight instance is
 * one dated operation of it. Distance is stored because it is read constantly
 * -- on range checks, on utilisation, on every list -- and the great-circle
 * distance between two fixed points does not change.
 */
export const routes = pgTable(
  "routes",
  {
    id: uuid("id").primaryKey(),
    originAirportId: uuid("origin_airport_id")
      .notNull()
      .references(() => airports.id),
    destinationAirportId: uuid("destination_airport_id")
      .notNull()
      .references(() => airports.id),
    distanceNm: integer("distance_nm").notNull(),
    /** Planned block time in minutes, gate to gate. */
    blockMinutes: integer("block_minutes").notNull(),
    status: routeStatusEnum("status").notNull().default("active"),
    typicalAircraftTypeId: uuid("typical_aircraft_type_id").references(() => aircraftTypes.id),
    /** Set on seasonal routes; null on year-round ones. */
    seasonStart: instant("season_start"),
    seasonEnd: instant("season_end"),
    ...lifecycle,
  },
  (table) => [
    uniqueIndex("routes_pair_key").on(table.originAirportId, table.destinationAirportId),
    index("routes_origin_idx").on(table.originAirportId),
    index("routes_destination_idx").on(table.destinationAirportId),
    index("routes_status_idx").on(table.status),
  ],
);

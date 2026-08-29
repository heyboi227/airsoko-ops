import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { ALERT_SEVERITIES, ALERT_STATUSES, RESOURCE_KINDS, ROLES } from "@airsoko/contracts";

/**
 * Phase 0 schema: the reference data and control-plane tables everything else
 * will hang off. Flights, fleet, crew and bookings arrive in their own phases;
 * what is here is what the mutation pipeline itself needs to exist.
 *
 * Two conventions hold across every table added later:
 *
 *  - Instants are `timestamp with time zone`. There is no naive datetime in
 *    this database. Airport-local times are derived from the airport's IANA
 *    zone at the edge, never stored.
 *  - Identifiers are UUIDs generated deterministically by the seed, so a
 *    reseed produces byte-identical data and screenshots stay reproducible.
 */

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const roleEnum = pgEnum("role", ROLES);
export const alertSeverityEnum = pgEnum("alert_severity", ALERT_SEVERITIES);
export const alertStatusEnum = pgEnum("alert_status", ALERT_STATUSES);
export const resourceKindEnum = pgEnum("resource_kind", RESOURCE_KINDS);

// --- Reference data --------------------------------------------------------

export const countries = pgTable("countries", {
  /** ISO 3166-1 alpha-2, the natural key. */
  code: varchar("code", { length: 2 }).primaryKey(),
  alpha3: varchar("alpha3", { length: 3 }).notNull(),
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
    // and the extra decimal places numeric would preserve are below the
    // resolution of anything we draw.
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    elevationFt: integer("elevation_ft").notNull().default(0),
    /** IANA identifier, e.g. "Europe/Belgrade". Drives every local-time display. */
    timeZone: text("time_zone").notNull(),
    isHub: boolean("is_hub").notNull().default(false),
    isFocusCity: boolean("is_focus_city").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("airports_iata_code_key").on(table.iataCode),
    uniqueIndex("airports_icao_code_key").on(table.icaoCode),
    index("airports_country_code_idx").on(table.countryCode),
    index("airports_active_idx").on(table.active),
  ],
);

// --- Identity --------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    /** scrypt, stored as `salt:derivedKey` in hex. See http/password.ts. */
    passwordHash: text("password_hash").notNull(),
    homeBase: varchar("home_base", { length: 3 }),
    active: boolean("active").notNull().default(true),
    lastLoginAt: instant("last_login_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

// --- Control plane ---------------------------------------------------------

/**
 * Append-only from the application's perspective. Nothing in the codebase
 * updates or deletes a row here; the only write path is the mutation pipeline,
 * and it only inserts.
 */
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: uuid("id").primaryKey(),
    occurredAt: instant("occurred_at").notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Kept alongside the id so the trail survives a user being removed. */
    actorLabel: text("actor_label").notNull(),
    /** The intent name, e.g. "airport.create", "flight.reassign_aircraft". */
    action: text("action").notNull(),
    resourceKind: resourceKindEnum("resource_kind").notNull(),
    resourceId: uuid("resource_id"),
    resourceLabel: text("resource_label").notNull(),
    /** Null on create. */
    previousValue: jsonb("previous_value"),
    /** Null on delete. */
    newValue: jsonb("new_value"),
    /** Operator justification, when the intent asked for one. */
    reason: text("reason"),
    /** Warning codes the operator explicitly accepted to get here. */
    acknowledgedWarnings: jsonb("acknowledged_warnings")
      .$type<string[]>()
      .notNull()
      .default([]),
  },
  (table) => [
    index("audit_entries_occurred_at_idx").on(table.occurredAt),
    index("audit_entries_resource_idx").on(table.resourceKind, table.resourceId),
    index("audit_entries_actor_idx").on(table.actorId),
    index("audit_entries_action_idx").on(table.action),
  ],
);

export const operationalAlerts = pgTable(
  "operational_alerts",
  {
    id: uuid("id").primaryKey(),
    raisedAt: instant("raised_at").notNull().defaultNow(),
    severity: alertSeverityEnum("severity").notNull(),
    status: alertStatusEnum("status").notNull().default("open"),
    /** The rule code that produced it, when a rule did. */
    code: text("code"),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    resourceKind: resourceKindEnum("resource_kind").notNull(),
    resourceId: uuid("resource_id"),
    resourceLabel: text("resource_label").notNull(),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: instant("acknowledged_at"),
    resolvedAt: instant("resolved_at"),
    resolvedById: uuid("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Marking an alert resolved never erases it -- history is the point. */
    resolutionNote: text("resolution_note"),
  },
  (table) => [
    index("operational_alerts_status_idx").on(table.status, table.severity),
    index("operational_alerts_resource_idx").on(table.resourceKind, table.resourceId),
    index("operational_alerts_raised_at_idx").on(table.raisedAt),
  ],
);

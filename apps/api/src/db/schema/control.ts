import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { instant } from "./common.ts";
import { alertSeverityEnum, alertStatusEnum, resourceKindEnum } from "./enums.ts";
import { users } from "./identity.ts";

/**
 * Append-only from the application's perspective. Nothing in the codebase
 * updates or deletes a row here; the only write path is the mutation pipeline,
 * and it only inserts.
 */
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: uuid("id").primaryKey(),
    occurredAt: instant("occurred_at")
      .notNull()
      .default(sql`now()`),
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
    raisedAt: instant("raised_at")
      .notNull()
      .default(sql`now()`),
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

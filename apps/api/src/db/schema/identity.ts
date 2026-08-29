import {
  boolean,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { instant, lifecycle } from "./common.ts";
import { roleEnum } from "./enums.ts";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    /** scrypt, stored as `scrypt$N$r$p$salt$key` in hex. See http/password.ts. */
    passwordHash: text("password_hash").notNull(),
    homeBase: varchar("home_base", { length: 3 }),
    active: boolean("active").notNull().default(true),
    lastLoginAt: instant("last_login_at"),
    ...lifecycle,
  },
  (table) => [uniqueIndex("users_email_key").on(table.email)],
);

/**
 * Roles are a set per user, and permissions are derived from them in
 * `packages/contracts/src/rbac.ts` rather than stored. One table, read by both
 * the API that enforces it and the client that renders from it.
 */
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

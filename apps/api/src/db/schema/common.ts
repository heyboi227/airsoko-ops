import { timestamp } from "drizzle-orm/pg-core";

/**
 * Every absolute time in this database is `timestamp with time zone`, read and
 * written as an ISO string.
 *
 * There is no naive datetime here and there will not be one. Anything an
 * airport-local clock would show is derived at the edge from that airport's
 * IANA zone -- see `packages/domain/src/time.ts`. Keeping the mode as `string`
 * stops node-postgres turning instants into JS Dates, which would carry the
 * host's zone into every serialisation.
 */
export const instant = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

/** Created and updated stamps, on every table that has a lifecycle. */
export const lifecycle = {
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
};

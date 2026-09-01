import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/**
 * Every absolute time in this database is `timestamp with time zone`, read and
 * written as an ISO 8601 string in UTC.
 *
 * There is no naive datetime here and there will not be one. Anything an
 * airport-local clock would show is derived at the edge from that airport's
 * IANA zone -- see `packages/domain/src/time.ts`.
 *
 * The conversion on the way out is load-bearing. Postgres sends
 * `2026-09-01 03:30:00+00`: a space where ISO 8601 has a `T`, and a two-digit
 * offset. V8 parses that by leniency, which is why it survived two phases
 * unnoticed, but it is not what `instantSchema` declares an instant to be, and
 * other engines reject it. Normalising here rather than at each read means
 * a value that has been through the database and one that has just been
 * computed are the same string for the same moment.
 *
 * It cannot be done with `pg.types.setTypeParser`. Drizzle overrides the
 * driver's parsers per query to guarantee its own string mode, so a parser
 * registered on the pool never runs -- the two lines in `db/client.ts` that
 * tried were dead from the day they were written.
 */
function toIsoInstant(value: string): string {
  const normalised = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(normalised);
  // A value Postgres sent that cannot be parsed is worth surfacing as it came,
  // not replacing with a plausible-looking epoch.
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

export const instant = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (value) => toIsoInstant(value),
  toDriver: (value) => value,
});

/**
 * Created and updated stamps, on every table that has a lifecycle.
 *
 * `default(sql`now()`)` rather than `.defaultNow()`: the latter lives on
 * drizzle's own date builders, and this column is a custom type. The DDL is
 * identical.
 */
export const lifecycle = {
  createdAt: instant("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: instant("updated_at")
    .notNull()
    .default(sql`now()`),
};

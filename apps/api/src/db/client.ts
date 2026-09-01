import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.ts";
import * as schema from "./schema/index.ts";

/**
 * Instants are handled by the schema's own `instant` column type, not here.
 *
 * Drizzle overrides the driver's type parsers per query to guarantee its
 * string mode, so `pg.types.setTypeParser(1184, ...)` never runs. Two such
 * calls used to sit here and did nothing at all. See `db/schema/common.ts`.
 */
/** numeric -> string by default; we want numbers for money and distances. */
pg.types.setTypeParser(1700, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type Database = typeof db;
/** A handle inside a transaction. Every write in the app receives one of these. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Either a pooled connection or a transaction -- reads accept both. */
export type Executor = Database | Transaction;

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

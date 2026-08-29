import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.ts";
import * as schema from "./schema.ts";

/**
 * `timestamptz` columns come back as strings rather than JS Date objects.
 *
 * node-postgres parses type 1184 into a Date by default, which re-introduces
 * exactly the ambiguity this codebase spends effort avoiding: a Date carries
 * the host's zone into every serialisation. Keeping the ISO string means an
 * instant stays an instant from Postgres to the browser.
 */
pg.types.setTypeParser(1184, (value) => value);
pg.types.setTypeParser(1114, (value) => value);
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

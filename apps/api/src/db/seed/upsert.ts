import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

/**
 * A table the seed upserts by `id` and marks as its own through `created_at`:
 * every row the seed generates carries the seed epoch there, and nothing an
 * operator makes does.
 */
type SeededTable = PgTable & { id: PgColumn; createdAt: PgColumn; updatedAt: PgColumn };

/**
 * The `SET` block of an upsert in which the seed owns every column of a row
 * it generated.
 *
 * Each column is taken from the row the statement just tried to insert --
 * `excluded.<column>` in Postgres -- rather than from a value of its own, so
 * one statement can carry a batch of rows and the block is the same for all
 * of them. And it is read from the table rather than written out: a list
 * kept by hand fell behind the generated row three times, and each time a
 * column it missed was a column a hand edit kept across a reseed.
 *
 * Two columns are left as they were: `id`, the conflict key, and `created_at`,
 * the marker the seed's deletes use to tell its own rows from an operator's.
 * `updated_at` is pinned to the seed epoch rather than read from the row.
 */
export function ownEveryColumn<T extends SeededTable>(
  table: T,
  seedEpoch: string,
): PgUpdateSetSource<T> {
  const columns: Record<string, PgColumn> = getTableColumns(table);
  const set: Record<string, SQL | string> = {};
  for (const [key, column] of Object.entries(columns)) {
    if (key === "id" || key === "createdAt") continue;
    set[key] = sql`excluded.${sql.identifier(column.name)}`;
  }
  set.updatedAt = seedEpoch;
  return set as PgUpdateSetSource<T>;
}

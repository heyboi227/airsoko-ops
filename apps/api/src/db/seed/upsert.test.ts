import { describe, expect, it } from "vitest";
import { getTableColumns, type SQL } from "drizzle-orm";
import { PgDialect, type PgColumn } from "drizzle-orm/pg-core";
import { flightInstances, recurringSchedules } from "../schema/index.ts";
import { ownEveryColumn } from "./upsert.ts";

const SEED_EPOCH = "2026-01-01T00:00:00.000Z";
const dialect = new PgDialect();

/** The Postgres for one value of the block, e.g. `excluded."notes"`. */
function rendered(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

/** The two upserts in `seedNetwork` that state the rule. */
const TABLES = [
  ["flightInstances", flightInstances],
  ["recurringSchedules", recurringSchedules],
] as const;

for (const [name, table] of TABLES) {
  describe(`ownEveryColumn(${name})`, () => {
    const columns: Record<string, PgColumn> = getTableColumns(table);
    const set: Record<string, unknown> = ownEveryColumn(table, SEED_EPOCH);

    it("names every column but the conflict key and the seed's marker", () => {
      // Read from the schema rather than listed here, so a column added to
      // the table is expected without anyone remembering it. The hand-written
      // block this replaced lost the scheduled times, then the exception
      // marker, then the notes and nine more, one drift at a time.
      const expected = Object.keys(columns).filter(
        (key) => key !== "id" && key !== "createdAt",
      );
      expect(Object.keys(set).sort()).toEqual(expected.sort());
    });

    it("takes each of them from the row the statement tried to insert", () => {
      for (const [key, column] of Object.entries(columns)) {
        if (key === "id" || key === "createdAt" || key === "updatedAt") continue;
        expect(rendered(set[key]), key).toBe(`excluded."${column.name}"`);
      }
    });

    it("pins updated_at to the seed epoch", () => {
      expect(set.updatedAt).toBe(SEED_EPOCH);
    });
  });
}

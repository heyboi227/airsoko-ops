import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, ne, type InferInsertModel } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Executor } from "../client.ts";
import {
  aircraft,
  aircraftCabins,
  airports,
  amenities,
  amenityAssignments,
  countries,
  flightInstances,
  flightStatusEvents,
  recurringSchedules,
  seats,
} from "../schema/index.ts";

/**
 * Entries an operator made through the application, kept as seed data.
 *
 * The seed owns its fixtures and nothing else, which is right for a fixture
 * and wrong for the flight somebody filed yesterday on another machine. So
 * every entry that goes through the mutation pipeline is also written here,
 * one file per entity under `src/db/seed/recorded/`, and the seed replays the
 * directory after its own fixtures. Commit the files and a second machine
 * ends up with the same rows. Decision 32.
 *
 * What is recorded is *state*, not intent: the row as it stands after the
 * change, with the children that only make sense beside it -- a cabin's
 * seats, a flight's timeline. Replaying an intent would run the rules again
 * on a different day and refuse a retiming that was fine when it was made;
 * replaying a row is an upsert. A removal is a tombstone, because the seed
 * would otherwise put a seeded row straight back.
 *
 * The recorder decides *what* to write by reading the database, never by
 * trusting a caller: the trigger in migration 0006 logs which rows a
 * transaction touched, and the current state of each is read back through
 * the same schema the application uses. A route that changes five tables
 * records five tables without knowing this module exists.
 */

export const RECORDED_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../seed/recorded",
);

/** In dependency order: an entry is replayed after everything it refers to. */
export const RECORDED_KINDS = [
  "country",
  "airport",
  "aircraft",
  "aircraft_cabin",
  "schedule",
  "flight",
  "amenity_assignment",
] as const;
export type RecordedKind = (typeof RECORDED_KINDS)[number];

const DIRECTORY_FOR_KIND: Readonly<Record<RecordedKind, string>> = {
  country: "countries",
  airport: "airports",
  aircraft: "aircraft",
  aircraft_cabin: "aircraft-cabins",
  schedule: "schedules",
  flight: "flights",
  amenity_assignment: "amenity-assignments",
};

/**
 * Which tracked table belongs to which kind.
 *
 * A child table names the column that holds its parent's id: a seat change is
 * recorded as its cabin, a timeline event as its flight. The trigger's row
 * snapshot is in Postgres column names, so these are too.
 */
export const KIND_FOR_TABLE: Readonly<
  Record<string, { kind: RecordedKind; parentKey?: string }>
> = {
  countries: { kind: "country" },
  airports: { kind: "airport" },
  aircraft: { kind: "aircraft" },
  aircraft_cabins: { kind: "aircraft_cabin" },
  seats: { kind: "aircraft_cabin", parentKey: "cabin_id" },
  recurring_schedules: { kind: "schedule" },
  flight_instances: { kind: "flight" },
  flight_status_events: { kind: "flight", parentKey: "flight_instance_id" },
  amenity_assignments: { kind: "amenity_assignment" },
};

type Row = Record<string, unknown>;

export interface LiveEntry {
  kind: RecordedKind;
  /** For the person reading `git status`; nothing reads it back. */
  label: string;
  row: Row;
  seats?: Row[];
  statusEvents?: Row[];
}

export interface Tombstone {
  kind: RecordedKind;
  label: string;
  deleted: true;
}

export type RecordedEntry = LiveEntry | Tombstone;

export function isTombstone(entry: RecordedEntry): entry is Tombstone {
  return "deleted" in entry && entry.deleted === true;
}

interface KindOps {
  /** The entity as it stands now, or null once it is gone. */
  load(executor: Executor, key: string): Promise<LiveEntry | null>;
  /** Put a recorded entity into this database, taking over its natural key. */
  upsert(executor: Executor, entry: LiveEntry): Promise<void>;
  remove(executor: Executor, key: string): Promise<void>;
  /** A label from the trigger's snapshot of a deleted row, in column names. */
  labelOf(raw: Row): string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

async function upsertById<T extends PgTable & { id: PgColumn }>(
  executor: Executor,
  table: T,
  row: InferInsertModel<T>,
): Promise<void> {
  const { id: _id, ...rest } = row as Row;
  await executor
    .insert(table)
    .values(row)
    .onConflictDoUpdate({ target: table.id, set: rest as PgUpdateSetSource<T> });
}

const CHUNK = 500;

const country: KindOps = {
  load: async (executor, key) => {
    const [row] = await executor
      .select()
      .from(countries)
      .where(eq(countries.code, key))
      .limit(1);
    return row ? { kind: "country", label: `${row.code} ${row.name}`, row } : null;
  },
  upsert: async (executor, entry) => {
    const row = entry.row as InferInsertModel<typeof countries>;
    await executor
      .insert(countries)
      .values(row)
      .onConflictDoUpdate({ target: countries.code, set: { name: row.name } });
  },
  remove: async (executor, key) => {
    await executor.delete(countries).where(eq(countries.code, key));
  },
  labelOf: (raw) => `${text(raw.code)} ${text(raw.name)}`,
};

const airport: KindOps = {
  load: async (executor, key) => {
    const [row] = await executor.select().from(airports).where(eq(airports.id, key)).limit(1);
    return row ? { kind: "airport", label: `${row.iataCode} ${row.name}`, row } : null;
  },
  upsert: (executor, entry) =>
    upsertById(executor, airports, entry.row as InferInsertModel<typeof airports>),
  remove: async (executor, key) => {
    await executor.delete(airports).where(eq(airports.id, key));
  },
  labelOf: (raw) => `${text(raw.iata_code)} ${text(raw.name)}`,
};

const airframe: KindOps = {
  load: async (executor, key) => {
    const [row] = await executor.select().from(aircraft).where(eq(aircraft.id, key)).limit(1);
    return row
      ? {
          kind: "aircraft",
          label: row.name ? `${row.registration} ${row.name}` : row.registration,
          row,
        }
      : null;
  },
  upsert: (executor, entry) =>
    upsertById(executor, aircraft, entry.row as InferInsertModel<typeof aircraft>),
  remove: async (executor, key) => {
    await executor.delete(aircraft).where(eq(aircraft.id, key));
  },
  labelOf: (raw) => text(raw.registration),
};

const aircraftCabin: KindOps = {
  load: async (executor, key) => {
    const [row] = await executor
      .select()
      .from(aircraftCabins)
      .where(eq(aircraftCabins.id, key))
      .limit(1);
    if (!row) return null;

    const [tail] = await executor
      .select({ registration: aircraft.registration })
      .from(aircraft)
      .where(eq(aircraft.id, row.aircraftId))
      .limit(1);
    const seatRows = await executor
      .select()
      .from(seats)
      .where(eq(seats.cabinId, key))
      .orderBy(asc(seats.row), asc(seats.letter));

    return {
      kind: "aircraft_cabin",
      label: `${tail?.registration ?? row.aircraftId} ${row.cabinClass} rows ${row.firstRow}-${row.lastRow}`,
      row,
      seats: seatRows,
    };
  },
  upsert: async (executor, entry) => {
    const row = entry.row as InferInsertModel<typeof aircraftCabins>;

    // The recorded cabin owns its class on this airframe. One of the same
    // class under another id is a fixture this machine grew on its own, and
    // it goes first -- its seats with it, by cascade -- so the labels the
    // recorded seats carry are free.
    await executor
      .delete(aircraftCabins)
      .where(
        and(
          eq(aircraftCabins.aircraftId, row.aircraftId),
          eq(aircraftCabins.cabinClass, row.cabinClass),
          ne(aircraftCabins.id, row.id),
        ),
      );
    await upsertById(executor, aircraftCabins, row);

    // Seats are replaced wholesale: they are the cabin's layout, not entries
    // in their own right, and a seat that has left the layout has no tombstone.
    await executor.delete(seats).where(eq(seats.cabinId, row.id));
    const seatRows = (entry.seats ?? []) as InferInsertModel<typeof seats>[];
    for (let index = 0; index < seatRows.length; index += CHUNK) {
      await executor.insert(seats).values(seatRows.slice(index, index + CHUNK));
    }
  },
  remove: async (executor, key) => {
    await executor.delete(aircraftCabins).where(eq(aircraftCabins.id, key));
  },
  labelOf: (raw) =>
    `${text(raw.cabin_class)} rows ${text(raw.first_row)}-${text(raw.last_row)}`,
};

const schedule: KindOps = {
  load: async (executor, key) => {
    const [row] = await executor
      .select()
      .from(recurringSchedules)
      .where(eq(recurringSchedules.id, key))
      .limit(1);
    return row
      ? {
          kind: "schedule",
          label: `${row.flightNumber} ${row.validFrom} to ${row.validTo}`,
          row,
        }
      : null;
  },
  upsert: (executor, entry) =>
    upsertById(
      executor,
      recurringSchedules,
      entry.row as InferInsertModel<typeof recurringSchedules>,
    ),
  remove: async (executor, key) => {
    await executor.delete(recurringSchedules).where(eq(recurringSchedules.id, key));
  },
  labelOf: (raw) =>
    `${text(raw.flight_number)} ${text(raw.valid_from)} to ${text(raw.valid_to)}`,
};

const flight: KindOps = {
  load: async (executor, key) => {
    const [row] = await executor
      .select()
      .from(flightInstances)
      .where(eq(flightInstances.id, key))
      .limit(1);
    if (!row) return null;

    const events = await executor
      .select()
      .from(flightStatusEvents)
      .where(eq(flightStatusEvents.flightInstanceId, key))
      .orderBy(asc(flightStatusEvents.occurredAt), asc(flightStatusEvents.id));

    return {
      kind: "flight",
      label: `${row.flightNumber} ${row.serviceDate}`,
      row,
      statusEvents: events,
    };
  },
  upsert: async (executor, entry) => {
    const row = entry.row as InferInsertModel<typeof flightInstances>;

    // A flight number on a date is one flight. The seed's window follows the
    // calendar, so a machine seeded on a later day may have generated this
    // very sector under its own id before the recorded one arrived; the
    // recorded one is the one somebody worked on, and it wins.
    await executor
      .delete(flightInstances)
      .where(
        and(
          eq(flightInstances.flightNumber, row.flightNumber),
          eq(flightInstances.serviceDate, row.serviceDate),
          ne(flightInstances.id, row.id),
        ),
      );
    await upsertById(executor, flightInstances, row);

    await executor
      .delete(flightStatusEvents)
      .where(eq(flightStatusEvents.flightInstanceId, row.id));
    const events = (entry.statusEvents ?? []) as InferInsertModel<typeof flightStatusEvents>[];
    if (events.length > 0) await executor.insert(flightStatusEvents).values(events);
  },
  remove: async (executor, key) => {
    await executor.delete(flightInstances).where(eq(flightInstances.id, key));
  },
  labelOf: (raw) => `${text(raw.flight_number)} ${text(raw.service_date)}`,
};

const amenityAssignment: KindOps = {
  load: async (executor, key) => {
    const [found] = await executor
      .select({ row: amenityAssignments, amenityCode: amenities.code })
      .from(amenityAssignments)
      .innerJoin(amenities, eq(amenities.id, amenityAssignments.amenityId))
      .where(eq(amenityAssignments.id, key))
      .limit(1);
    if (!found) return null;

    return {
      kind: "amenity_assignment",
      label: `${found.amenityCode} ${found.row.included ? "offered" : "withheld"} at ${found.row.scope.replace(/_/g, " ")} level`,
      row: found.row,
    };
  },
  upsert: (executor, entry) =>
    upsertById(
      executor,
      amenityAssignments,
      entry.row as InferInsertModel<typeof amenityAssignments>,
    ),
  remove: async (executor, key) => {
    await executor.delete(amenityAssignments).where(eq(amenityAssignments.id, key));
  },
  labelOf: (raw) =>
    `${raw.included ? "offered" : "withheld"} at ${text(raw.scope).replace(/_/g, " ")} level`,
};

export const KIND_OPS: Readonly<Record<RecordedKind, KindOps>> = {
  country,
  airport,
  aircraft: airframe,
  aircraft_cabin: aircraftCabin,
  schedule,
  flight,
  amenity_assignment: amenityAssignment,
};

// --- The files --------------------------------------------------------------

export function entryPath(kind: RecordedKind, key: string): string {
  return join(RECORDED_DIRECTORY, DIRECTORY_FOR_KIND[kind], `${key}.json`);
}

/**
 * Written whole or not at all. Two intents can finish close together, and a
 * file that is half of one and half of the other is worse than either.
 */
export async function writeEntry(
  kind: RecordedKind,
  key: string,
  entry: RecordedEntry,
): Promise<void> {
  const path = entryPath(kind, key);
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.tmp`;
  await writeFile(staging, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  await rename(staging, path);
}

export async function readEntry(
  kind: RecordedKind,
  key: string,
): Promise<RecordedEntry | null> {
  const path = entryPath(kind, key);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseEntry(kind, key, raw, path);
}

export interface RecordedFile {
  path: string;
  key: string;
  entry: RecordedEntry;
}

/** Every file of one kind, in name order, each checked against its name. */
export async function readEntries(kind: RecordedKind): Promise<RecordedFile[]> {
  const directory = join(RECORDED_DIRECTORY, DIRECTORY_FOR_KIND[kind]);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files: RecordedFile[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    const path = join(directory, name);
    const key = name.slice(0, -".json".length);
    files.push({ path, key, entry: parseEntry(kind, key, await readFile(path, "utf8"), path) });
  }
  return files;
}

function isObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(kind: RecordedKind, key: string, raw: string, path: string): RecordedEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON. If two machines changed the same entry, this is the merge conflict to resolve: keep whichever version is right and remove the markers.`,
      { cause: error },
    );
  }

  if (!isObject(parsed) || parsed.kind !== kind) {
    const found = isObject(parsed) ? text(parsed.kind) : typeof parsed;
    throw new Error(`${path}: expected a ${kind} entry, found ${found}.`);
  }
  if (parsed.deleted === true) {
    return { kind, label: text(parsed.label), deleted: true };
  }
  if (!isObject(parsed.row)) {
    throw new Error(`${path}: an entry that is not a tombstone must carry its row.`);
  }
  const rowKey = parsed.row.id ?? parsed.row.code;
  if (rowKey !== key) {
    throw new Error(
      `${path}: the row inside is ${text(rowKey)}, but the file is named for ${key}.`,
    );
  }

  return {
    kind,
    label: text(parsed.label),
    row: parsed.row,
    ...(Array.isArray(parsed.seats) ? { seats: parsed.seats as Row[] } : {}),
    ...(Array.isArray(parsed.statusEvents)
      ? { statusEvents: parsed.statusEvents as Row[] }
      : {}),
  };
}

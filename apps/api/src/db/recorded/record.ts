import { AsyncLocalStorage } from "node:async_hooks";
import { asc, lte, sql } from "drizzle-orm";
import { db, type Transaction } from "../client.ts";
import { rowChanges } from "../schema/index.ts";
import { env, isProduction } from "../../env.ts";
import { logger } from "../../logger.ts";
import {
  KIND_FOR_TABLE,
  KIND_OPS,
  readEntry,
  writeEntry,
  type RecordedKind,
} from "./entries.ts";

/**
 * The recorder: what the mutation pipeline calls, before and after a commit.
 *
 * Before: `armRecording` sets a transaction-local flag that the trigger in
 * migration 0006 checks. Nothing else in the database sets it, so the seed,
 * a migration and a psql session write no change rows, and neither does an
 * end-to-end test that has asked not to be recorded.
 *
 * After: `recordPendingChanges` drains the change log into files. It runs
 * after the commit, not inside it -- a slow disk should never hold a row
 * lock -- and it reads the *current* state of each touched entity rather
 * than the values the trigger saw, so the order two intents finished in
 * cannot matter. Change rows are removed only once their files are written:
 * a process that dies in between leaves them for the next drain, which the
 * API also runs when it starts.
 *
 * On by default in development and nowhere else. `SEED_RECORDING=off` turns
 * it off; a request can decline with `x-airsoko-recording: off`, which is how
 * the acceptance suite keeps its fixtures out of the committed data.
 */

export const recordingEnabled: boolean =
  !isProduction &&
  (env.SEED_RECORDING ?? (env.NODE_ENV === "development" ? "on" : "off")) === "on";

const preference = new AsyncLocalStorage<{ record: boolean }>();

/** Run `work` under a per-request decision. A request can only opt out. */
export function withRecordingPreference<T>(record: boolean, work: () => T): T {
  return preference.run({ record }, work);
}

export function recordingArmed(): boolean {
  return recordingEnabled && (preference.getStore()?.record ?? true);
}

export async function armRecording(tx: Transaction): Promise<void> {
  await tx.execute(sql`SET LOCAL airsoko.record_changes = 'on'`);
}

// One drain at a time. Two finishing together would race to write the same
// file, and the second to read the change log would find it already empty.
let queue: Promise<unknown> = Promise.resolve();

/** Drain the change log into files. Resolves with how many entities were written. */
export function recordPendingChanges(): Promise<number> {
  const next = queue.then(drain, drain);
  queue = next.catch(() => undefined);
  return next;
}

interface Touched {
  kind: RecordedKind;
  key: string;
  /** The trigger's snapshot of the row, when the last change was a delete. */
  removed: Record<string, unknown> | null;
}

async function drain(): Promise<number> {
  const changes = await db.select().from(rowChanges).orderBy(asc(rowChanges.id));
  const last = changes.at(-1);
  if (!last) return 0;

  const touched = new Map<string, Touched>();
  for (const change of changes) {
    const mapping = KIND_FOR_TABLE[change.tableName];
    if (!mapping) {
      logger.warn(
        { table: change.tableName },
        "A change was logged for a table the recorder does not know. Add it to KIND_FOR_TABLE.",
      );
      continue;
    }
    const key = mapping.parentKey
      ? String(change.rowData[mapping.parentKey] ?? "")
      : change.rowKey;
    if (!key) continue;

    const id = `${mapping.kind}:${key}`;
    const entry = touched.get(id) ?? { kind: mapping.kind, key, removed: null };
    if (!mapping.parentKey) entry.removed = change.op === "DELETE" ? change.rowData : null;
    touched.set(id, entry);
  }

  for (const entry of touched.values()) {
    const ops = KIND_OPS[entry.kind];
    const live = await ops.load(db, entry.key);
    if (live) {
      await writeEntry(entry.kind, entry.key, live);
      continue;
    }
    // Gone. The label comes from the deleted row when the trigger saw it go,
    // otherwise from the file this tombstone replaces.
    const label = entry.removed
      ? ops.labelOf(entry.removed)
      : ((await readEntry(entry.kind, entry.key))?.label ?? entry.key);
    await writeEntry(entry.kind, entry.key, { kind: entry.kind, label, deleted: true });
  }

  await db.delete(rowChanges).where(lte(rowChanges.id, last.id));
  return touched.size;
}

import { db } from "../client.ts";
import {
  KIND_OPS,
  RECORDED_KINDS,
  isTombstone,
  readEntries,
  type RecordedFile,
  type RecordedKind,
} from "./entries.ts";

/**
 * Put the recorded entries into this database.
 *
 * Run by the seed after its own fixtures, and by the API as it starts, so a
 * machine that has just pulled is brought up to date before it serves a
 * request. Live entries first, in dependency order, so a flight lands after
 * the schedule and the airframe it names; tombstones last, in reverse, so a
 * schedule is removed after its occurrences.
 *
 * One transaction. A file that cannot be replayed -- a merge conflict left
 * unresolved, a row naming an airframe that no longer exists -- stops the
 * whole replay and is named in the error, rather than leaving the database
 * half-way between two machines.
 */

export interface ReplaySummary {
  files: number;
  applied: number;
  removed: number;
}

export async function applyRecordedEntries(): Promise<ReplaySummary> {
  const byKind = new Map<RecordedKind, RecordedFile[]>();
  for (const kind of RECORDED_KINDS) {
    byKind.set(kind, await readEntries(kind));
  }

  let applied = 0;
  let removed = 0;

  await db.transaction(async (tx) => {
    for (const kind of RECORDED_KINDS) {
      for (const file of byKind.get(kind) ?? []) {
        const { entry } = file;
        if (isTombstone(entry)) continue;
        await attempt(file.path, () => KIND_OPS[kind].upsert(tx, entry));
        applied += 1;
      }
    }

    for (const kind of [...RECORDED_KINDS].reverse()) {
      for (const file of byKind.get(kind) ?? []) {
        if (!isTombstone(file.entry)) continue;
        await attempt(file.path, () => KIND_OPS[kind].remove(tx, file.key));
        removed += 1;
      }
    }
  });

  return { files: applied + removed, applied, removed };
}

async function attempt(path: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not replay ${path}: ${reason}`, { cause: error });
  }
}

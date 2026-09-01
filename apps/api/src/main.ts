import { relative } from "node:path";
import { createApp } from "./http/app.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import { closeDatabase } from "./db/client.ts";
import { RECORDED_DIRECTORY } from "./db/recorded/entries.ts";
import { recordPendingChanges, recordingEnabled } from "./db/recorded/record.ts";
import { applyRecordedEntries } from "./db/recorded/replay.ts";

/**
 * Before the first request: the files and the database agree.
 *
 * Leftover change rows first -- a commit whose recording was interrupted has
 * a database ahead of its file, and replaying the file over it would undo the
 * change. Then the files, which after a `git pull` may be ahead of the
 * database. Both are idempotent, and both happen before `listen`, so a
 * request can never race a replay of its own entity.
 */
async function syncRecordedEntries(): Promise<string> {
  if (!recordingEnabled) return "off";
  try {
    const leftover = await recordPendingChanges();
    const replayed = await applyRecordedEntries();
    return (
      `${replayed.files} replayed from ${relative(process.cwd(), RECORDED_DIRECTORY)}` +
      (leftover > 0 ? `, ${leftover} recorded from an interrupted run` : "")
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Recorded entries could not be synchronised. The database may be behind the files; run npm run db:seed once the cause is fixed.",
    );
    return "failed, see above";
  }
}

const recorded = await syncRecordedEntries();

const app = createApp();
const server = app.listen(env.API_PORT, () => {
  logger.info(`Air Soko operations API listening on http://localhost:${env.API_PORT}`);
  logger.info(`  telemetry provider: ${env.TELEMETRY_PROVIDER}`);
  logger.info(`  recorded entries:   ${recorded}`);
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down.`);
  server.close();
  await closeDatabase().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

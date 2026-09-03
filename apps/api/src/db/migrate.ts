import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, db } from "./client.ts";
import { logger } from "../logger.ts";
import { apiPath } from "../paths.ts";

// From the package root, like every other path this API opens. `db:migrate`
// only ever runs under `tsx`, so this one was never wrong -- but the rule is
// worth keeping uniform. See `src/paths.ts`.
const migrationsFolder = apiPath("drizzle");

migrate(db, { migrationsFolder })
  .then(async () => {
    logger.info("Migrations applied.");
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, "Migration failed");
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });

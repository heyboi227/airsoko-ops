import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, db } from "./client.ts";
import { logger } from "../logger.ts";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../../drizzle");

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

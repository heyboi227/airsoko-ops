import { createApp } from "./http/app.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";
import { closeDatabase } from "./db/client.ts";

const app = createApp();
const server = app.listen(env.API_PORT, () => {
  logger.info(`Air Soko operations API listening on http://localhost:${env.API_PORT}`);
  logger.info(`  telemetry provider: ${env.TELEMETRY_PROVIDER}`);
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down.`);
  server.close();
  await closeDatabase().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

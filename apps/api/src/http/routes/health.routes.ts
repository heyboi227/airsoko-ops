import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { env } from "../../env.ts";

export const healthRouter: Router = Router();

/** Liveness: the process is up. Deliberately touches nothing. */
healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

/** Readiness: the process can actually serve, which means the database answers. */
healthRouter.get("/ready", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
    res.json({
      status: "ok",
      database: "reachable",
      telemetryProvider: env.TELEMETRY_PROVIDER,
    });
  } catch (error) {
    res.status(503).json({
      status: "degraded",
      database: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

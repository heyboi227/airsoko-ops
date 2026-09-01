import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "../env.ts";
import { logger } from "../logger.ts";
import { errorHandler } from "./errors.ts";
import { withRecordingPreference } from "../db/recorded/record.ts";
import { authRouter } from "./routes/auth.routes.ts";
import { airportsRouter } from "./routes/airports.routes.ts";
import { amenitiesRouter } from "./routes/amenities.routes.ts";
import { analyticsRouter } from "./routes/analytics.routes.ts";
import { auditRouter } from "./routes/audit.routes.ts";
import { fleetRouter } from "./routes/fleet.routes.ts";
import { flightsRouter } from "./routes/flights.routes.ts";
import { schedulesRouter } from "./routes/schedules.routes.ts";
import { healthRouter } from "./routes/health.routes.ts";
import { liveRouter } from "./routes/live.routes.ts";
import { networkRouter } from "./routes/network.routes.ts";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    }),
  );

  // A request id on every response, echoed in error envelopes, so a user can
  // report "it failed" with something the logs can be searched by.
  app.use((req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const id = typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    res.setHeader("x-request-id", id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => String(res.getHeader("x-request-id")),
      autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
    }),
  );

  app.use(express.json({ limit: "1mb" }));

  // A request can ask not to be recorded as seed data. The acceptance suite
  // sends this on everything it does, so its fixtures never reach the
  // committed entries; nothing else has a reason to. It can only decline --
  // recording that is off stays off.
  app.use((req, _res, next) => {
    withRecordingPreference(req.headers["x-airsoko-recording"] !== "off", () => next());
  });

  app.use("/health", healthRouter);
  app.use("/api/auth", authRouter);
  app.use("/api/airports", airportsRouter);
  app.use("/api/amenities", amenitiesRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/aircraft", fleetRouter);
  app.use("/api/flights", flightsRouter);
  app.use("/api/schedules", schedulesRouter);
  app.use("/api/routes", networkRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/live-operations", liveRouter);

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: `No route matches ${req.method} ${req.path}.`,
      },
    });
  });

  app.use(errorHandler);

  return app;
}

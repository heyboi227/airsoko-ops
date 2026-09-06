import { Router } from "express";
import { eq } from "drizzle-orm";
import { liveQuerySchema, liveSnapshotSchema } from "@airsoko/contracts";
import { addMinutes, unavailableTelemetry } from "@airsoko/domain";
import { db } from "../../db/client.ts";
import { airports } from "../../db/schema/index.ts";
import { loadLiveFlights } from "../../flights/state.ts";
import { createTelemetryProvider } from "../../telemetry/provider.ts";
import { env } from "../../env.ts";
import { requireAuth, requirePermission } from "../auth.ts";

export const liveRouter: Router = Router();
const provider = createTelemetryProvider(env.TELEMETRY_PROVIDER);

liveRouter.get("/", requireAuth, requirePermission("flight:read"), async (req, res) => {
  const query = liveQuerySchema.parse(req.query);
  const now = new Date().toISOString();
  const from = query.from ?? addMinutes(now, -60);
  const to = query.to ?? addMinutes(now, 120);
  const roster = await loadLiveFlights(from, to, now);
  const fixes = await provider.observe(roster.items, now);
  res.setHeader("Cache-Control", "no-store");
  res.json(
    liveSnapshotSchema.parse({
      generatedAt: now,
      window: { from, to },
      provider: provider.description,
      refreshAfterMs: env.TELEMETRY_TICK_MS,
      staleAfterMs: Math.max(10_000, env.TELEMETRY_TICK_MS * 3),
      items: roster.items.map(({ flight, domestic }) => ({
        flight,
        domestic,
        telemetry:
          fixes.get(flight.id) ??
          unavailableTelemetry(now, "No position returned by the provider."),
      })),
      total: roster.items.length,
      truncated: roster.truncated,
    }),
  );
});

/** Airport positions for the map's station layer. */
liveRouter.get(
  "/stations",
  requireAuth,
  requirePermission("airport:read"),
  async (_req, res) => {
    const rows = await db
      .select({
        iataCode: airports.iataCode,
        name: airports.name,
        latitude: airports.latitude,
        longitude: airports.longitude,
        isHub: airports.isHub,
        isFocusCity: airports.isFocusCity,
      })
      .from(airports)
      .where(eq(airports.active, true));
    res.json({ items: rows, total: rows.length });
  },
);

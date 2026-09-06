import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../apps/api/src/db/client.ts";
import { flightInstances } from "../../apps/api/src/db/schema/index.ts";

/** A private, short-lived observation fixture. It must move at any hour the
 * acceptance suite runs, even when the seeded operation has finished for the
 * night. Only this new id is written or removed; no existing flight is retimed.
 * Direct setup does not arm the application's seed-recording trigger.
 */
export async function createLiveFixture() {
  const [source] = await db
    .select()
    .from(flightInstances)
    .where(isNotNull(flightInstances.aircraftId))
    .limit(1);
  if (!source) throw new Error("Seed an assigned flight before running live acceptance tests.");
  const now = Date.now();
  const serviceDate = new Date(now).toISOString().slice(0, 10);
  const existing = await db
    .select({ number: flightInstances.flightNumber })
    .from(flightInstances)
    .where(eq(flightInstances.serviceDate, serviceDate));
  const used = new Set(existing.map((row) => row.number));
  const number = Array.from({ length: 100 }, (_, i) => `SO${9900 + i}`).find(
    (value) => !used.has(value),
  );
  if (!number) throw new Error("No acceptance flight number available.");
  const id = randomUUID();
  await db.insert(flightInstances).values({
    ...source,
    id,
    scheduleId: null,
    flightNumber: number,
    callsign: `ASO${number.slice(2)}`,
    serviceDate,
    status: "airborne",
    phase: "climb",
    scheduledDeparture: new Date(now - 65 * 60_000).toISOString(),
    actualDeparture: new Date(now - 45 * 60_000).toISOString(),
    scheduledArrival: new Date(now + 55 * 60_000).toISOString(),
    estimatedDeparture: null,
    estimatedArrival: new Date(now + 75 * 60_000).toISOString(),
    actualArrival: null,
    delayReason: "air_traffic_control",
    delayNote: "Live acceptance fixture",
    notes: "Temporary Phase 4 acceptance fixture",
    overriddenFields: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  return {
    id,
    number,
    aircraftId: source.aircraftId!,
    async remove() {
      await db
        .delete(flightInstances)
        .where(
          and(
            eq(flightInstances.id, id),
            eq(flightInstances.notes, "Temporary Phase 4 acceptance fixture"),
          ),
        );
    },
  };
}

import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { liveSnapshotSchema, type FlightDetail } from "@airsoko/contracts";
import { db } from "../../apps/api/src/db/client.ts";
import { flightInstances } from "../../apps/api/src/db/schema/index.ts";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";
import { createLiveFixture } from "../support/live.ts";
import { createTelemetryProvider } from "../../apps/api/src/telemetry/provider.ts";

test.describe("Scenario E: live flight records", () => {
  test("returns the same flight, updates positions and never writes an operational status", async ({
    request,
  }) => {
    const fixture = await createLiveFixture();
    try {
      const token = await signIn(request, ACCOUNTS.opsController);
      const headers = auth(token);
      const before = await db
        .select()
        .from(flightInstances)
        .where(eq(flightInstances.id, fixture.id));
      const response = await request.get("/api/live-operations", { headers });
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("no-store");
      const snapshot = liveSnapshotSchema.parse(await response.json());
      const item = snapshot.items.find((row) => row.flight.id === fixture.id)!;
      expect(item).toBeTruthy();
      expect(item.telemetry.quality).toBe("current");
      expect(item.flight.delayed).toBe(true);
      const external = createTelemetryProvider("external");
      expect(external.description).toMatchObject({ simulated: false, available: false });
      const observations = await external.observe(
        [{ flight: item.flight, serviceCeilingFt: 35000 }],
        snapshot.generatedAt,
      );
      expect(observations.get(fixture.id)).toMatchObject({
        quality: "unavailable",
        position: null,
      });
      const detailResponse = await request.get(`/api/flights/${fixture.id}`, { headers });
      const detail = (await detailResponse.json()) as { flight: FlightDetail };
      for (const key of [
        "id",
        "flightNumber",
        "status",
        "phase",
        "aircraft",
        "scheduledDeparture",
        "estimatedDeparture",
        "actualDeparture",
        "estimatedArrival",
        "origin",
        "destination",
        "delayMinutes",
      ] as const) {
        expect(item.flight[key]).toEqual(detail.flight[key]);
      }
      await expect
        .poll(async () => {
          const next = liveSnapshotSchema.parse(
            await (await request.get("/api/live-operations", { headers })).json(),
          );
          return next.items.find((row) => row.flight.id === fixture.id)!.telemetry
            .routeProgress!;
        })
        .toBeGreaterThan(item.telemetry.routeProgress!);
      expect(
        await db.select().from(flightInstances).where(eq(flightInstances.id, fixture.id)),
      ).toEqual(before);
    } finally {
      await fixture.remove();
    }
  });

  test("applies window overlap across midnight and validates both window endpoints", async ({
    request,
  }) => {
    const fixture = await createLiveFixture();
    try {
      const headers = auth(await signIn(request, ACCOUNTS.opsController));
      const from = "2026-10-10T00:00:00.000Z";
      const to = "2026-10-11T00:00:00.000Z";
      await db
        .update(flightInstances)
        .set({
          serviceDate: "2026-10-09",
          scheduledDeparture: "2026-10-09T23:30:00.000Z",
          actualDeparture: null,
          scheduledArrival: "2026-10-10T01:30:00.000Z",
          estimatedArrival: null,
        })
        .where(eq(flightInstances.id, fixture.id));
      const response = await request.get("/api/live-operations", {
        headers,
        params: { from, to },
      });
      const snapshot = liveSnapshotSchema.parse(await response.json());
      expect(snapshot.items.some((row) => row.flight.id === fixture.id)).toBe(true);
      for (const params of [
        { from },
        { from: to, to: from },
        { from, to: "2026-11-10T00:00:00.000Z" },
        { from: "invalid", to },
      ]) {
        expect((await request.get("/api/live-operations", { headers, params })).status()).toBe(
          400,
        );
      }
    } finally {
      await fixture.remove();
    }
  });

  test("authenticates every frame and permits the shared read to booking staff", async ({
    request,
  }) => {
    expect((await request.get("/api/live-operations")).status()).toBe(401);
    expect((await request.get("/api/live-operations/stations")).status()).toBe(401);
    const headers = auth(await signIn(request, ACCOUNTS.bookingAdmin));
    expect((await request.get("/api/live-operations", { headers })).status()).toBe(200);
    expect((await request.post("/api/live-operations", { headers, data: {} })).status()).toBe(
      404,
    );
  });
});

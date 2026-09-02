import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * Recorded entries: what an operator makes through the application is seed
 * data too, so a second machine can replay it. Decision 32.
 *
 * The suite as a whole declines to be recorded -- `extraHTTPHeaders` in the
 * Playwright config -- because nothing it creates belongs in the committed
 * data. These tests opt back in one request at a time, and remove every file
 * they cause before they finish. The API writes the files on this machine, so
 * the tests read them from disk; against a remote API they skip.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RECORDED = resolve(REPO_ROOT, "apps/api/src/db/seed/recorded");
const RECORD = { "x-airsoko-recording": "on" } as const;

/** A number the seeded network does not use. The schedules spec holds 970. */
const FLIGHT_NUMBER = "SO971";
const SUITE_FLIGHT_NUMBERS = new Set(["SO970", FLIGHT_NUMBER]);
const SERVICE_DATE = "2027-05-04";
const REGISTRATION = "YU-SNC";

interface Entry {
  kind: string;
  label: string;
  deleted?: boolean;
  row?: Record<string, unknown>;
  seats?: unknown[];
  statusEvents?: unknown[];
}

/** A dated flight as the API reports it, in the fields these tests read. */
interface Occurrence {
  id: string;
  flightNumber: string;
  scheduleId: string | null;
  origin: { gate: string | null };
  overriddenFields: string[];
}

function entryPath(kind: string, key: string): string {
  return resolve(RECORDED, kind, `${key}.json`);
}

function readEntry(path: string): Entry {
  return JSON.parse(readFileSync(path, "utf8")) as Entry;
}

/**
 * Preview, then apply acknowledging whatever the preview asked for.
 *
 * What these tests claim is that the entry was recorded, not that a flight
 * filed on a Tuesday in 2027 raises no warning; a warning the rules do raise
 * is accepted by its code, exactly as an operator would.
 */
async function mutate(
  request: APIRequestContext,
  method: "POST" | "DELETE",
  path: string,
  token: string,
  data: Record<string, unknown>,
  record: boolean,
): Promise<Record<string, unknown>> {
  const headers = { ...auth(token), ...(record ? RECORD : {}) };

  const preview = await request.fetch(path, {
    method,
    headers,
    data: { ...data, mutation: { preview: true } },
  });
  const previewText = await preview.text();
  expect(preview.status(), `preview ${method} ${path}: ${previewText}`).toBe(200);
  const { requiresAcknowledgement } = JSON.parse(previewText) as {
    requiresAcknowledgement: string[];
  };

  const response = await request.fetch(path, {
    method,
    headers,
    data: { ...data, mutation: { acknowledgedWarnings: requiresAcknowledgement } },
  });
  const text = await response.text();
  expect(response.ok(), `${method} ${path} -> ${response.status()} ${text}`).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

/** A route and a pair of local times taken from a sector flying today. */
async function sectorFromToday(request: APIRequestContext, token: string) {
  const response = await request.get("/api/flights", {
    headers: auth(token),
    params: { originIata: "BEG", limit: "20" },
  });
  const body = (await response.json()) as {
    items: {
      routeId: string;
      serviceDate: string;
      origin: { localTime: string };
      destination: { localTime: string; localDate: string };
    }[];
  };
  const sector = body.items.find((item) => item.destination.localDate === item.serviceDate);
  if (!sector) throw new Error("No same-day BEG departure to copy a route from.");
  return {
    routeId: sector.routeId,
    departureLocalTime: sector.origin.localTime,
    arrivalLocalTime: sector.destination.localTime,
  };
}

async function createFlight(
  request: APIRequestContext,
  token: string,
  record: boolean,
): Promise<string> {
  const sector = await sectorFromToday(request, token);
  const body = await mutate(
    request,
    "POST",
    "/api/flights",
    token,
    { flightNumber: FLIGHT_NUMBER, serviceDate: SERVICE_DATE, ...sector },
    record,
  );
  return (body.flight as { id: string }).id;
}

async function removeFlight(
  request: APIRequestContext,
  token: string,
  id: string,
  record: boolean,
): Promise<void> {
  await mutate(request, "DELETE", `/api/flights/${id}`, token, {}, record);
}

/** Best effort, for `finally` blocks: the flight may already be gone. */
async function discardFlight(request: APIRequestContext, token: string, id: string) {
  await request.delete(`/api/flights/${id}`, { headers: auth(token), data: {} });
}

async function occurrence(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<Occurrence> {
  const response = await request.get(`/api/flights/${id}`, { headers: auth(token) });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { flight: Occurrence }).flight;
}

/**
 * Occurrences the seed generated, on a day far enough ahead that nothing on
 * it has operated, and that nobody has edited yet.
 *
 * The API does not say which rows the seed made. A generated occurrence has a
 * pattern behind it, and the only patterns the suite adds use numbers the
 * seeded network does not, so those are excluded by name.
 */
async function untouchedOccurrences(
  request: APIRequestContext,
  token: string,
  count: number,
): Promise<Occurrence[]> {
  const today = await request.get("/api/flights", {
    headers: auth(token),
    params: { limit: "1" },
  });
  const { generatedAt } = (await today.json()) as { generatedAt: string };
  const day = new Date(generatedAt);
  day.setUTCDate(day.getUTCDate() + 2);
  const date = day.toISOString().slice(0, 10);

  const response = await request.get("/api/flights", {
    headers: auth(token),
    params: { from: date, to: date, status: "scheduled", limit: "100" },
  });
  const { items } = (await response.json()) as { items: Occurrence[] };
  const candidates = items.filter(
    (item) =>
      item.scheduleId !== null &&
      item.overriddenFields.length === 0 &&
      !SUITE_FLIGHT_NUMBERS.has(item.flightNumber),
  );
  if (candidates.length < count) {
    throw new Error(`Fewer than ${count} untouched seeded occurrences on ${date}.`);
  }
  return candidates.slice(0, count);
}

/** What the schedules page reports for the pattern behind an occurrence. */
async function exceptionCount(
  request: APIRequestContext,
  token: string,
  flight: Occurrence,
): Promise<number> {
  const response = await request.get("/api/schedules", {
    headers: auth(token),
    params: { search: flight.flightNumber },
  });
  const { items } = (await response.json()) as {
    items: { id: string; exceptionCount: number }[];
  };
  const pattern = items.find((item) => item.id === flight.scheduleId);
  if (!pattern)
    throw new Error(`No pattern ${flight.scheduleId} behind ${flight.flightNumber}.`);
  return pattern.exceptionCount;
}

test.describe("recorded entries", () => {
  test.skip(
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API_URL),
    "reads the files the API writes, so the API has to be on this machine",
  );

  test("an entry is recorded when made, re-recorded when changed, and left as a tombstone when removed", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const id = await createFlight(request, token, true);
    const file = entryPath("flights", id);

    try {
      expect(existsSync(file), `${file} should exist`).toBe(true);
      const created = readEntry(file);
      expect(created.kind).toBe("flight");
      expect(created.deleted).toBeUndefined();
      expect(created.label).toContain(FLIGHT_NUMBER);
      expect(created.row?.id).toBe(id);
      expect(created.row?.flightNumber).toBe(FLIGHT_NUMBER);
      expect(created.row?.serviceDate).toBe(SERVICE_DATE);
      // The row is the schema's own shape: an instant is ISO 8601 in UTC, not
      // whatever the trigger's snapshot happened to render.
      expect(created.row?.scheduledDeparture).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(created.statusEvents).toEqual([]);

      // A change is recorded as the state after it, not as the change.
      await mutate(
        request,
        "POST",
        `/api/flights/${id}/gate`,
        token,
        { departureGate: "C7" },
        true,
      );
      expect(readEntry(file).row?.departureGate).toBe("C7");

      // A removal has to survive a reseed, so it is a file too.
      await removeFlight(request, token, id, true);
      const tombstone = readEntry(file);
      expect(tombstone.deleted).toBe(true);
      expect(tombstone.kind).toBe("flight");
      expect(tombstone.label).toContain(FLIGHT_NUMBER);
      expect(tombstone.row).toBeUndefined();
    } finally {
      rmSync(file, { force: true });
      await discardFlight(request, token, id);
    }
  });

  test("a request that declines is not recorded -- which is how this suite stays out of the data", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const id = await createFlight(request, token, false);
    const file = entryPath("flights", id);

    try {
      expect(existsSync(file), `${file} should not have been written`).toBe(false);
      await removeFlight(request, token, id, false);
      expect(existsSync(file), "nor a tombstone").toBe(false);
    } finally {
      rmSync(file, { force: true });
      await discardFlight(request, token, id);
    }
  });

  test("an airframe is recorded with each cabin and its seats", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.fleetManager);

    const types = await request.get("/api/aircraft/types/list", { headers: auth(token) });
    const { items } = (await types.json()) as { items: { id: string; icaoTypeCode: string }[] };
    const type = items.find((item) => item.icaoTypeCode === "A320");
    expect(type, "A320 is not a seeded type").toBeDefined();
    if (!type) return;

    const body = await mutate(
      request,
      "POST",
      "/api/aircraft",
      token,
      {
        registration: REGISTRATION,
        serialNumber: "SNC-0001",
        name: "Zapisnik",
        aircraftTypeId: type.id,
        deliveredOn: "2020-02-20",
        cabins: [
          { cabinClass: "business", firstRow: 1, lastRow: 3, layout: "AC-DF", pitchInches: 38 },
          {
            cabinClass: "economy",
            firstRow: 4,
            lastRow: 37,
            layout: "ABC-DEF",
            pitchInches: 30,
          },
        ],
      },
      true,
    );
    const id = (body.aircraft as { id: string }).id;
    const tailFile = entryPath("aircraft", id);
    const cabinFiles: string[] = [];

    try {
      expect(existsSync(tailFile), `${tailFile} should exist`).toBe(true);
      const tail = readEntry(tailFile);
      expect(tail.kind).toBe("aircraft");
      expect(tail.row?.registration).toBe(REGISTRATION);
      expect(tail.label).toContain(REGISTRATION);

      // Cabins are entries of their own, each carrying its seats: the seat
      // rows are the layout, and capacity is summed from exactly them.
      const cabinDirectory = resolve(RECORDED, "aircraft-cabins");
      for (const name of readdirSync(cabinDirectory)) {
        const path = resolve(cabinDirectory, name);
        const entry = readEntry(path);
        if (entry.row?.aircraftId === id) cabinFiles.push(path);
      }
      expect(cabinFiles).toHaveLength(2);

      const seatTotal = cabinFiles.reduce((total, path) => {
        const cabin = readEntry(path);
        expect(cabin.kind).toBe("aircraft_cabin");
        expect(cabin.label).toContain(REGISTRATION);
        expect(cabin.seats).toHaveLength(cabin.row?.seatCount as number);
        return total + (cabin.seats?.length ?? 0);
      }, 0);
      expect(seatTotal).toBe((body.aircraft as { seatCapacity: number }).seatCapacity);
    } finally {
      rmSync(tailFile, { force: true });
      for (const path of cabinFiles) rmSync(path, { force: true });
      // Retired, not recorded: the registration is free again for the next run.
      await mutate(request, "POST", `/api/aircraft/${id}/retire`, token, {}, false);
    }
  });

  test("npm run db:seed replays a recorded entry, and honours a tombstone", async ({
    request,
  }) => {
    // Two seeds of the whole database.
    test.setTimeout(300_000);

    const token = await signIn(request, ACCOUNTS.opsController);
    const id = await createFlight(request, token, true);
    const file = entryPath("flights", id);

    try {
      // Lose the row but keep the file: what the second machine looks like
      // after a pull.
      await removeFlight(request, token, id, false);
      const gone = await request.get(`/api/flights/${id}`, { headers: auth(token) });
      expect(gone.status()).toBe(404);

      reseed();

      const restored = await request.get(`/api/flights/${id}`, { headers: auth(token) });
      expect(restored.status(), await restored.text()).toBe(200);
      const { flight } = (await restored.json()) as {
        flight: { flightNumber: string; serviceDate: string; status: string };
      };
      expect(flight.flightNumber).toBe(FLIGHT_NUMBER);
      expect(flight.serviceDate).toBe(SERVICE_DATE);
      expect(flight.status).toBe("scheduled");

      // Now the removal travels the same way.
      await removeFlight(request, token, id, true);
      expect(readEntry(file).deleted).toBe(true);

      reseed();

      const stillGone = await request.get(`/api/flights/${id}`, { headers: auth(token) });
      expect(stillGone.status()).toBe(404);
    } finally {
      rmSync(file, { force: true });
      await discardFlight(request, token, id);
    }
  });

  test("npm run db:seed puts a hand-edited occurrence back on its pattern, marker included, and keeps a recorded one", async ({
    request,
  }) => {
    // Two seeds of the whole database.
    test.setTimeout(300_000);

    const token = await signIn(request, ACCOUNTS.opsController);
    const [unrecorded, recorded] = await untouchedOccurrences(request, token, 2);
    if (!unrecorded || !recorded) throw new Error("Two occurrences were asked for.");
    const file = entryPath("flights", recorded.id);

    try {
      // One edit the suite's way, which nobody asked to keep, and one an
      // operator made for real. Both are exceptions until the seed runs.
      const gate = { departureGate: "Z97" };
      await mutate(request, "POST", `/api/flights/${unrecorded.id}/gate`, token, gate, false);
      await mutate(request, "POST", `/api/flights/${recorded.id}/gate`, token, gate, true);
      expect((await occurrence(request, token, unrecorded.id)).overriddenFields).toContain(
        "departureGate",
      );
      expect(readEntry(file).row?.overriddenFields).toContain("departureGate");

      reseed();

      // The fixture is back, and so is the marker. A reseed used to restore
      // the gate and leave the flag, so the schedules page counted an
      // exception that no longer differed from its pattern, and a series edit
      // skipped it.
      const restored = await occurrence(request, token, unrecorded.id);
      expect(restored.origin.gate).toBe(unrecorded.origin.gate);
      expect(restored.overriddenFields).toEqual([]);
      expect(await exceptionCount(request, token, unrecorded)).toBe(0);

      // The recorded edit landed after the fixtures, exception and all.
      const kept = await occurrence(request, token, recorded.id);
      expect(kept.origin.gate).toBe("Z97");
      expect(kept.overriddenFields).toContain("departureGate");
      expect(await exceptionCount(request, token, recorded)).toBe(1);
    } finally {
      rmSync(file, { force: true });
      // Without its file the recorded edit is a hand edit like any other, and
      // the next seed puts that flight back too.
      reseed();
    }
  });
});

function reseed(): void {
  execSync("npm run db:seed", { cwd: REPO_ROOT, stdio: "pipe", timeout: 120_000 });
}

import { expect, test, type APIRequestContext } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * Recurring schedules, and Scenario C.
 *
 * These tests build their own weekly service rather than editing a seeded one.
 * Scenario C is about what an edit reaches, and asserting that against a
 * pattern with a hundred and eighty occurrences would be measuring the seed;
 * a four-week service the test authored is a claim about the rule.
 *
 * The pattern and its flights are cleared before and after every test, so the
 * suite can be re-run against one database.
 */

interface Preview {
  applicable: boolean;
  requiresAcknowledgement: string[];
  findings: { code: string; severity: string; title: string; detail: string }[];
  consequences: { kind: string; summary: string; count?: number }[];
}

interface Occurrence {
  flightId: string;
  flightNumber: string;
  serviceDate: string;
  status: string;
  scheduledDeparture: string;
  overriddenFields: string[];
}

interface ScheduleRow {
  id: string;
  flightNumber: string;
  validFrom: string;
  validTo: string;
  operatingDays: boolean[];
  departureLocalTime: string;
  arrivalLocalTime: string;
  blockMinutes: number;
  occurrenceCount: number;
  exceptionCount: number;
  nextOccurrenceAt: string | null;
  active: boolean;
}

/**
 * A flight number nothing else uses.
 *
 * The seeded network numbers in the 100s to 400s; 9xx is free, and the
 * per-test cleanup below puts it back.
 */
const TEST_FLIGHT_NUMBER = "SO970";

/**
 * Four Tuesdays, chosen far enough out that none of them has operated.
 *
 * The block time is a realistic 95 minutes for BEG-MXP. A tighter one is not
 * wrong so much as noisy: the rules would warn about the implied cruise speed
 * on every call, and these tests are about edit scope, not about that.
 */
const VALID_FROM = "2027-03-02";
const VALID_TO = "2027-03-23";
const TUESDAYS = ["2027-03-02", "2027-03-09", "2027-03-16", "2027-03-23"];
const TUESDAY_ONLY = [false, false, true, false, false, false, false];

async function routeId(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.get("/api/flights", {
    headers: auth(token),
    params: { originIata: "BEG", limit: "1" },
  });
  const body = (await response.json()) as { items: { routeId: string }[] };
  const flight = body.items[0];
  if (!flight) throw new Error("No BEG departure today to take a route from.");
  return flight.routeId;
}

async function aircraftTypeId(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.get("/api/aircraft/types/list", { headers: auth(token) });
  const body = (await response.json()) as { items: { id: string; icaoTypeCode: string }[] };
  const type = body.items.find((item) => item.icaoTypeCode === "A319") ?? body.items[0];
  if (!type) throw new Error("No aircraft types on file.");
  return type.id;
}

async function occurrencesOf(
  request: APIRequestContext,
  token: string,
  scheduleId: string,
): Promise<Occurrence[]> {
  const response = await request.get(`/api/schedules/${scheduleId}`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { occurrences: Occurrence[] };
  return [...body.occurrences].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));
}

async function createSeries(
  request: APIRequestContext,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await request.post("/api/schedules", {
    headers: auth(token),
    data: {
      flightNumber: TEST_FLIGHT_NUMBER,
      routeId: await routeId(request, token),
      validFrom: VALID_FROM,
      validTo: VALID_TO,
      operatingDays: TUESDAY_ONLY,
      departureLocalTime: "09:00",
      arrivalLocalTime: "10:35",
      aircraftTypeId: await aircraftTypeId(request, token),
      generateOccurrences: true,
      ...overrides,
      mutation: { preview: false, reason: "Scenario C fixture" },
    },
  });

  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as {
    schedule: { id: string; occurrencesFiled: number };
  };
  expect(body.schedule.occurrencesFiled).toBe(TUESDAYS.length);
  return body.schedule.id;
}

/**
 * Remove every pattern under the test flight number, and the flights each
 * produced.
 *
 * Written to clear *all* of them rather than one id, because the interesting
 * test splits a pattern in two and a failure part-way through would otherwise
 * leave the successor behind -- which is how this file first went red on its
 * second run. Run before and after each test, so the suite is idempotent
 * whatever state the last one left.
 */
async function removeTestSeries(request: APIRequestContext, token: string) {
  const response = await request.get("/api/schedules", {
    headers: auth(token),
    params: { search: TEST_FLIGHT_NUMBER, includeInactive: "true" },
  });
  const body = (await response.json()) as { items: ScheduleRow[] };

  for (const pattern of body.items) {
    const deleted = await request.delete(`/api/schedules/${pattern.id}`, {
      headers: auth(token),
      data: {
        preview: false,
        acknowledgedWarnings: ["SCHEDULE_HAS_OCCURRENCES"],
        reason: "Scenario C fixture teardown",
      },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);
  }
}

test.beforeEach(async ({ request }) => {
  await removeTestSeries(request, await signIn(request, ACCOUNTS.opsController));
});

test.afterEach(async ({ request }) => {
  await removeTestSeries(request, await signIn(request, ACCOUNTS.opsController));
});

test.describe("recurring schedules", () => {
  test("a pattern generates one dated flight per operating day", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const scheduleId = await createSeries(request, token);

    {
      const occurrences = await occurrencesOf(request, token, scheduleId);
      expect(occurrences.map((item) => item.serviceDate)).toEqual(TUESDAYS);
      // Every occurrence follows the pattern until somebody changes one.
      expect(occurrences.every((item) => item.overriddenFields.length === 0)).toBe(true);

      const list = await request.get("/api/schedules", {
        headers: auth(token),
        params: { search: TEST_FLIGHT_NUMBER },
      });
      const body = (await list.json()) as { items: ScheduleRow[] };
      const pattern = body.items.find((item) => item.id === scheduleId);
      expect(pattern?.occurrenceCount).toBe(4);
      expect(pattern?.exceptionCount).toBe(0);
      // Block time is derived from the two local times and their zones.
      expect(pattern?.blockMinutes).toBe(95);
      expect(pattern?.nextOccurrenceAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

  test("refuses a pattern that cannot be operated, before anything is written", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const route = await routeId(request, token);
    const type = await aircraftTypeId(request, token);

    const cases: [string, Record<string, unknown>, string][] = [
      [
        "a season that ends before it starts",
        { validFrom: VALID_TO, validTo: VALID_FROM },
        "SCHEDULE_VALIDITY_INVERTED",
      ],
      [
        "no operating days",
        { operatingDays: [false, false, false, false, false, false, false] },
        "SCHEDULE_NO_OPERATING_DAYS",
      ],
      [
        "a block time nothing could fly",
        { arrivalLocalTime: "09:05" },
        "SCHEDULE_DURATION_IMPLAUSIBLE",
      ],
    ];

    for (const [label, overrides, code] of cases) {
      const response = await request.post("/api/schedules", {
        headers: auth(token),
        data: {
          flightNumber: TEST_FLIGHT_NUMBER,
          routeId: route,
          validFrom: VALID_FROM,
          validTo: VALID_TO,
          operatingDays: TUESDAY_ONLY,
          departureLocalTime: "09:00",
          arrivalLocalTime: "10:35",
          aircraftTypeId: type,
          ...overrides,
          mutation: { preview: false },
        },
      });

      expect(response.status(), label).toBe(422);
      const body = (await response.json()) as { error: { findings: Preview["findings"] } };
      expect(
        body.error.findings.map((f) => f.code),
        label,
      ).toContain(code);
    }

    // Nothing was persisted by any of the three refusals.
    const list = await request.get("/api/schedules", {
      headers: auth(token),
      params: { search: TEST_FLIGHT_NUMBER, includeInactive: "true" },
    });
    expect(((await list.json()) as { items: ScheduleRow[] }).items).toHaveLength(0);
  });

  test("refuses a second pattern that would collide on the same dates", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    await createSeries(request, token);

    {
      const response = await request.post("/api/schedules", {
        headers: auth(token),
        data: {
          flightNumber: TEST_FLIGHT_NUMBER,
          routeId: await routeId(request, token),
          validFrom: VALID_FROM,
          validTo: VALID_TO,
          operatingDays: TUESDAY_ONLY,
          departureLocalTime: "14:00",
          arrivalLocalTime: "15:35",
          aircraftTypeId: await aircraftTypeId(request, token),
          mutation: { preview: true },
        },
      });

      const preview = (await response.json()) as Preview;
      expect(preview.applicable).toBe(false);
      expect(preview.findings.map((f) => f.code)).toContain("SCHEDULE_FLIGHT_NUMBER_IN_USE");
    }
  });
});

// --- Scenario C -------------------------------------------------------------

test.describe("Scenario C: recurring schedule exception", () => {
  test("editing one occurrence leaves the rest of the series alone", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const scheduleId = await createSeries(request, token);

    {
      const before = await occurrencesOf(request, token, scheduleId);
      const second = before[1];
      if (!second) throw new Error("The fixture produced fewer than two occurrences.");

      const response = await request.patch(`/api/flights/${second.flightId}`, {
        headers: auth(token),
        data: {
          departureLocalTime: "11:30",
          arrivalLocalTime: "13:05",
          scope: "occurrence",
          mutation: { preview: false, reason: "Scenario C" },
        },
      });
      expect(response.status(), await response.text()).toBe(200);

      const after = await occurrencesOf(request, token, scheduleId);

      // The one edited moved.
      expect(after[1]?.scheduledDeparture).not.toBe(second.scheduledDeparture);
      // And is now an exception, recorded by field rather than as a flag.
      expect(after[1]?.overriddenFields).toEqual(
        expect.arrayContaining(["scheduledDeparture", "scheduledArrival"]),
      );

      // The other three did not.
      for (const index of [0, 2, 3]) {
        expect(after[index]?.scheduledDeparture, `occurrence ${index}`).toBe(
          before[index]?.scheduledDeparture,
        );
        expect(after[index]?.overriddenFields, `occurrence ${index}`).toEqual([]);
      }

      // Nor did the pattern itself.
      const list = await request.get("/api/schedules", {
        headers: auth(token),
        params: { search: TEST_FLIGHT_NUMBER },
      });
      const pattern = ((await list.json()) as { items: ScheduleRow[] }).items.find(
        (item) => item.id === scheduleId,
      );
      expect(pattern?.departureLocalTime).toBe("09:00");
      expect(pattern?.exceptionCount).toBe(1);
    }
  });

  test("a broader scope changes this and future occurrences only", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const scheduleId = await createSeries(request, token);

    {
      const before = await occurrencesOf(request, token, scheduleId);
      const third = before[2];
      if (!third) throw new Error("The fixture produced fewer than three occurrences.");

      const preview = (await (
        await request.patch(`/api/flights/${third.flightId}`, {
          headers: auth(token),
          data: {
            departureLocalTime: "16:00",
            arrivalLocalTime: "17:35",
            scope: "this_and_future",
            mutation: { preview: true },
          },
        })
      ).json()) as Preview;

      // The preview states the reach before anything happens.
      const affected = preview.consequences.filter((c) => c.kind === "occurrences_affected");
      expect(
        affected.some((c) => c.count === 2 && /follow the new pattern/.test(c.summary)),
      ).toBe(true);
      expect(affected.some((c) => c.count === 2 && /outside this edit/.test(c.summary))).toBe(
        true,
      );

      const applied = await request.patch(`/api/flights/${third.flightId}`, {
        headers: auth(token),
        data: {
          departureLocalTime: "16:00",
          arrivalLocalTime: "17:35",
          scope: "this_and_future",
          mutation: { preview: false, reason: "Scenario C" },
        },
      });
      expect(applied.status(), await applied.text()).toBe(200);
      const result = (await applied.json()) as {
        flight: { occurrencesChanged: number; scheduleId: string };
      };
      expect(result.flight.occurrencesChanged).toBe(2);

      // The season is split rather than rewritten: the flights already produced
      // by the old timetable came from a pattern that really did say 09:00.
      const patterns = (await (
        await request.get("/api/schedules", {
          headers: auth(token),
          params: { search: TEST_FLIGHT_NUMBER, includeInactive: "true" },
        })
      ).json()) as { items: ScheduleRow[] };

      expect(patterns.items).toHaveLength(2);
      const original = patterns.items.find((item) => item.id === scheduleId);
      const successor = patterns.items.find((item) => item.id !== scheduleId);

      expect(original?.departureLocalTime).toBe("09:00");
      // The old season ends the day before the split, not on its last flight:
      // a validity window is a range of dates, not a list of occurrences.
      expect(original?.validTo).toBe("2027-03-15");
      expect(successor?.departureLocalTime).toBe("16:00");
      expect(successor?.validFrom).toBe(TUESDAYS[2]);
      expect(successor?.validTo).toBe(VALID_TO);

      // Occurrences one and two are untouched; three and four moved.
      const first = await occurrencesOf(request, token, scheduleId);
      expect(first.map((item) => item.serviceDate)).toEqual(TUESDAYS.slice(0, 2));
      expect(first[0]?.scheduledDeparture).toBe(before[0]?.scheduledDeparture);
      expect(first[1]?.scheduledDeparture).toBe(before[1]?.scheduledDeparture);

      const moved = await occurrencesOf(request, token, result.flight.scheduleId);
      expect(moved.map((item) => item.serviceDate)).toEqual(TUESDAYS.slice(2));
      for (const occurrence of moved) {
        expect(occurrence.scheduledDeparture).not.toBe(
          before.find((item) => item.serviceDate === occurrence.serviceDate)
            ?.scheduledDeparture,
        );
      }
    }
  });

  test("a series edit leaves a hand-edited occurrence exactly as it is", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const scheduleId = await createSeries(request, token);

    {
      const before = await occurrencesOf(request, token, scheduleId);
      const exception = before[1];
      if (!exception) throw new Error("The fixture produced fewer than two occurrences.");

      // Make one an exception.
      await request.patch(`/api/flights/${exception.flightId}`, {
        headers: auth(token),
        data: {
          departureLocalTime: "11:30",
          arrivalLocalTime: "13:05",
          scope: "occurrence",
          mutation: { preview: false },
        },
      });
      const edited = (await occurrencesOf(request, token, scheduleId))[1];

      // Now move the whole pattern.
      const preview = (await (
        await request.patch(`/api/schedules/${scheduleId}`, {
          headers: auth(token),
          data: {
            departureLocalTime: "07:15",
            arrivalLocalTime: "08:50",
            mutation: { preview: true },
          },
        })
      ).json()) as Preview;

      const diverged = preview.findings.find((f) => f.code === "FLIGHT_OCCURRENCE_DIVERGED");
      expect(diverged?.severity).toBe("warning");
      expect(diverged?.title).toContain("keep their own values");
      expect(diverged?.detail).toContain(TUESDAYS[1] as string);

      const applied = await request.patch(`/api/schedules/${scheduleId}`, {
        headers: auth(token),
        data: {
          departureLocalTime: "07:15",
          arrivalLocalTime: "08:50",
          mutation: {
            preview: false,
            acknowledgedWarnings: ["FLIGHT_OCCURRENCE_DIVERGED"],
            reason: "Scenario C",
          },
        },
      });
      expect(applied.status(), await applied.text()).toBe(200);

      const after = await occurrencesOf(request, token, scheduleId);
      // Three follow the pattern...
      for (const index of [0, 2, 3]) {
        expect(after[index]?.scheduledDeparture, `occurrence ${index}`).not.toBe(
          before[index]?.scheduledDeparture,
        );
      }
      // ...and the exception is byte-identical to what it was.
      expect(after[1]?.scheduledDeparture).toBe(edited?.scheduledDeparture);
    }
  });

  test("overwriting the exception is possible, but has to be asked for", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.opsController);
    const scheduleId = await createSeries(request, token);

    {
      const before = await occurrencesOf(request, token, scheduleId);
      const exception = before[1];
      if (!exception) throw new Error("The fixture produced fewer than two occurrences.");

      await request.patch(`/api/flights/${exception.flightId}`, {
        headers: auth(token),
        data: {
          departureLocalTime: "11:30",
          arrivalLocalTime: "13:05",
          scope: "occurrence",
          mutation: { preview: false },
        },
      });

      const applied = await request.patch(`/api/schedules/${scheduleId}`, {
        headers: auth(token),
        data: {
          departureLocalTime: "07:15",
          arrivalLocalTime: "08:50",
          overwriteExceptions: true,
          mutation: {
            preview: false,
            acknowledgedWarnings: ["FLIGHT_OCCURRENCE_DIVERGED"],
            reason: "Scenario C",
          },
        },
      });
      expect(applied.status(), await applied.text()).toBe(200);

      const after = await occurrencesOf(request, token, scheduleId);
      // All four now sit at 07:15 local, the exception included.
      const times = new Set(after.map((item) => item.scheduledDeparture.slice(11, 16)));
      expect(times.size).toBe(1);
    }
  });

  test("occurrences that have already operated are never rewritten", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.opsController);

    // A seeded pattern whose window straddles today: the past is history.
    const list = (await (
      await request.get("/api/schedules", { headers: auth(token), params: { limit: "50" } })
    ).json()) as { items: ScheduleRow[] };

    const pattern = list.items.find((item) => item.occurrenceCount > 4);
    if (!pattern) throw new Error("No seeded pattern with enough occurrences.");

    // History is anything that has pushed back or reached a terminal state --
    // arrived, cancelled and everything between. A plan change does not rewrite
    // any of it.
    const HISTORICAL = new Set([
      "taxi_out",
      "airborne",
      "taxi_in",
      "arrived",
      "diverted",
      "cancelled",
    ]);
    const before = await occurrencesOf(request, token, pattern.id);
    const flown = before.filter((item) => HISTORICAL.has(item.status));
    expect(flown.length).toBeGreaterThan(0);

    const preview = (await (
      await request.patch(`/api/schedules/${pattern.id}`, {
        headers: auth(token),
        data: { departureLocalTime: "13:45", mutation: { preview: true } },
      })
    ).json()) as Preview;

    const asFlown = preview.consequences.find((item) => /left as flown/.test(item.summary));
    expect(asFlown?.count).toBe(flown.length);
  });
});

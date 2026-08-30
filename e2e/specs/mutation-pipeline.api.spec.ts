import { expect, test, type APIRequestContext } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * The Phase 0 gate: the mutation pipeline, end to end.
 *
 * Not a scenario from the brief -- the foundation every scenario will stand
 * on. If evaluate / decide / apply / audit works here for something as
 * undramatic as an airport, it works for reassigning an aircraft.
 *
 * Every assertion is idempotent. The one path that writes performs an update
 * that lands the same value it already had, so the suite can be re-run against
 * a seeded database without a reset.
 */

const BEG = { latitude: 44.8184, longitude: 20.3091 };

interface AirportRow {
  id: string;
  iataCode: string;
  name: string;
  city: string;
  countryCode: string;
  icaoCode: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  timeZone: string;
  isHub: boolean;
  isFocusCity: boolean;
}

interface Preview {
  intent: string;
  applicable: boolean;
  requiresAcknowledgement: string[];
  findings: { code: string; severity: string; title: string; detail: string }[];
  consequences: { kind: string; summary: string }[];
}

async function findByIata(
  request: APIRequestContext,
  token: string,
  iata: string,
): Promise<AirportRow> {
  const response = await request.get("/api/airports", {
    headers: auth(token),
    params: { search: iata, pageSize: 5 },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: AirportRow[] };
  const found = body.items.find((item) => item.iataCode === iata);
  if (!found) throw new Error(`${iata} is not in the seeded network.`);
  return found;
}

test.describe("mutation pipeline", () => {
  test("the seed produced a coherent network", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await request.get("/api/airports", {
      headers: auth(token),
      params: { pageSize: 100 },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: AirportRow[]; total: number };

    expect(body.total, "the brief asks for 20 or more destinations").toBeGreaterThanOrEqual(20);

    // Belgrade is the seeded hub. Asserted as present rather than as the only
    // one: an operator may legitimately mark another base through the
    // application, and the seed does not own rows it did not create.
    const hubs = body.items.filter((airport) => airport.isHub);
    expect(hubs.map((hub) => hub.iataCode)).toContain("BEG");

    // Coordinates are the whole reason airports come first. Null Island here
    // would put the live map in the Atlantic.
    for (const airport of body.items) {
      expect(Math.abs(airport.latitude) + Math.abs(airport.longitude)).toBeGreaterThan(0.001);
      // IANA names can carry a third component -- America/Argentina/Buenos_Aires,
      // America/Indiana/Indianapolis -- so this is not a two-segment format.
      expect(airport.timeZone).toMatch(/^([A-Za-z_]+\/)+[A-Za-z_+-]+$|^UTC$/);
    }
  });

  test("a blocking conflict refuses the write and explains itself", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);

    // BEG already holds this code.
    const response = await request.post("/api/airports", {
      headers: auth(token),
      data: {
        iataCode: "BEG",
        icaoCode: "LYXX",
        name: "Duplicate Belgrade",
        city: "Belgrade",
        countryCode: "RS",
        latitude: 45.0,
        longitude: 21.0,
        timeZone: "Europe/Belgrade",
      },
    });

    expect(response.status()).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; findings: Preview["findings"] };
    };
    expect(body.error.code).toBe("RULE_VIOLATION");

    const blocking = body.error.findings.filter((finding) => finding.severity === "blocking");
    expect(blocking.length).toBeGreaterThan(0);
    // The message names the actual conflicting record, not a generic refusal.
    expect(blocking[0]?.detail).toContain("Nikola Tesla");
  });

  test("preview reports without writing", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const tivat = await findByIata(request, token, "TIV");

    const before = await request.get("/api/airports", {
      headers: auth(token),
      params: { pageSize: 100 },
    });
    const countBefore = ((await before.json()) as { total: number }).total;

    const preview = await request.post("/api/airports", {
      headers: auth(token),
      data: {
        iataCode: "QQQ",
        icaoCode: "QQQQ",
        name: "Preview Station",
        city: "Nowhere",
        countryCode: "RS",
        latitude: 45.5,
        longitude: 21.5,
        timeZone: "Europe/Belgrade",
        mutation: { preview: true },
      },
    });

    expect(preview.status()).toBe(200);
    const body = (await preview.json()) as Preview;
    expect(body.intent).toBe("airport.create");
    expect(body.applicable).toBe(true);

    const after = await request.get("/api/airports", {
      headers: auth(token),
      params: { pageSize: 100 },
    });
    const countAfter = ((await after.json()) as { total: number }).total;

    expect(countAfter, "a preview must not create anything").toBe(countBefore);
    expect(tivat.iataCode).toBe("TIV");
  });

  test("a warning must be acknowledged by its own code before it applies", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const tivat = await findByIata(request, token, "TIV");

    // Moving Tivat onto Belgrade's coordinates raises the coincident-position
    // warning: not impossible, but not something to do by accident.
    const onTopOfBelgrade = {
      latitude: BEG.latitude,
      longitude: BEG.longitude,
    };

    const preview = await request.patch(`/api/airports/${tivat.id}`, {
      headers: auth(token),
      data: { ...onTopOfBelgrade, mutation: { preview: true } },
    });

    expect(preview.status()).toBe(200);
    const previewBody = (await preview.json()) as Preview;
    expect(previewBody.applicable, "a warning does not block").toBe(true);
    expect(previewBody.requiresAcknowledgement.length).toBeGreaterThan(0);

    const warnings = previewBody.findings.filter((finding) => finding.severity === "warning");
    expect(warnings[0]?.detail).toContain("BEG");

    // Applying without the acknowledgement is refused.
    const unacknowledged = await request.patch(`/api/airports/${tivat.id}`, {
      headers: auth(token),
      data: { ...onTopOfBelgrade, mutation: { preview: false, acknowledgedWarnings: [] } },
    });

    expect(unacknowledged.status()).toBe(412);
    const refusal = (await unacknowledged.json()) as { error: { code: string } };
    expect(refusal.error.code).toBe("PRECONDITION_FAILED");

    // Tivat is untouched -- a refused write leaves nothing behind.
    const unchanged = await findByIata(request, token, "TIV");
    expect(unchanged.latitude).toBeCloseTo(tivat.latitude, 6);
    expect(unchanged.longitude).toBeCloseTo(tivat.longitude, 6);
  });

  test("an applied change writes an audit entry with before and after", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const tivat = await findByIata(request, token, "TIV");

    // Idempotent: sets the elevation to the value it already holds. Still a
    // real mutation through the pipeline, so it must still be audited.
    const response = await request.patch(`/api/airports/${tivat.id}`, {
      headers: auth(token),
      data: {
        elevationFt: tivat.elevationFt,
        mutation: { preview: false, reason: "Pipeline verification" },
      },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { airport: AirportRow; preview: Preview };
    expect(body.airport.iataCode).toBe("TIV");
    expect(body.preview.intent).toBe("airport.update");

    const audit = await request.get("/api/audit", {
      headers: auth(await signIn(request, ACCOUNTS.superAdmin)),
      params: { resourceId: tivat.id, action: "airport.update", pageSize: 5 },
    });

    expect(audit.status()).toBe(200);
    const entries = (await audit.json()) as {
      items: {
        action: string;
        resourceKind: string;
        resourceLabel: string;
        actorLabel: string;
        previousValue: unknown;
        newValue: unknown;
        reason: string | null;
      }[];
    };

    expect(entries.items.length).toBeGreaterThan(0);
    const latest = entries.items[0];
    expect(latest?.action).toBe("airport.update");
    expect(latest?.resourceKind).toBe("airport");
    expect(latest?.resourceLabel).toBe("TIV");
    expect(latest?.actorLabel).toContain(ACCOUNTS.commercialManager);
    expect(latest?.reason).toBe("Pipeline verification");
    expect(latest?.previousValue, "audit records what it was").not.toBeNull();
    expect(latest?.newValue, "and what it became").not.toBeNull();
  });

  test("audit history is not readable without the permission", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.bookingAdmin);
    const response = await request.get("/api/audit", { headers: auth(token) });
    expect(response.status()).toBe(403);
  });
});

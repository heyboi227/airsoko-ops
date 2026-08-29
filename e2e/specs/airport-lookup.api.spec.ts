import { expect, test } from "@playwright/test";
import { ACCOUNTS, auth, signIn } from "../support/api.ts";

/**
 * Airport reference lookup.
 *
 * The autofill behind the station form. Backed by a committed reference file
 * rather than a remote API, so these assertions are deterministic and run
 * offline -- which is most of the reason it was built that way.
 */

interface Suggestion {
  iataCode: string;
  icaoCode: string;
  name: string;
  city: string;
  countryCode: string;
  countryName: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  timeZone: string;
  alreadyOnFile: boolean;
}

test.describe("airport reference lookup", () => {
  test("an IATA code resolves to the airport, its position and its zone", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await request.get("/api/airports/lookup", {
      headers: auth(token),
      params: { q: "LIS", limit: 5 },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: Suggestion[] };
    const lisbon = body.items[0];

    expect(lisbon?.iataCode).toBe("LIS");
    expect(lisbon?.icaoCode).toBe("LPPT");
    expect(lisbon?.name).toContain("Lisbon");
    expect(lisbon?.countryCode).toBe("PT");
    expect(lisbon?.countryName).toBe("Portugal");
    expect(lisbon?.timeZone).toBe("Europe/Lisbon");
    // The field a human is most likely to get wrong, and the one the map reads.
    expect(lisbon?.latitude).toBeCloseTo(38.78, 1);
    expect(lisbon?.longitude).toBeCloseTo(-9.14, 1);
  });

  test("a city name resolves too, not just a code", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await request.get("/api/airports/lookup", {
      headers: auth(token),
      params: { q: "reykjav", limit: 5 },
    });

    const body = (await response.json()) as { items: Suggestion[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.some((item) => item.countryCode === "IS")).toBe(true);
  });

  test("stations already on file are marked, so the form does not offer a duplicate", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await request.get("/api/airports/lookup", {
      headers: auth(token),
      params: { q: "BEG" },
    });

    const body = (await response.json()) as { items: Suggestion[] };
    const belgrade = body.items.find((item) => item.iataCode === "BEG");
    expect(belgrade?.alreadyOnFile).toBe(true);
  });

  test("the reference carries no country code outside ISO 3166-1", async ({ request }) => {
    // The importer rejects user-assigned codes from the XA-XZ range and the
    // ZZ placeholder, because the schema documents this column as ISO 3166-1.
    // Anything the importer drops is reported for a person to decide on, never
    // silently admitted. This asserts the gate held.
    const token = await signIn(request, ACCOUNTS.commercialManager);

    for (const probe of ["a", "e", "i", "o", "u"]) {
      const response = await request.get("/api/airports/lookup", {
        headers: auth(token),
        params: { q: probe + probe, limit: 25 },
      });
      const body = (await response.json()) as { items: Suggestion[] };
      for (const item of body.items) {
        expect(item.countryCode, `${item.iataCode} carries a non-ISO country code`).not.toMatch(
          /^(X.|ZZ)$/,
        );
      }
    }
  });

  test("a country code ISO does not assign is refused on save", async ({ request }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);
    const response = await request.post("/api/airports", {
      headers: auth(token),
      data: {
        iataCode: "QZZ",
        icaoCode: "QZZZ",
        name: "Nowhere",
        city: "Nowhere",
        countryCode: "XK",
        latitude: 42.5,
        longitude: 21.0,
        timeZone: "Europe/Belgrade",
        mutation: { preview: true },
      },
    });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; issues?: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.issues?.[0]?.path).toBe("countryCode");
    expect(body.error.issues?.[0]?.message).toContain("ISO 3166-1");
  });

  test("serving a new country reports it as a consequence before it happens", async ({
    request,
  }) => {
    const token = await signIn(request, ACCOUNTS.commercialManager);

    // Helsinki: a real airport in a country the network does not yet serve.
    // If Finland is ever added as a station, pick another absent country.
    const response = await request.post("/api/airports", {
      headers: auth(token),
      data: {
        iataCode: "HEL",
        icaoCode: "EFHK",
        name: "Helsinki Vantaa",
        city: "Helsinki",
        countryCode: "FI",
        latitude: 60.3172,
        longitude: 24.9633,
        timeZone: "Europe/Helsinki",
        mutation: { preview: true },
      },
    });

    expect(response.status()).toBe(200);
    const preview = (await response.json()) as {
      applicable: boolean;
      consequences: { summary: string }[];
    };

    expect(preview.applicable).toBe(true);
    expect(preview.consequences.map((c) => c.summary).join(" ")).toContain("Finland");
  });

  test("lookup needs authentication", async ({ request }) => {
    const response = await request.get("/api/airports/lookup", { params: { q: "LIS" } });
    expect(response.status()).toBe(401);
  });
});

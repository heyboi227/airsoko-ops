import { inArray } from "drizzle-orm";
import { airportLookupQuerySchema, type AirportSuggestion } from "@airsoko/contracts";
import { db } from "../../db/client.ts";
import { airports } from "../../db/schema.ts";
import { airportReference, type ReferenceAirport } from "../../db/seed/reference/index.ts";
import { ISO_3166_1_ALPHA2 } from "../../db/seed/reference/iso3166.ts";
import type { Request, Response } from "express";

/**
 * Autofill for the airport form.
 *
 * Backed by a committed reference file rather than a remote API. An airport's
 * coordinates are stable for decades; calling out to the network per keystroke
 * to look up a fact that never changes would buy a dependency, a key and a
 * rate limit in exchange for nothing. This is instant, works offline, and
 * makes the tests deterministic.
 *
 * If a live source is ever wanted, it replaces `airportReference()` behind the
 * same shape -- the same pattern the telemetry provider uses.
 *
 * What this returns is a *suggestion*. It fills a form; it is not a record and
 * it is not a write path. The operator can change any field, the same Zod
 * schema and the same kernel rules still run on save, and the audit entry
 * records what they saved.
 */

const COUNTRY_NAMES = new Map(ISO_3166_1_ALPHA2.map((country) => [country.code, country.name]));

interface Scored {
  airport: ReferenceAirport;
  score: number;
}

/** Lower is better. Exact code matches win, then prefixes, then substrings. */
function scoreMatch(airport: ReferenceAirport, needle: string): number | null {
  const iata = airport.iataCode.toLowerCase();
  const icao = airport.icaoCode.toLowerCase();
  const name = airport.name.toLowerCase();
  const city = airport.city.toLowerCase();

  if (iata === needle) return 0;
  if (icao === needle) return 1;
  if (city === needle) return 2;
  if (city.startsWith(needle)) return 3;
  if (name.startsWith(needle)) return 4;
  if (city.includes(needle)) return 5;
  if (name.includes(needle)) return 6;
  if (iata.startsWith(needle)) return 7;
  return null;
}

export async function lookupAirports(req: Request, res: Response): Promise<void> {
  const query = airportLookupQuerySchema.parse(req.query);
  const needle = query.q.toLowerCase();

  const matches: Scored[] = [];
  for (const airport of airportReference().values()) {
    const score = scoreMatch(airport, needle);
    if (score !== null) matches.push({ airport, score });
  }

  matches.sort(
    (a, b) => a.score - b.score || a.airport.iataCode.localeCompare(b.airport.iataCode),
  );
  const top = matches.slice(0, query.limit);

  // Tell the operator which suggestions are already stations, so they do not
  // fill a form that the duplicate-code rule is about to refuse.
  const codes = top.map((match) => match.airport.iataCode);
  const onFile =
    codes.length > 0
      ? new Set(
          (
            await db
              .select({ iataCode: airports.iataCode })
              .from(airports)
              .where(inArray(airports.iataCode, codes))
          ).map((row) => row.iataCode),
        )
      : new Set<string>();

  const items: AirportSuggestion[] = top.map(({ airport }) => ({
    ...airport,
    countryName: COUNTRY_NAMES.get(airport.countryCode) ?? airport.countryCode,
    alreadyOnFile: onFile.has(airport.iataCode),
  }));

  res.json({ items, total: matches.length });
}

import { readFileSync } from "node:fs";
import { apiPath } from "../../../paths.ts";
import { ISO_3166_1_ALPHA2 } from "./iso3166.ts";
import { AIR_SOKO_STATIONS, type StationRole } from "./stations.ts";

/**
 * Resolves the Air Soko network against the curated airport reference.
 *
 * The reference is a committed JSON file rather than a network call: an
 * airport's coordinates are stable for decades, so fetching them at runtime
 * would buy a dependency and a rate limit in exchange for nothing. Rebuild it
 * with `npx tsx scripts/build-airport-reference.ts` when the upstream data is
 * worth refreshing.
 */

export interface ReferenceAirport {
  iataCode: string;
  icaoCode: string;
  name: string;
  city: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  elevationFt: number;
  timeZone: string;
}

// Addressed from the package root, not from this file: the production build
// bundles this module into `dist/main.js`, where a path relative to the module
// resolves to `dist/`. See `src/paths.ts`.
const REFERENCE_PATH = apiPath("src/db/seed/reference/airports.reference.json");

let cache: ReadonlyMap<string, ReferenceAirport> | null = null;

/** Every airport the operator can autofill from, keyed by IATA code. */
export function airportReference(): ReadonlyMap<string, ReferenceAirport> {
  if (cache) return cache;
  const rows = JSON.parse(readFileSync(REFERENCE_PATH, "utf8")) as ReferenceAirport[];
  cache = new Map(rows.map((row) => [row.iataCode, row]));
  return cache;
}

export interface SeedStation extends ReferenceAirport {
  isHub: boolean;
  isFocusCity: boolean;
}

/**
 * The network as rows ready to insert.
 *
 * Throws rather than skipping when a station is missing from the reference.
 * A silently absent station would surface much later as an empty route map,
 * and the fix -- widening the reference selection rule -- is a decision worth
 * making deliberately.
 */
export function resolveStations(
  stations: readonly StationRole[] = AIR_SOKO_STATIONS,
): SeedStation[] {
  const reference = airportReference();
  const missing: string[] = [];

  const resolved = stations.map((station) => {
    const airport = reference.get(station.iataCode);
    if (!airport) {
      missing.push(station.iataCode);
      return null;
    }
    return {
      ...airport,
      isHub: station.isHub ?? false,
      isFocusCity: station.isFocusCity ?? false,
    };
  });

  if (missing.length > 0) {
    throw new Error(
      `These stations are not in the airport reference: ${missing.join(", ")}.\n` +
        `Either the IATA code is wrong, or the reference selection rule in\n` +
        `scripts/build-airport-reference.ts needs to widen to include them.`,
    );
  }

  return resolved.filter((station): station is SeedStation => station !== null);
}

/** Only the countries the network actually touches, named from the ISO list. */
export function resolveCountries(stations: readonly SeedStation[]) {
  const names = new Map(ISO_3166_1_ALPHA2.map((country) => [country.code, country.name]));
  const used = [...new Set(stations.map((station) => station.countryCode))].sort();

  return used.map((code) => {
    const name = names.get(code);
    if (!name) {
      // The importer already rejects non-ISO codes, so reaching here means the
      // reference and the ISO list have drifted apart.
      throw new Error(`Country code ${code} is not in the ISO 3166-1 list.`);
    }
    return { code, name };
  });
}

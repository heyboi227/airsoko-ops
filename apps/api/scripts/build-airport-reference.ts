/**
 * Builds the curated airport reference set from OurAirports.
 *
 * A development tool, not part of the running application. Run it when the
 * upstream data is worth refreshing; commit the JSON it produces. Nothing at
 * runtime or in CI touches the network.
 *
 *   npx tsx scripts/build-airport-reference.ts [--source path/to/airports.csv]
 *
 * ---------------------------------------------------------------------------
 * Selection is curated, not exhaustive.
 *
 * OurAirports lists 85,000 airports. An airline's station reference covers
 * where it flies and where it might plausibly fly, not the whole world, so the
 * rule below is deliberately narrow: everywhere in Europe with scheduled
 * service, plus major airports elsewhere. That is the network Air Soko could
 * credibly grow into.
 *
 * ---------------------------------------------------------------------------
 * Country codes must be real ISO 3166-1.
 *
 * The source's `iso_country` column is not strictly ISO 3166-1 -- it carries
 * user-assigned codes from the XA-XZ range that ISO deliberately leaves
 * unstandardised, plus ZZ for unknown. Our schema documents that column as ISO
 * 3166-1, so accepting those values would make the schema's own contract false.
 *
 * The importer therefore rejects every non-ISO code and reports what it
 * dropped. That is a single general rule applied uniformly: there is no
 * per-entity list here, and adding one would be a different kind of decision
 * than this script is allowed to make. Anything dropped is visible in the run
 * output for a human to act on.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse/sync";
import tzLookup from "tz-lookup";
import { ISO_3166_1_ALPHA2 } from "../src/db/seed/reference/iso3166.ts";

const SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(here, "../src/db/seed/reference/airports.reference.json");
const CACHE = resolve(here, "../.cache/ourairports-airports.csv");

interface SourceRow {
  type: string;
  name: string;
  latitude_deg: string;
  longitude_deg: string;
  elevation_ft: string;
  continent: string;
  iso_country: string;
  municipality: string;
  scheduled_service: string;
  icao_code: string;
  iata_code: string;
  ident: string;
}

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

async function loadSource(): Promise<string> {
  const flagIndex = process.argv.indexOf("--source");
  if (flagIndex !== -1) {
    const path = process.argv[flagIndex + 1];
    if (!path) throw new Error("--source needs a file path.");
    return readFile(path, "utf8");
  }

  try {
    return await readFile(CACHE, "utf8");
  } catch {
    // Not cached yet.
  }

  console.log(`Downloading ${SOURCE_URL} ...`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Could not fetch the source: ${response.status} ${response.statusText}`);
  }

  await mkdir(dirname(CACHE), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(CACHE));
  return readFile(CACHE, "utf8");
}

/** Everywhere in Europe with scheduled service, plus major airports worldwide. */
function isCandidateStation(row: SourceRow): boolean {
  if (row.scheduled_service !== "yes") return false;
  if (!/^[A-Z]{3}$/.test(row.iata_code)) return false;
  if (!/^[A-Z]{4}$/.test(row.icao_code)) return false;
  if (row.type === "large_airport") return true;
  return row.type === "medium_airport" && row.continent === "EU";
}

/** Trims the source's house style: every name there ends in "Airport". */
function tidyName(name: string): string {
  return name
    .replace(/\s+(International\s+)?Airport$/i, (match) =>
      /International/i.test(match) ? " International" : "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function main(): Promise<void> {
  const csv = await loadSource();
  const rows = parse(csv, { columns: true, skip_empty_lines: true }) as SourceRow[];
  console.log(`Read ${rows.length.toLocaleString()} rows from the source.`);

  const iso = new Set(ISO_3166_1_ALPHA2.map((country) => country.code));

  const selected: ReferenceAirport[] = [];
  const rejectedForCountry = new Map<string, string[]>();
  let tzFailures = 0;

  for (const row of rows) {
    if (!isCandidateStation(row)) continue;

    if (!iso.has(row.iso_country)) {
      const existing = rejectedForCountry.get(row.iso_country) ?? [];
      existing.push(`${row.iata_code} ${row.name}`);
      rejectedForCountry.set(row.iso_country, existing);
      continue;
    }

    const latitude = Number(row.latitude_deg);
    const longitude = Number(row.longitude_deg);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

    let timeZone: string;
    try {
      timeZone = tzLookup(latitude, longitude);
    } catch {
      tzFailures += 1;
      continue;
    }

    selected.push({
      iataCode: row.iata_code,
      icaoCode: row.icao_code,
      name: tidyName(row.name),
      city: row.municipality || tidyName(row.name),
      countryCode: row.iso_country,
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
      elevationFt: Number.isFinite(Number(row.elevation_ft)) ? Number(row.elevation_ft) : 0,
      timeZone,
    });
  }

  // Deterministic order so the committed file only changes when the data does.
  selected.sort((a, b) => a.iataCode.localeCompare(b.iataCode));

  // A duplicate IATA code upstream would silently shadow a station.
  const seen = new Map<string, ReferenceAirport>();
  const duplicates: string[] = [];
  for (const airport of selected) {
    const previous = seen.get(airport.iataCode);
    if (previous) duplicates.push(`${airport.iataCode}: ${previous.name} / ${airport.name}`);
    else seen.set(airport.iataCode, airport);
  }

  const output = [...seen.values()];

  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`\nSelected ${output.length.toLocaleString()} stations -> ${OUTPUT}`);

  if (rejectedForCountry.size > 0) {
    console.log(`\nRejected for non-ISO 3166-1 country codes:`);
    for (const [code, airports] of [...rejectedForCountry].sort()) {
      console.log(`  ${code}  ${airports.length} airport${airports.length === 1 ? "" : "s"}`);
      for (const airport of airports) console.log(`        ${airport}`);
    }
    console.log(
      `\n  These are user-assigned or placeholder codes, not ISO 3166-1. Adding any of\n` +
        `  them is a deliberate decision for a person to make, not something this\n` +
        `  importer should do silently.`,
    );
  }

  if (duplicates.length > 0) {
    console.log(`\nDuplicate IATA codes (kept the first):`);
    for (const entry of duplicates) console.log(`  ${entry}`);
  }

  if (tzFailures > 0)
    console.log(`\n${tzFailures} rows dropped: no time zone for their position.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

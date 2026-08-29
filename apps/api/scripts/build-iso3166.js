/**
 * Regenerates src/db/seed/reference/iso3166.ts from the host's ICU data.
 *
 * A development tool. Run it if a future ICU update changes the region list --
 * the count assertion below will fail loudly rather than silently widening or
 * narrowing the gate the airport importer validates against.
 *
 *   node scripts/build-iso3166.js
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/db/seed/reference/iso3166.ts",
);

/**
 * Codes ICU knows that ISO 3166-1 does not assign as countries.
 * Grouped by why, because "why" is the part that will matter to whoever reads
 * this next.
 */
const NOT_ISO_COUNTRY_ASSIGNMENTS = new Set([
  // ICU's own supranational groupings.
  "EU",
  "EZ",
  "UN",
  "QO",
  "ZZ",
  // Exceptionally reserved: reserved by ISO for other standards' use, never
  // assigned as countries.
  "AC",
  "CP",
  "CQ",
  "DG",
  "EA",
  "IC",
  "TA",
  "FX",
  "SU",
  "UK",
  // Transitionally reserved: states that no longer exist.
  "AN",
  "BU",
  "CS",
  "NT",
  "TP",
  "YU",
  "ZR",
  // Withdrawn or formerly used.
  "DD",
  "DY",
  "HV",
  "NH",
  "QU",
  "RH",
  "VD",
  "YD",
]);

/** ISO 3166-1 currently assigns exactly this many alpha-2 country codes. */
const EXPECTED_COUNT = 249;

const display = new Intl.DisplayNames(["en"], { type: "region" });

const countries = [];
for (let first = 65; first <= 90; first += 1) {
  for (let second = 65; second <= 90; second += 1) {
    const code = String.fromCharCode(first) + String.fromCharCode(second);

    // XA-XZ is the range ISO leaves free for user assignment, so nothing in it
    // is a standardised country code no matter what ICU calls it.
    if (code.startsWith("X")) continue;
    if (NOT_ISO_COUNTRY_ASSIGNMENTS.has(code)) continue;

    let name;
    try {
      name = display.of(code);
    } catch {
      continue;
    }
    if (!name || name === code) continue;

    countries.push({ code, name });
  }
}

countries.sort((a, b) => a.code.localeCompare(b.code));

if (countries.length !== EXPECTED_COUNT) {
  console.error(
    `Expected ${EXPECTED_COUNT} ISO 3166-1 alpha-2 codes, derived ${countries.length}.\n` +
      `The host's ICU region data has changed. Reconcile the exclusion list above\n` +
      `against the current standard before regenerating.`,
  );
  process.exit(1);
}

const rows = countries
  .map(({ code, name }) => `  { code: "${code}", name: ${JSON.stringify(name)} },`)
  .join("\n");

const file = `/**
 * The ${EXPECTED_COUNT} country codes officially assigned by ISO 3166-1 alpha-2.
 *
 * This list exists to be a gate, not a directory. The airport reference
 * importer validates every incoming country code against it and rejects
 * anything outside it, because the source dataset's country column is not
 * strictly ISO 3166-1 -- it carries user-assigned codes from the XA-XZ range
 * that ISO deliberately leaves unstandardised, plus placeholders for unknown.
 * Our schema documents that column as ISO 3166-1, so letting those through
 * would make the schema's own contract false.
 *
 * Generated from the host ICU region data, minus four groups ICU carries that
 * ISO does not assign as countries: its own supranational groupings, codes
 * exceptionally reserved for other standards, transitionally reserved codes
 * for states that no longer exist, and withdrawn assignments. The count is
 * asserted at ${EXPECTED_COUNT} so a future ICU update cannot silently widen or narrow
 * the gate.
 *
 * Names are English display names for administrative use in this application.
 * They are labels on reference rows, not a position on anything.
 *
 * Regenerate with: node scripts/build-iso3166.js
 */

export interface IsoCountry {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
}

export const ISO_3166_1_ALPHA2: readonly IsoCountry[] = [
${rows}
];

/** Fast membership test for the importer's country gate. */
export const ISO_COUNTRY_CODES: ReadonlySet<string> = new Set(
  ISO_3166_1_ALPHA2.map((country) => country.code),
);
`;

writeFileSync(OUTPUT, file, "utf8");
console.log(`Wrote ${countries.length} ISO 3166-1 alpha-2 codes to ${OUTPUT}`);

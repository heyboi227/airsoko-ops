/**
 * ISO 3166-1 entries for the countries Air Soko serves.
 *
 * Not a world atlas -- the table exists to give airports a referential home and
 * to print a country name next to a station. Adding a destination adds its
 * country here.
 *
 * The reference project's `country` table was 194 names with no ISO codes at
 * all, so there was nothing to port: a name alone cannot key a foreign key or
 * drive a flag, and the alpha-2/alpha-3 pairs had to be authored regardless.
 */

export interface SeedCountry {
  code: string;
  alpha3: string;
  name: string;
}

export const SEED_COUNTRIES: readonly SeedCountry[] = [
  { code: "AE", alpha3: "ARE", name: "United Arab Emirates" },
  { code: "AL", alpha3: "ALB", name: "Albania" },
  { code: "AT", alpha3: "AUT", name: "Austria" },
  { code: "BA", alpha3: "BIH", name: "Bosnia and Herzegovina" },
  { code: "BE", alpha3: "BEL", name: "Belgium" },
  { code: "BG", alpha3: "BGR", name: "Bulgaria" },
  { code: "BR", alpha3: "BRA", name: "Brazil" },
  { code: "CA", alpha3: "CAN", name: "Canada" },
  { code: "CH", alpha3: "CHE", name: "Switzerland" },
  { code: "CN", alpha3: "CHN", name: "China" },
  { code: "CZ", alpha3: "CZE", name: "Czechia" },
  { code: "DE", alpha3: "DEU", name: "Germany" },
  { code: "DK", alpha3: "DNK", name: "Denmark" },
  { code: "ES", alpha3: "ESP", name: "Spain" },
  { code: "FR", alpha3: "FRA", name: "France" },
  { code: "GB", alpha3: "GBR", name: "United Kingdom" },
  { code: "GR", alpha3: "GRC", name: "Greece" },
  { code: "HR", alpha3: "HRV", name: "Croatia" },
  { code: "HU", alpha3: "HUN", name: "Hungary" },
  { code: "IN", alpha3: "IND", name: "India" },
  { code: "IT", alpha3: "ITA", name: "Italy" },
  { code: "ME", alpha3: "MNE", name: "Montenegro" },
  { code: "MK", alpha3: "MKD", name: "North Macedonia" },
  { code: "NL", alpha3: "NLD", name: "Netherlands" },
  { code: "NO", alpha3: "NOR", name: "Norway" },
  { code: "PL", alpha3: "POL", name: "Poland" },
  { code: "RO", alpha3: "ROU", name: "Romania" },
  { code: "RS", alpha3: "SRB", name: "Serbia" },
  { code: "SE", alpha3: "SWE", name: "Sweden" },
  { code: "SI", alpha3: "SVN", name: "Slovenia" },
  { code: "TR", alpha3: "TUR", name: "Türkiye" },
  { code: "US", alpha3: "USA", name: "United States" },
];

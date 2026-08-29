import { z } from "zod";
import {
  iataAirportCodeSchema,
  icaoAirportCodeSchema,
  ianaTimeZoneSchema,
  idSchema,
  instantSchema,
  latitudeSchema,
  longitudeSchema,
  paginationSchema,
} from "./primitives.ts";

/**
 * Airports are the first entity built end to end because everything else
 * depends on them: routes need the pair, schedules need the local zone, and
 * the live map needs the coordinates. The reference project stored neither
 * latitude nor longitude, which is why its data could not have produced a map.
 */

export const countrySchema = z.object({
  /** ISO 3166-1 alpha-2. */
  code: z.string().regex(/^[A-Z]{2}$/),
  name: z.string().min(1),
});
export type Country = z.infer<typeof countrySchema>;

export const airportSchema = z.object({
  id: idSchema,
  iataCode: iataAirportCodeSchema,
  icaoCode: icaoAirportCodeSchema,
  name: z.string().min(1).max(160),
  city: z.string().min(1).max(120),
  countryCode: countrySchema.shape.code,
  countryName: z.string().min(1),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  elevationFt: z.number().int().min(-1500).max(20000),
  timeZone: ianaTimeZoneSchema,
  /** An airline base: drives map emphasis and default schedule origins. */
  isHub: z.boolean(),
  /** Airports we serve but do not base aircraft at are still "focus" markers. */
  isFocusCity: z.boolean(),
  active: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type Airport = z.infer<typeof airportSchema>;

/** The trimmed shape embedded in flights, routes and map payloads. */
export const airportRefSchema = airportSchema.pick({
  id: true,
  iataCode: true,
  icaoCode: true,
  name: true,
  city: true,
  countryCode: true,
  latitude: true,
  longitude: true,
  timeZone: true,
});
export type AirportRef = z.infer<typeof airportRefSchema>;

export const createAirportSchema = airportSchema
  .omit({ id: true, countryName: true, createdAt: true, updatedAt: true })
  .extend({
    elevationFt: airportSchema.shape.elevationFt.default(0),
    isHub: z.boolean().default(false),
    isFocusCity: z.boolean().default(false),
    active: z.boolean().default(true),
  });
export type CreateAirport = z.input<typeof createAirportSchema>;

export const updateAirportSchema = createAirportSchema.partial();
export type UpdateAirport = z.input<typeof updateAirportSchema>;

export const airportQuerySchema = paginationSchema.extend({
  /** Matches IATA, ICAO, name or city, case-insensitively. */
  search: z.string().trim().max(120).optional(),
  countryCode: countrySchema.shape.code.optional(),
  hubsOnly: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().default(false),
  sort: z.enum(["iataCode", "name", "city", "countryCode"]).default("iataCode"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type AirportQuery = z.infer<typeof airportQuerySchema>;

/**
 * A suggestion from the curated airport reference, offered while an operator
 * types an IATA code or a city name.
 *
 * Deliberately not an `Airport`: it has no id and it is not a record. It is a
 * proposal the operator can accept, edit, or ignore, and what gets audited is
 * what they saved -- never what the reference said.
 */
export const airportSuggestionSchema = z.object({
  iataCode: iataAirportCodeSchema,
  icaoCode: icaoAirportCodeSchema,
  name: z.string(),
  city: z.string(),
  countryCode: countrySchema.shape.code,
  countryName: z.string(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  elevationFt: z.number().int(),
  timeZone: ianaTimeZoneSchema,
  /** True when this station is already on file, so the form can say so. */
  alreadyOnFile: z.boolean(),
});
export type AirportSuggestion = z.infer<typeof airportSuggestionSchema>;

export const airportLookupQuerySchema = z.object({
  /** IATA code, ICAO code, airport name or city. */
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(25).default(8),
});
export type AirportLookupQuery = z.infer<typeof airportLookupQuerySchema>;

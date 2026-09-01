import { z } from "zod";

/**
 * Shared value types. Anything that appears in more than one entity and has a
 * validation rule worth stating once lives here.
 */

export const idSchema = z.uuid();
export type Id = z.infer<typeof idSchema>;

/**
 * Instants are ISO 8601 with an explicit offset, always serialised in UTC.
 * The rule for this codebase: instants are absolute and stored as
 * `timestamptz`; anything an airport-local clock would show is derived at the
 * edge from the airport's IANA zone. There is no such thing as a naive
 * datetime in this system.
 */
export const instantSchema = z.iso.datetime({ offset: true });
export type Instant = z.infer<typeof instantSchema>;

/** A wall-clock time of day with no date and no zone, e.g. a schedule pattern's "07:45". */
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, {
  message: "Expected a 24-hour local time such as 07:45",
});
export type LocalTime = z.infer<typeof localTimeSchema>;

/** A calendar date with no zone, e.g. a schedule's validity window. */
export const localDateSchema = z.iso.date();
export type LocalDate = z.infer<typeof localDateSchema>;

export const iataAirportCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "IATA airport codes are three uppercase letters" });

export const icaoAirportCodeSchema = z
  .string()
  .regex(/^[A-Z]{4}$/, { message: "ICAO airport codes are four uppercase letters" });

/** Two-letter IATA airline designator, e.g. "SK". */
export const airlineCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{2}$/, { message: "Airline designators are two characters" });

/** Flight number as printed: designator plus one to four digits, e.g. "SO412". */
export const flightNumberSchema = z
  .string()
  .regex(/^[A-Z0-9]{2}\d{1,4}$/, { message: "Expected a flight number such as SO412" });

/** Aircraft registration, e.g. "YU-ASA". */
export const registrationSchema = z.string().regex(/^[A-Z0-9]{1,2}-[A-Z0-9]{3,5}$/, {
  message: "Expected a registration such as YU-ASA",
});

/** Booking reference: six characters, ambiguous glyphs excluded. */
export const pnrSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{6}$/, {
  message: "A PNR is six characters, excluding I, O, 0 and 1",
});

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const coordinatesSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});
export type Coordinates = z.infer<typeof coordinatesSchema>;

/** Compass heading in degrees true. 360 normalises to 0. */
export const headingSchema = z.number().min(0).lt(360);

/**
 * IANA time zone identifier. Validated against the host's own zone database
 * rather than a hard-coded list, so it stays correct as the database updates.
 */
export const ianaTimeZoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Expected an IANA time zone such as Europe/Belgrade" },
);

/**
 * A boolean carried in a query string.
 *
 * Not `z.coerce.boolean()`: that is `Boolean(value)`, so the string "false"
 * coerces to `true` and a filter turned off in the UI arrives at the API
 * turned on. Query parameters are text, and the only honest reading of that
 * text is an explicit one.
 */
export const booleanFlagSchema = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof paginationSchema>;

export function pageEnvelopeSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });
}

export interface PageEnvelope<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

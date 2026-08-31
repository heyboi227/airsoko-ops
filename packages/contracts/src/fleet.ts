import { z } from "zod";
import { cabinClassSchema } from "./enums.ts";
import { iataAirportCodeSchema, idSchema } from "./primitives.ts";

/**
 * What the fleet already knows about a type, offered while registering a new
 * airframe of it.
 *
 * The airport form fills itself from a reference file, because an airport's
 * coordinates are a fact about the world that someone else has already
 * recorded. An aircraft's cabin is not: it is the airline's own decision, and
 * the only place it is written down is the fleet on file. So this reads the
 * tails already flying and reports the configurations they are flown in --
 * the fleet's own convention, learned rather than authored.
 *
 * Like `AirportSuggestion`, and for the same reason, none of this is a record.
 * It fills a form. The operator can change every field, the same Zod schema
 * and the same kernel rules run on save, and the audit entry records what they
 * submitted -- never what the fleet suggested.
 *
 * These shapes live in contracts because both ends must agree on them. The
 * rest of the fleet's request and response shapes are still declared at their
 * route: they are read by one caller, and moving them here would be filing
 * them somewhere they are not shared from.
 */

export const cabinConfigurationSchema = z.object({
  cabinClass: cabinClassSchema,
  firstRow: z.number().int(),
  lastRow: z.number().int(),
  /**
   * Seat letters with dashes for aisles, e.g. "ABC-DEF" -- reconstructed from
   * the stored letters and the seats' aisle flags, because the string itself
   * is notation and is stored nowhere.
   */
  layout: z.string(),
  pitchInches: z.number().int(),
  seatCount: z.number().int(),
});
export type CabinConfiguration = z.infer<typeof cabinConfigurationSchema>;

/** One cabin arrangement, and the airframes on file that are flown in it. */
export const fleetConfigurationSchema = z.object({
  cabins: z.array(cabinConfigurationSchema).min(1),
  /** Summed from the cabins, here as everywhere else. */
  seatCapacity: z.number().int(),
  // Registration is a plain string here rather than `registrationSchema`: the
  // register accepts marks in shapes that pattern does not cover, and a
  // response contract should not claim more than the write path enforces.
  aircraft: z.array(z.object({ id: idSchema, registration: z.string() })).min(1),
});
export type FleetConfiguration = z.infer<typeof fleetConfigurationSchema>;

export const typeConfigurationsSchema = z.object({
  typeId: idSchema,
  icaoTypeCode: z.string(),
  /**
   * Airframes of this type still in the fleet. Zero means this one is the
   * first. Counted from the same airframes the configurations are built from,
   * so the tails across every configuration add up to exactly this -- which is
   * what lets a form say "all of them" and be right.
   */
  onFile: z.number().int(),
  /** Most-flown arrangement first. Empty when the type has no airframes yet. */
  configurations: z.array(fleetConfigurationSchema),
  /**
   * Where most of this sub-fleet is based, with how many tails sit there --
   * enough for the form to say how strong the suggestion is rather than just
   * making it.
   */
  base: z
    .object({
      id: idSchema,
      iataCode: iataAirportCodeSchema,
      name: z.string(),
      sharedBy: z.number().int(),
    })
    .nullable(),
});
export type TypeConfigurations = z.infer<typeof typeConfigurationsSchema>;

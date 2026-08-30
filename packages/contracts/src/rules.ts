import { z } from "zod";
import { idSchema } from "./primitives.ts";
import { resourceKindSchema } from "./enums.ts";

/**
 * The rule vocabulary shared between the kernel, the API and the UI.
 *
 * Every conflict the brief asks us to detect has a code here. A code is a
 * contract: the confirmation dialog can key off it, an end-to-end test can
 * assert on it, and its wording can change without breaking either.
 *
 * `blocking` findings refuse the mutation outright. `warning` findings let it
 * proceed, but only once the operator has explicitly acknowledged that exact
 * code -- see `acknowledgedWarnings` below. There is no third state and no
 * silent pass, which is what the brief means by never "silently allowing
 * aircraft, crew, capacity, or schedule conflicts".
 */

export const RULE_CODES = [
  // --- Aircraft assignment -------------------------------------------------
  "AIRCRAFT_UNAVAILABLE",
  "AIRCRAFT_OVERLAPPING_ASSIGNMENT",
  "AIRCRAFT_INSUFFICIENT_TURNAROUND",
  "AIRCRAFT_IMPOSSIBLE_REPOSITIONING",
  "AIRCRAFT_RANGE_INSUFFICIENT",
  "AIRCRAFT_CAPACITY_BELOW_SOLD",
  "AIRCRAFT_CABIN_CAPACITY_BELOW_SOLD",
  "AIRCRAFT_TYPE_MISMATCH_WITH_SCHEDULE",

  // --- Aircraft records ----------------------------------------------------
  // Distinct codes rather than one AIRCRAFT_INVALID, because the operator
  // acknowledges a warning *by code*: a single code covering two conditions
  // would let one tick accept both.
  "AIRCRAFT_REGISTRATION_IN_USE",
  "AIRCRAFT_REGISTRATION_PREVIOUSLY_USED",
  "AIRCRAFT_SERIAL_IN_USE",
  "AIRCRAFT_NO_CABIN_CONFIGURATION",
  "AIRCRAFT_CABIN_LAYOUT_INVALID",
  "AIRCRAFT_DELIVERY_DATE_FUTURE",
  "AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET",
  "AIRCRAFT_REGISTRATION_PREFIX_UNUSUAL",

  // --- Crew ----------------------------------------------------------------
  "CREW_POSITION_UNFILLED",
  "CREW_OVERLAPPING_DUTY",
  "CREW_MISSING_TYPE_RATING",
  "CREW_UNAVAILABLE",
  "CREW_DUTY_LIMIT_EXCEEDED",
  "CREW_COMPLEMENT_INSUFFICIENT",
  "CREW_BASE_MISMATCH",

  // --- Schedule ------------------------------------------------------------
  "SCHEDULE_INVALID_TIME_ORDER",
  "SCHEDULE_SAME_ORIGIN_AND_DESTINATION",
  "SCHEDULE_DURATION_IMPLAUSIBLE",
  "SCHEDULE_OUTSIDE_VALIDITY_WINDOW",
  "SCHEDULE_AIRPORT_RESTRICTION",

  // --- Maintenance ---------------------------------------------------------
  "MAINTENANCE_LIMIT_APPROACHING",
  "MAINTENANCE_LIMIT_EXCEEDED",

  // --- Commercial ----------------------------------------------------------
  "BOOKING_AFFECTED_BY_CHANGE",
  "SEAT_ASSIGNMENTS_ORPHANED",
  "FARE_PRODUCT_CABIN_UNAVAILABLE",

  // --- Amenities -----------------------------------------------------------
  "AMENITY_ASSIGNMENT_DUPLICATE",
  "AMENITY_ASSIGNMENT_CONTRADICTS_EXISTING",
  "AMENITY_WITHDRAWAL_GRANTS_NOTHING",
] as const;

export const ruleCodeSchema = z.enum(RULE_CODES);
export type RuleCode = z.infer<typeof ruleCodeSchema>;

export const RULE_SEVERITIES = ["blocking", "warning"] as const;
export const ruleSeveritySchema = z.enum(RULE_SEVERITIES);
export type RuleSeverity = z.infer<typeof ruleSeveritySchema>;

export const resourceRefSchema = z.object({
  kind: resourceKindSchema,
  id: idSchema,
  /** What a human calls it: "SK412", "YU-ASA", "M. Petrovic". */
  label: z.string(),
});
export type ResourceRef = z.infer<typeof resourceRefSchema>;

export const ruleFindingSchema = z.object({
  code: ruleCodeSchema,
  severity: ruleSeveritySchema,
  /** One line, scannable in a list: "Aircraft already flying SK118". */
  title: z.string(),
  /** Precise, quantified, and specific to this case -- never generic advice. */
  detail: z.string(),
  /** What the operator should look at. Drives the deep link in alerts. */
  subject: resourceRefSchema.optional(),
  /** Other records implicated, e.g. the overlapping flight or the sold seats. */
  related: z.array(resourceRefSchema).default([]),
});
export type RuleFinding = z.infer<typeof ruleFindingSchema>;

/**
 * What will happen if this mutation is applied. Distinct from findings: a
 * consequence is not a problem, it is an effect the operator is entitled to
 * see before confirming. This is what fills the confirmation dialog that
 * section 15 asks for.
 */
export const CONSEQUENCE_KINDS = [
  "capacity_changed",
  "bookings_flagged",
  "seat_assignments_cleared",
  "crew_released",
  "crew_assigned",
  "aircraft_released",
  "aircraft_assigned",
  "alerts_raised",
  "map_visibility_changed",
  "analytics_restated",
  "occurrences_affected",
  "amenity_resolution_changed",
] as const;
export const consequenceKindSchema = z.enum(CONSEQUENCE_KINDS);
export type ConsequenceKind = z.infer<typeof consequenceKindSchema>;

export const consequenceSchema = z.object({
  kind: consequenceKindSchema,
  summary: z.string(),
  /** How many records this touches, when a count is meaningful. */
  count: z.number().int().nonnegative().optional(),
  related: z.array(resourceRefSchema).default([]),
});
export type Consequence = z.infer<typeof consequenceSchema>;

/**
 * The result of evaluating an intent without applying it. Every mutating
 * endpoint can be called in preview mode to obtain exactly this, so the
 * confirmation dialog and the eventual write agree by construction.
 */
export const mutationPreviewSchema = z.object({
  intent: z.string(),
  findings: z.array(ruleFindingSchema),
  consequences: z.array(consequenceSchema),
  /** False when at least one finding is blocking. */
  applicable: z.boolean(),
  /** Warning codes the operator must acknowledge for the apply to succeed. */
  requiresAcknowledgement: z.array(ruleCodeSchema),
});
export type MutationPreview = z.infer<typeof mutationPreviewSchema>;

/** Envelope every mutating request carries alongside its own payload. */
export const mutationOptionsSchema = z.object({
  /** Evaluate and report, write nothing. */
  preview: z.boolean().default(false),
  /** Warning codes the operator has seen and accepted. */
  acknowledgedWarnings: z.array(ruleCodeSchema).default([]),
  /** Free-text justification, recorded on the audit entry. */
  reason: z.string().max(500).optional(),
});
export type MutationOptions = z.infer<typeof mutationOptionsSchema>;

export function isBlocking(findings: readonly RuleFinding[]): boolean {
  return findings.some((finding) => finding.severity === "blocking");
}

export function warningCodes(findings: readonly RuleFinding[]): RuleCode[] {
  return [...new Set(findings.filter((f) => f.severity === "warning").map((f) => f.code))];
}

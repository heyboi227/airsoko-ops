import type { AmenityScope, CabinClass, Id } from "@airsoko/contracts";
import { EvaluationBuilder, blocking, consequence, resourceRef, warning } from "../intent.ts";
import type { Evaluation } from "../intent.ts";
import { resolveAmenities, type AmenityAssignment, type AmenityContext } from "../amenities.ts";

/**
 * Rules for changing what a passenger is offered.
 *
 * The interesting case is not adding an amenity -- it is withdrawing one, and
 * the two ways that can surprise an operator. Adding a withdrawal beside an
 * existing grant at the same level silently wins, because that is the tie-break
 * (see `resolveAmenities`); and adding one where nothing grants the amenity
 * changes nothing at all. Both are legitimate, and both are worth being told
 * before rather than discovering after.
 */

export interface AmenityAssignmentDraft {
  amenityId: Id;
  amenityCode: string;
  amenityName: string;
  scope: AmenityScope;
  included: boolean;
  aircraftId?: Id | null | undefined;
  cabinClass?: CabinClass | null | undefined;
  flightInstanceId?: Id | null | undefined;
  /** Modelled for Phase 6; nothing creates one yet. */
  fareProductId?: Id | null | undefined;
  note?: string | null | undefined;
}

export interface AmenityAssignmentContext {
  /** Every assignment already on file, in the shape the resolver reads. */
  existing: readonly (AmenityAssignment & { amenityName?: string })[];
  /** The cabins this change could reach, so its effect can be counted. */
  affectedContexts: readonly (AmenityContext & { label: string })[];
}

/** Three labels then a count -- the same shape the withdrawal warning uses. */
function listLabels(labels: readonly string[]): string {
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
}

/**
 * Does this assignment target the same thing the draft does?
 *
 * Same scope, same amenity, same thing pointed at. Which column identifies
 * "the same thing" depends on the scope, which is why this is a switch rather
 * than a comparison of every field: a cabin-scope row has no aircraft, and
 * comparing nulls would make two unrelated rows look identical.
 */
function sameTarget(assignment: AmenityAssignment, draft: AmenityAssignmentDraft): boolean {
  if (assignment.scope !== draft.scope) return false;
  if (assignment.amenityCode !== draft.amenityCode) return false;
  switch (draft.scope) {
    case "aircraft":
      return assignment.aircraftId === draft.aircraftId;
    case "flight":
      return assignment.flightInstanceId === draft.flightInstanceId;
    case "fare_product":
      return assignment.fareProductId === draft.fareProductId;
    default:
      return assignment.cabinClass === draft.cabinClass;
  }
}

export function evaluateAmenityAssignment(
  draft: AmenityAssignmentDraft,
  context: AmenityAssignmentContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("amenity", draft.amenityId, draft.amenityName);
  const verb = draft.included ? "grant" : "withdrawal";

  const identical = context.existing.find(
    (item) => sameTarget(item, draft) && item.included === draft.included,
  );
  if (identical) {
    builder.add(
      blocking(
        "AMENITY_ASSIGNMENT_DUPLICATE",
        `This ${verb} already exists`,
        `${draft.amenityName} is already ${draft.included ? "granted" : "withdrawn"} at this level for this target. A second identical row would change nothing and make the trail harder to read.`,
        { subject },
      ),
    );
    return builder.build();
  }

  const contradiction = context.existing.find(
    (item) => sameTarget(item, draft) && item.included !== draft.included,
  );
  if (contradiction) {
    builder.add(
      warning(
        "AMENITY_ASSIGNMENT_CONTRADICTS_EXISTING",
        `The opposite is already set at this level`,
        draft.included
          ? `${draft.amenityName} is currently withdrawn here. Adding a grant beside it will not restore the amenity — at equal specificity a withdrawal wins, deliberately, because promising something absent is the worse mistake. Remove the withdrawal instead.`
          : `${draft.amenityName} is currently granted here. Adding this withdrawal will override that grant, because at equal specificity a withdrawal wins. The grant stays on file and stays visible in the resolution.`,
        { subject },
      ),
    );
  }

  // Count the change by resolving before and after. Cheaper to be exact than
  // to describe the rule again in prose and hope the two agree.
  const after: AmenityAssignment[] = [
    ...context.existing,
    {
      id: "pending",
      amenityCode: draft.amenityCode,
      scope: draft.scope,
      included: draft.included,
      note: draft.note ?? null,
      aircraftId: draft.aircraftId ?? null,
      cabinClass: draft.cabinClass ?? null,
      fareProductId: draft.fareProductId ?? null,
      flightInstanceId: draft.flightInstanceId ?? null,
    },
  ];

  const changed: string[] = [];
  for (const target of context.affectedContexts) {
    const was = resolveAmenities(context.existing, target).find(
      (entry) => entry.amenityCode === draft.amenityCode,
    );
    const now = resolveAmenities(after, target).find(
      (entry) => entry.amenityCode === draft.amenityCode,
    );
    // Absent and withheld are different facts -- `resolveAmenities` keeps them
    // apart deliberately -- but they are the same *offer*: the passenger does
    // not get it either way. What changes here is the offer, so both fall to
    // false, and adding a withdrawal over silence correctly counts as nothing.
    if ((was?.included ?? false) !== (now?.included ?? false)) changed.push(target.label);
  }

  if (changed.length === 0) {
    builder.add(
      warning(
        "AMENITY_WITHDRAWAL_GRANTS_NOTHING",
        "This changes nothing that is offered today",
        draft.included
          ? `${draft.amenityName} already resolves the same way everywhere this assignment reaches, so nothing a passenger is told will change. The row is still worth keeping if it records an intent.`
          : `Nothing at any level currently grants ${draft.amenityName} where this withdrawal applies, so there is nothing for it to withhold. It will take effect if a broader grant is added later.`,
        { subject },
      ),
    );
  } else {
    builder.expect(
      consequence(
        "amenity_resolution_changed",
        `${draft.amenityName} changes for ${listLabels(changed)}`,
        { count: changed.length },
      ),
    );
  }

  return builder.build();
}

export interface ExistingAssignment {
  id: Id;
  amenityId: Id;
  amenityCode: string;
  amenityName: string;
  scope: AmenityScope;
  included: boolean;
}

export function evaluateRemoveAmenityAssignment(
  assignment: ExistingAssignment,
  context: AmenityAssignmentContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("amenity", assignment.amenityId, assignment.amenityName);

  const after = context.existing.filter((item) => item.id !== assignment.id);

  const changed: string[] = [];
  for (const target of context.affectedContexts) {
    const was = resolveAmenities(context.existing, target).find(
      (entry) => entry.amenityCode === assignment.amenityCode,
    );
    const now = resolveAmenities(after, target).find(
      (entry) => entry.amenityCode === assignment.amenityCode,
    );
    // Absent and withheld are different facts -- `resolveAmenities` keeps them
    // apart deliberately -- but they are the same *offer*: the passenger does
    // not get it either way. What changes here is the offer, so both fall to
    // false, and adding a withdrawal over silence correctly counts as nothing.
    if ((was?.included ?? false) !== (now?.included ?? false)) changed.push(target.label);
  }

  builder.expect(
    consequence(
      "amenity_resolution_changed",
      changed.length === 0
        ? `${assignment.amenityName} resolves the same way with or without this row`
        : `${assignment.amenityName} changes for ${listLabels(changed)}`,
      { count: changed.length, related: [subject] },
    ),
  );

  // Removing a withdrawal restores whatever it was suppressing. That is the
  // point of removing it, but it means a passenger starts being promised
  // something again, so it is stated rather than left to be inferred.
  if (!assignment.included && changed.length > 0) {
    builder.expect(
      consequence(
        "amenity_resolution_changed",
        `${assignment.amenityName} becomes offered again wherever a broader level grants it`,
      ),
    );
  }

  return builder.build();
}

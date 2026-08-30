import { describe, expect, it } from "vitest";
import type { AmenityAssignment } from "../amenities.ts";
import {
  evaluateAmenityAssignment,
  evaluateRemoveAmenityAssignment,
  type AmenityAssignmentContext,
  type AmenityAssignmentDraft,
} from "./amenities.ts";

/**
 * The two surprises worth warning about, stated as the situations that produce
 * them rather than as abstract rule pairs.
 */

const AIRCRAFT = "aircraft-1";

const CABINS: AmenityAssignmentContext["affectedContexts"] = [
  { label: "Business", aircraftId: AIRCRAFT, cabinClass: "business" },
  { label: "Economy", aircraftId: AIRCRAFT, cabinClass: "economy" },
];

function assignment(overrides: Partial<AmenityAssignment> & { id: string }): AmenityAssignment {
  return {
    amenityCode: "wifi",
    scope: "aircraft",
    included: true,
    note: null,
    aircraftId: AIRCRAFT,
    cabinClass: null,
    fareProductId: null,
    flightInstanceId: null,
    ...overrides,
  };
}

function draft(overrides: Partial<AmenityAssignmentDraft> = {}): AmenityAssignmentDraft {
  return {
    amenityId: "amenity-wifi",
    amenityCode: "wifi",
    amenityName: "Wi-Fi",
    scope: "aircraft",
    included: true,
    aircraftId: AIRCRAFT,
    cabinClass: null,
    note: null,
    ...overrides,
  };
}

function codes(evaluation: ReturnType<typeof evaluateAmenityAssignment>) {
  return evaluation.findings.map((finding) => finding.code);
}

describe("evaluateAmenityAssignment", () => {
  it("accepts a grant that reaches cabins nothing else covers", () => {
    const result = evaluateAmenityAssignment(draft(), {
      existing: [],
      affectedContexts: CABINS,
    });

    expect(result.findings).toEqual([]);
    expect(result.consequences[0]?.kind).toBe("amenity_resolution_changed");
    expect(result.consequences[0]?.summary).toContain("Business, Economy");
  });

  it("refuses an assignment identical to one already on file", () => {
    const result = evaluateAmenityAssignment(draft(), {
      existing: [assignment({ id: "x" })],
      affectedContexts: CABINS,
    });

    expect(codes(result)).toEqual(["AMENITY_ASSIGNMENT_DUPLICATE"]);
    expect(result.findings[0]?.severity).toBe("blocking");
  });

  it("warns that a withdrawal will beat the grant already there", () => {
    const result = evaluateAmenityAssignment(draft({ included: false }), {
      existing: [assignment({ id: "x", included: true })],
      affectedContexts: CABINS,
    });

    expect(codes(result)).toContain("AMENITY_ASSIGNMENT_CONTRADICTS_EXISTING");
    expect(result.findings[0]?.detail).toContain("withdrawal wins");
    // And it does change what a passenger is told, in both cabins.
    expect(result.consequences[0]?.count).toBe(2);
  });

  it("warns that a grant will NOT beat the withdrawal already there", () => {
    // The asymmetry the tie-break creates, and the one an operator is most
    // likely to get wrong: adding a grant next to a withdrawal does nothing.
    const result = evaluateAmenityAssignment(draft({ included: true }), {
      existing: [assignment({ id: "x", included: false })],
      affectedContexts: CABINS,
    });

    expect(codes(result)).toContain("AMENITY_ASSIGNMENT_CONTRADICTS_EXISTING");
    expect(result.findings[0]?.detail).toContain("Remove the withdrawal instead");
    // Nothing resolves differently, so the second warning fires too.
    expect(codes(result)).toContain("AMENITY_WITHDRAWAL_GRANTS_NOTHING");
    expect(result.consequences).toEqual([]);
  });

  it("warns when a withdrawal has nothing to withhold", () => {
    const result = evaluateAmenityAssignment(draft({ included: false }), {
      existing: [],
      affectedContexts: CABINS,
    });

    expect(codes(result)).toContain("AMENITY_WITHDRAWAL_GRANTS_NOTHING");
    expect(result.findings[0]?.detail).toContain("take effect if a broader grant is added");
  });

  it("counts only the cabins a cabin-scope assignment actually reaches", () => {
    const result = evaluateAmenityAssignment(
      draft({
        amenityCode: "meal_hot",
        amenityName: "Hot meal",
        amenityId: "amenity-meal",
        scope: "cabin",
        aircraftId: null,
        cabinClass: "business",
      }),
      { existing: [], affectedContexts: CABINS },
    );

    expect(result.consequences[0]?.count).toBe(1);
    expect(result.consequences[0]?.summary).toContain("Business");
    expect(result.consequences[0]?.summary).not.toContain("Economy");
  });

  it("treats the same amenity on a different airframe as unrelated", () => {
    const elsewhere = assignment({ id: "x", aircraftId: "aircraft-2" });
    const result = evaluateAmenityAssignment(draft(), {
      existing: [elsewhere],
      affectedContexts: CABINS,
    });

    expect(codes(result)).not.toContain("AMENITY_ASSIGNMENT_DUPLICATE");
    expect(result.findings).toEqual([]);
  });

  it("does not confuse a cabin-scope row with an aircraft-scope one", () => {
    const atCabin = assignment({
      id: "x",
      scope: "cabin",
      aircraftId: null,
      cabinClass: "economy",
    });
    const result = evaluateAmenityAssignment(draft({ scope: "aircraft" }), {
      existing: [atCabin],
      affectedContexts: CABINS,
    });

    expect(codes(result)).not.toContain("AMENITY_ASSIGNMENT_DUPLICATE");
    expect(codes(result)).not.toContain("AMENITY_ASSIGNMENT_CONTRADICTS_EXISTING");
  });
});

describe("evaluateRemoveAmenityAssignment", () => {
  const existing = [assignment({ id: "grant", included: true })];

  it("states which cabins stop offering the amenity", () => {
    const result = evaluateRemoveAmenityAssignment(
      {
        id: "grant",
        amenityId: "amenity-wifi",
        amenityCode: "wifi",
        amenityName: "Wi-Fi",
        scope: "aircraft",
        included: true,
      },
      { existing, affectedContexts: CABINS },
    );

    expect(result.consequences[0]?.count).toBe(2);
    expect(result.consequences[0]?.summary).toContain("Business, Economy");
  });

  it("says that removing a withdrawal starts promising the amenity again", () => {
    const withGrantAndWithdrawal = [
      assignment({ id: "grant", included: true }),
      assignment({ id: "withdrawal", included: false }),
    ];

    const result = evaluateRemoveAmenityAssignment(
      {
        id: "withdrawal",
        amenityId: "amenity-wifi",
        amenityCode: "wifi",
        amenityName: "Wi-Fi",
        scope: "aircraft",
        included: false,
      },
      { existing: withGrantAndWithdrawal, affectedContexts: CABINS },
    );

    expect(result.consequences.map((item) => item.summary).join(" ")).toContain(
      "becomes offered again",
    );
  });

  it("says plainly when removing a row changes nothing", () => {
    const redundant = [
      assignment({ id: "grant", included: true }),
      assignment({ id: "withdrawal", included: false }),
    ];

    // Removing the grant leaves the withdrawal, which was already winning.
    const result = evaluateRemoveAmenityAssignment(
      {
        id: "grant",
        amenityId: "amenity-wifi",
        amenityCode: "wifi",
        amenityName: "Wi-Fi",
        scope: "aircraft",
        included: true,
      },
      { existing: redundant, affectedContexts: CABINS },
    );

    expect(result.consequences[0]?.count).toBe(0);
    expect(result.consequences[0]?.summary).toContain("resolves the same way");
  });
});

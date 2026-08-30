import { describe, expect, it } from "vitest";
import { includedAmenityCodes, resolveAmenities, type AmenityAssignment } from "./amenities.ts";

/**
 * The resolution order is the contract here, so these tests state it in cases
 * an operator would recognise rather than in abstract precedence pairs.
 */

const AIRCRAFT = "aircraft-1";
const FLIGHT = "flight-1";
const FARE = "fare-flex";

function assignment(overrides: Partial<AmenityAssignment> & { id: string }): AmenityAssignment {
  return {
    amenityCode: "WIFI",
    scope: "aircraft",
    included: true,
    note: null,
    aircraftId: null,
    cabinClass: null,
    fareProductId: null,
    flightInstanceId: null,
    ...overrides,
  };
}

const CONTEXT = {
  aircraftId: AIRCRAFT,
  cabinClass: "economy" as const,
  fareProductId: FARE,
  flightInstanceId: FLIGHT,
};

describe("resolveAmenities", () => {
  it("returns nothing when no assignment mentions the amenity", () => {
    expect(resolveAmenities([], CONTEXT)).toEqual([]);
  });

  it("ignores assignments for a different aircraft", () => {
    const other = assignment({ id: "a", aircraftId: "aircraft-2" });
    expect(resolveAmenities([other], CONTEXT)).toEqual([]);
  });

  it("grants an amenity fitted to the airframe", () => {
    const fitted = assignment({ id: "a", aircraftId: AIRCRAFT });
    const [result] = resolveAmenities([fitted], CONTEXT);

    expect(result?.included).toBe(true);
    expect(result?.decidedBy).toBe("aircraft");
    expect(result?.overridden).toHaveLength(0);
  });

  it("lets a flight-level exclusion withhold what the airframe provides", () => {
    // The Wi-Fi is fitted, but it is broken today. That is a flight fact, not
    // a fleet edit.
    const fitted = assignment({ id: "a", aircraftId: AIRCRAFT });
    const brokenToday = assignment({
      id: "b",
      scope: "flight",
      flightInstanceId: FLIGHT,
      included: false,
      note: "Wi-Fi unserviceable, awaiting part",
    });

    const [result] = resolveAmenities([fitted, brokenToday], CONTEXT);

    expect(result?.included).toBe(false);
    expect(result?.decidedBy).toBe("flight");
    expect(result?.note).toBe("Wi-Fi unserviceable, awaiting part");
    // The airframe assignment is still visible, so the operator can see that
    // the aircraft does have Wi-Fi and something overrode it.
    expect(result?.overridden).toEqual([
      { scope: "aircraft", included: true, assignmentId: "a", note: null },
    ]);
  });

  it("orders flight over fare product over cabin over aircraft", () => {
    const all = [
      assignment({ id: "a", scope: "aircraft", aircraftId: AIRCRAFT, included: false }),
      assignment({ id: "b", scope: "cabin", cabinClass: "economy", included: false }),
      assignment({ id: "c", scope: "fare_product", fareProductId: FARE, included: false }),
      assignment({ id: "d", scope: "flight", flightInstanceId: FLIGHT, included: true }),
    ];

    const [result] = resolveAmenities(all, CONTEXT);

    expect(result?.decidedBy).toBe("flight");
    expect(result?.included).toBe(true);
    expect(result?.overridden.map((entry) => entry.scope)).toEqual([
      "fare_product",
      "cabin",
      "aircraft",
    ]);
  });

  it("lets a fare product grant what the cabin does not", () => {
    const cabinDoesNot = assignment({
      id: "a",
      amenityCode: "MEAL",
      scope: "cabin",
      cabinClass: "economy",
      included: false,
    });
    const fareDoes = assignment({
      id: "b",
      amenityCode: "MEAL",
      scope: "fare_product",
      fareProductId: FARE,
      included: true,
    });

    const [result] = resolveAmenities([cabinDoesNot, fareDoes], CONTEXT);

    expect(result?.included).toBe(true);
    expect(result?.decidedBy).toBe("fare_product");
  });

  it("prefers the exclusion when two assignments sit at the same level", () => {
    // A data problem, but it must still resolve, and the safer claim is the
    // one that does not promise something the passenger may not get.
    const grants = assignment({ id: "a", aircraftId: AIRCRAFT, included: true });
    const withholds = assignment({ id: "b", aircraftId: AIRCRAFT, included: false });

    expect(resolveAmenities([grants, withholds], CONTEXT)[0]?.included).toBe(false);
    // Order of the input must not change the answer.
    expect(resolveAmenities([withholds, grants], CONTEXT)[0]?.included).toBe(false);
  });

  it("does not depend on row order when everything else ties", () => {
    const first = assignment({ id: "a", aircraftId: AIRCRAFT });
    const second = assignment({ id: "b", aircraftId: AIRCRAFT });

    expect(resolveAmenities([first, second], CONTEXT)[0]?.decidedByAssignmentId).toBe("a");
    expect(resolveAmenities([second, first], CONTEXT)[0]?.decidedByAssignmentId).toBe("a");
  });

  it("resolves a partial context without inventing matches", () => {
    // Asking what an airframe offers, with no flight or fare in mind.
    const fitted = assignment({ id: "a", aircraftId: AIRCRAFT });
    const flightOnly = assignment({
      id: "b",
      scope: "flight",
      flightInstanceId: FLIGHT,
      included: false,
    });

    const result = resolveAmenities([fitted, flightOnly], { aircraftId: AIRCRAFT });

    expect(result).toHaveLength(1);
    expect(result[0]?.included).toBe(true);
    expect(result[0]?.decidedBy).toBe("aircraft");
  });

  it("sorts by code so the same inputs always read the same way", () => {
    const codes = ["WIFI", "POWER", "IFE"].map((amenityCode, index) =>
      assignment({ id: `a${index}`, amenityCode, aircraftId: AIRCRAFT }),
    );

    expect(resolveAmenities(codes, CONTEXT).map((entry) => entry.amenityCode)).toEqual([
      "IFE",
      "POWER",
      "WIFI",
    ]);
  });
});

describe("includedAmenityCodes", () => {
  it("drops what was withheld rather than reporting it as absent", () => {
    const fitted = assignment({ id: "a", amenityCode: "WIFI", aircraftId: AIRCRAFT });
    const power = assignment({ id: "b", amenityCode: "POWER", aircraftId: AIRCRAFT });
    const broken = assignment({
      id: "c",
      amenityCode: "WIFI",
      scope: "flight",
      flightInstanceId: FLIGHT,
      included: false,
    });

    expect(includedAmenityCodes([fitted, power, broken], CONTEXT)).toEqual(["POWER"]);
  });
});

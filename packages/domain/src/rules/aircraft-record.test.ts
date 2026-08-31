import { describe, expect, it } from "vitest";
import {
  cabinSeatCount,
  draftSeatCapacity,
  evaluateRegisterAircraft,
  formatCabinLayout,
  parseCabinLayout,
  type AircraftDraft,
  type CabinDraft,
  type ExistingAirframe,
} from "./aircraft-record.ts";

const A320 = "type-a320";
const AT76 = "type-at76";
const TODAY = "2026-08-30";

function cabin(overrides: Partial<CabinDraft> = {}): CabinDraft {
  return {
    cabinClass: "economy",
    firstRow: 1,
    lastRow: 25,
    seatLetters: "ABCDEF",
    pitchInches: 30,
    ...overrides,
  };
}

function draft(overrides: Partial<AircraftDraft> = {}): AircraftDraft {
  return {
    registration: "YU-AZZ",
    serialNumber: "9999",
    deliveredOn: "2020-01-01",
    aircraftTypeId: A320,
    cabins: [cabin()],
    ...overrides,
  };
}

const FLEET: ExistingAirframe[] = [
  {
    id: "a-1",
    registration: "YU-APE",
    serialNumber: "1111",
    aircraftTypeId: A320,
    seatCapacity: 148,
    retired: false,
  },
  {
    id: "a-2",
    registration: "YU-APF",
    serialNumber: "2222",
    aircraftTypeId: A320,
    seatCapacity: 148,
    retired: false,
  },
  {
    id: "a-3",
    registration: "YU-ALA",
    serialNumber: "3333",
    aircraftTypeId: AT76,
    seatCapacity: 72,
    retired: false,
  },
];

function codes(evaluation: ReturnType<typeof evaluateRegisterAircraft>) {
  return evaluation.findings.map((finding) => finding.code);
}

function blockingCodes(evaluation: ReturnType<typeof evaluateRegisterAircraft>) {
  return evaluation.findings.filter((f) => f.severity === "blocking").map((f) => f.code);
}

describe("cabinSeatCount", () => {
  it("multiplies rows by letters, and never storing the answer is the point", () => {
    expect(cabinSeatCount(cabin({ firstRow: 1, lastRow: 25, seatLetters: "ABCDEF" }))).toBe(
      150,
    );
    expect(cabinSeatCount(cabin({ firstRow: 1, lastRow: 4, seatLetters: "ACDF" }))).toBe(16);
  });

  it("counts a backwards range as no seats rather than a negative number", () => {
    expect(cabinSeatCount(cabin({ firstRow: 10, lastRow: 4 }))).toBe(0);
  });

  it("sums a whole configuration", () => {
    expect(
      draftSeatCapacity([
        cabin({ cabinClass: "business", firstRow: 1, lastRow: 4, seatLetters: "ACDF" }),
        cabin({ cabinClass: "economy", firstRow: 5, lastRow: 30, seatLetters: "ABCDEF" }),
      ]),
    ).toBe(16 + 156);
  });
});

describe("cabin layout notation", () => {
  it("reads the letters, the aisles and nothing else out of one field", () => {
    expect(parseCabinLayout("ABC-DEF")).toEqual({ letters: "ABCDEF", aisleLetters: "CD" });
    expect(parseCabinLayout("AC-DF")).toEqual({ letters: "ACDF", aisleLetters: "CD" });
    expect(parseCabinLayout("AB-CDEF-GH")).toEqual({
      letters: "ABCDEFGH",
      aisleLetters: "BCFG",
    });
  });

  it("takes the layout however it was typed", () => {
    expect(parseCabinLayout("  abc-def  ")).toEqual({ letters: "ABCDEF", aisleLetters: "CD" });
  });

  it("writes a stored cabin back the way it was typed", () => {
    expect(formatCabinLayout("ABCDEF", "CD")).toBe("ABC-DEF");
    expect(formatCabinLayout("ACDF", "CD")).toBe("AC-DF");
    expect(formatCabinLayout("ABCDEFGH", "BCFG")).toBe("AB-CDEF-GH");
    expect(formatCabinLayout("ABCDEFG", "BCEF")).toBe("AB-CDE-FG");
  });

  it("has no aisle to mark when none was recorded", () => {
    expect(formatCabinLayout("ABCD", "")).toBe("ABCD");
  });

  // Every configuration this fleet flies survives the trip. Offering an
  // existing cabin as a starting point is only honest if it comes back as the
  // aircraft it describes.
  it("round-trips every layout in the fleet", () => {
    for (const layout of ["ABC-DEF", "AC-DF", "AB-CD", "AB-CDE-FG", "AB-CDEF-GH"]) {
      const parsed = parseCabinLayout(layout);
      expect(formatCabinLayout(parsed.letters, parsed.aisleLetters)).toBe(layout);
    }
  });

  // The one shape the stored facts cannot distinguish: a cabin where every
  // seat touches an aisle. The notation changes, the aircraft does not -- same
  // letters, same windows, same seats on an aisle -- and it re-parses to what
  // it came from, which is the property that actually matters.
  it("cannot tell a 1-2-1 cabin from a 1-1-1-1, but round-trips the facts", () => {
    const parsed = parseCabinLayout("A-CD-F");
    expect(formatCabinLayout(parsed.letters, parsed.aisleLetters)).toBe("A-C-D-F");
    expect(parseCabinLayout("A-C-D-F")).toEqual(parsed);
  });
});

describe("evaluateRegisterAircraft", () => {
  it("accepts a well-formed airframe with nothing to say about it", () => {
    const result = evaluateRegisterAircraft(
      draft({
        aircraftTypeId: "type-new",
        cabins: [
          cabin({ cabinClass: "business", firstRow: 1, lastRow: 4, seatLetters: "ACDF" }),
          cabin({ cabinClass: "economy", firstRow: 5, lastRow: 30, seatLetters: "ABCDEF" }),
        ],
      }),
      { existing: FLEET, today: TODAY },
    );

    expect(result.findings).toEqual([]);
    expect(result.consequences[0]?.count).toBe(172);
  });

  it("refuses a registration another airframe already carries", () => {
    const result = evaluateRegisterAircraft(draft({ registration: "YU-APE" }), {
      existing: FLEET,
      today: TODAY,
    });

    expect(blockingCodes(result)).toContain("AIRCRAFT_REGISTRATION_IN_USE");
    expect(result.findings[0]?.subject?.label).toBe("YU-APE");
  });

  it("matches a registration case-insensitively -- a tail number is not case", () => {
    const result = evaluateRegisterAircraft(draft({ registration: "yu-ape" }), {
      existing: FLEET,
      today: TODAY,
    });

    expect(blockingCodes(result)).toContain("AIRCRAFT_REGISTRATION_IN_USE");
  });

  it("lets an airframe keep its own registration when edited", () => {
    const result = evaluateRegisterAircraft(draft({ registration: "YU-APE" }), {
      existing: FLEET,
      today: TODAY,
      editingId: "a-1",
    });

    expect(blockingCodes(result)).not.toContain("AIRCRAFT_REGISTRATION_IN_USE");
  });

  it("warns rather than refuses on a duplicate serial, which is legal across makers", () => {
    const result = evaluateRegisterAircraft(draft({ serialNumber: "1111" }), {
      existing: FLEET,
      today: TODAY,
    });

    expect(blockingCodes(result)).toEqual([]);
    expect(codes(result)).toContain("AIRCRAFT_SERIAL_IN_USE");
  });

  it("notices a registration that breaks the fleet's own prefix", () => {
    const result = evaluateRegisterAircraft(draft({ registration: "YO-AZZ" }), {
      existing: FLEET,
      today: TODAY,
    });

    expect(codes(result)).toContain("AIRCRAFT_REGISTRATION_PREFIX_UNUSUAL");
    expect(result.findings[0]?.detail).toContain("YU-");
  });

  it("says nothing about the prefix when the fleet already uses several", () => {
    const mixed = [
      ...FLEET,
      {
        id: "a-4",
        registration: "9A-ABC",
        serialNumber: "4444",
        aircraftTypeId: A320,
        seatCapacity: 148,
        retired: false,
      },
    ];

    const result = evaluateRegisterAircraft(draft({ registration: "YO-AZZ" }), {
      existing: mixed,
      today: TODAY,
    });

    expect(codes(result)).not.toContain("AIRCRAFT_REGISTRATION_PREFIX_UNUSUAL");
  });

  it("refuses an airframe with no cabins, because capacity is summed from them", () => {
    const result = evaluateRegisterAircraft(draft({ cabins: [] }), {
      existing: FLEET,
      today: TODAY,
    });

    expect(blockingCodes(result)).toContain("AIRCRAFT_NO_CABIN_CONFIGURATION");
    expect(result.consequences).toEqual([]);
  });

  it("refuses the same cabin class twice", () => {
    const result = evaluateRegisterAircraft(
      draft({
        cabins: [
          cabin({ cabinClass: "economy", firstRow: 1, lastRow: 10 }),
          cabin({ cabinClass: "economy", firstRow: 11, lastRow: 20 }),
        ],
      }),
      { existing: FLEET, today: TODAY },
    );

    expect(blockingCodes(result)).toContain("AIRCRAFT_CABIN_LAYOUT_INVALID");
    expect(result.findings.some((f) => f.title.includes("configured twice"))).toBe(true);
  });

  it("refuses overlapping rows -- 12A belongs to one cabin", () => {
    const result = evaluateRegisterAircraft(
      draft({
        cabins: [
          cabin({ cabinClass: "business", firstRow: 1, lastRow: 12, seatLetters: "ACDF" }),
          cabin({ cabinClass: "economy", firstRow: 12, lastRow: 30 }),
        ],
      }),
      { existing: FLEET, today: TODAY },
    );

    expect(result.findings.some((f) => f.title === "Cabin rows overlap")).toBe(true);
  });

  it("allows cabins that merely touch", () => {
    const result = evaluateRegisterAircraft(
      draft({
        aircraftTypeId: "type-new",
        cabins: [
          cabin({ cabinClass: "business", firstRow: 1, lastRow: 11, seatLetters: "ACDF" }),
          cabin({ cabinClass: "economy", firstRow: 12, lastRow: 30 }),
        ],
      }),
      { existing: FLEET, today: TODAY },
    );

    expect(result.findings).toEqual([]);
  });

  it("refuses rows that run backwards", () => {
    const result = evaluateRegisterAircraft(
      draft({ cabins: [cabin({ firstRow: 30, lastRow: 5 })] }),
      { existing: FLEET, today: TODAY },
    );

    expect(result.findings.some((f) => f.title.includes("run backwards"))).toBe(true);
  });

  it("refuses a repeated seat letter, which would duplicate a label in every row", () => {
    const result = evaluateRegisterAircraft(
      draft({ cabins: [cabin({ seatLetters: "ABCDEA" })] }),
      { existing: FLEET, today: TODAY },
    );

    expect(result.findings.some((f) => f.title.includes("repeats a seat letter"))).toBe(true);
  });

  it("refuses seat letters that are not letters", () => {
    const result = evaluateRegisterAircraft(
      draft({ cabins: [cabin({ seatLetters: "AB1D" })] }),
      {
        existing: FLEET,
        today: TODAY,
      },
    );

    expect(result.findings.some((f) => f.title.includes("not letters"))).toBe(true);
  });

  it("warns about a delivery date in the future without refusing it", () => {
    const result = evaluateRegisterAircraft(draft({ deliveredOn: "2027-06-01" }), {
      existing: FLEET,
      today: TODAY,
    });

    expect(blockingCodes(result)).toEqual([]);
    expect(codes(result)).toContain("AIRCRAFT_DELIVERY_DATE_FUTURE");
  });

  it("notices a capacity that disagrees with the rest of the sub-fleet", () => {
    // The other two A320s seat 148; a dropped row here gives 138.
    const result = evaluateRegisterAircraft(
      draft({ cabins: [cabin({ firstRow: 1, lastRow: 23 })] }),
      { existing: FLEET, today: TODAY },
    );

    expect(codes(result)).toContain("AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET");
    expect(result.findings[0]?.title).toContain("148");
  });

  it("says nothing about capacity when the sub-fleet is not uniform", () => {
    const varied: ExistingAirframe[] = [
      { ...FLEET[0]!, seatCapacity: 148 },
      { ...FLEET[1]!, seatCapacity: 156 },
    ];

    const result = evaluateRegisterAircraft(
      draft({ cabins: [cabin({ firstRow: 1, lastRow: 23 })] }),
      { existing: varied, today: TODAY },
    );

    expect(codes(result)).not.toContain("AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET");
  });

  it("says nothing about capacity for the first airframe of a type", () => {
    const result = evaluateRegisterAircraft(draft({ aircraftTypeId: "type-b738" }), {
      existing: FLEET,
      today: TODAY,
    });

    expect(codes(result)).not.toContain("AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET");
  });

  it("raises every applicable finding at once rather than stopping at the first", () => {
    const result = evaluateRegisterAircraft(
      draft({
        registration: "YU-APE",
        deliveredOn: "2027-01-01",
        cabins: [cabin({ seatLetters: "AA" })],
      }),
      { existing: FLEET, today: TODAY },
    );

    expect(codes(result)).toContain("AIRCRAFT_REGISTRATION_IN_USE");
    expect(codes(result)).toContain("AIRCRAFT_CABIN_LAYOUT_INVALID");
    expect(codes(result)).toContain("AIRCRAFT_DELIVERY_DATE_FUTURE");
  });

  it("lets a retired airframe's marks be reused, with a note that they were", () => {
    const withRetired: ExistingAirframe[] = [
      ...FLEET,
      {
        id: "a-old",
        registration: "YU-AZZ",
        serialNumber: "5555",
        aircraftTypeId: A320,
        seatCapacity: 148,
        retired: true,
      },
    ];

    const result = evaluateRegisterAircraft(draft({ registration: "YU-AZZ" }), {
      existing: withRetired,
      today: TODAY,
    });

    expect(blockingCodes(result)).not.toContain("AIRCRAFT_REGISTRATION_IN_USE");
    expect(codes(result)).toContain("AIRCRAFT_REGISTRATION_PREVIOUSLY_USED");
  });

  it("does not let a retired sub-fleet set the expected capacity", () => {
    const withRetired: ExistingAirframe[] = [
      { ...FLEET[0]!, retired: true, seatCapacity: 100 },
      { ...FLEET[1]!, retired: true, seatCapacity: 100 },
    ];

    const result = evaluateRegisterAircraft(draft(), { existing: withRetired, today: TODAY });

    expect(codes(result)).not.toContain("AIRCRAFT_CAPACITY_DIFFERS_FROM_FLEET");
  });
});

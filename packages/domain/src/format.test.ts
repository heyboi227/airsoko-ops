import { describe, expect, it } from "vitest";
import { grouped } from "./format.ts";

describe("grouped", () => {
  it("groups thousands the same way on every host locale", () => {
    // On a workstation set to sr-Latn-RS, `(1004).toLocaleString()` is
    // "1.004", and a finding that says "1.004 kt" reads as one knot and change.
    expect(grouped(1004)).toBe("1,004");
    expect(grouped(3910)).toBe("3,910");
    expect(grouped(251)).toBe("251");
  });

  it("rounds to a whole figure, since every quantity a finding names is one", () => {
    expect(grouped(3910.4)).toBe("3,910");
    expect(grouped(1004.5)).toBe("1,005");
  });
});

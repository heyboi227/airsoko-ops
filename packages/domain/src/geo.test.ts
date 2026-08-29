import { describe, expect, it } from "vitest";
import {
  distanceKm,
  distanceNm,
  greatCirclePath,
  initialBearing,
  interpolateGreatCircle,
  normaliseHeading,
  progressAlong,
} from "./geo.ts";

const BEG = { latitude: 44.8184, longitude: 20.3091 }; // Belgrade Nikola Tesla
const LHR = { latitude: 51.4706, longitude: -0.4619 }; // London Heathrow
const JFK = { latitude: 40.6413, longitude: -73.7781 }; // New York JFK
const NRT = { latitude: 35.7647, longitude: 140.3864 }; // Tokyo Narita
const ANC = { latitude: 61.1743, longitude: -149.9962 }; // Anchorage

describe("distance", () => {
  it("matches published great-circle distances within half a percent", () => {
    // BEG-LHR is about 1690 km; LHR-JFK about 5555 km.
    expect(distanceKm(BEG, LHR)).toBeCloseTo(1690, -2);
    expect(distanceKm(LHR, JFK)).toBeCloseTo(5555, -2);
  });

  it("is symmetric", () => {
    expect(distanceKm(BEG, JFK)).toBeCloseTo(distanceKm(JFK, BEG), 9);
  });

  it("is zero for coincident points", () => {
    expect(distanceKm(BEG, BEG)).toBe(0);
  });

  it("converts to nautical miles", () => {
    expect(distanceNm(BEG, LHR)).toBeCloseTo(distanceKm(BEG, LHR) / 1.852, 6);
  });
});

describe("initialBearing", () => {
  it("points north for a due-north leg", () => {
    expect(
      initialBearing({ latitude: 0, longitude: 0 }, { latitude: 10, longitude: 0 }),
    ).toBeCloseTo(0, 6);
  });

  it("points east for a leg along the equator", () => {
    expect(
      initialBearing({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 10 }),
    ).toBeCloseTo(90, 6);
  });

  it("leaves Belgrade for London on a north-westerly heading", () => {
    const bearing = initialBearing(BEG, LHR);
    expect(bearing).toBeGreaterThan(280);
    expect(bearing).toBeLessThan(320);
  });

  it("always returns a value inside [0, 360)", () => {
    for (const to of [LHR, JFK, NRT, ANC]) {
      const bearing = initialBearing(BEG, to);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    }
  });
});

describe("normaliseHeading", () => {
  it("wraps a full turn to zero", () => {
    expect(normaliseHeading(360)).toBe(0);
    expect(normaliseHeading(720)).toBe(0);
  });

  it("wraps negatives forward", () => {
    expect(normaliseHeading(-90)).toBe(270);
  });
});

describe("interpolateGreatCircle", () => {
  it("returns the endpoints at 0 and 1", () => {
    const start = interpolateGreatCircle(BEG, JFK, 0);
    const end = interpolateGreatCircle(BEG, JFK, 1);
    expect(start.latitude).toBeCloseTo(BEG.latitude, 6);
    expect(start.longitude).toBeCloseTo(BEG.longitude, 6);
    expect(end.latitude).toBeCloseTo(JFK.latitude, 6);
    expect(end.longitude).toBeCloseTo(JFK.longitude, 6);
  });

  it("places the midpoint equidistant from both ends", () => {
    const middle = interpolateGreatCircle(BEG, JFK, 0.5);
    expect(distanceKm(BEG, middle)).toBeCloseTo(distanceKm(middle, JFK), 3);
  });

  it("bows north of the rhumb line on a transatlantic leg", () => {
    // The whole point of a great circle: the midpoint sits well north of the
    // arithmetic mean latitude. If this ever fails we are drawing straight
    // lines on a Mercator projection and calling them routes.
    const middle = interpolateGreatCircle(LHR, JFK, 0.5);
    const meanLatitude = (LHR.latitude + JFK.latitude) / 2;
    expect(middle.latitude).toBeGreaterThan(meanLatitude + 1);
  });

  it("clamps fractions outside the route", () => {
    const before = interpolateGreatCircle(BEG, LHR, -3);
    const after = interpolateGreatCircle(BEG, LHR, 8);
    expect(before.latitude).toBeCloseTo(BEG.latitude, 6);
    expect(after.latitude).toBeCloseTo(LHR.latitude, 6);
  });

  it("survives coincident endpoints without dividing by zero", () => {
    const point = interpolateGreatCircle(BEG, BEG, 0.5);
    expect(point.latitude).toBeCloseTo(BEG.latitude, 9);
    expect(Number.isNaN(point.longitude)).toBe(false);
  });
});

describe("greatCirclePath", () => {
  it("returns a single continuous segment for a route that stays put", () => {
    const path = greatCirclePath(BEG, LHR, 32);
    expect(path).toHaveLength(1);
    expect(path[0]).toHaveLength(32);
  });

  it("emits [longitude, latitude] pairs in GeoJSON order", () => {
    const [first] = greatCirclePath(BEG, LHR, 4);
    expect(first?.[0]?.[0]).toBeCloseTo(BEG.longitude, 6);
    expect(first?.[0]?.[1]).toBeCloseTo(BEG.latitude, 6);
  });

  it("splits at the antimeridian instead of streaking across the map", () => {
    const path = greatCirclePath(NRT, ANC, 64);
    expect(path.length).toBeGreaterThan(1);
    for (const segment of path) {
      for (let i = 1; i < segment.length; i += 1) {
        const previous = segment[i - 1]?.[0] ?? 0;
        const current = segment[i]?.[0] ?? 0;
        expect(Math.abs(current - previous)).toBeLessThan(180);
      }
    }
  });
});

describe("progressAlong", () => {
  it("is zero at the origin and one at the destination", () => {
    expect(progressAlong(BEG, LHR, BEG)).toBe(0);
    expect(progressAlong(BEG, LHR, LHR)).toBeCloseTo(1, 6);
  });

  it("is a half at the midpoint", () => {
    const middle = interpolateGreatCircle(BEG, LHR, 0.5);
    expect(progressAlong(BEG, LHR, middle)).toBeCloseTo(0.5, 3);
  });

  it("never exceeds one, even past the destination", () => {
    const beyond = interpolateGreatCircle(BEG, LHR, 1);
    expect(progressAlong(BEG, LHR, beyond)).toBeLessThanOrEqual(1);
  });
});

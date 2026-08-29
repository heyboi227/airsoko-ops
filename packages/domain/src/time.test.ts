import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  addMinutes,
  formatLocalDate,
  formatLocalTime,
  formatOffset,
  gapMinutes,
  intervalsOverlap,
  localDateRange,
  minutesBetween,
  offsetMinutesInZone,
  partsInZone,
  weekdayInZone,
  zonedTimeToInstant,
} from "./time.ts";

const BELGRADE = "Europe/Belgrade";
const KOLKATA = "Asia/Kolkata";
const KIRITIMATI = "Pacific/Kiritimati";
const LOS_ANGELES = "America/Los_Angeles";

describe("interval arithmetic", () => {
  const morning = { start: "2026-08-29T06:00:00.000Z", end: "2026-08-29T08:00:00.000Z" };

  it("detects a genuine overlap", () => {
    expect(
      intervalsOverlap(morning, {
        start: "2026-08-29T07:30:00.000Z",
        end: "2026-08-29T09:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("treats touching intervals as not overlapping", () => {
    // An arrival at 08:00 and a departure at 08:00 is a turnaround problem,
    // not a double-booking. Conflating them would produce the wrong message.
    expect(
      intervalsOverlap(morning, {
        start: "2026-08-29T08:00:00.000Z",
        end: "2026-08-29T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("detects full containment in both directions", () => {
    const inner = { start: "2026-08-29T06:30:00.000Z", end: "2026-08-29T07:00:00.000Z" };
    expect(intervalsOverlap(morning, inner)).toBe(true);
    expect(intervalsOverlap(inner, morning)).toBe(true);
  });

  it("measures the gap between consecutive intervals", () => {
    expect(
      gapMinutes(morning, {
        start: "2026-08-29T08:45:00.000Z",
        end: "2026-08-29T10:00:00.000Z",
      }),
    ).toBe(45);
  });

  it("reports a negative gap when intervals overlap", () => {
    expect(
      gapMinutes(morning, {
        start: "2026-08-29T07:30:00.000Z",
        end: "2026-08-29T09:00:00.000Z",
      }),
    ).toBe(-30);
  });

  it("adds and subtracts minutes symmetrically", () => {
    const later = addMinutes(morning.start, 135);
    expect(minutesBetween(morning.start, later)).toBe(135);
    expect(minutesBetween(later, morning.start)).toBe(-135);
  });
});

describe("offsets", () => {
  it("reads Belgrade as UTC+1 in winter and UTC+2 in summer", () => {
    expect(offsetMinutesInZone("2026-01-15T12:00:00.000Z", BELGRADE)).toBe(60);
    expect(offsetMinutesInZone("2026-07-15T12:00:00.000Z", BELGRADE)).toBe(120);
  });

  it("handles half-hour zones", () => {
    expect(offsetMinutesInZone("2026-07-15T12:00:00.000Z", KOLKATA)).toBe(330);
  });

  it("handles the far side of the date line", () => {
    expect(offsetMinutesInZone("2026-07-15T12:00:00.000Z", KIRITIMATI)).toBe(840);
  });

  it("formats offsets the way operations staff write them", () => {
    expect(formatOffset(120)).toBe("+02:00");
    expect(formatOffset(330)).toBe("+05:30");
    expect(formatOffset(-300)).toBe("-05:00");
    expect(formatOffset(0)).toBe("+00:00");
  });
});

describe("local rendering", () => {
  it("renders an instant in the airport's own clock", () => {
    // 05:45Z is 07:45 in Belgrade during summer time.
    expect(formatLocalTime("2026-07-15T05:45:00.000Z", BELGRADE)).toBe("07:45");
    expect(formatLocalDate("2026-07-15T05:45:00.000Z", BELGRADE)).toBe("2026-07-15");
  });

  it("rolls the local date backwards west of the meridian", () => {
    // Just after midnight UTC is still the previous evening in California.
    expect(formatLocalDate("2026-07-15T02:00:00.000Z", LOS_ANGELES)).toBe("2026-07-14");
    expect(formatLocalTime("2026-07-15T02:00:00.000Z", LOS_ANGELES)).toBe("19:00");
  });

  it("renders midnight as 00:00, not 24:00", () => {
    expect(formatLocalTime("2026-07-14T22:00:00.000Z", BELGRADE)).toBe("00:00");
    expect(partsInZone("2026-07-14T22:00:00.000Z", BELGRADE).hour).toBe(0);
  });

  it("reports the weekday the airport is having, not the UTC one", () => {
    // Monday 01:00 UTC is still Sunday evening in Los Angeles.
    const instant = "2026-07-13T01:00:00.000Z";
    expect(weekdayInZone(instant, BELGRADE)).toBe(1);
    expect(weekdayInZone(instant, LOS_ANGELES)).toBe(0);
  });
});

describe("zonedTimeToInstant", () => {
  it("resolves a scheduled departure to the right instant in winter and summer", () => {
    // This is the whole reason the function exists. A 07:45 Belgrade departure
    // is a different instant either side of the DST change, and a recurring
    // schedule that ignores this silently shifts every flight by an hour.
    const winter = zonedTimeToInstant("2026-01-15", "07:45", BELGRADE);
    const summer = zonedTimeToInstant("2026-07-15", "07:45", BELGRADE);

    expect(winter.instant).toBe("2026-01-15T06:45:00.000Z");
    expect(winter.resolution).toBe("exact");
    expect(summer.instant).toBe("2026-07-15T05:45:00.000Z");
    expect(summer.resolution).toBe("exact");
  });

  it("round-trips through the local formatter", () => {
    for (const date of ["2026-01-15", "2026-05-02", "2026-11-30"]) {
      const { instant } = zonedTimeToInstant(date, "07:45", BELGRADE);
      expect(formatLocalTime(instant, BELGRADE)).toBe("07:45");
      expect(formatLocalDate(instant, BELGRADE)).toBe(date);
    }
  });

  it("shifts a departure scheduled inside the spring-forward gap", () => {
    // Belgrade clocks jump 02:00 -> 03:00 on 2026-03-29, so 02:30 never happens.
    const result = zonedTimeToInstant("2026-03-29", "02:30", BELGRADE);
    expect(result.resolution).toBe("gap_shifted_forward");
    // 01:30Z is 03:30 local -- the first valid moment matching the request.
    expect(result.instant).toBe("2026-03-29T01:30:00.000Z");
    expect(formatLocalTime(result.instant, BELGRADE)).toBe("03:30");
  });

  it("takes the earlier of two readings in the autumn overlap", () => {
    // Belgrade clocks fall 03:00 -> 02:00 on 2026-10-25, so 02:30 happens twice.
    const result = zonedTimeToInstant("2026-10-25", "02:30", BELGRADE);
    expect(result.resolution).toBe("ambiguous_took_earlier");
    // The first 02:30 is still CEST (UTC+2), so 00:30Z.
    expect(result.instant).toBe("2026-10-25T00:30:00.000Z");
    expect(formatLocalTime(result.instant, BELGRADE)).toBe("02:30");
  });

  it("keeps a whole DST week of departures at the same local time", () => {
    // Seven consecutive 07:45 departures across the transition. Every one must
    // read 07:45 locally; the underlying instants shift by an hour mid-week.
    const dates = localDateRange("2026-03-26", "2026-04-01");
    const instants = dates.map((date) => zonedTimeToInstant(date, "07:45", BELGRADE).instant);

    for (const instant of instants) {
      expect(formatLocalTime(instant, BELGRADE)).toBe("07:45");
    }
    expect(instants[0]).toBe("2026-03-26T06:45:00.000Z");
    expect(instants.at(-1)).toBe("2026-04-01T05:45:00.000Z");
  });

  it("handles zones with a half-hour offset", () => {
    const result = zonedTimeToInstant("2026-07-15", "09:15", KOLKATA);
    expect(result.instant).toBe("2026-07-15T03:45:00.000Z");
    expect(formatLocalTime(result.instant, KOLKATA)).toBe("09:15");
  });

  it("handles UTC itself", () => {
    const result = zonedTimeToInstant("2026-07-15", "13:00", "UTC");
    expect(result.instant).toBe("2026-07-15T13:00:00.000Z");
    expect(result.resolution).toBe("exact");
  });
});

describe("calendar helpers", () => {
  it("adds days across a month boundary", () => {
    expect(addLocalDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("builds an inclusive range", () => {
    expect(localDateRange("2026-08-29", "2026-09-01")).toEqual([
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
    ]);
  });

  it("returns a single day when start equals end", () => {
    expect(localDateRange("2026-08-29", "2026-08-29")).toEqual(["2026-08-29"]);
  });

  it("returns nothing for an inverted range rather than looping", () => {
    expect(localDateRange("2026-09-01", "2026-08-29")).toEqual([]);
  });
});

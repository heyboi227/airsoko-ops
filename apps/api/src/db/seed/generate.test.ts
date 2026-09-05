import { describe, expect, it } from "vitest";
import {
  TIMETABLE_GRID_MINUTES,
  addLocalDays,
  addMinutes,
  minutesBetween,
  zonedTimeToInstant,
} from "@airsoko/domain";
import { SEED_AIRCRAFT_TYPES } from "./reference/fleet.ts";
import { resolveStations } from "./reference/index.ts";
import { buildFlights, buildRoutes, buildSchedules } from "./generate.ts";

/**
 * A fixed operating day, so these assertions are about the generator and not
 * about the calendar. The window it opens straddles nothing unusual; the grid
 * holds across a DST change regardless, because every zone offset the network
 * touches is a whole quarter of an hour.
 */
const REFERENCE_DATE = "2026-09-05";
const NOW = "2026-09-05T12:00:00.000Z";

const stations = resolveStations();
const byIata = new Map(stations.map((station) => [station.iataCode, station]));
const routes = buildRoutes(stations);
const schedules = buildSchedules(routes, stations, REFERENCE_DATE);
const flights = buildFlights(schedules, stations, REFERENCE_DATE, NOW);

const minuteOfLocal = (localTime: string): number => Number(localTime.slice(3, 5));
const minuteOfInstant = (instant: string): number => new Date(instant).getUTCMinutes();
const onGrid = (minute: number): boolean => minute % TIMETABLE_GRID_MINUTES === 0;

describe("the seeded timetable", () => {
  it("generates a network worth asserting over", () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(schedules.length).toBeGreaterThan(0);
    expect(flights.length).toBeGreaterThan(0);
  });

  it("plans every route's block to the five minutes a timetable publishes", () => {
    const offGrid = routes
      .filter((route) => !onGrid(route.blockMinutes))
      .map((route) => `${route.originIata}-${route.destinationIata} ${route.blockMinutes}`);
    expect(offGrid).toEqual([]);
  });

  it("publishes every departure and arrival on the grid, return legs included", () => {
    const offGrid = schedules
      .filter(
        (schedule) =>
          !onGrid(minuteOfLocal(schedule.departureLocalTime)) ||
          !onGrid(minuteOfLocal(schedule.arrivalLocalTime)),
      )
      .map((s) => `${s.flightNumber} ${s.departureLocalTime}-${s.arrivalLocalTime}`);
    expect(offGrid).toEqual([]);
  });

  it("files every scheduled instant on the grid across the whole window", () => {
    const offGrid = flights
      .filter(
        (flight) =>
          !onGrid(minuteOfInstant(flight.scheduledDeparture)) ||
          !onGrid(minuteOfInstant(flight.scheduledArrival)),
      )
      .map((f) => `${f.flightNumber} ${f.serviceDate} ${f.scheduledDeparture}`);
    expect(offGrid).toEqual([]);
  });

  it("still gives the return leg at least the type's minimum turnaround", () => {
    // Snapping the return departure onto the grid must only ever move it
    // later. Rounding to nearest would shave up to two minutes off a
    // turnaround that is already the minimum the type allows.
    const turnaroundByType = new Map(
      SEED_AIRCRAFT_TYPES.map((type) => [type.icaoTypeCode, type.minimumTurnaroundMinutes]),
    );
    const byFlightNumber = new Map(
      schedules.map((schedule) => [schedule.flightNumber, schedule]),
    );

    const tooTight: string[] = [];
    for (const outbound of schedules) {
      const number = Number(outbound.flightNumber.slice(2));
      if (number % 2 !== 0) continue;
      const back = byFlightNumber.get(`SO${number + 1}`);
      const origin = byIata.get(outbound.originIata);
      const destination = byIata.get(outbound.destinationIata);
      if (!back || !origin || !destination) continue;

      const outDeparture = zonedTimeToInstant(
        REFERENCE_DATE,
        outbound.departureLocalTime,
        origin.timeZone,
      ).instant;
      const outArrival = addMinutes(outDeparture, outbound.blockMinutes);
      const backDeparture = zonedTimeToInstant(
        addLocalDays(REFERENCE_DATE, outbound.arrivalDayOffset),
        back.departureLocalTime,
        destination.timeZone,
      ).instant;

      // The return may leave on the day after the outbound arrives, when the
      // turnaround runs past midnight; a day's wrap keeps the gap honest.
      const gap = ((minutesBetween(outArrival, backDeparture) % 1440) + 1440) % 1440;
      const turnaround = turnaroundByType.get(outbound.plannedTypeCode) ?? 0;
      if (gap < turnaround) {
        tooTight.push(`${outbound.flightNumber}/${back.flightNumber} ${gap} < ${turnaround}`);
      }
    }
    expect(tooTight).toEqual([]);
  });
});

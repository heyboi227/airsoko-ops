/**
 * Air Soko's commercial plan: where it flies from Belgrade, how often, and on
 * what.
 *
 * This is the airline's own decision-making, so it is authored rather than
 * derived. Everything downstream -- routes, recurring schedules, dated flight
 * instances and the aircraft rotations that operate them -- is generated from
 * this table, which keeps the whole operation consistent by construction: a
 * frequency changed here changes the schedule, the flights and the rotation
 * together.
 *
 * Flight numbers are allocated in blocks so a number is readable on its own:
 *
 *   SO1xx  regional turboprop
 *   SO2xx  European narrow-body, central and eastern
 *   SO3xx  European narrow-body, western and southern
 *   SO4xx  European narrow-body, northern
 *   SO5xx  long haul
 *
 * Outbound from Belgrade is the allocated number; the return leg is that
 * number plus one, which is the convention most European carriers use.
 */

/**
 * The marketing code every flight number carries. The airline row, the
 * schedules and the flights all read it from here, so the code appears once
 * rather than being spelled into each of them.
 */
export const MARKETING_CODE = "SO";

export type Equipment = "turboprop" | "narrow_body" | "wide_body";

export interface PlannedRoute {
  /** Station code. The other end is always the hub unless `origin` says otherwise. */
  destination: string;
  /** Defaults to BEG. Set for the Tivat-based summer programme. */
  origin?: string;
  /** Outbound flight number; the return is this plus one. */
  flightNumber: number;
  /** Departures per day in each direction. */
  frequency: 1 | 2 | 3;
  equipment: Equipment;
  /** Days of week this operates, Sunday-first. Absent means daily. */
  operatingDays?: readonly boolean[];
  season?: string;
}

/** Sun Mon Tue Wed Thu Fri Sat */
const WEEKDAYS = [false, true, true, true, true, true, false] as const;
const MON_WED_FRI_SUN = [true, true, false, true, false, true, false] as const;
const TUE_THU_SAT = [false, false, true, false, true, false, true] as const;
const WEEKEND_PLUS = [true, false, true, false, true, false, true] as const;
const MON_THU = [false, true, false, false, true, false, false] as const;
const TUE_FRI = [false, false, true, false, false, true, false] as const;
const WED_SAT = [false, false, false, true, false, false, true] as const;
const SUN_WED = [true, false, false, true, false, false, false] as const;

export const NETWORK_PLAN: readonly PlannedRoute[] = [
  // --- Regional turboprop, SO1xx -------------------------------------------
  { destination: "SJJ", flightNumber: 100, frequency: 2, equipment: "turboprop" },
  { destination: "SKP", flightNumber: 102, frequency: 2, equipment: "turboprop" },
  { destination: "TIA", flightNumber: 104, frequency: 1, equipment: "turboprop" },
  { destination: "TIV", flightNumber: 106, frequency: 2, equipment: "turboprop" },
  { destination: "LJU", flightNumber: 108, frequency: 1, equipment: "turboprop" },
  {
    destination: "OTP",
    flightNumber: 110,
    frequency: 1,
    equipment: "turboprop",
    operatingDays: WEEKDAYS,
  },
  // The Niš programme: a second Serbian base that is not the hub, so the
  // rotation builder has to cope with an aircraft that does not start at BEG.
  // Jasenica lives here and cannot reach Belgrade -- there is no BEG-INI
  // sector, because 206 km is a drive -- so these three and their returns are
  // the whole of what it flies.
  {
    destination: "VIE",
    origin: "INI",
    flightNumber: 114,
    frequency: 1,
    equipment: "turboprop",
    operatingDays: MON_WED_FRI_SUN,
  },
  {
    destination: "ZAG",
    origin: "INI",
    flightNumber: 116,
    frequency: 1,
    equipment: "turboprop",
    operatingDays: TUE_THU_SAT,
  },
  {
    destination: "TIV",
    origin: "INI",
    flightNumber: 118,
    frequency: 1,
    equipment: "turboprop",
    operatingDays: WEEKEND_PLUS,
    season: "Summer",
  },

  // --- European narrow-body, central and eastern, SO2xx ---------------------
  { destination: "VIE", flightNumber: 200, frequency: 3, equipment: "narrow_body" },
  { destination: "MUC", flightNumber: 202, frequency: 2, equipment: "narrow_body" },
  { destination: "FRA", flightNumber: 204, frequency: 2, equipment: "narrow_body" },
  { destination: "ZRH", flightNumber: 206, frequency: 2, equipment: "narrow_body" },
  { destination: "PRG", flightNumber: 208, frequency: 1, equipment: "narrow_body" },
  {
    destination: "WAW",
    flightNumber: 210,
    frequency: 1,
    equipment: "narrow_body",
    operatingDays: WEEKDAYS,
  },
  { destination: "BUD", flightNumber: 212, frequency: 1, equipment: "narrow_body" },
  { destination: "SOF", flightNumber: 214, frequency: 1, equipment: "narrow_body" },
  { destination: "ZAG", flightNumber: 216, frequency: 1, equipment: "narrow_body" },

  // --- European narrow-body, western and southern, SO3xx -------------------
  { destination: "CDG", flightNumber: 300, frequency: 2, equipment: "narrow_body" },
  { destination: "AMS", flightNumber: 302, frequency: 2, equipment: "narrow_body" },
  {
    destination: "BRU",
    flightNumber: 304,
    frequency: 1,
    equipment: "narrow_body",
    operatingDays: WEEKDAYS,
  },
  { destination: "LHR", flightNumber: 306, frequency: 2, equipment: "narrow_body" },
  { destination: "FCO", flightNumber: 308, frequency: 2, equipment: "narrow_body" },
  { destination: "MXP", flightNumber: 310, frequency: 2, equipment: "narrow_body" },
  { destination: "BCN", flightNumber: 312, frequency: 1, equipment: "narrow_body" },
  {
    destination: "MAD",
    flightNumber: 314,
    frequency: 1,
    equipment: "narrow_body",
    operatingDays: MON_WED_FRI_SUN,
  },
  { destination: "ATH", flightNumber: 316, frequency: 2, equipment: "narrow_body" },
  { destination: "IST", flightNumber: 318, frequency: 2, equipment: "narrow_body" },

  // --- European narrow-body, northern, SO4xx -------------------------------
  { destination: "CPH", flightNumber: 400, frequency: 1, equipment: "narrow_body" },
  {
    destination: "ARN",
    flightNumber: 402,
    frequency: 1,
    equipment: "narrow_body",
    operatingDays: MON_WED_FRI_SUN,
  },
  {
    destination: "OSL",
    flightNumber: 404,
    frequency: 1,
    equipment: "narrow_body",
    operatingDays: TUE_THU_SAT,
  },

  // --- Long haul, SO5xx ----------------------------------------------------
  { destination: "JFK", flightNumber: 500, frequency: 1, equipment: "wide_body" },
  {
    destination: "ORD",
    flightNumber: 502,
    frequency: 1,
    equipment: "wide_body",
    operatingDays: MON_THU,
  },
  {
    destination: "YYZ",
    flightNumber: 504,
    frequency: 1,
    equipment: "wide_body",
    operatingDays: TUE_FRI,
  },
  { destination: "DXB", flightNumber: 506, frequency: 1, equipment: "narrow_body" },
  {
    destination: "BOM",
    flightNumber: 508,
    frequency: 1,
    equipment: "wide_body",
    operatingDays: WED_SAT,
  },
  {
    destination: "PEK",
    flightNumber: 510,
    frequency: 1,
    equipment: "wide_body",
    operatingDays: SUN_WED,
  },
  {
    destination: "GRU",
    flightNumber: 512,
    frequency: 1,
    equipment: "wide_body",
    operatingDays: WED_SAT,
  },
];

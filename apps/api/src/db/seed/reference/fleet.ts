import type { AircraftBodyType, CabinClass } from "@airsoko/contracts";

/**
 * The Air Soko fleet.
 *
 * Unlike airports, this is not sourced from anywhere -- it is the airline's own
 * property, so it is authored. The figures are representative of the real
 * types: range and cruise speed are close enough for planning checks, and the
 * cabin layouts are plausible two- and three-class European configurations.
 *
 * An all-Airbus narrow-body fleet with a turboprop for thin regional routes
 * and a small wide-body sub-fleet for long haul is the shape a carrier this
 * size actually takes -- common ratings across A319/A320/A320neo are most of
 * why, and Phase 5's crew rules will lean on exactly that.
 */

export interface SeedAircraftType {
  icaoTypeCode: string;
  iataTypeCode: string;
  manufacturer: string;
  model: string;
  variant: string | null;
  bodyType: AircraftBodyType;
  engineModel: string;
  rangeNm: number;
  cruiseSpeedKts: number;
  serviceCeilingFt: number;
  minimumTurnaroundMinutes: number;
  cabins: SeedCabin[];
}

export interface SeedCabin {
  cabinClass: CabinClass;
  firstRow: number;
  lastRow: number;
  /** Seat letters present in this cabin, in order. */
  seatLetters: string;
  /**
   * Letters that sit on an aisle. Stated rather than inferred: 3-3, 2-2 and
   * 2-4-2 all put the aisle in a different place, and a passenger who booked
   * an aisle seat and got a middle one has a real complaint.
   */
  aisleLetters: string;
  pitchInches: number;
  /** Rows in this cabin that sit at an overwing exit. */
  exitRows?: number[];
}

export const SEED_AIRCRAFT_TYPES: readonly SeedAircraftType[] = [
  {
    icaoTypeCode: "A319",
    iataTypeCode: "319",
    manufacturer: "Airbus",
    model: "A319",
    variant: "100",
    bodyType: "narrow_body",
    engineModel: "CFM56-5B6",
    rangeNm: 3750,
    cruiseSpeedKts: 447,
    serviceCeilingFt: 39100,
    minimumTurnaroundMinutes: 35,
    cabins: [
      {
        cabinClass: "business",
        firstRow: 1,
        lastRow: 3,
        seatLetters: "ACDF",
        aisleLetters: "CD",
        pitchInches: 34,
      },
      {
        cabinClass: "economy",
        firstRow: 4,
        lastRow: 22,
        aisleLetters: "CD",
        seatLetters: "ABCDEF",
        pitchInches: 30,
        exitRows: [10, 11],
      },
    ],
  },
  {
    icaoTypeCode: "A320",
    iataTypeCode: "320",
    manufacturer: "Airbus",
    model: "A320",
    variant: "200",
    bodyType: "narrow_body",
    engineModel: "CFM56-5B4",
    rangeNm: 3300,
    cruiseSpeedKts: 447,
    serviceCeilingFt: 39100,
    minimumTurnaroundMinutes: 35,
    cabins: [
      {
        cabinClass: "business",
        firstRow: 1,
        lastRow: 4,
        seatLetters: "ACDF",
        aisleLetters: "CD",
        pitchInches: 34,
      },
      {
        cabinClass: "economy",
        firstRow: 5,
        lastRow: 26,
        aisleLetters: "CD",
        seatLetters: "ABCDEF",
        pitchInches: 30,
        exitRows: [12, 13],
      },
    ],
  },
  {
    icaoTypeCode: "A20N",
    iataTypeCode: "32N",
    manufacturer: "Airbus",
    model: "A320neo",
    variant: null,
    bodyType: "narrow_body",
    engineModel: "LEAP-1A26",
    rangeNm: 3500,
    cruiseSpeedKts: 455,
    serviceCeilingFt: 39800,
    minimumTurnaroundMinutes: 35,
    cabins: [
      {
        cabinClass: "business",
        firstRow: 1,
        lastRow: 4,
        seatLetters: "ACDF",
        aisleLetters: "CD",
        pitchInches: 34,
      },
      {
        cabinClass: "economy",
        firstRow: 5,
        lastRow: 30,
        aisleLetters: "CD",
        seatLetters: "ABCDEF",
        pitchInches: 30,
        exitRows: [14, 15],
      },
    ],
  },
  {
    icaoTypeCode: "AT76",
    iataTypeCode: "AT7",
    manufacturer: "ATR",
    model: "ATR 72",
    variant: "600",
    bodyType: "regional",
    engineModel: "PW127M",
    // The range constraint that makes the regional sub-fleet interesting: it
    // physically cannot fly most of the network, which is a real conflict for
    // the aircraft-assignment rules to catch.
    rangeNm: 825,
    cruiseSpeedKts: 275,
    serviceCeilingFt: 25000,
    minimumTurnaroundMinutes: 25,
    cabins: [
      {
        cabinClass: "economy",
        firstRow: 1,
        lastRow: 18,
        aisleLetters: "BC",
        seatLetters: "ABCD",
        pitchInches: 30,
        exitRows: [11],
      },
    ],
  },
  {
    icaoTypeCode: "A332",
    iataTypeCode: "332",
    manufacturer: "Airbus",
    model: "A330",
    variant: "200",
    bodyType: "wide_body",
    engineModel: "Trent 772B-60",
    rangeNm: 7250,
    cruiseSpeedKts: 470,
    serviceCeilingFt: 41100,
    minimumTurnaroundMinutes: 75,
    cabins: [
      {
        cabinClass: "business",
        firstRow: 1,
        lastRow: 5,
        seatLetters: "ACDF",
        aisleLetters: "CD",
        pitchInches: 60,
      },
      {
        cabinClass: "premium_economy",
        firstRow: 10,
        lastRow: 12,
        aisleLetters: "BCEF",
        seatLetters: "ABCDEFG",
        pitchInches: 38,
      },
      {
        cabinClass: "economy",
        firstRow: 20,
        lastRow: 45,
        aisleLetters: "BCFG",
        seatLetters: "ABCDEFGH",
        pitchInches: 31,
        exitRows: [30, 31],
      },
    ],
  },
];

export interface SeedAircraft {
  registration: string;
  icaoTypeCode: string;
  serialNumber: string;
  /** Air Soko names its aircraft after Serbian rivers. */
  name: string;
  deliveredOn: string;
  /** Where the tail sits at the start of the seeded day. */
  baseIata: string;
  /** Airframes deliberately unavailable, so the conflict rules have something to catch. */
  unavailable?: { status: "maintenance" | "stored"; note: string };
}

export const SEED_AIRCRAFT: readonly SeedAircraft[] = [
  // --- A319 -----------------------------------------------------------------
  {
    registration: "YU-APA",
    icaoTypeCode: "A319",
    serialNumber: "3211",
    name: "Dunav",
    deliveredOn: "2014-03-18",
    baseIata: "BEG",
  },
  {
    registration: "YU-APB",
    icaoTypeCode: "A319",
    serialNumber: "3348",
    name: "Sava",
    deliveredOn: "2014-07-02",
    baseIata: "BEG",
  },
  {
    registration: "YU-APC",
    icaoTypeCode: "A319",
    serialNumber: "3502",
    name: "Morava",
    deliveredOn: "2015-01-27",
    baseIata: "BEG",
  },
  {
    registration: "YU-APD",
    icaoTypeCode: "A319",
    serialNumber: "3677",
    name: "Drina",
    deliveredOn: "2015-06-11",
    baseIata: "BEG",
    unavailable: {
      status: "maintenance",
      note: "C-check, hangar 2. Out of service until further notice.",
    },
  },

  // --- A320 -----------------------------------------------------------------
  {
    registration: "YU-APE",
    icaoTypeCode: "A320",
    serialNumber: "4112",
    name: "Tisa",
    deliveredOn: "2016-02-09",
    baseIata: "BEG",
  },
  {
    registration: "YU-APF",
    icaoTypeCode: "A320",
    serialNumber: "4290",
    name: "Timok",
    deliveredOn: "2016-09-23",
    baseIata: "BEG",
  },
  {
    registration: "YU-APG",
    icaoTypeCode: "A320",
    serialNumber: "4455",
    name: "Ibar",
    deliveredOn: "2017-04-05",
    baseIata: "BEG",
  },
  {
    registration: "YU-APH",
    icaoTypeCode: "A320",
    serialNumber: "4618",
    name: "Nisava",
    deliveredOn: "2017-11-14",
    baseIata: "BEG",
  },
  {
    registration: "YU-API",
    icaoTypeCode: "A320",
    serialNumber: "4801",
    name: "Kolubara",
    deliveredOn: "2018-05-30",
    baseIata: "BEG",
  },
  {
    registration: "YU-APJ",
    icaoTypeCode: "A320",
    serialNumber: "4977",
    name: "Tamis",
    deliveredOn: "2018-12-08",
    baseIata: "BEG",
  },

  // Three more added once the schedule was built: at twenty-one tails the
  // rotation left around eighteen sectors a day without an aircraft, which is
  // a fleet-planning answer rather than a scheduling one. Twenty-four is what
  // this network actually needs, and still inside the brief's 15-30.
  {
    registration: "YU-APK",
    icaoTypeCode: "A320",
    serialNumber: "5140",
    name: "Resava",
    deliveredOn: "2019-04-16",
    baseIata: "BEG",
  },
  {
    registration: "YU-APL",
    icaoTypeCode: "A320",
    serialNumber: "5288",
    name: "Nera",
    deliveredOn: "2019-10-02",
    baseIata: "BEG",
  },
  {
    registration: "YU-APM",
    icaoTypeCode: "A320",
    serialNumber: "5433",
    name: "Karas",
    deliveredOn: "2020-06-24",
    baseIata: "BEG",
  },

  // --- A320neo --------------------------------------------------------------
  {
    registration: "YU-ANA",
    icaoTypeCode: "A20N",
    serialNumber: "9204",
    name: "Begej",
    deliveredOn: "2021-06-17",
    baseIata: "BEG",
  },
  {
    registration: "YU-ANB",
    icaoTypeCode: "A20N",
    serialNumber: "9388",
    name: "Zapadna Morava",
    deliveredOn: "2021-10-29",
    baseIata: "BEG",
  },
  {
    registration: "YU-ANC",
    icaoTypeCode: "A20N",
    serialNumber: "9571",
    name: "Juzna Morava",
    deliveredOn: "2022-04-12",
    baseIata: "BEG",
  },
  {
    registration: "YU-AND",
    icaoTypeCode: "A20N",
    serialNumber: "9760",
    name: "Velika Morava",
    deliveredOn: "2022-09-26",
    baseIata: "BEG",
  },

  // --- ATR 72 ---------------------------------------------------------------
  {
    registration: "YU-ALA",
    icaoTypeCode: "AT76",
    serialNumber: "1204",
    name: "Toplica",
    deliveredOn: "2019-03-21",
    baseIata: "BEG",
  },
  {
    registration: "YU-ALB",
    icaoTypeCode: "AT76",
    serialNumber: "1288",
    name: "Rasina",
    deliveredOn: "2019-08-14",
    baseIata: "BEG",
  },
  {
    registration: "YU-ALC",
    icaoTypeCode: "AT76",
    serialNumber: "1355",
    name: "Jasenica",
    deliveredOn: "2020-02-06",
    baseIata: "TIV",
  },
  {
    registration: "YU-ALD",
    icaoTypeCode: "AT76",
    serialNumber: "1421",
    name: "Lim",
    deliveredOn: "2020-11-19",
    baseIata: "BEG",
    unavailable: { status: "stored", note: "Stored pending engine availability." },
  },

  // --- A330 -----------------------------------------------------------------
  {
    registration: "YU-ARA",
    icaoTypeCode: "A332",
    serialNumber: "1502",
    name: "Uvac",
    deliveredOn: "2020-07-30",
    baseIata: "BEG",
  },
  {
    registration: "YU-ARB",
    icaoTypeCode: "A332",
    serialNumber: "1618",
    name: "Mlava",
    deliveredOn: "2021-12-03",
    baseIata: "BEG",
  },
  {
    registration: "YU-ARC",
    icaoTypeCode: "A332",
    serialNumber: "1744",
    name: "Pek",
    deliveredOn: "2023-05-18",
    baseIata: "BEG",
  },
];

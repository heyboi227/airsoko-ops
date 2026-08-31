/**
 * The Air Soko network.
 *
 * A Belgrade-based European carrier: the hub at BEG, a second Serbian base at
 * INI flying a regional programme of its own, a dense short- and medium-haul
 * European network, and long-haul stations that give the wide-body fleet
 * something to do.
 *
 * Only the airline's own decisions live here -- which stations it serves and
 * what role each plays. Everything factual about an airport (name, ICAO code,
 * coordinates, elevation, time zone) comes from the curated reference set,
 * because those are facts about the world rather than choices Air Soko gets to
 * make. An earlier version of this file carried hand-authored coordinates;
 * they were a median 261 m out, and Madrid was wrong by 2.5 km.
 *
 * Adding a station is one line. The seed fails loudly if its IATA code is not
 * in the reference set, which is also the point at which somebody has to think
 * about whether the reference set should grow.
 */

export interface StationRole {
  iataCode: string;
  /** An airline base. Drives map emphasis and default schedule origins. */
  isHub?: boolean;
  /** Served heavily without basing aircraft there. */
  isFocusCity?: boolean;
}

export const AIR_SOKO_STATIONS: readonly StationRole[] = [
  // --- Home ---------------------------------------------------------------
  { iataCode: "BEG", isHub: true },
  { iataCode: "INI", isHub: true },

  // --- Regional -----------------------------------------------------------
  { iataCode: "SJJ" },
  { iataCode: "SKP" },
  { iataCode: "TIA" },
  { iataCode: "ZAG" },
  { iataCode: "LJU" },
  { iataCode: "SOF" },
  { iataCode: "OTP" },
  { iataCode: "BUD" },
  { iataCode: "OHD" },
  { iataCode: "TGD" },
  { iataCode: "TIV" },
  { iataCode: "KVO", isFocusCity: true },
  { iataCode: "OMO" },
  { iataCode: "TZL" },
  { iataCode: "DBV" },

  // --- Western and central Europe -----------------------------------------
  { iataCode: "VIE" },
  { iataCode: "MUC" },
  { iataCode: "FRA" },
  { iataCode: "ZRH" },
  { iataCode: "CDG" },
  { iataCode: "AMS" },
  { iataCode: "BRU" },
  { iataCode: "LHR" },
  { iataCode: "PRG" },
  { iataCode: "WAW" },
  { iataCode: "DUS" },
  { iataCode: "HAM" },
  { iataCode: "STR" },
  { iataCode: "LYS" },
  { iataCode: "DUB" },
  { iataCode: "MAN" },
  { iataCode: "EDI" },
  { iataCode: "LGW" },
  { iataCode: "ABZ" },

  // --- Southern Europe ----------------------------------------------------
  { iataCode: "FCO" },
  { iataCode: "MXP" },
  { iataCode: "BCN" },
  { iataCode: "MAD" },
  { iataCode: "ATH" },
  { iataCode: "LIS" },
  { iataCode: "OPO" },
  { iataCode: "SVQ" },
  { iataCode: "TFS" },
  { iataCode: "VCE" },

  // --- Northern Europe ----------------------------------------------------
  { iataCode: "CPH" },
  { iataCode: "ARN" },
  { iataCode: "OSL" },

  // --- East and Caucasus --------------------------------------------------
  { iataCode: "SVO" },
  { iataCode: "LED" },
  { iataCode: "DME" },
  { iataCode: "TBS" },
  { iataCode: "GYD" },
  { iataCode: "EVN" },
  { iataCode: "IST" },
  { iataCode: "ESB" },
  { iataCode: "AYT" },

  // --- Long haul ----------------------------------------------------------
  // Chosen partly to exercise the time handling rather than only to look
  // plausible: Asia/Kolkata sits at a half-hour offset, Asia/Dubai and
  // Asia/Shanghai never change, America/Sao_Paulo is southern-hemisphere with
  // DST abolished, and the American stations change on different dates from
  // the European ones.
  { iataCode: "DXB" },
  { iataCode: "BOM" },
  { iataCode: "PEK" },
  { iataCode: "JFK" },
  { iataCode: "ORD" },
  { iataCode: "YYZ" },
  { iataCode: "GRU" },
  { iataCode: "HND" },
  { iataCode: "SIN" },
  { iataCode: "BKK" },
  { iataCode: "DEL" },
  { iataCode: "CMN" },
  { iataCode: "MIA" },
  { iataCode: "EWR" },
  { iataCode: "ATL" },
  { iataCode: "LAX" },
  { iataCode: "EZE" },
  { iataCode: "MEX" },
  { iataCode: "GIG" },
  { iataCode: "SYD" },
];

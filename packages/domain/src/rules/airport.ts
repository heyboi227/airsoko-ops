import type { Id } from "@airsoko/contracts";
import { EvaluationBuilder, blocking, consequence, resourceRef, warning } from "../intent.ts";
import type { Evaluation } from "../intent.ts";
import { distanceKm } from "../geo.ts";

/**
 * Airport rules.
 *
 * Modest by design -- airports are reference data, not an operation. They are
 * built first because everything downstream reads them, and because getting
 * one entity through the whole pipeline (validate, evaluate, decide, apply,
 * audit) proves the architecture before there is anything complicated riding
 * on it.
 */

/**
 * Only the fields the rules actually read. Taking the whole create DTO would
 * force every caller -- including an edit merging a partial patch over a
 * stored row -- to reconstruct fields no rule looks at.
 */
export interface AirportDraft {
  iataCode: string;
  icaoCode: string;
  latitude: number;
  longitude: number;
}

export interface ExistingAirport {
  id: Id;
  iataCode: string;
  icaoCode: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface AirportDependencies {
  /** Routes that use this airport at either end. */
  routeCount: number;
  /** Flight instances not yet arrived or cancelled. */
  upcomingFlightCount: number;
}

export interface SaveAirportContext {
  /** Every airport already on file, including inactive ones. */
  existing: readonly ExistingAirport[];
  /** Set when editing, so the record does not collide with itself. */
  editingId?: Id;
}

/** Two airports closer together than this are almost certainly a data error. */
const COINCIDENT_THRESHOLD_KM = 1;

export function evaluateSaveAirport(
  airport: AirportDraft,
  context: SaveAirportContext,
): Evaluation {
  const builder = new EvaluationBuilder();
  const others = context.existing.filter((item) => item.id !== context.editingId);

  const iataClash = others.find((item) => item.iataCode === airport.iataCode);
  if (iataClash) {
    builder.add(
      blocking(
        "AIRPORT_IATA_IN_USE",
        `IATA code ${airport.iataCode} is already in use`,
        `${iataClash.name} (${iataClash.city}) already holds ${iataClash.iataCode}. IATA codes identify an airport uniquely across the network and cannot be shared.`,
        { subject: resourceRef("airport", iataClash.id, iataClash.iataCode) },
      ),
    );
  }

  const icaoClash = others.find((item) => item.icaoCode === airport.icaoCode);
  if (icaoClash) {
    builder.add(
      blocking(
        "AIRPORT_ICAO_IN_USE",
        `ICAO code ${airport.icaoCode} is already in use`,
        `${icaoClash.name} (${icaoClash.city}) already holds ${icaoClash.icaoCode}.`,
        { subject: resourceRef("airport", icaoClash.id, icaoClash.icaoCode) },
      ),
    );
  }

  // Null Island. A missing coordinate that defaulted to zero would otherwise
  // put an airport in the Gulf of Guinea and drag every route through it.
  if (Math.abs(airport.latitude) < 1e-6 && Math.abs(airport.longitude) < 1e-6) {
    builder.add(
      blocking(
        "AIRPORT_COORDINATES_MISSING",
        "Coordinates are missing",
        "Latitude and longitude are both zero, which places this airport in the Atlantic. Route distances and the live map both read these values directly.",
      ),
    );
  }

  const coincident = others.find(
    (item) =>
      distanceKm(
        { latitude: airport.latitude, longitude: airport.longitude },
        { latitude: item.latitude, longitude: item.longitude },
      ) < COINCIDENT_THRESHOLD_KM,
  );
  if (coincident) {
    builder.add(
      warning(
        "AIRPORT_COORDINATES_COINCIDENT",
        `Coordinates coincide with ${coincident.iataCode}`,
        `These coordinates are within ${COINCIDENT_THRESHOLD_KM} km of ${coincident.name} (${coincident.iataCode}). Multi-airport cities are normal, identical positions are not.`,
        { subject: resourceRef("airport", coincident.id, coincident.iataCode) },
      ),
    );
  }

  return builder.build();
}

export function evaluateDeactivateAirport(
  airport: ExistingAirport,
  dependencies: AirportDependencies,
): Evaluation {
  const builder = new EvaluationBuilder();
  const subject = resourceRef("airport", airport.id, airport.iataCode);

  if (dependencies.upcomingFlightCount > 0) {
    builder.add(
      blocking(
        "AIRPORT_HAS_UPCOMING_FLIGHTS",
        "Upcoming flights still use this airport",
        `${dependencies.upcomingFlightCount} flight${dependencies.upcomingFlightCount === 1 ? "" : "s"} not yet arrived or cancelled reference ${airport.iataCode}. Reschedule or cancel them before withdrawing the station.`,
        { subject },
      ),
    );
  }

  if (dependencies.routeCount > 0) {
    builder.add(
      warning(
        "AIRPORT_HAS_ROUTES",
        "Routes reference this airport",
        `${dependencies.routeCount} route${dependencies.routeCount === 1 ? "" : "s"} will be left without a serviceable endpoint and shown as suspended.`,
        { subject },
      ),
    );
    builder.expect(
      consequence("map_visibility_changed", "Affected routes stop drawing on the network map", {
        count: dependencies.routeCount,
      }),
    );
  }

  builder.expect(
    consequence(
      "map_visibility_changed",
      `${airport.iataCode} is removed from station pickers and the live map`,
    ),
  );

  return builder.build();
}

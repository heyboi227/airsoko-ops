import type { Coordinates } from "@airsoko/contracts";

/**
 * Spherical geometry for route distances, aircraft range checks and the
 * great-circle paths the live map draws.
 *
 * A sphere, not an ellipsoid: the error against WGS-84 is roughly 0.3%, which
 * is far below the margin that matters for "can this airframe fly this route"
 * and invisible at map scale. Stating it here so nobody later mistakes these
 * numbers for navigation-grade output.
 */

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_NAUTICAL_MILE = 1.852;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/** Normalise any bearing into [0, 360). */
export function normaliseHeading(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Great-circle distance in kilometres. */
export function distanceKm(from: Coordinates, to: Coordinates): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Great-circle distance in nautical miles -- the unit range limits use. */
export function distanceNm(from: Coordinates, to: Coordinates): number {
  return distanceKm(from, to) / KM_PER_NAUTICAL_MILE;
}

export const kmToNm = (km: number): number => km / KM_PER_NAUTICAL_MILE;
export const nmToKm = (nm: number): number => nm * KM_PER_NAUTICAL_MILE;

/**
 * Initial bearing in degrees true. On a great circle the bearing changes
 * continuously, so this is the heading at `from` only -- which is exactly what
 * a map marker needs when it is redrawn every tick.
 */
export function initialBearing(from: Coordinates, to: Coordinates): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

  return normaliseHeading(toDegrees(Math.atan2(y, x)));
}

/**
 * Point at `fraction` along the great circle from `from` to `to`, using
 * spherical linear interpolation. Fractions outside [0, 1] are clamped, so a
 * telemetry tick that arrives late cannot fling an aircraft past its
 * destination.
 */
export function interpolateGreatCircle(
  from: Coordinates,
  to: Coordinates,
  fraction: number,
): Coordinates {
  const t = Math.min(1, Math.max(0, fraction));

  const lat1 = toRadians(from.latitude);
  const lon1 = toRadians(from.longitude);
  const lat2 = toRadians(to.latitude);
  const lon2 = toRadians(to.longitude);

  const angular = distanceKm(from, to) / EARTH_RADIUS_KM;

  // Coincident endpoints: the sine terms below would divide by zero.
  if (angular < 1e-12) return { latitude: from.latitude, longitude: from.longitude };

  const a = Math.sin((1 - t) * angular) / Math.sin(angular);
  const b = Math.sin(t * angular) / Math.sin(angular);

  const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
  const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);

  return {
    latitude: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
    longitude: toDegrees(Math.atan2(y, x)),
  };
}

/**
 * A sampled great-circle path for drawing. Returned as [lon, lat] pairs
 * because that is GeoJSON's order and the map consumes it directly.
 *
 * Paths crossing the antimeridian are split into separate segments; drawn as
 * one line they would streak backwards across the entire map.
 */
export function greatCirclePath(
  from: Coordinates,
  to: Coordinates,
  samples = 64,
): [number, number][][] {
  const steps = Math.max(2, Math.floor(samples));
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let previousLon: number | null = null;

  for (let i = 0; i < steps; i += 1) {
    const point = interpolateGreatCircle(from, to, i / (steps - 1));

    if (previousLon !== null && Math.abs(point.longitude - previousLon) > 180) {
      segments.push(current);
      current = [];
    }

    current.push([point.longitude, point.latitude]);
    previousLon = point.longitude;
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * How far along the route a position sits, as a fraction in [0, 1]. Measured
 * by distance travelled rather than distance remaining so that a diversion --
 * which changes the destination -- does not make progress jump backwards.
 */
export function progressAlong(
  from: Coordinates,
  to: Coordinates,
  current: Coordinates,
): number {
  const total = distanceKm(from, to);
  if (total < 1e-9) return 1;
  return Math.min(1, Math.max(0, distanceKm(from, current) / total));
}

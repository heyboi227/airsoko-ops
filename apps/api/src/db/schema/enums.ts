import { pgEnum } from "drizzle-orm/pg-core";
import {
  AIRCRAFT_BODY_TYPES,
  AIRCRAFT_SERVICEABILITY,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  AMENITY_SCOPES,
  BOOKING_STATUSES,
  CABIN_CLASSES,
  CREW_DUTY_STATUSES,
  CREW_RANKS,
  DELAY_REASONS,
  FLIGHT_PHASES,
  FLIGHT_STATUSES,
  FLIGHT_TYPES,
  MAINTENANCE_CHECK_TYPES,
  PAYMENT_STATUSES,
  RESOURCE_KINDS,
  ROLES,
  ROUTE_STATUSES,
  SEAT_STATUSES,
  SSR_CODES,
} from "@airsoko/contracts";

/**
 * Postgres enums, defined once from the contract vocabularies.
 *
 * They are declared here rather than beside their tables so that a value can
 * only ever be added in `packages/contracts` -- the database, the API and the
 * browser then move together by construction. A `pgEnum` whose values were
 * typed out locally would be the one place the three could drift apart.
 */

export const roleEnum = pgEnum("role", ROLES);
export const resourceKindEnum = pgEnum("resource_kind", RESOURCE_KINDS);

export const alertSeverityEnum = pgEnum("alert_severity", ALERT_SEVERITIES);
export const alertStatusEnum = pgEnum("alert_status", ALERT_STATUSES);

export const routeStatusEnum = pgEnum("route_status", ROUTE_STATUSES);

export const aircraftServiceabilityEnum = pgEnum(
  "aircraft_serviceability",
  AIRCRAFT_SERVICEABILITY,
);
export const aircraftBodyTypeEnum = pgEnum("aircraft_body_type", AIRCRAFT_BODY_TYPES);
export const maintenanceCheckTypeEnum = pgEnum(
  "maintenance_check_type",
  MAINTENANCE_CHECK_TYPES,
);

export const cabinClassEnum = pgEnum("cabin_class", CABIN_CLASSES);
export const seatStatusEnum = pgEnum("seat_status", SEAT_STATUSES);
export const amenityScopeEnum = pgEnum("amenity_scope", AMENITY_SCOPES);

export const flightStatusEnum = pgEnum("flight_status", FLIGHT_STATUSES);
export const flightPhaseEnum = pgEnum("flight_phase", FLIGHT_PHASES);
export const flightTypeEnum = pgEnum("flight_type", FLIGHT_TYPES);
export const delayReasonEnum = pgEnum("delay_reason", DELAY_REASONS);

export const crewRankEnum = pgEnum("crew_rank", CREW_RANKS);
export const crewDutyStatusEnum = pgEnum("crew_duty_status", CREW_DUTY_STATUSES);

export const bookingStatusEnum = pgEnum("booking_status", BOOKING_STATUSES);
export const paymentStatusEnum = pgEnum("payment_status", PAYMENT_STATUSES);
export const ssrCodeEnum = pgEnum("ssr_code", SSR_CODES);

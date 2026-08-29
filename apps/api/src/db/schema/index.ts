/**
 * The full operational schema, organised by domain.
 *
 * Two conventions hold everywhere:
 *
 *  - Instants are `timestamp with time zone`, read and written as ISO strings.
 *    There is no naive datetime in this database. Airport-local times are
 *    derived at the edge from the airport's IANA zone, never stored.
 *  - Identifiers are UUIDs, generated deterministically by the seed so a
 *    reseed produces byte-identical data and screenshots stay reproducible.
 *
 * Import from here rather than from a module, so a table moving between
 * domains never breaks a call site.
 */

export * from "./enums.ts";
export * from "./common.ts";
export * from "./identity.ts";
export * from "./network.ts";
export * from "./fleet.ts";
export * from "./scheduling.ts";
export * from "./crew.ts";
export * from "./commercial.ts";
export * from "./bookings.ts";
export * from "./control.ts";

import { z } from "zod";

/**
 * Role-based access control.
 *
 * The brief is explicit that hiding a button is not security, so this table is
 * the single source of truth for both sides: the API enforces it on every
 * mutating route, and the web client reads the same map to decide what to
 * render. One definition, two consumers -- they cannot drift.
 *
 * Permissions are `resource:action`. Read and write are separated because the
 * interesting boundary in this product is almost always "can see, cannot
 * change" (Scenario G: a Booking Administrator reads flights all day and may
 * never cancel one).
 */

export const PERMISSIONS = [
  // Flights and schedules
  "flight:read",
  "flight:write",
  "flight:assign_aircraft",
  "flight:assign_crew",
  "flight:change_gate",
  "flight:record_delay",
  "flight:divert",
  "flight:cancel",
  "flight:delete_draft",
  "schedule:read",
  "schedule:write",

  // Fleet
  "aircraft:read",
  "aircraft:write",
  "aircraft:maintenance",

  // Crew
  "crew:read",
  "crew:write",
  "crew:assign",

  // Bookings and passengers
  "booking:read",
  "booking:write",
  "booking:seat",
  // Travel-document data is deliberately its own permission. It is the one
  // field group the brief calls out as restricted, and it is excluded from
  // logs regardless of who is reading it.
  "passenger:document:read",

  // Network
  "airport:read",
  "airport:write",
  "route:read",
  "route:write",

  // Commercial
  "commercial:read",
  "commercial:write",

  // Operational control
  "alert:read",
  "alert:resolve",
  "audit:read",
  "analytics:read",

  // Administration
  "user:read",
  "user:write",
  "settings:read",
  "settings:write",
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

export const ROLES = [
  "super_admin",
  "ops_controller",
  "fleet_manager",
  "crew_scheduler",
  "booking_admin",
  "commercial_manager",
] as const;

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  super_admin: "Super Administrator",
  ops_controller: "Operations Controller",
  fleet_manager: "Fleet Manager",
  crew_scheduler: "Crew Scheduler",
  booking_admin: "Booking Administrator",
  commercial_manager: "Commercial Manager",
};

/**
 * Read access that every role needs to do its own job. Operations staff cannot
 * schedule a flight without seeing the fleet; booking staff cannot seat a
 * passenger without seeing the flight. Nothing here grants a mutation.
 */
const BASELINE_READ = [
  "flight:read",
  "schedule:read",
  "aircraft:read",
  "airport:read",
  "route:read",
  "commercial:read",
  "alert:read",
  "analytics:read",
] as const satisfies readonly Permission[];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  super_admin: PERMISSIONS,

  ops_controller: [
    ...BASELINE_READ,
    "flight:write",
    "flight:assign_aircraft",
    "flight:assign_crew",
    "flight:change_gate",
    "flight:record_delay",
    "flight:divert",
    "flight:cancel",
    "flight:delete_draft",
    "schedule:write",
    "crew:read",
    "booking:read",
    "alert:resolve",
    "audit:read",
  ],

  fleet_manager: [
    ...BASELINE_READ,
    "aircraft:write",
    "aircraft:maintenance",
    "crew:read",
    "alert:resolve",
    "audit:read",
  ],

  crew_scheduler: [
    ...BASELINE_READ,
    "crew:read",
    "crew:write",
    "crew:assign",
    "flight:assign_crew",
    "alert:resolve",
    "audit:read",
  ],

  booking_admin: [
    ...BASELINE_READ,
    "booking:read",
    "booking:write",
    "booking:seat",
    "passenger:document:read",
  ],

  // Network planning owns the station list and the route map. This is also the
  // boundary Scenario G exercises: a Booking Administrator reads airports all
  // day and may never add one.
  commercial_manager: [
    ...BASELINE_READ,
    "commercial:write",
    "airport:write",
    "route:write",
    "booking:read",
    "audit:read",
  ],
};

// A Map rather than a record literal: it is built from ROLES directly, so a
// role added above cannot be silently missing from the lookup.
const PERMISSION_SETS: ReadonlyMap<Role, ReadonlySet<Permission>> = new Map(
  ROLES.map((role) => [role, new Set(ROLE_PERMISSIONS[role])] as const),
);

/** Does any of the actor's roles grant this permission? */
export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => PERMISSION_SETS.get(role)?.has(permission) ?? false);
}

/** Every permission an actor holds, deduplicated and stably ordered. */
export function permissionsFor(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return PERMISSIONS.filter((permission) => granted.has(permission));
}

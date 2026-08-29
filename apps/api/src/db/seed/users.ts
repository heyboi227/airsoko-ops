import { createHash } from "node:crypto";
import type { Role } from "@airsoko/contracts";

/**
 * Demonstration accounts -- one per role, so the permission boundaries in the
 * brief can actually be exercised rather than described.
 *
 * Every account shares the same password, printed by the seed. This is a demo
 * fixture and nothing else: the seed refuses to run against NODE_ENV=production
 * for exactly this reason.
 */

export const DEMO_PASSWORD = "airsoko-demo";

export interface SeedUser {
  email: string;
  displayName: string;
  roles: Role[];
  homeBase: string;
}

export const SEED_USERS: readonly SeedUser[] = [
  {
    email: "admin@airsoko.example",
    displayName: "Vesna Markovic",
    roles: ["super_admin"],
    homeBase: "BEG",
  },
  {
    email: "ops@airsoko.example",
    displayName: "Dragan Ilic",
    roles: ["ops_controller"],
    homeBase: "BEG",
  },
  {
    email: "fleet@airsoko.example",
    displayName: "Ana Radovanovic",
    roles: ["fleet_manager"],
    homeBase: "BEG",
  },
  {
    email: "crew@airsoko.example",
    displayName: "Nikola Stefanovic",
    roles: ["crew_scheduler"],
    homeBase: "BEG",
  },
  {
    email: "bookings@airsoko.example",
    displayName: "Jelena Popovic",
    roles: ["booking_admin"],
    homeBase: "BEG",
  },
  {
    email: "commercial@airsoko.example",
    displayName: "Marko Djuric",
    roles: ["commercial_manager"],
    homeBase: "BEG",
  },
  {
    // Deliberately holds two roles: the permission model is additive, and
    // something in the seed should prove that rather than only asserting it.
    email: "duty.manager@airsoko.example",
    displayName: "Sofija Lukic",
    roles: ["ops_controller", "crew_scheduler"],
    homeBase: "BEG",
  },
];

/**
 * A salt derived from the email rather than randomly generated, so that a
 * reseed produces byte-identical rows. Only ever used for demo accounts --
 * `hashPassword` generates a real random salt for anything a person sets.
 */
export function deterministicSalt(email: string): Buffer {
  return createHash("sha256").update(`airsoko-seed-salt:${email}`).digest().subarray(0, 16);
}

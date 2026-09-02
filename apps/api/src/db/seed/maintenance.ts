import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_POLICY, maintenanceStanding } from "@airsoko/domain";
import { db } from "../client.ts";
import { aircraft, amenities, amenityAssignments, maintenanceEvents } from "../schema/index.ts";
import { airportId, seededId } from "../ids.ts";
import { SEED_AIRCRAFT, SEED_AIRCRAFT_TYPES } from "./reference/fleet.ts";

/**
 * Light maintenance and cabin amenities.
 *
 * Not an MRO system -- the brief says it need not be. What it has to do is
 * answer "may this airframe fly tomorrow", warn before the answer becomes no,
 * and give the fleet pages something real to show.
 *
 * Check intervals are the usual three-way race: whichever of calendar time,
 * flight hours or cycles arrives first. The seed deliberately puts a few tails
 * near a limit and one past it, because a fleet where nothing is ever due
 * demonstrates none of the workflow.
 */

const SEED_EPOCH = "2026-01-01T00:00:00.000Z";

const unit = (key: string) =>
  createHash("sha256").update(key).digest().readUInt32BE(0) / 0x1_0000_0000;
const pick = (key: string, min: number, max: number) =>
  min + Math.floor(unit(key) * (max - min + 1));

/**
 * Deliberately placed maintenance cases, as a fraction through the interval.
 * Over 1.0 is overdue. Everything else is hashed.
 */
const FORCED_STANDING: Readonly<Record<string, number>> = {
  "YU-APG": 1.04, // overdue: the fleet manager's problem this morning
  "YU-ANC": 0.94, // approaching, a few days out
  "YU-APJ": 0.97, // approaching, sooner
  "YU-ALB": 0.92, // approaching on the turboprop fleet too
};

/** A-check intervals, by airframe size. Representative, not regulatory. */
const CHECK_INTERVAL = {
  regional: { days: 120, hours: 600, cycles: 900 },
  narrow_body: { days: 90, hours: 750, cycles: 600 },
  wide_body: { days: 100, hours: 900, cycles: 300 },
} as const;

function addDays(instant: string, days: number): string {
  return new Date(Date.parse(instant) + days * 86_400_000).toISOString();
}

interface CheckPlan {
  interval: (typeof CHECK_INTERVAL)[keyof typeof CHECK_INTERVAL];
  lastCheckAt: string;
  nextCheckDueAt: string;
  /** Interval allowance consumed by the reference day. */
  hoursUsed: number;
  cyclesUsed: number;
  daysRemaining: number;
}

/**
 * The check standing this seed will give an airframe, worked out from nothing
 * but its registration and the reference day.
 *
 * Pure, and deliberately free of the database: the rotation builder needs the
 * answer before any of this is written. See `unserviceableRegistrations`.
 */
function checkPlanFor(
  registration: string,
  icaoTypeCode: string,
  referenceDate: string,
): CheckPlan | null {
  const type = SEED_AIRCRAFT_TYPES.find((candidate) => candidate.icaoTypeCode === icaoTypeCode);
  if (!type) return null;

  const interval =
    type.bodyType === "regional"
      ? CHECK_INTERVAL.regional
      : type.bodyType === "wide_body"
        ? CHECK_INTERVAL.wide_body
        : CHECK_INTERVAL.narrow_body;

  // A spread of standings: most comfortable, a few close, one past due.
  //
  // Position in the interval is hashed off the registration, so it is stable
  // and varied -- but a uniform hash left only one airframe anywhere near a
  // limit, and a fleet where nothing is ever due demonstrates none of the
  // workflow the brief asks for. Three tails are therefore placed by name.
  const throughInterval =
    FORCED_STANDING[registration] ?? unit(`check-position:${registration}`);
  const daysSinceCheck = Math.round(throughInterval * (interval.days * 1.08));
  const lastCheckAt = addDays(`${referenceDate}T00:00:00.000Z`, -daysSinceCheck);

  return {
    interval,
    lastCheckAt,
    nextCheckDueAt: addDays(lastCheckAt, interval.days),
    // Hours and cycles limits sit ahead of the current totals by roughly the
    // same fraction of the interval, so the three limits agree about how worn
    // the airframe is rather than contradicting each other.
    hoursUsed: Math.round(throughInterval * interval.hours),
    cyclesUsed: Math.round(throughInterval * interval.cycles),
    daysRemaining: interval.days - daysSinceCheck,
  };
}

/**
 * Registrations the domain would refuse to put on a flight at `now`.
 *
 * The rotation builder excludes these. An airframe past a check limit is
 * blocked from assignment by `rules/aircraft.ts`, so a seed that rosters one
 * anyway produces a board the API itself will not let an operator reproduce:
 * releasing that airframe from its sector is accepted and putting it back is
 * refused, which is not a state any real operation can be in.
 *
 * Asked of the same `maintenanceStanding` the API uses rather than by reading
 * the intervals above a second time, so the two cannot drift apart.
 */
export function unserviceableRegistrations(
  referenceDate: string,
  now: string,
): ReadonlySet<string> {
  const unserviceable = new Set<string>();

  for (const entry of SEED_AIRCRAFT) {
    const plan = checkPlanFor(entry.registration, entry.icaoTypeCode, referenceDate);
    if (!plan) continue;

    const standing = maintenanceStanding(
      {
        nextCheckType: "a_check",
        nextCheckDueAt: plan.nextCheckDueAt,
        // The written limits are the airframe's totals plus what is left of
        // the interval, so the totals cancel and only the remainder matters.
        nextCheckDueHours: plan.interval.hours - plan.hoursUsed,
        nextCheckDueCycles: plan.interval.cycles - plan.cyclesUsed,
        totalHours: 0,
        totalCycles: 0,
      },
      now,
      DEFAULT_POLICY,
    );

    if (standing.urgency === "exceeded") unserviceable.add(entry.registration);
  }

  return unserviceable;
}

/**
 * Sets each airframe's check standing, relative to the reference day so the
 * fleet reads plausibly whatever date the seed runs on.
 */
export async function seedMaintenance(referenceDate: string): Promise<{
  aircraftUpdated: number;
  events: number;
  approaching: number;
  overdue: number;
}> {
  const events: (typeof maintenanceEvents.$inferInsert)[] = [];
  let approaching = 0;
  let overdue = 0;

  for (const entry of SEED_AIRCRAFT) {
    const plan = checkPlanFor(entry.registration, entry.icaoTypeCode, referenceDate);
    if (!plan) continue;

    const { interval, lastCheckAt, nextCheckDueAt, hoursUsed, cyclesUsed, daysRemaining } =
      plan;
    const id = seededId("aircraft", entry.registration);

    if (daysRemaining < 0) overdue += 1;
    else if (daysRemaining <= 14) approaching += 1;

    const [current] = await db
      .select({ totalHours: aircraft.totalHours, totalCycles: aircraft.totalCycles })
      .from(aircraft)
      .where(eq(aircraft.id, id))
      .limit(1);

    const totalHours = current?.totalHours ?? 0;
    const totalCycles = current?.totalCycles ?? 0;

    await db
      .update(aircraft)
      .set({
        lastCheckType: "a_check",
        lastCheckAt,
        nextCheckType: "a_check",
        nextCheckDueAt,
        nextCheckDueHours: totalHours + (interval.hours - hoursUsed),
        nextCheckDueCycles: totalCycles + (interval.cycles - cyclesUsed),
        updatedAt: SEED_EPOCH,
      })
      .where(eq(aircraft.id, id));

    // History: the last three checks, plus the one that is coming.
    for (let back = 0; back < 3; back += 1) {
      const start = addDays(lastCheckAt, -back * interval.days);
      const hangar = pick(`hangar:${entry.registration}:${back}`, 0, 1) === 0 ? "BEG" : "SJJ";
      events.push({
        id: seededId("maintenance", `${entry.registration}:past:${back}`),
        aircraftId: id,
        checkType: back === 2 ? "c_check" : "a_check",
        airportId: airportId(hangar),
        scheduledStart: start,
        scheduledEnd: addDays(start, back === 2 ? 9 : 1),
        actualStart: start,
        actualEnd: addDays(start, back === 2 ? 10 : 1),
        hoursAtCheck: Math.max(0, totalHours - back * interval.hours),
        cyclesAtCheck: Math.max(0, totalCycles - back * interval.cycles),
        description:
          back === 2
            ? "Heavy check: structural inspection, cabin refresh, landing gear overhaul."
            : "Routine A-check: systems, fluids, and a scheduled defect sweep.",
        notes: null,
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      });
    }

    events.push({
      id: seededId("maintenance", `${entry.registration}:next`),
      aircraftId: id,
      checkType: "a_check",
      airportId: airportId("BEG"),
      scheduledStart: nextCheckDueAt,
      scheduledEnd: addDays(nextCheckDueAt, 1),
      actualStart: null,
      actualEnd: null,
      hoursAtCheck: null,
      cyclesAtCheck: null,
      description: "Routine A-check.",
      notes: entry.unavailable ? entry.unavailable.note : null,
      createdAt: SEED_EPOCH,
      updatedAt: SEED_EPOCH,
    });
  }

  await db
    .insert(maintenanceEvents)
    .values(events)
    .onConflictDoUpdate({
      target: maintenanceEvents.id,
      set: {
        scheduledStart: sql`excluded.scheduled_start`,
        scheduledEnd: sql`excluded.scheduled_end`,
        actualStart: sql`excluded.actual_start`,
        actualEnd: sql`excluded.actual_end`,
        description: sql`excluded.description`,
        updatedAt: SEED_EPOCH,
      },
    });

  return { aircraftUpdated: SEED_AIRCRAFT.length, events: events.length, approaching, overdue };
}

// --- Amenities --------------------------------------------------------------

interface SeedAmenity {
  code: string;
  name: string;
  category: string;
  description: string;
}

const SEED_AMENITIES: readonly SeedAmenity[] = [
  {
    code: "wifi",
    name: "Wi-Fi",
    category: "connectivity",
    description: "Satellite broadband, purchasable by the hour or the sector.",
  },
  {
    code: "power_ac",
    name: "Seat power",
    category: "power",
    description: "AC outlet at every seat.",
  },
  {
    code: "usb_c",
    name: "USB-C charging",
    category: "power",
    description: "USB-C at every seat.",
  },
  {
    code: "ife_seatback",
    name: "Seat-back entertainment",
    category: "entertainment",
    description: "Personal screen with film and audio library.",
  },
  {
    code: "ife_stream",
    name: "Streaming to device",
    category: "entertainment",
    description: "Library streamed to a passenger's own device.",
  },
  {
    code: "meal_hot",
    name: "Hot meal",
    category: "catering",
    description: "Full hot service.",
  },
  {
    code: "meal_snack",
    name: "Snack",
    category: "catering",
    description: "Light snack service.",
  },
  {
    code: "drinks_complimentary",
    name: "Complimentary drinks",
    category: "catering",
    description: "Soft drinks and hot beverages at no charge.",
  },
  {
    code: "extra_legroom",
    name: "Extra legroom",
    category: "comfort",
    description: "Additional seat pitch.",
  },
  {
    code: "lie_flat",
    name: "Lie-flat seat",
    category: "comfort",
    description: "Seat converts to a full-flat bed.",
  },
];

/**
 * Amenities, and where they attach.
 *
 * The interesting part is that assignments carry an `included` flag, so a
 * narrower scope can *remove* what a broader one grants. A tail whose Wi-Fi is
 * unserviceable is a flight-level exclusion, not a fleet-wide edit.
 */
export async function seedAmenities(): Promise<{ amenities: number; assignments: number }> {
  const rows = SEED_AMENITIES.map((amenity) => ({
    id: seededId("amenity", amenity.code),
    code: amenity.code,
    name: amenity.name,
    category: amenity.category,
    description: amenity.description,
    active: true,
    createdAt: SEED_EPOCH,
    updatedAt: SEED_EPOCH,
  }));

  await db
    .insert(amenities)
    .values(rows)
    .onConflictDoUpdate({
      target: amenities.id,
      set: {
        name: sql`excluded.name`,
        category: sql`excluded.category`,
        description: sql`excluded.description`,
        updatedAt: SEED_EPOCH,
      },
    });

  const assignments: (typeof amenityAssignments.$inferInsert)[] = [];
  const add = (
    key: string,
    code: string,
    scope: "aircraft" | "cabin",
    extra: Partial<typeof amenityAssignments.$inferInsert>,
  ) => {
    assignments.push({
      id: seededId("amenity_assignment", key),
      amenityId: seededId("amenity", code),
      scope,
      included: true,
      createdAt: SEED_EPOCH,
      updatedAt: SEED_EPOCH,
      ...extra,
    });
  };

  // Cabin-level: what the cabin gets regardless of airframe.
  add("cabin:business:meal", "meal_hot", "cabin", { cabinClass: "business" });
  add("cabin:business:drinks", "drinks_complimentary", "cabin", { cabinClass: "business" });
  add("cabin:business:legroom", "extra_legroom", "cabin", { cabinClass: "business" });
  add("cabin:premium:meal", "meal_hot", "cabin", { cabinClass: "premium_economy" });
  add("cabin:premium:legroom", "extra_legroom", "cabin", { cabinClass: "premium_economy" });
  add("cabin:premium:drinks", "drinks_complimentary", "cabin", {
    cabinClass: "premium_economy",
  });
  add("cabin:economy:snack", "meal_snack", "cabin", { cabinClass: "economy" });

  // Aircraft-level: what a given airframe is fitted with.
  const typeByRegistration = new Map(
    SEED_AIRCRAFT.map((entry) => [entry.registration, entry.icaoTypeCode]),
  );

  for (const [registration, typeCode] of typeByRegistration) {
    const aircraftUuid = seededId("aircraft", registration);
    const fit = (code: string) =>
      add(`aircraft:${registration}:${code}`, code, "aircraft", { aircraftId: aircraftUuid });

    // The newer airframes are the connected ones -- which is both realistic and
    // gives the amenity resolution something to actually differ on.
    if (typeCode === "A20N" || typeCode === "A332") {
      fit("wifi");
      fit("power_ac");
      fit("usb_c");
    } else if (typeCode === "A320" || typeCode === "A319") {
      fit("usb_c");
    }

    if (typeCode === "A332") {
      fit("ife_seatback");
      fit("lie_flat");
    } else if (typeCode !== "AT76") {
      fit("ife_stream");
    }
  }

  // One deliberate exclusion, because the flag exists to be used: a tail with
  // Wi-Fi fitted but unserviceable today.
  assignments.push({
    id: seededId("amenity_assignment", "aircraft:YU-ANB:wifi-unserviceable"),
    amenityId: seededId("amenity", "wifi"),
    scope: "aircraft",
    included: false,
    aircraftId: seededId("aircraft", "YU-ANB"),
    note: "Wi-Fi antenna unserviceable, parts on order.",
    createdAt: SEED_EPOCH,
    updatedAt: SEED_EPOCH,
  });

  await db
    .insert(amenityAssignments)
    .values(assignments)
    .onConflictDoUpdate({
      target: amenityAssignments.id,
      set: {
        included: sql`excluded.included`,
        note: sql`excluded.note`,
        updatedAt: SEED_EPOCH,
      },
    });

  return { amenities: rows.length, assignments: assignments.length };
}

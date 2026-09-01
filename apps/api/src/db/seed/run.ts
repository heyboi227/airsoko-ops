import { sql } from "drizzle-orm";
import { closeDatabase, db } from "../client.ts";
import { airports, countries, userRoles, users } from "../schema/index.ts";
import { airportId, userId } from "../ids.ts";
import { hashPasswordWithSalt } from "../../http/password.ts";
import { env } from "../../env.ts";
import { logger } from "../../logger.ts";
import { resolveCountries, resolveStations } from "./reference/index.ts";
import { DEMO_PASSWORD, SEED_USERS, deterministicSalt } from "./users.ts";
import { seedAircraftTypes, seedAirlines, seedFleet, seedNetwork } from "./operation.ts";
import { seedAmenities, seedMaintenance } from "./maintenance.ts";
import { applyRecordedEntries } from "../recorded/replay.ts";

/**
 * The seed is idempotent and deterministic.
 *
 *  - Idempotent: every insert upserts on its natural key, so running it twice
 *    is the same as running it once. Rows an operator created through the
 *    application are never touched -- the seed owns its own fixtures and
 *    nothing else. What an operator did make is replayed at the end from
 *    `seed/recorded/`, where the application records it; see decision 32.
 *  - Deterministic: identifiers come from `seededId`, salts come from the
 *    email, airport facts come from a committed reference file, and no
 *    timestamp is generated at seed time. Two machines running this get
 *    byte-identical rows, which is what makes screenshots and end-to-end tests
 *    reproducible.
 */

/** A fixed instant so `created_at` does not drift between runs. */
const SEED_EPOCH = "2026-01-01T00:00:00.000Z";

/**
 * Reference data is byte-identical on every run. Flights cannot be: an
 * operations console with no flights today is useless, so the window has to
 * follow the calendar. The guarantee is therefore *deterministic given a
 * reference date* -- two runs on the same day are identical, a run tomorrow
 * shifts the window by one day and produces the same shape.
 *
 * SEED_REFERENCE_DATE pins it when a test needs a fixed operating day.
 */
function referenceDate(): string {
  const pinned = process.env.SEED_REFERENCE_DATE;
  if (pinned) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pinned)) {
      throw new Error(`SEED_REFERENCE_DATE must be YYYY-MM-DD, got "${pinned}".`);
    }
    return pinned;
  }
  return new Date().toISOString().slice(0, 10);
}

async function seedCountries(codes: { code: string; name: string }[]): Promise<number> {
  await db
    .insert(countries)
    .values(codes)
    .onConflictDoUpdate({
      target: countries.code,
      set: { name: sql`excluded.name` },
    });

  return codes.length;
}

async function seedAirports(): Promise<{ count: number; hubs: string[] }> {
  const stations = resolveStations();

  const rows = stations.map((station) => ({
    id: airportId(station.iataCode),
    iataCode: station.iataCode,
    icaoCode: station.icaoCode,
    name: station.name,
    city: station.city,
    countryCode: station.countryCode,
    latitude: station.latitude,
    longitude: station.longitude,
    elevationFt: station.elevationFt,
    timeZone: station.timeZone,
    isHub: station.isHub,
    isFocusCity: station.isFocusCity,
    active: true,
    createdAt: SEED_EPOCH,
    updatedAt: SEED_EPOCH,
  }));

  await db
    .insert(airports)
    .values(rows)
    .onConflictDoUpdate({
      target: airports.id,
      set: {
        iataCode: sql`excluded.iata_code`,
        icaoCode: sql`excluded.icao_code`,
        name: sql`excluded.name`,
        city: sql`excluded.city`,
        countryCode: sql`excluded.country_code`,
        latitude: sql`excluded.latitude`,
        longitude: sql`excluded.longitude`,
        elevationFt: sql`excluded.elevation_ft`,
        timeZone: sql`excluded.time_zone`,
        isHub: sql`excluded.is_hub`,
        isFocusCity: sql`excluded.is_focus_city`,
        active: sql`excluded.active`,
        updatedAt: SEED_EPOCH,
      },
    });

  return {
    count: rows.length,
    hubs: stations.filter((station) => station.isHub).map((station) => station.iataCode),
  };
}

async function seedUsers(): Promise<number> {
  for (const user of SEED_USERS) {
    const id = userId(user.email);
    const passwordHash = await hashPasswordWithSalt(
      DEMO_PASSWORD,
      deterministicSalt(user.email),
    );

    await db
      .insert(users)
      .values({
        id,
        email: user.email,
        displayName: user.displayName,
        passwordHash,
        homeBase: user.homeBase,
        active: true,
        lastLoginAt: null,
        createdAt: SEED_EPOCH,
        updatedAt: SEED_EPOCH,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: sql`excluded.email`,
          displayName: sql`excluded.display_name`,
          passwordHash: sql`excluded.password_hash`,
          homeBase: sql`excluded.home_base`,
          active: sql`excluded.active`,
          updatedAt: SEED_EPOCH,
        },
      });

    // Roles are a set, not a list: replace wholesale so a role removed from the
    // fixture is actually removed from the database.
    await db.delete(userRoles).where(sql`${userRoles.userId} = ${id}`);
    await db.insert(userRoles).values(user.roles.map((role) => ({ userId: id, role })));
  }

  return SEED_USERS.length;
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed a production database. These are demonstration accounts with a shared, published password.",
    );
  }

  logger.info("Seeding reference data...");

  // Countries are derived from the network rather than loaded wholesale: the
  // table gives airports a referential home, and a row is added when a station
  // needs one. See docs/DECISIONS.md.
  const stations = resolveStations();
  const countryCount = await seedCountries(resolveCountries(stations));
  logger.info(`  countries: ${countryCount} (only those the network touches)`);

  const { count, hubs } = await seedAirports();
  logger.info(`  airports:  ${count} (hub: ${hubs.join(", ")})`);

  const userCount = await seedUsers();
  logger.info(`  users:     ${userCount}`);

  logger.info("Seeding the operation...");

  const airlineCount = await seedAirlines();
  logger.info(`  airlines:  ${airlineCount}`);

  const typeCount = await seedAircraftTypes();
  const fleet = await seedFleet();
  logger.info(
    `  fleet:     ${fleet.tails} aircraft across ${typeCount} types, ` +
      `${fleet.cabins} cabins, ${fleet.seats} seats`,
  );

  const day = referenceDate();
  const now = new Date().toISOString();
  const network = await seedNetwork(stations, day, now);
  logger.info(`  routes:    ${network.routes}`);
  logger.info(`  schedules: ${network.schedules}`);
  logger.info(
    `  flights:   ${network.flights} across 9 days from ${day}, ` +
      `${network.assigned} with an aircraft`,
  );
  logger.info(
    `  ${network.rotationDelays} sectors pushed late by a late inbound (rotation delay)`,
  );

  const maintenance = await seedMaintenance(day);
  logger.info(
    `  checks:    ${maintenance.events} maintenance events; ` +
      `${maintenance.approaching} aircraft approaching a limit, ${maintenance.overdue} overdue`,
  );

  const amenityCounts = await seedAmenities();
  logger.info(
    `  amenities: ${amenityCounts.amenities} configured, ${amenityCounts.assignments} assignments`,
  );

  // After the fixtures, deliberately: an entry an operator made on top of a
  // seeded row -- a gate moved, a delay recorded -- must land after the seed
  // has put the row back the way the pattern says.
  const recorded = await applyRecordedEntries();
  logger.info(
    `  recorded:  ${recorded.applied} entries replayed from seed/recorded, ` +
      `${recorded.removed} removals honoured`,
  );

  if (network.unassigned.length > 0) {
    // Not a seeding failure. A flight the rotation could not cover is a real
    // operational state, and one the alert feed should be surfacing -- the
    // count is reported rather than hidden.
    logger.info(
      `  ${network.unassigned.length} flights have no aircraft assigned ` +
        `(no airframe of the right type free at the origin).`,
    );
  }

  logger.info(`Seed complete. Sign in with any address below and password "${DEMO_PASSWORD}":`);
  for (const user of SEED_USERS) {
    logger.info(`  ${user.email.padEnd(32)} ${user.roles.join(", ")}`);
  }
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    logger.error({ err: error }, "Seed failed");
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });

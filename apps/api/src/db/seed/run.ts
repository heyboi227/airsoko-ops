import { sql } from "drizzle-orm";
import { closeDatabase, db } from "../client.ts";
import { airports, countries, userRoles, users } from "../schema.ts";
import { airportId, userId } from "../ids.ts";
import { hashPasswordWithSalt } from "../../http/password.ts";
import { env } from "../../env.ts";
import { logger } from "../../logger.ts";
import { SEED_COUNTRIES } from "./reference/countries.ts";
import { SEED_AIRPORTS } from "./reference/airports.ts";
import { DEMO_PASSWORD, SEED_USERS, deterministicSalt } from "./users.ts";

/**
 * The seed is idempotent and deterministic.
 *
 *  - Idempotent: every insert upserts on its natural key, so running it twice
 *    is the same as running it once. There is no drop-and-recreate step, which
 *    means it is safe to re-run against a database that already has work in it.
 *  - Deterministic: identifiers come from `seededId`, salts come from the email,
 *    and no timestamp is generated at seed time. Two machines running this get
 *    byte-identical rows, which is what makes screenshots and end-to-end tests
 *    reproducible.
 *
 * Later phases add fleet, crew, schedules and bookings to the same pattern.
 */

/** A fixed instant so `created_at` does not drift between runs. */
const SEED_EPOCH = "2026-01-01T00:00:00.000Z";

async function seedCountries(): Promise<number> {
  const rows = SEED_COUNTRIES.map((country) => ({
    code: country.code,
    alpha3: country.alpha3,
    name: country.name,
  }));

  await db
    .insert(countries)
    .values(rows)
    .onConflictDoUpdate({
      target: countries.code,
      set: {
        alpha3: sql`excluded.alpha3`,
        name: sql`excluded.name`,
      },
    });

  return rows.length;
}

async function seedAirports(): Promise<number> {
  const known = new Set(SEED_COUNTRIES.map((country) => country.code));

  for (const airport of SEED_AIRPORTS) {
    if (!known.has(airport.countryCode)) {
      // Fail loudly. A missing country would otherwise surface much later as a
      // foreign-key error with no indication of which station caused it.
      throw new Error(
        `Airport ${airport.iataCode} references country ${airport.countryCode}, which is not in SEED_COUNTRIES.`,
      );
    }
  }

  const rows = SEED_AIRPORTS.map((airport) => ({
    id: airportId(airport.iataCode),
    iataCode: airport.iataCode,
    icaoCode: airport.icaoCode,
    name: airport.name,
    city: airport.city,
    countryCode: airport.countryCode,
    latitude: airport.latitude,
    longitude: airport.longitude,
    elevationFt: airport.elevationFt,
    timeZone: airport.timeZone,
    isHub: airport.isHub ?? false,
    isFocusCity: airport.isFocusCity ?? false,
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

  return rows.length;
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

  const countryCount = await seedCountries();
  logger.info(`  countries: ${countryCount}`);

  const airportCount = await seedAirports();
  const hubs = SEED_AIRPORTS.filter((airport) => airport.isHub).map((a) => a.iataCode);
  logger.info(`  airports:  ${airportCount} (hub: ${hubs.join(", ")})`);

  const userCount = await seedUsers();
  logger.info(`  users:     ${userCount}`);

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

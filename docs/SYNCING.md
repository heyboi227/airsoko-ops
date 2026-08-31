# Moving a change to another machine

The rule underneath everything here: **anything that must exist on more than one
machine has to live in a file git tracks.** Rows created through the application
are local to whichever machine you clicked on. The seed owns its own fixtures
and deliberately never touches operator-created rows, so a reseed elsewhere will
not reproduce them.

## Where data lives

| Data                      | File                                                     |
| ------------------------- | -------------------------------------------------------- |
| Which stations are served | `apps/api/src/db/seed/reference/stations.ts`             |
| Airport facts             | `apps/api/src/db/seed/reference/airports.reference.json` |
| Routes and frequencies    | `apps/api/src/db/seed/reference/network-plan.ts`         |
| Aircraft and types        | `apps/api/src/db/seed/reference/fleet.ts`                |
| Demonstration accounts    | `apps/api/src/db/seed/users.ts`                          |

Adding an airport through the console is a fine way to _decide_ you want it. It
is not a way to keep it. Add the station here and the identifiers even agree:
`POST /airports` derives its id with `seededId("airport", iata)`, the same
derivation the seed uses, so the row regenerates rather than duplicating.

## On the machine where you made the change

```
# 1. Edit the seed source above, or the schema in src/db/schema/.

# 2. Only if the schema changed -- run this from apps/api, not the root:
npm run db:generate -- --name=what_changed

# 3. Apply and load.
npm run db:migrate
npm run db:seed

# 4. Confirm, then commit and push.
npm run verify
```

Commit the seed files and, if step 2 produced any, all three migration
artefacts together: `drizzle/NNNN_name.sql`, `drizzle/meta/NNNN_snapshot.json`
and `drizzle/meta/_journal.json`.

## On the other machine

```
git pull
npm install          # only matters if dependencies moved
npm run db:up
npm run db:migrate   # a no-op when there is no new migration
npm run db:seed
```

Order matters: migrate before seed.

## Things that have already caught us out

**`--name` is swallowed from the root.** `npm run db:generate -- --name=x` at
the repo root appends the argument to the _outer_ `npm run`, which eats it, and
you get `0002_fast_nicolaos` instead. Run it from `apps/api`, or spell it out:
`npm run db:generate --workspace @airsoko/api -- --name=x`.

**Read the generated SQL before applying it.** A `.notNull()` column added to a
table that already has rows needs either a default or the three-step in
migration `0003`: add nullable, backfill, then tighten. It succeeds on your
empty database and fails in CI against a seeded one.

**A hand-written migration still advances the snapshot.** `drizzle-kit generate`
writes the snapshot from your TypeScript schema, not from the SQL in the file --
`--custom` included. If the SQL you wrote does not actually produce what the
schema describes, the snapshot now lies and the next `generate` sees nothing to
fix. Migrating a fresh database is the only thing that catches it.

**Never edit a migration that has been applied and committed.** Write a new one.
While iterating locally and before committing, `npm run db:reset` lets you redo
one instead of stacking fixups.

**Two branches both adding `0005` collide.** `npx drizzle-kit check` from
`apps/api` finds it; regenerate yours on top of theirs.

## Telling seeded rows from your own

Seeded rows carry the fixed epoch. Anything else came through the application
and will not travel:

```sql
SELECT iata_code, name FROM airports
WHERE created_at <> '2026-01-01T00:00:00Z';
```

## When the local database drifts

`npm run db:reset` drops the volume and rebuilds from migrations and seed. It is
the only thing that clears rows the seed no longer generates -- flights outside
the rolling nine-day window, retired test airframes, audit entries.

It also **destroys everything created through the application**. Check what you
would lose before running it, and fold anything worth keeping into the seed
first.

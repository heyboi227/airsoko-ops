# Air Soko Operations Console

An airline operations administration platform: flight scheduling, fleet and light
maintenance, crew rostering, booking and seat inventory, live flight tracking, and the
operational reporting around them.

Built against the brief in `docs/BRIEF.md`. Delivery is phased — see
[`docs/STATE.md`](docs/STATE.md) for where it currently stands and
[`docs/DECISIONS.md`](docs/DECISIONS.md) for why the architecture looks like this.

**Phase 3 is complete.** Working end to end: Airports & Routes, the Fleet and its
amenities, and the Flight Schedule — the board, the fleet timeline, the flight-control
page, recurring schedules with per-occurrence exceptions, and the conflict checks that
guard every change. Live Operations, Crew, Bookings and the rest say which phase builds
them rather than showing a convincing mock.

---

## Quickstart

Node 24 and npm 11. The version lives in `.nvmrc`, CI reads that same file, and
`engine-strict` refuses anything older rather than letting it quietly rewrite the
lockfile.

```bash
nvm use              # Node 24, npm 11
npm install
cp .env.example .env
npm run db:up        # Postgres 18 in Docker on port 5433
npm run db:migrate
npm run db:seed
npm run dev          # API on :4000, web on :5273
```

Sign in with any demonstration account listed on the login screen. They all use the
password `airsoko-demo`, and each one sees a different navigation set and is refused
different actions — at the API, not just in the interface.

| Account                      | Role                  |
| ---------------------------- | --------------------- |
| `admin@airsoko.example`      | Super Administrator   |
| `ops@airsoko.example`        | Operations Controller |
| `fleet@airsoko.example`      | Fleet Manager         |
| `crew@airsoko.example`       | Crew Scheduler        |
| `bookings@airsoko.example`   | Booking Administrator |
| `commercial@airsoko.example` | Commercial Manager    |

---

## Layout

```
packages/contracts   Zod schemas, enums, error codes, the RBAC table.
                     Shared verbatim by the API and the browser.
packages/domain      The kernel. Every operational rule, pure and typed.
                     No I/O, no framework, no persistence -- lint enforces it.
apps/api             Express 5 over PostgreSQL. The only write path is the
                     mutation pipeline in src/pipeline/runIntent.ts.
apps/web             React 19 + Vite + MUI. Reads the same permission table
                     the API enforces with.
e2e                  The seven acceptance scenarios from the brief.
```

### The mutation pipeline

Every write in this system is an **intent**: a named, typed command that is evaluated
before it is applied. One call to `runIntent` guarantees, atomically:

1. rules are evaluated against the state inside the transaction
2. blocking findings refuse the write
3. unacknowledged warnings refuse the write
4. the entity change lands
5. an audit entry lands
6. any alerts land
7. all of it commits together, or none of it does

`apply` is the only function handed a transaction, and it is unreachable unless the
decision came back "apply". Audit is not the caller's responsibility and cannot be
forgotten — `apply` must return an audit draft to type-check.

Read `packages/domain/src/intent.ts` first; it is the shortest path to understanding
the whole architecture.

---

## Scripts

| Command                          | What it does                                          |
| -------------------------------- | ----------------------------------------------------- |
| `npm run dev`                    | API and web together                                  |
| `npm run verify`                 | Everything CI runs: types, lint, format, tests, build |
| `npm run typecheck`              | All workspaces                                        |
| `npm test`                       | Domain rules (pure, no database)                      |
| `npm run test:e2e`               | Acceptance scenarios (needs a seeded database)        |
| `npm run db:up` / `db:down`      | Postgres container                                    |
| `npm run db:generate`            | New migration from a schema change                    |
| `npm run db:migrate` / `db:seed` | Apply migrations; load demo data and recorded entries |
| `npm run db:reset`               | Drop the volume and rebuild from scratch              |

---

## Demonstration data, and what it is not

The seed is idempotent and deterministic: identifiers derive from natural keys, salts
derive from the email, and no timestamp is generated at seed time. Two machines
running `npm run db:seed` get byte-identical rows, which is what makes screenshots and
end-to-end tests reproducible.

**The operational thresholds in `packages/domain/src/policy.ts` are demonstration
values.** Turnaround minimums, duty limits and crew complement rules are plausible for
a European short- and medium-haul operator and are _not_ EASA FTL, FAA rules, or any
other regulatory scheme. Nothing in this system checks legal compliance and it must
not be described as doing so.

Airport coordinates are reference points accurate to a few hundred metres — fine for
route distances and map rendering, useless for navigation.

---

## Working on two machines

Every entry made through the application is recorded as seed data — one JSON file per
entity under `apps/api/src/db/seed/recorded/` — and replayed by `npm run db:seed` and by
the API as it starts. Commit the files with your work. On the other machine, pull and
either restart the API or run `npm run db:seed`, and the flight you filed yesterday is
there. A removal travels as a tombstone. Decision 32 has the reasoning.

Recording is on in development and off everywhere else. `SEED_RECORDING=off` turns it
off, and a request that sends `x-airsoko-recording: off` is not recorded, which is how
the acceptance suite keeps its fixtures out of the committed data. The audit trail and
the alert feed stay local: they record what happened on this machine.

If both machines change the same entry, `git pull` reports a conflict on that one file.
Keep the version that is right, remove the markers, and restart the API.

---

## Known issue on this machine

Docker's credential helper fails when the CLI runs from an elevated (administrator)
shell: `error getting credentials — A specified logon session does not exist`. The
image is public and needs no credentials, but the CLI invokes the helper regardless.

Pull the image once from a **normal, non-elevated** terminal:

```bash
docker pull postgres:18-alpine
```

After that the image is local and `npm run db:up` works from any shell, elevated or
not, because Compose only contacts a registry when the image is missing.

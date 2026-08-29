# Decisions

Short records of choices that would otherwise have to be re-derived. Each says what was
decided, why, and — where it matters — what would justify revisiting it.

---

## 1. A new repository, not an extension of the thesis project

**Decided.** Air Soko's operations console lives in its own repository, reusing the
airline's identity but none of `airline-ticket-management-app`'s code.

The reference project is a passenger booking site with a small admin area. The domain
gap is structural rather than cosmetic: 12 booking-side tables against roughly 26
operational entities, airports with no coordinates at all, aircraft modelled as
`Narrow-body | Wide-body` rather than type-versus-airframe, two datetimes where six are
needed, and no crew, maintenance, audit, alerts or PNR container.

Its dependency state also argues against building on it. No file under `backend/src` or
`frontend/src` has changed since 12 March 2024, while 1,679 auto-merged Dependabot pull
requests dragged it to React 19.2, TypeScript 7, MUI 9 and `@types/node` 26 — still
building through `react-scripts` 5.0.1, unmaintained since 2022. Nothing ever compiled
the result; the only CI check was CodeQL.

**What did carry over:** the Air Soko brand, and the shape of its patterns —
per-domain module folders, validation at the boundary, transaction-owning services.

**What did not, despite an early assumption that it would:** the reference data. Its
`time_zone` table is 351 IANA names, a stale subset of the 418 Node's own ICU provides
and keeps current. Its `country` table is 194 names with **no ISO codes**, which cannot
key a foreign key or drive a flag. Both were re-authored from scratch.

---

## 2. PostgreSQL over MySQL or SQLite

**Decided.** Postgres 18 in Docker, accessed through Drizzle.

Instants and airport-local times are the single most reliable source of subtle bugs in
this domain, and `timestamptz` keeps them honestly separate in a way MySQL `datetime`
does not. Drizzle Kit provides migrations and a repeatable seed, which the brief asks
for. SQLite would have removed all infrastructure and was a reasonable alternative for
a portfolio piece; it lost on interval arithmetic and zone handling.

Port 5433, not 5432, so the container cannot collide with a local Postgres.

---

## 3. TypeScript 6.0, not 7.0

**Decided**, and worth revisiting.

TypeScript 7.0.2 is current, and the reference project is already pinned to it. But
`typescript-eslint@8.68.0` — the latest release, with no v9 in sight — declares
`typescript >=4.8.4 <6.1.0`. Installing TS 7 fails to resolve, and forcing it past the
peer range would leave type-aware linting either broken or unverified.

TypeScript **6.0.3** is stable, current, and inside that range. In a foundation
repository where CI runs lint as a gate, a working linter is worth more than the native
compiler's speed.

**Revisit when** typescript-eslint widens its peer range. The change is one line in the
root `package.json`.

---

## 4. Status and phase are separate axes; `delayed` is neither

**Decided.** `FlightStatus` is the operational state the airline manages
(`boarding`, `taxi_out`, `airborne`). `FlightPhase` is where the airframe physically is
(`climb`, `cruise`, `descent`). Telemetry moves phase; controllers move status.

The brief lists `delayed` among the statuses. Taken literally that is a worse model: a
flight can be boarding _and_ delayed, and one field cannot hold both without erasing
one. Delay is derived — an estimated time later than scheduled by more than
`policy.delay.thresholdMinutes`. The map legend still gives it its own visual
treatment; it just reads a computed flag.

---

## 5. Every write goes through one transactional pipeline

**Decided.** `runIntent` in `apps/api/src/pipeline/runIntent.ts`.

The brief's cross-module consistency rule and all seven acceptance scenarios are really
one requirement: a mutation must be impossible to apply without its consequences. That
cannot be enforced by discipline across twelve feature modules, so it is enforced
structurally. `apply` is the only function handed a transaction, and it is unreachable
unless the rules have already been evaluated and the decision came back "apply". Its
return type demands an audit draft, so audit cannot be forgotten.

Airports go through it too, even though a bare `UPDATE` would have been quicker. That
is the point — there is no precedent for a later, more dangerous endpoint to skip it.

---

## 6. Warnings are acknowledged by code, not by clicking through

**Decided.** A warning does not silently pass. The operator must send back the exact
rule codes they were shown, those codes are recorded on the audit entry, and each one
becomes an open alert.

A single "I understand" button would record that somebody clicked. This records what
they accepted, and leaves it visible in the alert feed after the dialog is gone.

---

## 7. The domain kernel is pure, and lint enforces it

**Decided.** `packages/domain` may not import a database driver, a framework, React, or
Node's I/O modules, and may not read the wall clock — the evaluation instant arrives as
an argument. Both rules are `no-restricted-imports` / `no-restricted-syntax` entries in
`eslint.config.js`.

The promise is that any operational rule can be tested in a millisecond with no
fixtures. A promise that is only a convention decays; this one fails the build.

---

## 8. scrypt for passwords, from the standard library

**Decided.** Not bcrypt, not argon2 — both need a native build, and on Windows that
turns clone-and-run into a toolchain hunt. scrypt is memory-hard, built into Node, and
needs nothing installed. The stored format carries its own parameters, so the cost can
be raised later without invalidating existing hashes.

---

## 9. Deterministic identifiers in the seed

**Decided.** Seeded rows derive their UUIDs from a fixed namespace plus their natural
key (RFC 4122 v5). `airportId("BEG")` is the same UUID on every machine, forever.

The brief asks for reproducible data. Random UUIDs would invalidate every bookmarked
URL and every hard-coded id in an end-to-end test on each reseed.

---

## 10. Acceptance scenarios are committed from Phase 0, marked `fixme`

**Decided.** All seven scenarios exist as Playwright specs now, each carrying the
assertion it will eventually make. Ones whose feature is unbuilt use `test.fixme`, so
they appear in every report as outstanding without painting CI red.

Removing a `fixme` is a deliberate act and is how a phase gate gets claimed. A screen
that looks finished cannot make a red spec green.

---

## 11. Dependabot stays; blind automerge does not

**Decided.** Updates are grouped, majors are never automatic, and automerge uses
`gh pr merge --auto`, which queues behind the full CI matrix — types, lint, format,
domain tests, production build, acceptance scenarios.

This is the direct lesson of decision 1. Keeping dependencies current is a good habit;
merging them without ever compiling the result is how a repository ends up two years
out of sync with its own dependency tree.

---

## 12. Deferred dependencies

**Decided.** `maplibre-gl` and the MUI X packages are not installed yet. They arrive
with the phase that uses them — the map in Phase 1's spike, the charts with the
dashboard. A foundation repository with unused dependencies teaches the wrong habit.

---

## 13. Airport facts are sourced, not authored

**Decided.** Station names, ICAO codes, coordinates, elevations and time zones come
from a curated extract of [OurAirports](https://ourairports.com/) (public domain),
committed as `apps/api/src/db/seed/reference/airports.reference.json`. Rebuild it with
`npx tsx scripts/build-airport-reference.ts`.

The first version of the seed carried coordinates written from memory. Checked against
the source they were a median 261 m out, and Madrid was wrong by 2.5 km — which would
have propagated into every route distance, range check and map position downstream.

**Not fetched at runtime.** An airport's coordinates are stable for decades, so calling
a remote API per keystroke would buy a network dependency, a key and a rate limit in
exchange for nothing. A committed file is instant, works offline, and makes the tests
deterministic. If a live source is ever wanted it replaces `airportReference()` behind
the same shape — the same pattern the telemetry provider uses.

**Time zones are derived, then validated.** OurAirports has no zone column, so
`tz-lookup` (148 KB, offline) derives one from the coordinates. It agreed with all 36
hand-authored zones across UTC+14 to UTC−5, including a half-hour offset and the
southern hemisphere, which is why the 71 MB `geo-tz` alternative was not needed.

**Selection is curated, not exhaustive:** everywhere in Europe with scheduled service,
plus major airports worldwide — 1,396 stations out of 85,986. An airline's station
reference covers where it flies and where it might plausibly fly.

---

## 14. Country codes must be ones ISO actually assigns

**Decided.** Both the importer and the API reject any country code outside the 249
officially assigned by ISO 3166-1 alpha-2, generated into `iso3166.ts` with the count
asserted so an ICU update cannot silently move the gate.

The reason is a plain data-modelling one: the source's `iso_country` column is **not**
ISO 3166-1. It carries user-assigned codes from the `XA`–`XZ` range that ISO
deliberately leaves unstandardised, plus `ZZ` for unknown. Our schema documents that
column as ISO 3166-1, so admitting those values would make the schema's own contract
false. One general rule, applied uniformly, with everything it drops reported in the
run output for a person to see.

**The countries table is not a world list.** It holds the countries the network
touches. Serving a new one is exactly the deliberate act that adds it, so the row is
created alongside the station inside the same transaction — and the operator is told it
is coming, as a consequence on the preview.

An earlier version of this document claimed the import "forces the country table to
become complete". That was wrong, and it was the claim that manufactured the problem.
Reaching for a bulk world import is a lazy default, not a requirement.

---

## 15. No alpha-3 country column, for now

**Decided.** The `countries` table has `code` and `name` and nothing else. Migration
`0001` drops the `alpha3` column added in Phase 0.

Nothing reads it, and the 249 alpha-3 codes could not be derived from any source
available here — `Intl` does not expose them. Shipping 249 codes typed from memory
would have been unverifiable data in a column documented as authoritative. It returns
in Phase 6 if travel documents need it, sourced properly then.

---

## 16. Live map: findings from the Phase 1 spike

**Decided.** MapLibre GL is confirmed for Phase 4. The spike that proved it has been
deleted; these are its findings.

**No basemap is needed.** A style with `sources: {}` and a single background layer
renders fine. Stations, route arcs and aircraft all come from our own data, so the map
has no tile provider, no API key and no network dependency. A real basemap remains
optional, not structural.

**Great-circle arcs render correctly**, visibly bowed against a straight line, with the
antimeridian split working — `greatCirclePath` output drops straight into a GeoJSON
line source.

**Rotation must not use text.** `icon-rotate` on a symbol layer takes a compass heading
directly, but the icon has to be an _image_. Any `text-field` — a unicode aircraft
glyph, a station label, a callsign — requires font PBFs from a `glyphs` URL, which is
exactly the network dependency the offline style avoids. The spike generated its marker
to an `ImageData` at runtime instead. Phase 4 needs the same approach, plus either
bundled fonts or an HTML overlay for labels.

**Marker count is not the bottleneck.** Updating the aircraft source and rendering a
frame measured ~33 ms flat from 8 markers to 500 — that figure is the frame interval,
not the data cost, which stayed below measurement noise throughout. The live map will
be frame-bound rather than data-bound at any fleet size this airline will have.

### Two Vite configuration requirements, found the hard way

Both are in `apps/web/vite.config.ts` and both are load-bearing:

1. **`optimizeDeps.exclude` must list `maplibre-gl`.** Its renderer runs in a Web
   Worker, and Vite's dependency pre-bundler rewrites the import so the worker fails to
   load (`ERR_FAILED` on `maplibre-gl-worker.mjs`). Every GeoJSON source then sits at
   `loaded: false` for ever while the background layer paints normally — the map looks
   alive with nothing on it, and no error is raised.
2. **An anchored alias to `maplibre-gl/dist/maplibre-gl.mjs`.** With pre-bundling
   excluded, Vite resolves the bare specifier to the CJS `maplibre-gl.js`, which has no
   named exports. The alias must be a `/^maplibre-gl$/` regex, not a plain string:
   string aliases are prefix matches and would rewrite
   `maplibre-gl/dist/maplibre-gl.css` into a path inside the `.mjs` file.

### A diagnostic note worth keeping

Most of the spike was spent chasing a map that rendered nothing, and two of the three
hypotheses along the way were wrong. The one that cost most: **the in-app browser pane
was hidden**, and `requestAnimationFrame` does not fire in a hidden pane. MapLibre
renders entirely through rAF, so the map never painted a frame and looked identically
broken whatever the real cause. It briefly led to blaming maplibre-gl v6 and
downgrading to v5 — a false diagnosis, since v5 failed the same way. v6 is what shipped.

The lesson for later phases: **verify anything canvas- or animation-based in Playwright,
not the preview pane.** `scripts` are cheap; a wrong diagnosis is not.

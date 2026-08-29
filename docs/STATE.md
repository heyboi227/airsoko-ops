# State

Where the build currently stands. Updated at the end of every phase.

**Phase 0 — complete.** Next: Phase 1 (Foundation and map spike).

---

## What Phase 0 delivered

The foundations, and one entity through every layer to prove them.

| Area                                                      | Status                        |
| --------------------------------------------------------- | ----------------------------- |
| Monorepo, workspaces, TypeScript strict everywhere        | Done                          |
| PostgreSQL 18 + Drizzle, migration `0000_many_preak.sql`  | Done                          |
| Domain kernel: geo, time, policy, intent pipeline         | Done, 46 unit tests           |
| Mutation pipeline with audit and alerts, transactional    | Done                          |
| RBAC: 6 roles, 36 permissions, enforced API-side          | Done                          |
| Airports end to end: list, filter, create, edit, withdraw | Done                          |
| Audit read endpoint (`GET /api/audit`)                    | Done, minimal                 |
| App shell, navigation, login, theme                       | Done, minimal                 |
| Deterministic seed: 32 countries, 37 airports, 7 users    | Done                          |
| CI: types, lint, format, unit, build, acceptance          | Done                          |
| Acceptance scenarios A–G committed                        | G partly passing, A–F `fixme` |

### Verified

- 46 domain unit tests pass, including a full DST week either side of the
  Europe/Belgrade spring-forward and autumn-back transitions.
- All five workspaces typecheck under `strict` with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- Production build produces `apps/api/dist/main.js` and `apps/web/dist`.

### Not yet verified

- **Nothing has run against a live database.** Migration and seed are written and the
  migration is generated, but the Postgres image could not be pulled on this machine —
  see the known issue in the README. Until then the acceptance specs and the seed are
  unexercised.

---

## What is deliberately absent

Eleven of the twelve navigation sections show an honest "not built yet" panel naming
the phase that builds them. That is a choice, not an omission: the brief rules out
"fake controls that do nothing", and a convincing mock would be worse than nothing.

The airport `deactivate` intent evaluates route and upcoming-flight dependencies
against hard-coded zeroes, because routes and flights do not exist yet. The rule is
real and tested; its inputs become real in Phases 2 and 3.

---

## Next: Phase 1 — Foundation and map spike

**Gate:** every route navigable; the spike answers tiles, rotation, projection and
update cost; the spike is then deleted.

1. Domain types and persistence for the full entity set — aircraft types and airframes,
   cabins and seats, routes, schedules and flight instances, crew, bookings, alerts.
   Migration and schema only; the screens come with their phases.
2. Dashboard skeleton reading real metric queries against seeded data.
3. Breadcrumbs, global search shell, notification surface.
4. **Map spike** (throwaway): MapLibre renders with no network using a bundled offline
   style; a marker rotates to heading; the telemetry provider interface compiles
   against a stub; measure the cost of moving ~40 markers per tick.

**Before starting:** pull the Postgres image from a non-elevated terminal, then run
`npm run db:up && npm run db:migrate && npm run db:seed && npm run test:e2e` to close
out the Phase 0 gate properly.

---

## Open questions

None blocking. Two worth a decision before Phase 4:

- **Map tiles.** The offline style keeps the app working with no network, but a real
  raster or vector source looks considerably better. If one is acceptable, it needs a
  provider and a key in `VITE_MAP_TILE_URL`.
- **Live transport.** SSE is the current plan and is in `.env.example` as
  `TELEMETRY_PROVIDER`. WebSockets become worth the complexity only if the console ever
  needs to push commands back, which nothing in the brief requires.

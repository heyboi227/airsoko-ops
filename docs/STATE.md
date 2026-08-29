# State

Where the build currently stands. Updated at the end of every phase.

**Phase 1 — complete.** Next: Phase 2 (Fleet).

---

## What Phase 1 delivered

| Area                                                 | Status                                 |
| ---------------------------------------------------- | -------------------------------------- |
| Airport reference import from OurAirports, ISO-gated | Done, 1,396 stations                   |
| Full operational schema, 29 tables by domain         | Done, migration `0002`                 |
| Fleet: 24 aircraft, 5 types, 47 cabins, 3,559 seats  | Done                                   |
| Network: 72 routes, 102 recurring schedules          | Done                                   |
| Flights: 806 across a 9-day window, with rotations   | Done                                   |
| Dashboard on real queries                            | Done                                   |
| Station autofill from the reference                  | Done                                   |
| Live map spike                                       | Done, findings recorded, spike deleted |

### Verified

- 46 domain unit tests and 22 acceptance tests pass; `npm run verify` exits 0.
- The seed is deterministic given a reference date — same-day reseeds are byte-identical
  by checksum, verified across flights, aircraft and status.
- The dashboard's figures are all derived from the flights themselves. Nothing about
  the operation is stored twice, so the dashboard and the flight data cannot disagree.
- The live map renders stations, great-circle arcs and heading-rotated aircraft with no
  basemap, no API key and no network. Marker updates are frame-bound, not data-bound,
  flat from 8 to 500 markers.

### Known simplifications

- **No overnight repositioning.** Real rotations end the day at a base; this one leaves
  tails where their last sector ended, so unassigned flights accumulate across the
  window (about 11 on day one, 23 by day six). Those flights are genuine conflicts and
  feed the alert work in Phase 7, but the growth is a modelling gap rather than a
  design.
- **Crew and bookings are absent**, so the dashboard reports those sections as
  unavailable with the phase that builds them, never as zero.
- **Aircraft status is not driven by flights yet.** The fleet's `status` column is
  seeded, while "airborne" on the dashboard is read from the flights themselves — the
  fact rather than a second copy of it. Phase 2 reconciles the two.

---

## Next: Phase 2 — Fleet

**Gate:** an unavailable aircraft is not silently assignable; capacity derives from the
cabin configuration and is never stored twice.

1. Fleet overview: registration, type, status, location, current and next flight,
   capacity, age, utilisation, maintenance state.
2. Aircraft profile with cabin layout and an optional seat map.
3. Amenities, configurable and assignable at aircraft and cabin level.
4. Light maintenance: last check, next due, hours and cycles remaining, approaching-limit
   warnings.

## Open questions

None blocking. Two worth a decision before Phase 4:

- **Map tiles.** The offline style keeps the app working with no network, but a real
  raster or vector source looks considerably better. If one is acceptable, it needs a
  provider and a key in `VITE_MAP_TILE_URL`.
- **Live transport.** SSE is the current plan and is in `.env.example` as
  `TELEMETRY_PROVIDER`. WebSockets become worth the complexity only if the console ever
  needs to push commands back, which nothing in the brief requires.

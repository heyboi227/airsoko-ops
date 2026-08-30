# State

Where the build currently stands. Updated at the end of every phase.

**Phase 2 — complete.** Next: Phase 3 (Flight schedule).

---

## What Phase 2 delivered

**Gate:** an unavailable aircraft is not silently assignable; capacity derives from the
cabin configuration and is never stored twice. **Met** — pinned by acceptance tests at
both the API and the browser.

| Area                                                         | Status                     |
| ------------------------------------------------------------ | -------------------------- |
| Serviceability split from operational state                  | Done, migration `0003`     |
| `deriveFleetState` — position, state, rotation, from flights | Done, pure                 |
| `evaluateAircraftAssignment` — the Phase 3 assignment gate   | Done, 20 unit tests        |
| Registering an airframe with its cabins                      | Done, 20 unit tests        |
| Retiring an airframe                                         | Done, migration `0004`     |
| Maintenance standing across calendar / hours / cycles        | Done, 96 events seeded     |
| Amenity resolution across four scopes                        | Done, 11 unit tests        |
| Amenity assignment at aircraft and cabin scope               | Done, 11 unit tests        |
| Fleet list with derived state and URL-backed filters         | Done                       |
| Aircraft profile drawer, incl. serviceability change         | Done, through the pipeline |
| Amenities page with the per-cabin resolution matrix          | Done                       |

### Verified

- 112 domain unit tests and 58 acceptance tests pass; `npm run verify` exits 0.
- Withdrawing an airframe with onward sectors names them by flight number before it
  happens, refuses to apply until the warning is acknowledged by its code, and raises a
  critical alert per stranded flight when it does.
- Every aircraft's reported capacity equals the sum of its cabins, across the whole
  fleet. No column stores the total, and the registration form has no field for one —
  a registered airframe's 216 seats are 216 seat rows, written in the same transaction.
- No aircraft can report a state that contradicts its serviceability, and no airborne
  aircraft claims to be at an airport.
- A registered airframe round-trips: created, listed with the right capacity, retired,
  gone from the fleet, and its marks available again.
- Amenity resolution is order-independent, and adding a grant beside an existing
  withdrawal is warned as changing nothing rather than silently doing nothing.
- The dashboard, the fleet page and the aircraft profile all read `loadFleet`. There is
  one implementation of "where is this aircraft and what is it doing".

### Known simplifications

- **Aircraft types are read-only.** Registering a tail of an existing type is the
  common act and is built; adding a _type_ is a much heavier form and a rarer
  event. The five seeded types cover the network as it stands.
- **Aircraft records cannot be edited after registration.** They can be
  registered and retired. An edit form is the same rule set with `editingId`
  set — `evaluateRegisterAircraft` already takes it — but nothing calls it yet.
- **Fare-product and flight amenity scope are read-only.** Both are modelled and
  both resolve correctly; what is missing is the thing to attach them to. Fare
  products arrive in Phase 6, flights in Phase 3.
- **No seat map.** The brief calls it optional. Seats exist as rows from the
  moment an aircraft is registered, so the map has data waiting for it; it only
  becomes meaningful once bookings can occupy seats, in Phase 6.
- **Maintenance is read-only.** Events are seeded and shown; scheduling a check is not
  a mutation the product offers yet. `aircraft:maintenance` exists as a permission and
  is unused.
- **No overnight repositioning** (carried from Phase 1). Tails still end the day where
  their last sector left them, so unassigned flights accumulate across the window.
  Those are genuine conflicts and feed Phase 7.

---

## Next: Phase 3 — Flight schedule

**Gate:** a conflicting change is refused with a precise reason, and nothing invalid is
persisted.

1. Flight list and calendar, filterable by date, route, aircraft and status.
2. The flight-control detail page: status, times, gate, aircraft, delay recording.
3. Recurring schedules, with per-occurrence overrides that do not disturb the series.
4. Aircraft assignment through `evaluateAircraftAssignment`, which Phase 2 already
   built and tested — this is where it becomes reachable from the UI.

Scenario A from the brief lands here, and Scenario C. Scenario F is raised here and
completed in Phase 6, when seats sold exist to compare capacity against.

## Open questions

None blocking. Two worth a decision before Phase 4:

- **Map tiles.** The offline style keeps the app working with no network, but a real
  raster or vector source looks considerably better. If one is acceptable, it needs a
  provider and a key in `VITE_MAP_TILE_URL`.
- **Live transport.** SSE is the current plan and is in `.env.example` as
  `TELEMETRY_PROVIDER`. WebSockets become worth the complexity only if the console ever
  needs to push commands back, which nothing in the brief requires.

---

## Phase 1 — complete

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

The seed is deterministic given a reference date — same-day reseeds are byte-identical
by checksum. The live map spike's findings are decision 16; the spike itself was
deleted.

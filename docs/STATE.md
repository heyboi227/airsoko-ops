# State

Where the build currently stands. Updated at the end of every phase.

**Phase 3 — complete.** Next: Phase 4 (Live Operations).

---

## What Phase 3 delivered

**Gate:** a conflicting change is refused with a precise reason, and nothing invalid is
persisted. **Met** — pinned by acceptance tests at both the API and the browser.

| Area                                                            | Status                             |
| --------------------------------------------------------------- | ---------------------------------- |
| Flight board, filterable by date, route, status, aircraft, type | Done, URL-backed filters           |
| Fleet timeline — the operating day by airframe                  | Done                               |
| Flight-control page: times, aircraft, gates, timeline, rotation | Done                               |
| Aircraft assignment through `evaluateAircraftAssignment`        | Done, Scenario A                   |
| Releasing an airframe, with the alert it raises                 | Done                               |
| Status lifecycle, and the transitions it refuses                | Done, 10 unit tests                |
| Recording and clearing a delay                                  | Done                               |
| Gates, terminals, counters and carousels                        | Done                               |
| Creating, duplicating and rescheduling a flight                 | Done                               |
| Removing a flight that never operated                           | Done, distinct from cancelling     |
| Recurring schedules: list, create, edit, delete                 | Done                               |
| Occurrence generation over an explicit window                   | Done, decision 30                  |
| Per-occurrence exceptions and the three edit scopes             | Done, Scenario C, migration `0005` |
| `GET /api/routes`, so a flight or pattern can pick a pair       | Done, read-only                    |

### Verified

- 195 domain unit tests pass, up from 118, and 102 acceptance tests across the API and
  the browser; `npm run verify` exits 0. The 11 still skipped are the `fixme` scenarios
  Phases 5 to 7 build.
- Scenario A and Scenario C have left `pending-scenarios.api.spec.ts`. They are
  executable specifications now, in `flights.api.spec.ts` and `schedules.api.spec.ts`,
  with their browser halves in `flights.ui.spec.ts`.
- An unserviceable, overlapping, out-of-position, out-of-range or too-small airframe is
  refused by name, with the figure and the conflicting flight. The refusal reaches the
  screen: the Assign button stays disabled and the reason is on it.
- Releasing an airframe warns, names the sector it strands, and raises a critical alert.
  Without the acknowledgement the API returns 412 and the flight keeps its aircraft.
- Editing one occurrence of a four-week service moves that date, records which fields
  now diverge, and leaves the other three and the pattern untouched.
- "This and future" splits the season in two: the old pattern keeps its times and its
  earlier flights, a new one carries the change forward.
- A series edit leaves a hand-edited occurrence byte-identical unless overwriting is
  asked for, and says how many it is leaving before it does anything.
- A flight that has already operated is never rewritten by a plan change.
- Every instant on the wire is ISO 8601 in UTC — asserted, because it was not before.
- Recording ninety minutes on a hub departure raises two warnings, not one: the delay
  is significant, and the airframe's next sector is left with one minute on the ground
  against a thirty-five-minute minimum. Both must be acknowledged by their own code
  before the change applies. That is the cross-module check working on real data, and
  the browser test asserts the Apply button stays disabled until the last tick.
- A booking administrator reads the board and is refused all four flight mutations at
  the API, in preview mode as well as apply.

### Fixed here, from earlier phases

Two Phase 2 rules were wrong in ways only real data could show; both are decision 29.
`evaluateAircraftAssignment` compared a sector against every commitment rather than the
adjacent ones, which made every aircraft in a rotation unassignable. And instants had
been leaving the database in Postgres's wire format since Phase 0, against a contract
that says they are ISO 8601 — decision 28.

Two smaller ones: the seed's schedule upsert did not own the columns it writes, so a
season shortened by an edit survived a reseed; and `z.coerce.boolean()` read the string
`"false"` as `true` on three query filters.

### Known simplifications

- **Cancellation is not built.** Scenario B propagates to bookings and crew assignments,
  neither of which exists yet, so it stays in Phase 7 where the plan has always put it.
  The status lifecycle models `cancelled` and refuses to reach it after pushback; what is
  missing is the propagation, and no control offers the action.
- **Scenario F is raised but cannot fire.** `AIRCRAFT_CAPACITY_BELOW_SOLD` and its
  per-cabin sibling are written, unit-tested, and read on every assignment —
  `soldByCabin` is passed to the rule today. It is always empty because nothing can sell
  a seat. Phase 6 supplies the data, not the rule.
- **Crew is absent from the flight page** beyond a note saying Phase 5 brings it. The
  complement rules are in `policy.complement` and unused.
- **Routes are read-only.** A route is a network-planning decision behind a schedule
  rather than something a controller edits between flights. Picking one is what Phase 3
  needs; creating and suspending them belongs with the network screens.
- **Diversion sets the status and raises an alert but does not move the destination.**
  Re-routing a flight to another airport touches the rotation, the crew and the
  passengers, which is Phase 7's cross-module work.
- **No overnight repositioning** (carried from Phase 1). Tails still end the day where
  their last sector left them, so unassigned flights accumulate across the window — 145
  of 820 in the current seed. Those are genuine conflicts and feed Phase 7.

---

## Next: Phase 4 — Live Operations

**Gate:** the map is a working view of the same flight records, not a second copy of
them — selecting a marker selects its list row and opens the flight this console
already knows about.

1. The interactive 2D map, on MapLibre GL, using the offline style proven in Phase 1's
   spike (decision 16).
2. The synchronised active-flight list, with selection in both directions.
3. The telemetry provider contract, and the simulation behind it.
4. Simulated movement through the phases, interpolated along great-circle arcs.
5. Filters, search, and the flight-detail drawer that links to `/flights/:id`.

Scenario E lands here. The pieces it needs already exist: `GET /api/live-operations`
returns the active flights with both endpoints' coordinates, `greatCirclePath` is in the
kernel and tested, and `flightProgress` is the same function the board reads.

## Open questions

None blocking. The two from Phase 2 still stand and are now due:

- **Map tiles.** The offline style keeps the app working with no network, but a real
  raster or vector source looks considerably better. If one is acceptable, it needs a
  provider and a key in `VITE_MAP_TILE_URL`.
- **Live transport.** SSE is the current plan and is in `.env.example` as
  `TELEMETRY_PROVIDER`. WebSockets become worth the complexity only if the console ever
  needs to push commands back, which nothing in the brief requires.

---

## Since Phase 3: recorded entries

Entries made through the application are seed data now (decision 32). The mutation
pipeline records every committed change as a JSON file under
`apps/api/src/db/seed/recorded/`; the seed and the API's start-up replay the directory;
the acceptance suite declines to be recorded, so its fixtures stay out of the committed
data. Migration `0006` adds the change log and its triggers. Five acceptance tests in
`recorded-entries.api.spec.ts` pin it, two of them by reseeding the database: one reads
the entry, and then its tombstone, back; the other shows a gate and a note the suite
declined to record going back on their pattern, exception marker included, while a
recorded edit keeps both and its exception. The schedule and flight upserts, the two that
own every column of a row the seed generated, read their SET block from the table
(`ownEveryColumn` in `seed/upsert.ts`) rather than from a list kept by hand, so nothing a
hand edit wrote outlives a reseed; a unit test holds that block to every column of both
tables, so a column added to the schema is owned without being listed.

---

## Phase 2 — complete

**Gate:** an unavailable aircraft is not silently assignable; capacity derives from the
cabin configuration and is never stored twice. **Met.**

| Area                                                         | Status                        |
| ------------------------------------------------------------ | ----------------------------- |
| Serviceability split from operational state                  | Done, migration `0003`        |
| `deriveFleetState` — position, state, rotation, from flights | Done, pure                    |
| `evaluateAircraftAssignment`                                 | Done; reachable since Phase 3 |
| Registering an airframe with its cabins                      | Done, 20 unit tests           |
| Cabin autofill from the tails already flying the type        | Done, decision 26             |
| Retiring an airframe                                         | Done, migration `0004`        |
| Maintenance standing across calendar / hours / cycles        | Done, 96 events seeded        |
| Amenity resolution and assignment across four scopes         | Done, 22 unit tests           |
| Fleet list, aircraft profile drawer, amenities page          | Done                          |

The dashboard, the fleet page, the aircraft profile and now the flight-control page all
read `loadFleet`. There is one implementation of "where is this aircraft and what is it
doing", and one of "what is this flight" beside it in `loadFlights`.

---

## Phase 1 — complete

| Area                                                 | Status                                 |
| ---------------------------------------------------- | -------------------------------------- |
| Airport reference import from OurAirports, ISO-gated | Done, 1,396 stations                   |
| Full operational schema, 29 tables by domain         | Done, migration `0002`                 |
| Fleet: 24 aircraft, 5 types, 47 cabins, 3,559 seats  | Done                                   |
| Network: 72 routes, 106 recurring schedules          | Done                                   |
| Flights: 820 across a 9-day window, with rotations   | Done                                   |
| Dashboard on real queries                            | Done                                   |
| Station autofill from the reference                  | Done                                   |
| Live map spike                                       | Done, findings recorded, spike deleted |

The seed is deterministic given a reference date — same-day reseeds are byte-identical
by checksum. The live map spike's findings are decision 16; the spike itself was
deleted.

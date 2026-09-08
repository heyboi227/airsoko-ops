# State

Where the build currently stands. Updated at the end of every phase.

**Phase 4 — complete.** Next: Phase 5 (Crew).

---

## What Phase 4 delivered

**Gate:** selecting either a map marker or list row selects the same flight,
opens its detail drawer, and navigates to its existing control record.

**Met.** Scenario E passes at the API and in the browser.

- MapLibre 2D map with bundled land, hub and station labels, great-circle routes,
  rotating aircraft, animated received positions, pan, zoom and route fitting.
- One shared selection across the map, list and drawer. Flight and aircraft
  links open their existing records, and selection survives a page reload.
- Validated telemetry contracts, a replaceable API provider, and a deterministic
  schedule simulator. The board's summary loader supplies identity, endpoints,
  aircraft, times and delay; the simulator never writes a flight status.
- URL-backed search and status, delay, type, registration, origin, destination,
  airport, route, domestic/international and UTC-date filters.
- Authenticated polling with cancellation, request timeout, hidden-tab pause,
  reconnection, visible frame age and stale/unavailable states.
- Contextual schedule, phase, position, altitude, speed, heading, progress,
  remaining distance/time, gates and aircraft capacity in the drawer.

### Verify it

Open `/live`, search for a flight number and select the row. Its route is framed
and the marker is selected; select a marker to perform the same action in the
other direction. **Open flight** reaches `/flights/:id`; **Open aircraft** reaches
the selected airframe in Fleet. Disconnecting the API leaves the last frame
visible with its age, then reconnects when service returns.

`live.api.spec.ts` and `live.ui.spec.ts` implement Scenario E. Their temporary
flight fixtures move at any time of day without changing an existing flight.
`telemetry.test.ts` covers phase boundaries, effective times, consistency between
speed and position, stale and unavailable cases, short sectors and the dateline.

### Verification results

- `npm run verify` passed: all workspaces type-check, lint and format checks
  pass, 247 unit tests pass, and both production builds succeed.
- `npm run test:e2e` passed: 122 acceptance tests, with the nine existing
  future-phase scenarios still skipped.
- The live page was visually inspected at 1,600px and 1,100px widths. The map,
  route, selected marker, list and contextual drawer render together; narrower
  screens stack the panels without horizontal clipping.
- Vite retains its advisory about chunks larger than 500 kB. The map is loaded
  on demand rather than included in the initial route's module.

The main additions are `packages/contracts/src/telemetry.ts`,
`packages/domain/src/telemetry.ts`, `apps/api/src/telemetry/provider.ts`,
`apps/web/src/pages/LiveOperationsPage.tsx` and `apps/web/src/components/live/`.
The existing flight loader, live routes, navigation and Fleet selection were
extended to connect them.

### Known limitations

- The simulation observes records; controllers still advance operational status.
  An overdue airborne record has no current position until its times/status are
  corrected. Selecting a date filters records and does not replay historical movement.
- Diversions cannot be simulated until a destination is confirmed. External mode
  explicitly reports unavailable positions; a real tracking adapter is not installed.
- The map caps a window at 1,000 flights and reports when it does so. Land is
  deliberately low resolution, with no external tiles or fonts required.
- Crew assignments and passenger load/inventory remain Phase 5 and Phase 6 work.

Implementation details and the polling decision are recorded in decision 35.

### Fixed since

- **Station dots sat south-east of their airports.** The dot was part of the HTML
  label, so it took the label's ten-pixel offset with it while the arcs ended at the
  true coordinate — a visible miss at every zoom, and a few hundred kilometres at
  zoom 1. Dots are a GL `circle` layer now, above the routes, and the label sits beside
  the dot rather than carrying it. Aircraft markers shrink as the view widens, and
  zoomed out the labels step back to the selected flight and its two airports, so a
  continent is legible rather than a pile of overlapping circles. Recorded in
  decision 35.
- **The recorded-entries specs went red for a whole day.** They filed their test flight
  by copying the local times off today's first Belgrade departure, and the board
  prints what is expected — actual, else estimated, else scheduled. On 2026-09-08 the
  seed handed that sector an 88-minute delay, so the copied block was 60 minutes for
  492 nm: a blocking finding, which no acknowledgement clears, and every pull request
  that UTC day failed without a line of its own changing. The sector now comes from a
  seeded pattern, whose times are the published ones whatever the clock says.

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
| `GET /api/routes`, so a flight or pattern can pick a pair       | Done, read-only at the gate        |

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
- **A route can be filed, but not withdrawn.** `POST /api/routes` opens a pair from the
  picker on the flight and schedule forms, both legs of it, and `route:write` now reaches
  operations control as well as network planning — decision 33. Removing, suspending and
  retiring one still belong with the network screens, because all three reach into the
  schedules and flights already filed on the pair. So a mistyped pair persists; the guard
  is the review before it is filed.
- **Diversion sets the status and raises an alert but does not move the destination.**
  Re-routing a flight to another airport touches the rotation, the crew and the
  passengers, which is Phase 7's cross-module work.
- **No overnight repositioning** (carried from Phase 1). Tails still end the day where
  their last sector left them, so unassigned flights accumulate across the window — 145
  of 820 in the current seed. Those are genuine conflicts and feed Phase 7.

---

## Next: Phase 5 — Crew

Profiles, qualifications and availability; cockpit and cabin complement;
assignment with overlap, type-rating and duty warnings. Scenario D is the next
acceptance gate. The live drawer can then display crew from the same flight record.

## Open questions

None blocking. Phase 4 settled transport on authenticated polling and bundled
offline land. A real tile source and a real telemetry adapter remain optional.

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

## Since Phase 3: a route can be opened

Routes were read-only at the Phase 3 gate, which meant a service could be filed only on a
pair the seed had generated — the schedule form offered the existing pairs and no way in
(decision 33). `POST /api/routes` files one through the same pipeline as every other
write, and the picker on the flight and schedule forms carries a **New route** button
beside the field. The pair is still picked rather than typed: filing one is a second,
deliberate step with its own review.

The distance is derived from the two stations' coordinates rather than asked for, and the
block time is offered from the planned type's cruise speed through `suggestedBlockMinutes`
— which the seed's own route builder now reads too, so the thirty-minute ground allowance
lives in one place instead of three. Both legs are filed together, because a route is
directional and a service is not. `route:write` reaches operations control as well as
network planning, for the reason decision 33 gives; Scenario G's boundary is unchanged.

`evaluateSaveRoute` is 18 more unit tests: a duplicate pair, a pair to itself, a withdrawn
endpoint, a block time no aeroplane could keep, and a sector nothing in the fleet reaches —
that last one a warning, because filing a pair the fleet cannot fly is how a network plan
starts. Ten acceptance tests cover the boundary, the refusals and the write, seven at the
API and three through the browser, and migration `0007` puts routes under the change
trigger so a pair opened in the console is recorded as seed data like everything else.

---

## Since Phase 3: the picker checks every tail

Choosing an airframe used to be the first thing the rules said anything about: the picker
listed the fleet, and an operator learned whether a tail could fly the sector by reviewing
it, one at a time. Now every tail arrives checked. `GET /api/flights/:id/aircraft/candidates`
runs `evaluateAircraftAssignment` over the whole active fleet against the sector and returns
each airframe with the rules' own preview of assigning it. The picker puts the verdict on the
row — clear, the warnings that would need acknowledging, or the conflicts that refuse it, by
name — and ranks the fleet by it, with the tails already standing at the origin first.

The verdicts are read, not decided (decision 34). Review still runs the same rule inside the
transaction that would apply the change, and that evaluation is the one the confirmation
shows. Both paths draw on the same three loaders, so the chip an operator read before
choosing cannot disagree with the review that follows for any reason but time. The endpoint
is gated on `flight:assign_aircraft` rather than on reading the fleet: it returns the
evaluation of a mutation, and Scenario G refuses a booking administrator the read as it
refuses them the preview. An acceptance test pins it at the API — the whole fleet comes back
with a verdict each, the unserviceable tail is refused by name, and a tail's verdict matches
what its review reaches — Scenario G's boundary test now refuses the read alongside the four
mutations, and the browser half asserts the conflict is on the row before Review is pressed.

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

Every published time the seed writes sits on the five-minute grid a timetable is
written to: the departure slot is hashed onto it, `suggestedBlockMinutes` rounds the
block to it (so the route form's suggestion lands there too), and a return leg takes the
first slot after the turnaround. Estimates and actuals stay to the minute, because a
delay is as long as it is. `generate.test.ts` holds every route, schedule and dated
flight to the grid.

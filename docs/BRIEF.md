# Build Brief: Airline Management Administration Dashboard

## Instructions to the implementation agent

Read this entire specification before making changes. Treat it as the authoritative product brief.

Do not attempt to satisfy the brief by creating disconnected mock pages. Build a coherent application in which flights, aircraft, crew, bookings, airports, schedules, and live operations share the same underlying data and business rules.

Work incrementally:

1. Inspect the existing repository, if one is provided.
2. Summarise the current architecture and reusable components.
3. Propose a short implementation plan aligned with the phases in this brief.
4. Implement one coherent phase at a time.
5. Validate each phase before continuing.
6. Keep the application runnable throughout the work.

If a requested external service is unavailable, implement a realistic local abstraction or simulation. Do not omit the user experience simply because a live API is unavailable.

When a decision is not specified, choose a sensible production-quality default, record the choice briefly, and continue. Ask for clarification only when the answer would materially change the architecture or product.

---

## 1. Product objective

Design and implement a modern, desktop-first **airline management administration web application** for airline operations and commercial staff.

The finished product should combine the core qualities of:

- an airline Operations Control Centre;
- flight and seasonal-schedule management software;
- fleet and light maintenance management;
- crew rostering and assignment software;
- booking and seat-inventory administration;
- live flight-tracking software;
- operational reporting and audit tooling.

The application is an internal administration platform, not a passenger booking website. It should feel credible to dispatchers, operations controllers, scheduling teams, fleet managers, crew schedulers, and booking administrators.

### Defining feature

The **Live Operations Map** is a primary product feature, not a decorative dashboard widget. It must show the airline's current operation on an interactive 2D map and connect directly to flight, aircraft, crew, and booking data.

An administrator opening the application should quickly understand:

- which flights are operating now;
- where airborne aircraft are located;
- which flights are delayed, boarding, cancelled, or diverted;
- which aircraft and crew are assigned;
- how full each flight is;
- which conflicts or warnings require attention;
- what operational actions are available.

---

## 2. Product principles and priority levels

Interpret requirement words as follows:

| Level      | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| **Must**   | Required for the core product. Do not omit.              |
| **Should** | Include unless a clear technical constraint prevents it. |
| **Could**  | Valuable enhancement after the core workflows work.      |

### Must-have principles

- Use a shared, relational domain model rather than separate per-page mock data.
- Ensure changes propagate to every affected module.
- Prefer complete workflows over a large number of shallow screens.
- Use realistic aviation terminology, data, statuses, dates, and constraints.
- Keep operational information dense but readable.
- Provide loading, empty, error, validation, and permission-denied states.
- Make dangerous or high-impact actions explicit and confirm them.
- Keep live-data integrations replaceable through a service abstraction.
- Use strong typing and modular, maintainable code.

### Explicitly avoid

- a collection of unrelated CRUD pages;
- oversized cards as the only information pattern;
- fake controls that do nothing;
- a map that is merely a static background;
- duplicated state that becomes inconsistent across screens;
- one enormous component containing the application;
- hard-coded amenities, roles, fare products, or statuses when configuration is appropriate;
- silently allowing aircraft, crew, capacity, or schedule conflicts.

---

## 3. Users, roles, and permissions

Implement role-based access control. At minimum, model these roles:

| Role                  | Main responsibilities                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Super Administrator   | Full system access and configuration                                                                |
| Operations Controller | Flight status, schedule changes, gates, aircraft assignments, delays, diversions, and cancellations |
| Fleet Manager         | Aircraft records, availability, cabin configuration, and maintenance overview                       |
| Crew Scheduler        | Crew records, qualifications, availability, and assignments                                         |
| Booking Administrator | PNRs, passengers, seats, baggage, and special-service requests                                      |
| Commercial Manager    | Fare products, cabins, amenities, inventory rules, and commercial reporting                         |

The UI and API must both enforce permissions. Hiding a button in the interface is not sufficient security.

Sensitive passenger and travel-document information must be restricted to authorised roles and excluded from ordinary logs.

---

## 4. Global application shell

Create a persistent administration layout with:

- collapsible left navigation;
- top header;
- global search;
- notifications and operational alerts;
- account and role menu;
- current date and relevant time-zone display;
- concise airline operational-status indicator;
- main content workspace;
- breadcrumbs or equivalent location context on deep pages.

Primary navigation:

1. Dashboard
2. Live Operations
3. Flight Schedule
4. Fleet
5. Crew
6. Bookings
7. Airports & Routes
8. Cabins & Fare Products
9. Amenities
10. Reports & Analytics
11. Alerts & Audit History
12. Settings

The primary target is a large desktop workstation. Tablet layouts must remain usable. On wide screens, use split views where they improve operational awareness.

---

## 5. Shared domain model

Model realistic relationships among at least these entities:

- Airline
- User
- Role and Permission
- Airport
- Route
- Aircraft Type
- Aircraft
- Cabin Configuration
- Seat
- Amenity
- Recurring Schedule
- Flight Instance
- Flight Status Event
- Crew Member
- Qualification or Type Rating
- Crew Assignment
- Booking / PNR
- Passenger
- Flight Segment
- Fare Product
- Seat Assignment
- Baggage or Ancillary Service
- Special Service Request
- Maintenance Event or Limit
- Operational Alert
- Audit Entry

Important distinctions:

- A **recurring schedule** defines a repeating service; a **flight instance** is one dated occurrence.
- A **cabin class** is not the same as a **fare product**.
- An **aircraft type** describes a model; an **aircraft** is a registered physical airframe.
- A **route** is a reusable airport pair; a **flight instance** has dated operational details.
- Scheduled, estimated, and actual timestamps must remain distinct.
- Store instants safely and preserve each airport's IANA time zone for local display and schedule calculations.

### Cross-module consistency rule

Every mutation must update or invalidate all related views and calculations.

Example: changing the aircraft assigned to a flight must trigger all of the following:

1. Update the flight and Live Operations views.
2. Recalculate cabin and total seat capacity.
3. Warn if sold inventory exceeds the replacement aircraft's capacity.
4. Check the aircraft for schedule and turnaround conflicts.
5. verify that assigned pilots and cabin crew meet type and complement requirements.
6. Recalculate aircraft utilisation where relevant.
7. Create an audit entry.
8. Create an operational alert if human action is required.

Cancelling a flight must affect its map visibility, bookings, aircraft availability, crew assignments, alerts, analytics, and audit history.

---

## 6. Dashboard

Build an operational overview for the current day.

### Required summary metrics

- scheduled, boarding, airborne, delayed, cancelled, completed, and diverted flights;
- average delay and on-time performance;
- expected and checked-in passenger counts;
- bookings and seats sold;
- overall and per-cabin load factor;
- aircraft flying, on ground, in turnaround, in maintenance, and unavailable;
- fleet utilisation;
- crew on duty, assigned, unavailable, approaching limits, or missing from a required position.

### Required visual and operational elements

- departures and arrivals through the day;
- flights grouped by status;
- fleet utilisation;
- booking or passenger trend;
- route or load-factor performance;
- a compact preview of live operations;
- a prominent actionable-alert feed.

Alert examples include missing crew, aircraft unavailability, schedule conflicts, approaching maintenance limits, oversold flights, low turnaround time, and airport restrictions.

Charts must have meaningful labels, accessible legends, tooltips, and useful empty states.

---

## 7. Live Operations Map — core feature

Create a dedicated Live Operations page centred on an interactive 2D map.

Recommended wide-screen layout:

- main map occupying most of the page;
- synchronised active-flight list beside it;
- filter/search toolbar;
- flight-detail drawer opened by selecting either a marker or list row.

### Map content

Show:

- airborne aircraft at current or simulated coordinates;
- airline hubs and relevant airports;
- active route paths or great-circle-style arcs;
- scheduled departures and approaching arrivals where useful;
- visual flight progress;
- a clear status legend.

Aircraft markers must rotate according to heading and update without reloading the page. Selecting a list item must select its map marker, and selecting a marker must select its list item.

### Statuses

Visually distinguish at least:

- scheduled;
- check-in open;
- boarding;
- taxiing;
- airborne;
- delayed;
- diverted;
- landed or arrived;
- cancelled.

Do not rely on colour alone; use labels, icons, or patterns as additional cues.

### Search and filters

Support search by flight number, callsign, aircraft registration, aircraft type, airport code, airport name, city, and route.

Support filters for:

- operational status;
- delayed flights only;
- aircraft type and registration;
- origin and destination;
- airport and route;
- domestic or international operation;
- date or time window.

### Selected-flight detail drawer

Display:

- flight number and callsign;
- status and current delay;
- origin and destination;
- scheduled, estimated, and actual departure/arrival times;
- aircraft type and registration;
- altitude, ground speed, heading, coordinates, and flight phase;
- progress percentage, remaining distance, and estimated time remaining;
- gate or terminal information when present;
- assigned cockpit and cabin crew;
- passenger load, capacity, and available seats.

Provide working navigation to the full flight, aircraft, crew-assignment, and booking-inventory views.

### Live-data architecture

Expose live updates through a clear provider interface. The initial implementation may use WebSockets, Server-Sent Events, or well-managed polling; prefer WebSockets when the chosen architecture supports them cleanly.

If no real tracking source is configured, implement a simulation provider. The UI must depend on the provider contract rather than directly on simulation logic, so a real provider can replace it later.

### Simulation behaviour

For each active flight, maintain current latitude, longitude, heading, altitude, speed, progress, and phase. Interpolate along a plausible route between airport coordinates and simulate:

1. scheduled;
2. boarding;
3. taxi and departure;
4. climb;
5. cruise;
6. descent;
7. landing;
8. arrival.

Updates should be smooth enough to feel live while avoiding unnecessary rendering or network load. Handle reconnection, stale data, and unavailable telemetry visibly.

---

## 8. Flight scheduling and operations

Provide list, calendar/timeline, creation, editing, duplication, rescheduling, cancellation, and permitted deletion of draft flights.

Each flight instance should support:

### Identity

- flight number;
- callsign;
- operating airline;
- marketing airline or codeshare numbers;
- domestic, international, positioning, charter, or other flight type.

### Route and schedule

- origin and destination;
- distance and planned duration;
- scheduled, estimated, and actual departure/arrival;
- airport-local time zones;
- block time;
- required turnaround time;
- terminal, check-in counters, gates, and baggage carousel.

### Operation

- assigned aircraft type and registration;
- status and delay reason;
- assigned crew;
- passenger and inventory summary;
- flight-level amenities;
- operational notes.

### Recurring schedules

Allow an administrator to define a flight number, route, validity start/end, operating weekdays, local departure/arrival times, season, aircraft type, default aircraft, and default commercial configuration.

Generate dated flight instances from the pattern. Allow one occurrence to be changed without modifying the complete series. When editing the series, clearly offer a scope such as this occurrence, this and future occurrences, or the entire series.

### Conflict detection

Validate before saving and distinguish blocking errors from warnings:

- an aircraft assigned to overlapping flights;
- insufficient post-arrival turnaround time;
- impossible repositioning between airports;
- aircraft range unsuited to route distance;
- replacement aircraft capacity below sold seats;
- crew member assigned to overlapping duties;
- unfilled required crew positions;
- missing aircraft type rating;
- unavailable crew member;
- likely crew duty-time exceedance;
- obviously invalid airport or time ordering.

### Flight detail and timeline

Build a central flight-control page combining schedule, status, aircraft, crew, gates, passenger load, inventory, amenities, alerts, and an operational timeline.

The timeline should represent events such as crew report, aircraft at gate, check-in open, boarding, pushback, take-off, landing, and gate arrival. Preserve scheduled, estimated, and actual values when applicable.

Provide confirmed actions for changing aircraft, assigning crew, changing gate, recording a delay, diverting, and cancelling.

---

## 9. Fleet and light maintenance

### Fleet overview

Provide a filterable, sortable table or dense card/table hybrid containing:

- registration;
- manufacturer, model, and variant;
- operational status;
- current location;
- current and next flight;
- seat capacity;
- aircraft age;
- recent utilisation;
- maintenance state.

Model statuses including active, airborne, on ground, turnaround, maintenance, stored, and out of service.

### Aircraft profile

Include:

- registration, serial number, delivery date, and age;
- manufacturer, model, variant, engine model, range, cruise speed, and relevant limits;
- cabin layout and total capacity;
- aircraft-specific amenities;
- current location and status;
- previous and upcoming flights;
- total hours and cycles;
- recent airports and maintenance events.

The cabin layout should support cabins such as Business, Premium Economy, and Economy, with seat counts and an optional visual seat map.

### Maintenance scope

This need not be a complete MRO system. Include last check, next scheduled maintenance, hours and cycles remaining, notes, status, and clear approaching-limit warnings. An aircraft marked unavailable or in maintenance must not be silently assignable to a flight.

---

## 10. Crew management and scheduling

Support roles such as Captain, First Officer, Relief Pilot, Purser, Senior Cabin Crew, and Cabin Crew.

Each profile should include employee ID, name, role/rank, base, employment status, contact information, qualifications, aircraft type ratings, languages, current duty status, availability, and upcoming assignments.

### Assignment interface

For each flight, show the required and assigned complement for cockpit and cabin positions. Provide a scheduling board or similarly efficient interface; drag-and-drop is a useful enhancement if it remains accessible.

Warn or block when:

- a required position is empty;
- assignments overlap;
- the person is unavailable;
- a pilot lacks the required type rating;
- the assigned complement is insufficient for the aircraft or passenger load;
- a configurable duty-time threshold may be exceeded.

Rules must be configurable enough for demonstration. Do not claim that simplified demo rules constitute legal compliance.

---

## 11. Bookings, passengers, and inventory

### Booking search and profile

Allow search by PNR, passenger name, flight number, email, and ticket number.

A booking should contain:

- reference and status;
- passengers;
- one or more flight segments;
- cabin and fare product per segment;
- seats, baggage, and ancillary services;
- payment status and total price;
- creation and modification timestamps.

### Passenger information

Include full name, date of birth, nationality, permitted contact details, restricted travel-document information, segment-specific seat assignments, baggage allowance, and special-service requests.

Model requests such as wheelchair assistance, special meals, infant, unaccompanied minor, medical assistance, and extra baggage.

### Seat inventory

For each flight and cabin, display capacity, sold, available, blocked, checked-in, standby, and load factor.

A visual seat map should, if implemented, show availability and allow authorised staff to block/unblock seats, assign or move a passenger, and inspect relevant seat details.

### Cabins and fare products

Model cabins separately from fare products. For example, Economy may contain Light, Standard, and Flex products.

Fare-product configuration should cover checked and cabin baggage, seat selection, changes, refunds, priority boarding, lounge access, meals, and frequent-flyer earning rules.

---

## 12. Airports, routes, and amenities

### Airports

Store IATA and ICAO code, name, city, country, latitude, longitude, and IANA time zone. Coordinates must drive route and live-map positioning.

### Routes

Show origin, destination, distance, frequency, usual aircraft, and status. Support active, seasonal, planned, suspended, and discontinued routes. Include a route-network map when feasible.

### Amenities

Amenities must be configurable and assignable at appropriate levels, such as aircraft, cabin, fare product, or flight. Examples include Wi-Fi, seat power, USB charging, in-flight entertainment, streaming, meals, snacks, drinks, extra-legroom seating, and lie-flat seats.

Resolve the final effective amenity set predictably when several levels apply.

---

## 13. Alerts, notifications, search, and audit history

### Alerts

Support severity, status, affected resource, message, timestamp, ownership or assignee when useful, and direct navigation.

- **Critical:** unavailable aircraft, missing cockpit crew, capacity below passengers sold.
- **Warning:** maintenance approaching, duty limit approaching, delay, low turnaround time.
- **Information:** boarding started, aircraft arrived, flight departed, flight landed.

Allow marking alerts as read or resolved without erasing their history.

### Global search

Search flights, aircraft, crew, bookings, passengers where permitted, and airports. Group results by type and provide keyboard-friendly navigation.

### Audit history

Record important mutations with actor, timestamp, resource, action, previous value, new value, and optional reason. Provide filters and a clear human-readable presentation. Audit entries should be append-only from the application's perspective.

---

## 14. Reports and analytics

Include useful operational and commercial KPIs:

- flight count;
- completion and cancellation rate;
- on-time performance and average delay;
- passenger count and load factor;
- aircraft utilisation;
- most-used aircraft;
- route popularity and performance;
- bookings and revenue by route or period.

Allow filtering by day, week, month, custom date range, airport, route, and aircraft type. Ensure metrics use consistent definitions and explain any simulated values.

---

## 15. User-experience direction

The visual style should resemble professional aviation operations software with a more modern and approachable interface.

Use the right information pattern for each task:

- cards for high-level summaries;
- tables for dense records and comparison;
- maps for geographic operations;
- timelines for operational events;
- charts for trends and distributions;
- drawers for contextual detail without losing place;
- dialogs for focused edits and confirmations;
- status badges, icons, and concise labels for scanability.

Include tooltips, skeletons, toasts, inline validation, sensible defaults, keyboard focus states, accessible contrast, and responsive overflow behaviour.

High-impact actions such as cancellation, diversion, destructive deletion, inventory reduction, or moving an assigned passenger must require clear confirmation and show expected consequences.

---

## 16. Demo data

Create a coherent fictional airline dataset rather than generic placeholders.

Target approximately:

- 15–30 aircraft across several types;
- 20 or more destinations;
- at least 40 daily flight instances;
- at least 50 crew members with varied roles and qualifications;
- hundreds of bookings distributed across flights and cabins;
- several simultaneous active flights for the map;
- enough delays, warnings, maintenance cases, and assignment conflicts to demonstrate the workflows.

Use consistent flight numbers, aircraft registrations, airport data, assignments, schedules, and passenger totals. Seeded or deterministic data is preferable so testing and screenshots are reproducible.

---

## 17. Technical expectations

If the repository already defines a stack, follow it unless there is a strong reason not to. Otherwise choose a mature typed web stack and document the choice briefly.

### Architecture

- Organise code by domain, for example `operations`, `flights`, `fleet`, `crew`, `bookings`, `airports`, `commercial`, `analytics`, and `shared`.
- Separate presentation, domain logic, persistence, and external/live-data integrations.
- Use reusable components without abstracting prematurely.
- Use schema-based validation at system boundaries.
- Centralise API access and cache invalidation.
- Handle optimistic updates only where rollback and conflict behaviour are clear.
- Keep secrets and provider credentials out of client code and source control.
- Provide migrations and a repeatable seed process when persistent storage is used.

### Suggested API surface

The exact style may be REST, GraphQL, or an equivalent typed contract. A REST-style design might include:

```text
/aircraft
/aircraft/:id
/aircraft/:id/maintenance
/flights
/flights/:id
/flights/:id/crew
/flights/:id/bookings
/flights/:id/inventory
/flights/:id/operations
/schedules
/crew
/crew/:id
/bookings
/bookings/:id
/airports
/routes
/fare-products
/amenities
/alerts
/audit
/analytics
/live-operations
```

Use server-side validation and transactional updates for multi-entity operations. Return actionable errors with stable codes where practical.

### Quality

- Add focused tests for domain rules and critical workflows.
- Test schedule conflicts, aircraft replacement, capacity checks, crew qualifications, recurring-schedule exceptions, cancellation propagation, and permission enforcement.
- Add integration or end-to-end coverage for at least one complete operational workflow.
- Run the repository's formatter, type checker, linter, tests, and production build before handoff.
- Do not suppress failing checks merely to obtain a green result.

---

## 18. Delivery phases

Implement in this order unless the existing repository makes a different sequence clearly safer.

### Phase 1 — Foundation

- application shell and navigation;
- authentication/role scaffolding;
- core domain types and persistence;
- airports and seed data;
- dashboard foundation.

### Phase 2 — Fleet

- fleet overview;
- aircraft profiles;
- cabin configuration and amenities;
- status and light-maintenance information.

### Phase 3 — Flight operations

- flight list and detail;
- create/edit/duplicate/reschedule;
- recurring schedules and occurrence overrides;
- aircraft assignment;
- core status lifecycle and conflict checks.

### Phase 4 — Live Operations

- interactive 2D map;
- active-flight list and synchronised selection;
- telemetry provider contract;
- simulated movement and phases;
- filters, search, drawer, and live updates.

### Phase 5 — Crew

- profiles, qualifications, and availability;
- crew complement and assignments;
- overlap, qualification, and duty warnings.

### Phase 6 — Bookings and inventory

- PNR and passenger administration;
- cabins and fare products;
- seat inventory and assignments;
- capacity propagation after aircraft changes.

### Phase 7 — Operational control

- alerts and notifications;
- audit history;
- complete flight timeline;
- maintenance warnings;
- cross-module mutation handling.

### Phase 8 — Analytics and polish

- reports and KPIs;
- global search;
- permissions hardening;
- responsive and accessibility improvements;
- performance and final UX refinement.

At the end of each phase, report:

1. what was implemented;
2. which files or modules changed;
3. how the feature can be verified;
4. test/build results;
5. known limitations;
6. the recommended next phase.

---

## 19. Core acceptance scenarios

The implementation is not complete until these scenarios work with shared data.

### Scenario A — Aircraft reassignment

An operations controller changes a flight from one aircraft to another. The system checks availability, overlap, turnaround, range, cabin capacity, and crew qualifications. The flight, map, fleet schedule, inventory, alerts, analytics, and audit log reflect the accepted change.

### Scenario B — Flight cancellation

An authorised user cancels a flight after reviewing a confirmation that explains the consequences. The flight leaves active-map tracking, aircraft and crew resources are released according to policy, affected bookings are flagged, alerts are created, analytics update, and the action is audited.

### Scenario C — Recurring schedule exception

A scheduler creates a multi-day weekly service and edits one dated occurrence. The exception changes only that instance unless a broader edit scope is explicitly selected.

### Scenario D — Crew incompatibility

A scheduler attempts to assign a pilot without the required aircraft rating or with an overlapping duty. The system presents a precise blocking reason and does not silently save an invalid assignment.

### Scenario E — Live flight selection

A user searches for a flight number, selects the result, sees the correct moving marker and route, opens the detail drawer, and navigates to the same shared flight record.

### Scenario F — Capacity reduction

An aircraft change reduces seat capacity below the number of seats sold. The system surfaces a critical warning, identifies the affected cabins or assignments, and requires an explicit authorised resolution rather than corrupting inventory.

### Scenario G — Permission boundary

A Booking Administrator can work with bookings and seats but cannot cancel a flight or modify aircraft maintenance. Both UI and API enforce the restriction.

---

## 20. Definition of done

A feature is done only when:

- its primary workflow is usable, not merely visible;
- it reads and writes the shared domain model;
- relevant permission and validation rules apply;
- loading, empty, error, and success states exist;
- related views remain consistent after changes;
- important mutations create audit records;
- critical conditions create alerts where required;
- focused tests cover its important business rules;
- the application passes type checking, linting, tests, and production build;
- any intentional limitation is documented clearly.

The final application should prioritise realistic workflows, strong relationships between data, operational clarity, and a polished professional interface. The Live Operations Map must remain a defining, fully connected feature throughout implementation.

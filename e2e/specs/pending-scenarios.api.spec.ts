import { test } from "@playwright/test";

/**
 * The scenarios from section 19 of the brief that are still outstanding.
 *
 * Committed from Phase 0 and marked `fixme` until the phase that builds them.
 * They appear in every test report as outstanding, which is the point: the
 * brief calls these the completion condition, and a plan that keeps them out
 * of the suite until the end lets a screen look finished long before it is.
 *
 * Each one carries the assertion it will make, so removing the `fixme` is
 * filling in a body rather than rediscovering the requirement.
 *
 * Scenario A and Scenario C left this file in Phase 3. They are now executable
 * specifications in `flights.api.spec.ts` and `schedules.api.spec.ts`, and
 * Scenario E's UI half in `flights.ui.spec.ts`. Removing a `fixme` is how a
 * phase gate is claimed, and these are the ones Phase 3 claimed.
 */

test.describe("Scenario B: flight cancellation (Phase 7)", () => {
  test.fixme("the confirmation states the consequences before anything happens", async () => {
    // POST /api/flights/:id/cancel with preview: true must return consequences
    // covering bookings flagged, crew released, aircraft released and alerts
    // raised -- with counts, not prose.
  });

  test.fixme("cancellation propagates to every affected module", async () => {
    // After applying: the flight leaves active-map tracking, its bookings are
    // marked disrupted, its crew assignments are released, an alert exists,
    // analytics no longer count it as operating, and an audit entry records it.
  });
});

test.describe("Scenario D: crew incompatibility (Phase 5)", () => {
  test.fixme("a pilot without the type rating is refused with a precise reason", async () => {
    // POST /api/flights/:id/crew must return 422 RULE_VIOLATION with
    // CREW_MISSING_TYPE_RATING, naming the aircraft type and the rating held.
  });

  test.fixme("an overlapping duty is refused and names the conflicting flight", async () => {
    // CREW_OVERLAPPING_DUTY, with the other flight in `related`.
  });

  test.fixme("nothing invalid is persisted after a refusal", async () => {
    // GET /api/flights/:id/crew must be unchanged after each refusal above.
  });
});

test.describe("Scenario E: live flight selection (Phase 4)", () => {
  test.fixme("searching a flight number selects its marker and its list row", async () => {
    // UI spec: search "SO412", select the result, assert the map marker has
    // aria-selected and the list row is highlighted -- both directions.
  });

  test.fixme("the drawer navigates to the same shared flight record", async () => {
    // The drawer's "Open flight" link must land on /flights/:id for the same
    // id the map marker carries. One record, not two representations of it.
  });
});

test.describe("Scenario F: capacity reduction (raised in Phase 3, held at Phase 6)", () => {
  // The rule exists and is unit-tested: `evaluateAircraftAssignment` raises
  // AIRCRAFT_CAPACITY_BELOW_SOLD and AIRCRAFT_CABIN_CAPACITY_BELOW_SOLD, and
  // POST /api/flights/:id/aircraft already reads `soldByCabin` on every call.
  // What is missing is a booking to sell a seat, so the figure is always zero
  // and the finding can never fire. Phase 6 supplies the data, not the rule.
  test.fixme("a smaller aircraft below seats sold raises a critical finding", async () => {
    // AIRCRAFT_CAPACITY_BELOW_SOLD, blocking, naming the affected cabins and
    // the shortfall per cabin -- not just a total.
  });

  test.fixme("inventory is never silently corrupted", async () => {
    // After the refusal, seats sold and seat assignments must be byte-identical
    // to before. The resolution path requires an explicit authorised action.
  });
});

import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, DEMO_PASSWORD } from "../support/api.ts";

/**
 * The Flight Schedule through the browser.
 *
 * The claims an API test cannot make: an operator standing in front of the
 * flight-control page cannot change the aircraft without first reading what the
 * rules found, cannot move a flight to a state the lifecycle does not offer
 * because the control never shows one, and cannot widen an edit to a whole
 * series without saying so.
 *
 * The tests that write put the flight back. The board is a shared fixture and
 * the suite runs serially, so a test that left a sector delayed would be
 * changing the ground under the next one.
 */

async function signInAs(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

/**
 * Waits for real rows.
 *
 * The header reads "Refreshing…" while a query is in flight and "N flights"
 * once it is not. As on the fleet page, this proves no query is in flight --
 * not that yours is the one that ran -- so it is always followed by something
 * that retries onto the row actually expected.
 */
async function settled(page: Page) {
  await expect(page.getByText(/^\d+ flights$/)).toBeVisible();
}

async function openBoardAs(page: Page, email: string) {
  await signInAs(page, email);
  await page.getByRole("link", { name: "Flight Schedule" }).click();
  await expect(page.getByRole("heading", { name: "Flight Schedule" })).toBeVisible();
  await settled(page);
}

/** The service date two days out: nothing on it has operated. */
function futureDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 2);
  return date.toISOString().slice(0, 10);
}

test.describe("the flight board", () => {
  test("lists the operating day, with both a table and a fleet timeline", async ({ page }) => {
    await openBoardAs(page, ACCOUNTS.opsController);

    await expect(page.getByRole("columnheader", { name: "Flight" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Aircraft" })).toBeVisible();
    // Off and On rather than Departure and Arrival: an operations board uses
    // the words the operation uses.
    await expect(page.getByRole("columnheader", { name: "Off" })).toBeVisible();

    await page.getByRole("tab", { name: "Fleet timeline" }).click();
    await expect(page.getByText(/Times are UTC/)).toBeVisible();
    // The timeline is one row per tail, with the sectors as buttons on it.
    await expect(page.getByRole("button", { name: /BEG to |to BEG/ }).first()).toBeVisible();

    await page.getByRole("tab", { name: "Board" }).click();
    await expect(page.getByRole("columnheader", { name: "Flight" })).toBeVisible();
  });

  test("filters narrow the board and survive a reload", async ({ page }) => {
    await openBoardAs(page, ACCOUNTS.opsController);

    const tally = page.getByText(/^\d+ flights$/);
    const wholeDay = await tally.innerText();

    await page.getByLabel("Airport").fill("VIE");
    await expect(page).toHaveURL(/airportIata=VIE/);

    // Wait for the board to *become* the VIE board, not merely for a query to
    // finish. `settled` cannot tell those apart: the URL updates before the
    // new query starts, and in that gap the previous, wider result is still on
    // screen with nothing in flight. Reading the row count there captures the
    // unfiltered board and then compares it against the filtered one after a
    // reload -- which is exactly how this test first failed.
    await expect(tally).not.toHaveText(wholeDay);
    const narrowed = await tally.innerText();

    await expect(page.getByRole("row").filter({ hasText: "VIE" }).first()).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Airport")).toHaveValue("VIE");
    await expect(tally).toHaveText(narrowed);
  });

  test("a row opens the flight it names", async ({ page }) => {
    await openBoardAs(page, ACCOUNTS.opsController);

    const first = page.getByRole("row").nth(1);
    const flightNumber = (
      await first
        .getByText(/^SO\d+$/)
        .first()
        .innerText()
    ).trim();
    await first.click();

    await expect(page.getByRole("heading", { name: flightNumber })).toBeVisible();
    await expect(page).toHaveURL(/\/flights\/[0-9a-f-]{36}/);
  });
});

test.describe("the flight-control page", () => {
  test("shows the six timestamps, the timeline and the pattern behind the flight", async ({
    page,
  }) => {
    await openBoardAs(page, ACCOUNTS.opsController);
    await page.getByRole("row").nth(1).click();

    await expect(page.getByRole("heading", { name: /^SO\d+$/ })).toBeVisible();
    await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Estimated", { exact: true })).toBeVisible();
    await expect(page.getByText("Actual", { exact: true })).toBeVisible();

    await expect(page.getByText("Operational timeline")).toBeVisible();
    await expect(page.getByText("Pushback")).toBeVisible();
    await expect(page.getByText("On blocks")).toBeVisible();

    // Crew and inventory say which phase brings them rather than rendering an
    // empty table that reads as a fault.
    await expect(page.getByText("Phase 5")).toBeVisible();
    await expect(page.getByText("Phase 6")).toBeVisible();
  });

  test("offers only the states the lifecycle actually allows", async ({ page }) => {
    await signInAs(page, ACCOUNTS.opsController);
    await page.goto(`/flights?date=${futureDate()}&status=scheduled`);
    await settled(page);
    await page.getByRole("row").nth(1).click();
    await expect(page.getByRole("heading", { name: /^SO\d+$/ })).toBeVisible();

    await page.getByRole("button", { name: "Advance status" }).click();
    await page.getByLabel("Move to").click();

    // From `scheduled` the kernel offers check-in open and cancelled, and
    // nothing else. A control that offered "airborne" would be offering
    // something the API refuses -- the "fake control" the brief rules out.
    await expect(page.getByRole("option", { name: "Check-in open" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Airborne" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Arrived" })).toHaveCount(0);
  });

  test("a delay is confirmed against its consequences, then cleared", async ({ page }) => {
    await signInAs(page, ACCOUNTS.opsController);
    await page.goto(`/flights?date=${futureDate()}&status=scheduled`);
    await settled(page);
    await page.getByRole("row").nth(1).click();
    const heading = page.getByRole("heading", { name: /^SO\d+$/ });
    await expect(heading).toBeVisible();
    const flightNumber = (await heading.innerText()).trim();

    try {
      await page.getByRole("button", { name: "Record delay" }).click();
      await page.getByRole("slider", { name: "Departure delay in minutes" }).fill("90");
      await page.getByRole("button", { name: "Review" }).click();

      const apply = page.getByRole("button", { name: "Record" });
      await expect(page.getByText(/significant delay/)).toBeVisible();
      await expect(apply).toBeDisabled();

      // Every warning is acknowledged by its own code, and ninety minutes on a
      // tight rotation raises more than one: the delay is significant, and the
      // aircraft's next sector loses its turnaround. Ticking one is not
      // ticking them, which is the whole point of the model -- a single "I
      // understand" would record that somebody clicked.
      const warnings = page.getByRole("checkbox");
      const count = await warnings.count();
      expect(count).toBeGreaterThan(0);

      for (let index = 0; index < count; index += 1) {
        await expect(apply).toBeDisabled();
        await warnings.nth(index).check();
      }
      await expect(apply).toBeEnabled();
      await apply.click();

      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByText("+90m")).toBeVisible();
      // Delay is a condition, not a status: the flight is still scheduled.
      await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();
    } finally {
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Record delay" }).click();
      await page.getByRole("slider", { name: "Departure delay in minutes" }).fill("0");
      await page.getByRole("button", { name: "Review" }).click();

      // Clearing a delay puts the flight back on its scheduled times, so the
      // warnings it raised go with it -- but tick anything that survives.
      const remaining = page.getByRole("checkbox");
      for (let index = 0; index < (await remaining.count()); index += 1) {
        await remaining.nth(index).check();
      }
      await page.getByRole("button", { name: "Record" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByText("+90m")).toHaveCount(0);
    }

    expect(flightNumber).toMatch(/^SO\d+$/);
  });
});

// --- Scenario A, through the browser ---------------------------------------

test.describe("Scenario A: aircraft reassignment", () => {
  test("an unavailable airframe is refused with the reason on screen", async ({ page }) => {
    await signInAs(page, ACCOUNTS.opsController);
    await page.goto(`/flights?date=${futureDate()}&status=scheduled`);
    await settled(page);
    await page.getByRole("row").nth(1).click();
    await expect(page.getByRole("heading", { name: /^SO\d+$/ })).toBeVisible();

    await page.getByRole("button", { name: "Change aircraft" }).click();
    await expect(page.getByText(/Choosing a tail runs the checks/)).toBeVisible();

    // Unserviceable airframes are listed rather than hidden -- and refused when
    // chosen, which is the Phase 2 gate reached from the Phase 3 screen.
    const maintenance = page.getByRole("row").filter({ hasText: "Maintenance" }).first();
    await maintenance.getByRole("button", { name: "Review" }).click();

    await expect(
      page.getByText("blocking conflict").or(page.getByText("blocking conflicts")),
    ).toBeVisible();
    await expect(page.getByText(/cannot be assigned to SO\d+/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Assign", exact: true })).toBeDisabled();
  });

  test("releasing an airframe warns before it leaves a sector with nothing to fly", async ({
    page,
  }) => {
    await signInAs(page, ACCOUNTS.opsController);
    await page.goto(`/flights?date=${futureDate()}&status=scheduled`);
    await settled(page);

    const row = page.getByRole("row").filter({ hasText: /YU-/ }).first();
    await row.click();
    await expect(page.getByRole("heading", { name: /^SO\d+$/ })).toBeVisible();

    await page.getByRole("button", { name: "Change aircraft" }).click();
    await page.getByRole("button", { name: /^Release YU-/ }).click();

    const release = page.getByRole("button", { name: "Release", exact: true });
    await expect(page.getByText(/is left without an aircraft/)).toBeVisible();
    // The warning has to be accepted by its code before anything is written.
    await expect(release).toBeDisabled();

    await page.getByRole("button", { name: "Cancel" }).click();
    // Nothing was applied: the aircraft is still on the flight.
    await expect(page.getByText(/^YU-/).first()).toBeVisible();
  });
});

// --- Scenario C, through the browser ---------------------------------------

test.describe("Scenario C: the edit scope is explicit", () => {
  test("rescheduling offers the three scopes, narrowest first", async ({ page }) => {
    await signInAs(page, ACCOUNTS.opsController);
    await page.goto(`/flights?date=${futureDate()}&status=scheduled`);
    await settled(page);
    await page.getByRole("row").nth(1).click();
    await expect(page.getByRole("heading", { name: /^SO\d+$/ })).toBeVisible();

    await page.getByRole("button", { name: "Reschedule" }).click();

    const occurrence = page.getByRole("radio", { name: /This occurrence only/ });
    await expect(occurrence).toBeChecked();
    await expect(
      page.getByRole("radio", { name: /This and future occurrences/ }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: /The entire series/ })).toBeVisible();

    // Each option says what it reaches. "This and future" splitting the season
    // is not something an operator should discover by doing it.
    await expect(page.getByText(/the season splits in two/i)).toBeVisible();
  });

  test("the schedules page names its exceptions", async ({ page }) => {
    await signInAs(page, ACCOUNTS.opsController);
    await page.goto("/flights/schedules");
    await expect(page.getByRole("heading", { name: "Recurring schedules" })).toBeVisible();

    await expect(page.getByRole("columnheader", { name: "Operates" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Occurrences" })).toBeVisible();

    await page.getByRole("row").nth(1).click();
    await expect(page.getByText("Occurrences")).toBeVisible();
    await expect(page.getByText(/Follows the pattern/)).toBeVisible();
    await expect(page.getByText(/A season runs for months/)).toBeVisible();
  });
});

// --- Scenario G, through the browser ---------------------------------------

test.describe("Scenario G: the boundary is visible as well as enforced", () => {
  test("a booking administrator reads the board but cannot act on a flight", async ({
    page,
  }) => {
    await openBoardAs(page, ACCOUNTS.bookingAdmin);

    // Reading is their job and it works.
    await expect(page.getByRole("columnheader", { name: "Flight" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New flight" })).toBeDisabled();

    await page.getByRole("row").nth(1).click();
    await expect(page.getByRole("heading", { name: /^SO\d+$/ })).toBeVisible();

    // Disabled with the reason, not hidden: an operator should learn what they
    // lack, rather than wonder where a control went. The API refuses the same
    // calls regardless -- that half is asserted in flights.api.spec.ts.
    await expect(page.getByRole("button", { name: "Change aircraft" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Record delay" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reschedule" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  });
});

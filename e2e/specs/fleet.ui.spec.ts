import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, DEMO_PASSWORD } from "../support/api.ts";

/**
 * The Fleet and Amenities sections through the browser.
 *
 * The claim an API test cannot make: an operator standing in front of this
 * screen cannot withdraw an airframe without first reading which flights it
 * strands. The Apply button stays disabled until the warning is ticked, and
 * the warning names the sectors.
 */

async function signInAs(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
}

async function openFleetAs(page: Page, email: string) {
  await signInAs(page, email);
  await page.getByRole("link", { name: "Fleet", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible();
  await settled(page);
}

/**
 * Waits for real rows.
 *
 * The header reads "Refreshing…" while a query is in flight and "N airframes"
 * once it is not, so this is the page's own signal that the skeleton rows have
 * been replaced by aircraft that can be clicked.
 *
 * It proves that no query is in flight. It does not prove that *your* filter
 * is the one that ran: changing a filter re-renders before React commits
 * "Refreshing…", and in that gap this matches the previous list's count and
 * returns against stale rows. Follow it with something that retries onto the
 * result you expect -- a row addressed by its text, or `toHaveCount` -- and
 * never with a bare positional click.
 */
async function settled(page: Page) {
  await expect(page.getByText(/^\d+ airframes$/)).toBeVisible();
}

test.describe("Fleet", () => {
  test("the fleet lists every airframe with its derived state", async ({ page }) => {
    await openFleetAs(page, ACCOUNTS.fleetManager);

    const rows = page.getByRole("row");
    // 24 airframes plus the header.
    await expect(rows).toHaveCount(25);

    // Serviceability and state are separate columns, because they are separate
    // facts -- this is the distinction the whole phase turns on.
    await expect(page.getByRole("columnheader", { name: "Serviceability" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "State" })).toBeVisible();
  });

  test("filters narrow the list and survive a reload", async ({ page }) => {
    await openFleetAs(page, ACCOUNTS.fleetManager);

    await page.getByLabel("Search").fill("YU-ANB");
    await settled(page);
    await expect(page.getByRole("row")).toHaveCount(2);

    // Filters live in the URL, so a narrowed view can be sent to someone else.
    await expect(page).toHaveURL(/search=YU-ANB/);
    await page.reload();
    await settled(page);
    await expect(page.getByRole("row")).toHaveCount(2);
  });

  test("an airborne aircraft claims no airport", async ({ page }) => {
    await openFleetAs(page, ACCOUNTS.fleetManager);

    await page.getByLabel("State").click();
    await page.getByRole("option", { name: "Airborne" }).click();
    await settled(page);

    const rows = page.getByRole("row");
    const count = await rows.count();

    // Nothing is airborne at every hour of the day, so this asserts the
    // property only when there is something to assert it about.
    if (count > 1) {
      await expect(page.getByText("in flight").first()).toBeVisible();
    }
  });

  test("withdrawing an airframe names the stranded flights and blocks until acknowledged", async ({
    page,
  }) => {
    await openFleetAs(page, ACCOUNTS.fleetManager);

    // On the ground, so its Current column is empty, and still showing a
    // flight number -- which under that filter can only be its next sector.
    // Chosen this way so the test cannot quietly pass against a tail with
    // nothing to strand.
    await page.getByLabel("State").click();
    await page.getByRole("option", { name: "On ground" }).click();
    await settled(page);

    const row = page.getByRole("row").filter({ hasText: /SO\d+/ }).first();
    await expect(row).toBeVisible();
    await row.click();

    const drawer = page.getByRole("presentation").last();
    await expect(drawer.getByText("Serviceability", { exact: true })).toBeVisible();

    await drawer.getByLabel("Change to").click();
    await page.getByRole("option", { name: "Maintenance", exact: true }).click();

    // Named, not generic: the drawer behind it is also role="dialog", and MUI
    // only hides it from the tree while the confirmation is on top.
    const confirm = page.getByRole("dialog", { name: /^Mark / });
    await expect(confirm).toBeVisible();

    // The gate. The operator reads which sectors lose their aircraft, by
    // number, and Apply stays dead until they say they have.
    await expect(confirm.getByText(/lose their aircraft/)).toBeVisible();
    await expect(confirm.getByText(/SO\d+/).first()).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Apply" })).toBeDisabled();

    await confirm.getByRole("checkbox").first().check();
    await expect(confirm.getByRole("button", { name: "Apply" })).toBeEnabled();

    // Nothing is written: this test reads the guard, it does not exercise it.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
  });

  test("a role without aircraft:write is not offered the control", async ({ page }) => {
    await openFleetAs(page, ACCOUNTS.bookingAdmin);

    await page.getByRole("row").nth(1).click();
    const drawer = page.getByRole("presentation").last();

    await expect(drawer.getByRole("button", { name: "Change serviceability" })).toBeDisabled();
    await expect(drawer.getByLabel("Change to")).toHaveCount(0);
  });

  test("the aircraft profile derives capacity from the cabins it shows", async ({ page }) => {
    await openFleetAs(page, ACCOUNTS.fleetManager);

    await page.getByLabel("Search").fill("YU-ANB");
    await settled(page);
    // Addressed by registration rather than by position: `settled` can return
    // while the unfiltered list is still on screen -- see its note -- and row
    // one is then whichever tail sorts first, not this one.
    await page.getByRole("row").filter({ hasText: "YU-ANB" }).click();

    const drawer = page.getByRole("presentation").last();
    await expect(drawer.getByRole("heading", { name: "YU-ANB" })).toBeVisible();

    // The heading states the total; the rows below it are what add up to it.
    const cabin = drawer.getByText(/^Cabin — \d+ seats$/);
    await expect(cabin).toBeVisible();
    const total = Number(/(\d+) seats/.exec((await cabin.textContent()) ?? "")?.[1] ?? 0);

    const business = Number(
      (await drawer.getByText("Business").locator("..").textContent())
        ?.replace("Business", "")
        .trim(),
    );
    expect(total).toBeGreaterThan(business);

    // The seeded Wi-Fi withdrawal is visible as a withdrawal, not an absence.
    await expect(drawer.getByText("Wi-Fi")).toBeVisible();
  });
});

test.describe("Amenities", () => {
  test("the matrix shows which level settled each amenity", async ({ page }) => {
    await signInAs(page, ACCOUNTS.commercialManager);
    await page.getByRole("link", { name: "Amenities" }).click();
    await expect(page.getByRole("heading", { name: "Amenities" })).toBeVisible();

    // Until an airframe is chosen the page says what it needs rather than
    // rendering an empty table.
    await expect(
      page.getByText("Choose an airframe to see how its cabins resolve."),
    ).toBeVisible();

    await page.getByLabel("Aircraft").click();
    await page.getByRole("option", { name: /YU-ANB/ }).click();

    // Scoped to the matrix: the catalogue below it names the same amenities,
    // and an unscoped locator would match both.
    const matrix = page.getByRole("table", { name: "Cabin amenity resolution" });
    await expect(matrix.getByRole("columnheader", { name: /Business/ })).toBeVisible();
    await expect(matrix.getByRole("columnheader", { name: /Economy/ })).toBeVisible();

    // A hot meal is a cabin-level fact: Business gets it, Economy does not,
    // on the same airframe.
    const meal = matrix.getByRole("row").filter({ hasText: "Hot meal" });
    await expect(meal).toHaveCount(1);
    await expect(meal.getByText("cabin")).toHaveCount(1);

    // And the seeded Wi-Fi withdrawal is decided at aircraft level in both
    // cabins, because nothing narrower overrides it.
    const wifi = matrix.getByRole("row").filter({ hasText: "Wi-Fi" });
    await expect(wifi.getByText("aircraft")).toHaveCount(2);
  });
});

test.describe("Registering an aircraft", () => {
  test("the form derives capacity and never asks for it", async ({ page }) => {
    await openFleetAs(page, ACCOUNTS.fleetManager);
    await page.getByRole("button", { name: "Register aircraft" }).click();

    const form = page.getByRole("dialog", { name: "Register an aircraft" });
    await expect(form).toBeVisible();

    // The claim the whole phase rests on, made visible: there is no seat-count
    // box to disagree with the layout.
    await expect(form.getByLabel(/seat count|capacity|total seats/i)).toHaveCount(0);

    await expect(form.getByText("0 seats in total")).toBeVisible();

    // One economy cabin is offered by default; giving it a last row is enough
    // for the running total to appear.
    await form.getByLabel("Last row").fill("25");
    await expect(form.getByText("150 seats in total")).toBeVisible();

    // 25 rows of ABC-DEF is 150. Widening the layout changes the total with no
    // other field touched.
    await form.getByLabel("Layout").fill("ABC-DEFG");
    await expect(form.getByText("175 seats in total")).toBeVisible();

    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(form).toBeHidden();
  });

  test("a registration already in use is refused before anything is written", async ({
    page,
  }) => {
    await openFleetAs(page, ACCOUNTS.fleetManager);
    await page.getByRole("button", { name: "Register aircraft" }).click();

    const form = page.getByRole("dialog", { name: "Register an aircraft" });
    await form.getByLabel("Registration").fill("YU-APE");
    await form.getByLabel("Serial number").fill("DUPLICATE-1");
    await form.getByLabel(/^Type/).click();
    await page
      .getByRole("option")
      .filter({ hasText: /^A320 / })
      .click();
    await form.getByLabel("Delivered on").fill("2019-05-10");
    await form.getByLabel("Last row").fill("25");
    await form.getByRole("button", { name: "Review and register" }).click();

    const confirm = page.getByRole("dialog", { name: /^Register YU-APE/ });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("YU-APE is already registered")).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Register" })).toBeDisabled();

    await confirm.getByRole("button", { name: "Cancel" }).click();

    // The form is still there with what was typed, so a refusal is a
    // correction rather than a retype.
    await expect(form.getByLabel("Registration")).toHaveValue("YU-APE");
    await form.getByRole("button", { name: "Cancel" }).click();
  });

  test("a role without aircraft:write is not offered the button", async ({ page }) => {
    await openFleetAs(page, ACCOUNTS.bookingAdmin);
    await expect(page.getByRole("button", { name: "Register aircraft" })).toBeDisabled();
  });
});

test.describe("Assigning an amenity", () => {
  async function openAmenitiesAs(page: Page, email: string) {
    await signInAs(page, email);
    await page.getByRole("link", { name: "Amenities" }).click();
    await expect(page.getByRole("heading", { name: "Amenities" })).toBeVisible();
    await page.getByLabel("Aircraft").click();
    await page.getByRole("option", { name: /YU-ANB/ }).click();
    await expect(page.getByRole("table", { name: "Cabin amenity resolution" })).toBeVisible();
  }

  test("the rows that produced the resolution are listed under it", async ({ page }) => {
    await openAmenitiesAs(page, ACCOUNTS.commercialManager);

    const panel = page.getByRole("table", { name: "Assignments reaching this airframe" });
    await expect(panel).toBeVisible();

    // The seeded withdrawal is here as a row that can be removed, not just as
    // a struck-through chip somewhere.
    const wifi = panel.getByRole("row").filter({ hasText: "Wi-Fi" });
    await expect(wifi.first()).toBeVisible();
    await expect(panel.getByText("Wi-Fi antenna unserviceable, parts on order.")).toBeVisible();
  });

  test("removing a withdrawal says what starts being offered again", async ({ page }) => {
    await openAmenitiesAs(page, ACCOUNTS.commercialManager);

    const panel = page.getByRole("table", { name: "Assignments reaching this airframe" });
    const withdrawal = panel
      .getByRole("row")
      .filter({ hasText: "Wi-Fi antenna unserviceable" })
      .first();
    await withdrawal.getByRole("button", { name: "Remove" }).click();

    const confirm = page.getByRole("dialog", { name: /Remove the withdrawal of Wi-Fi/ });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/becomes offered again/).first()).toBeVisible();

    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
  });

  test("a withdrawal warns that it will beat the grant already there", async ({ page }) => {
    await openAmenitiesAs(page, ACCOUNTS.commercialManager);

    await page.getByRole("button", { name: "Assign" }).click();
    const form = page.getByRole("dialog", { name: "Assign an amenity" });

    await form.getByRole("combobox", { name: "Amenity" }).click();
    await page.getByRole("option", { name: /Streaming to device/ }).click();
    await form.getByLabel("Withhold it").check();
    await form.getByRole("button", { name: "Review" }).click();

    const confirm = page.getByRole("dialog", { name: /Withhold Streaming to device/ });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/withdrawal wins/)).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Withhold it" })).toBeDisabled();

    await confirm.getByRole("checkbox").first().check();
    await expect(confirm.getByRole("button", { name: "Withhold it" })).toBeEnabled();

    await confirm.getByRole("button", { name: "Cancel" }).click();
  });

  test("a role without commercial:write reads the matrix but cannot change it", async ({
    page,
  }) => {
    await openAmenitiesAs(page, ACCOUNTS.fleetManager);

    await expect(page.getByRole("table", { name: "Cabin amenity resolution" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Assign" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  });
});

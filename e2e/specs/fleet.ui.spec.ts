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
    await page.getByRole("row").nth(1).click();

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

import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, DEMO_PASSWORD } from "../support/api.ts";

/**
 * The Airports section through the browser.
 *
 * Two things worth proving here that an API test cannot: the confirmation
 * dialog actually shows the server's findings before anything is written, and
 * the interface does not offer actions the API would refuse.
 */

async function signInAs(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Airports & Routes" })).toBeVisible();
}

test.describe("Airports", () => {
  test("the seeded network loads and can be filtered", async ({ page }) => {
    await signInAs(page, ACCOUNTS.commercialManager);

    await expect(page.getByRole("cell", { name: "BEG", exact: false }).first()).toBeVisible();

    await page.getByLabel("Search").fill("Belgrade");
    await expect(page.getByText("Nikola Tesla")).toBeVisible();

    await page.getByLabel("Search").fill("zzzzzz");
    await expect(page.getByText("No stations match these filters")).toBeVisible();
  });

  test("the confirmation shows what the server found, before writing", async ({ page }) => {
    await signInAs(page, ACCOUNTS.commercialManager);

    await page.getByRole("button", { name: "Add airport" }).click();

    // Scope to the dialog: the page behind it has its own Country filter, and
    // several field labels would otherwise resolve to two controls.
    const form = page.getByRole("dialog");
    await form.getByRole("textbox", { name: "IATA code" }).fill("BEG");
    await form.getByRole("textbox", { name: "ICAO code" }).fill("LYXX");
    await form.getByRole("textbox", { name: "Airport name" }).fill("Duplicate Belgrade");
    await form.getByRole("textbox", { name: "City" }).fill("Belgrade");
    await form.getByRole("combobox", { name: "Country" }).fill("Serbia");
    await page.getByRole("option", { name: /Serbia/ }).click();
    await form.getByRole("textbox", { name: "Latitude" }).fill("45.0");
    await form.getByRole("textbox", { name: "Longitude" }).fill("21.0");
    await form.getByRole("button", { name: "Review and add" }).click();

    // A preview returns 200 carrying the finding rather than an error, so the
    // operator reads the conflict itself instead of a generic refusal banner.
    const confirm = page.getByRole("dialog");
    await expect(confirm.getByText("1 blocking conflict")).toBeVisible();
    // Named precisely: the actual colliding record, not "duplicate code".
    await expect(confirm.getByText(/IATA code BEG is already in use/)).toBeVisible();
    await expect(confirm.getByText(/Nikola Tesla/)).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  test("a Booking Administrator is not offered actions the API would refuse", async ({
    page,
  }) => {
    await signInAs(page, ACCOUNTS.bookingAdmin);

    await expect(page.getByRole("button", { name: "Add airport" })).toBeDisabled();
    // The section is still readable -- the boundary is on writing, not seeing.
    await expect(page.getByRole("cell", { name: "BEG", exact: false }).first()).toBeVisible();
  });

  test("navigation reflects the signed-in role", async ({ page }) => {
    await signInAs(page, ACCOUNTS.bookingAdmin);
    await expect(page.getByRole("link", { name: "Bookings" })).toBeVisible();
    // Settings requires settings:read, which a booking administrator lacks.
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  });

  test("unbuilt sections say so rather than showing an empty page", async ({ page }) => {
    await signInAs(page, ACCOUNTS.opsController);
    await page.getByRole("link", { name: "Live Operations" }).click();
    await expect(page.getByText("Not built yet")).toBeVisible();
    await expect(page.getByText(/interactive map/i)).toBeVisible();
  });
});

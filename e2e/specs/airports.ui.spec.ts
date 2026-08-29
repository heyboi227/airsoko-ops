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
    await page.getByLabel("IATA code").fill("BEG");
    await page.getByLabel("ICAO code").fill("LYXX");
    await page.getByLabel("Airport name").fill("Duplicate Belgrade");
    await page.getByLabel("City").fill("Belgrade");
    await page.getByLabel("Country").fill("Serbia");
    await page.getByRole("option", { name: /Serbia/ }).click();
    await page.getByLabel("Latitude").fill("45.0");
    await page.getByLabel("Longitude").fill("21.0");
    await page.getByRole("button", { name: "Review and add" }).click();

    // The dialog reports the kernel's blocking finding, and the confirm button
    // is unavailable -- the refusal is visible before any write is attempted.
    await expect(page.getByText("Cannot be applied")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
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

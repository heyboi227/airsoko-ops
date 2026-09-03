import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, DEMO_PASSWORD } from "../support/api.ts";

/**
 * Opening a route from the form that needs one.
 *
 * The complaint this answers is a browser complaint: the schedule form offered
 * the pairs somebody had seeded and no way to add one, so a service to a new
 * destination could not be filed at all. What an API test cannot prove is that
 * the way in is actually there, next to the field that was the dead end -- and
 * that the review still shows the server's own findings before anything is
 * written.
 *
 * Nothing here writes. The duplicate pair is the case worth driving through the
 * browser precisely because it ends in a refusal.
 */

async function openScheduleFormAs(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.getByRole("link", { name: "Flight Schedule" }).click();
  await page.getByRole("button", { name: "Recurring schedules" }).click();
  await expect(page.getByRole("heading", { name: "Recurring schedules" })).toBeVisible();

  await page.getByRole("button", { name: "New schedule" }).click();
  await expect(page.getByRole("heading", { name: "File a recurring schedule" })).toBeVisible();
}

test.describe("Routes from the schedule form", () => {
  test("the picker offers a way to open a pair that is not on file", async ({ page }) => {
    await openScheduleFormAs(page, ACCOUNTS.opsController);

    const scheduleForm = page.getByRole("dialog");
    await expect(scheduleForm.getByRole("combobox", { name: "Route" })).toBeVisible();

    // The escape hatch is beside the field rather than inside it: a route is
    // still picked, and filing one is a deliberate second step.
    await scheduleForm.getByRole("button", { name: "New route" }).click();
    await expect(page.getByRole("heading", { name: "File a route" })).toBeVisible();
  });

  test("the review shows the server's finding before anything is filed", async ({ page }) => {
    await openScheduleFormAs(page, ACCOUNTS.opsController);
    await page.getByRole("dialog").getByRole("button", { name: "New route" }).click();

    const routeForm = page.getByRole("dialog").filter({ hasText: "File a route" });
    await routeForm.getByRole("combobox", { name: "From" }).fill("BEG");
    await page.getByRole("option", { name: /BEG/ }).first().click();
    await routeForm.getByRole("combobox", { name: "To" }).fill("VIE");
    await page.getByRole("option", { name: /VIE/ }).first().click();

    // The distance is the server's business, but the form says what it will be
    // rather than asking for it.
    await expect(routeForm.getByText(/BEG–VIE is 251 nm/)).toBeVisible();

    await routeForm.getByRole("textbox", { name: "Block time (minutes)" }).fill("95");
    await routeForm.getByRole("button", { name: "Review" }).click();

    // BEG-VIE is already the airline's busiest pair: the refusal names it and
    // says what flies it, and the button stays out of reach.
    const confirm = page.getByRole("dialog").filter({ hasText: "File BEG–VIE?" });
    await expect(confirm.getByText("1 blocking conflict")).toBeVisible();
    await expect(confirm.getByText(/BEG-VIE is already a route/)).toBeVisible();
    await expect(confirm.getByRole("button", { name: "File route" })).toBeDisabled();
  });

  test("a role without route:write is not offered the button", async ({ page }) => {
    // A booking administrator cannot reach the schedule form at all, so the
    // gate that matters is the one on the button itself: it reads the same
    // permission table the API enforces with.
    await page.goto("/");
    await page.getByLabel("Email").fill(ACCOUNTS.bookingAdmin);
    await page.getByLabel("Password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    await page.getByRole("link", { name: "Flight Schedule" }).click();
    await page.getByRole("button", { name: "Recurring schedules" }).click();
    await expect(page.getByRole("button", { name: "New schedule" })).toBeDisabled();
  });
});

import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, DEMO_PASSWORD } from "../support/api.ts";
import { createLiveFixture } from "../support/live.ts";

async function openLive(page: Page, number: string) {
  await page.goto(`/live?search=${number}`);
  await page.getByLabel("Email").fill(ACCOUNTS.opsController);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Live Operations", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Live flight map" })).toHaveAttribute(
    "data-map-ready",
    "true",
  );
  await expect(page.getByRole("region", { name: "Live flight map" })).toBeVisible();
}

test.describe("Scenario E: live flight selection", () => {
  test("search selects a moving marker and its list row in both directions, then opens the shared record", async ({
    page,
  }, testInfo) => {
    const fixture = await createLiveFixture();
    try {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openLive(page, fixture.number);
      const row = page.getByRole("button", {
        name: `Select ${fixture.number} in list`,
        exact: true,
      });
      const marker = page.getByRole("button", {
        name: `Select ${fixture.number} on map`,
        exact: true,
      });
      await expect(row).toBeVisible();
      await row.click();
      await expect(row).toHaveAttribute("aria-pressed", "true");
      await expect(marker).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.getByRole("complementary", { name: "Selected flight details" }),
      ).toBeVisible();
      const longitude = await marker.getAttribute("data-longitude");
      await expect(marker).not.toHaveAttribute("data-longitude", longitude!);
      await expect(marker.locator("svg")).toHaveAttribute("style", /rotate\(/);
      await page.getByRole("button", { name: "Close flight details" }).click();
      await expect(row).toHaveAttribute("aria-pressed", "false");
      await marker.click();
      await expect(row).toHaveAttribute("aria-pressed", "true");
      await expect(marker).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("link", { name: "Open aircraft" })).toHaveAttribute(
        "href",
        `/fleet?selected=${fixture.aircraftId}`,
      );
      await page.screenshot({ path: testInfo.outputPath("live-selected.png") });
      await page.getByRole("link", { name: "Open flight", exact: true }).click();
      await expect(page).toHaveURL(`/flights/${fixture.id}`);
      await expect(
        page.getByRole("heading", { name: fixture.number, exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await fixture.remove();
    }
  });

  test("keeps URL filters after reload and shows an empty result without old markers", async ({
    page,
  }) => {
    const fixture = await createLiveFixture();
    try {
      await openLive(page, fixture.number);
      await page.getByLabel("Delayed only").click();
      await expect(page.getByLabel("Delayed only")).toBeChecked();
      await expect(page).toHaveURL(/delayedOnly=true/);
      await page.reload();
      await expect(page.getByLabel("Search live flights")).toHaveValue(fixture.number);
      await expect(page.getByLabel("Delayed only")).toBeChecked();
      const row = page.getByRole("button", { name: `Select ${fixture.number} in list` });
      await expect(row).toBeVisible();
      await row.focus();
      await page.keyboard.press("Enter");
      await expect(row).toHaveAttribute("aria-pressed", "true");
      await page.getByLabel("Search live flights").fill("DOES-NOT-EXIST");
      await expect(page.getByText("No flights match this view.")).toBeVisible();
      await expect(page.getByRole("button", { name: /on map$/ })).toHaveCount(0);
      await expect(
        page.getByRole("complementary", { name: "Selected flight details" }),
      ).toHaveCount(0);
    } finally {
      await fixture.remove();
    }
  });

  test("shows stale data during a lost connection and recovers without losing selection", async ({
    page,
  }) => {
    const fixture = await createLiveFixture();
    try {
      await openLive(page, fixture.number);
      const row = page.getByRole("button", { name: `Select ${fixture.number} in list` });
      await row.click();
      await page.route("**/api/live-operations", (route) => route.abort("failed"));
      await expect(page.getByText(/Connection interrupted/)).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByText(
          "Telemetry is stale. Positions are frozen until a fresh update arrives.",
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(row).toHaveAttribute("aria-pressed", "true");
      await page.unroute("**/api/live-operations");
      await page.getByRole("button", { name: "Retry now" }).click();
      await expect(page.getByText(/Connection interrupted/)).toHaveCount(0);
      await expect(
        page.getByText(
          "Telemetry is stale. Positions are frozen until a fresh update arrives.",
        ),
      ).toHaveCount(0);
      await expect(row).toHaveAttribute("aria-pressed", "true");
    } finally {
      await fixture.remove();
    }
  });
});

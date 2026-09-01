import { defineConfig, devices } from "@playwright/test";

/**
 * The seven acceptance scenarios from section 19 of the brief, as executable
 * specifications.
 *
 * They are committed from Phase 0, before most of them can pass. Ones whose
 * feature has not been built are marked `test.fixme`, which keeps them visible
 * in every report as outstanding work without painting CI red. Removing a
 * `fixme` is a deliberate act, and it is how a phase gate is claimed.
 *
 * Running these needs a database. See README -- `npm run db:up && npm run
 * db:migrate && npm run db:seed`.
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const WEB_URL = process.env.WEB_URL ?? "http://localhost:5273";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_500 },

  use: {
    baseURL: WEB_URL,
    // Nothing the suite creates belongs in the committed seed data. The API
    // records every entry as seed data in development (decision 32); this
    // header, sent on every request the suite and its browser make, declines.
    extraHTTPHeaders: { "x-airsoko-recording": "off" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      // API-level assertions run without a browser. Scenario G in particular
      // must prove the boundary holds with the UI entirely out of the picture.
      name: "api",
      testMatch: /.*\.api\.spec\.ts/,
      use: { baseURL: API_URL },
    },
    {
      name: "chromium",
      testMatch: /.*\.ui\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 950 } },
      dependencies: ["api"],
    },
  ],

  webServer: [
    {
      command: "npm run dev:api",
      url: `${API_URL}/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: "..",
    },
    {
      command: "npm run dev:web",
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: "..",
    },
  ],
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Kernel rules and API unit tests. End-to-end scenarios live in e2e/ and
    // run under Playwright instead -- see e2e/playwright.config.ts.
    include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/domain/src/**", "apps/api/src/**"],
      reporter: ["text", "html"],
    },
  },
});

import { defineConfig } from "@playwright/test";

/**
 * E2E for THE BOOK. Separate from the repo-root Playwright config (which
 * belongs to apps/web) so the two apps' journeys never entangle.
 * Run: npx playwright test -c apps/simulator/playwright.config.ts
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:9465",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @kayfabe/simulator dev",
    url: "http://127.0.0.1:9465",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

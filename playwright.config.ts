import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  retries: 0,
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:9460",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @kayfabe/web dev",
    url: "http://127.0.0.1:9460",
    reuseExistingServer: true,
    timeout: 30000,
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1920, height: 1080 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
    {
      name: "reduced-motion",
      use: { viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: "reduce" } },
    },
  ],
});

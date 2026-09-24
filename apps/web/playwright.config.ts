import { defineConfig } from "@playwright/test"

// E2E suite for the Waste prototype. The app is UI-only (fixture data +
// localStorage), so every test gets a fresh browser context and therefore
// pristine fixture state — no reset step is needed between tests.
//
// The dev server is NOT managed here on purpose: run `pnpm dev` (or `npm run
// dev`) yourself and keep it up — a Playwright-managed webServer once killed
// the shared dev server this prototype's browser sessions depend on.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  workers: 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
})

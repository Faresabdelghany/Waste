import { defineConfig } from "@playwright/test"

// E2E suite for the Waste prototype. The app is UI-only (fixture data +
// localStorage), so every test gets a fresh browser context and therefore
// pristine fixture state — no reset step is needed between tests.
//
// Locally the dev server is NOT managed here on purpose: run `pnpm dev` (or
// `npm run dev`) yourself and keep it up — a Playwright-managed webServer once
// killed the shared dev server this prototype's browser sessions depend on.
// Under CI there is no such server to kill, so the `webServer` block below
// exists there and only there: the job has run `next build`, and Playwright
// serves that build on the base URL's port and waits for it to answer before
// the first test. `CI` and `PLAYWRIGHT_BASE_URL` reach this file through
// turbo's strict env mode because turbo.json declares them on `test:e2e`.

const ci = Boolean(process.env.CI)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"
const htmlReport = ["html", { open: "never", outputFolder: "playwright-report" }] as const

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A `.only` left in a spec would pass CI by running one test.
  forbidOnly: ci,
  // A CI runner is slower and shared: a spec that fails three times there is
  // a failure, one that fails once is reported flaky and the run stays green.
  retries: ci ? 2 : 0,
  // Four vCPUs on the runner, shared by the server and the browsers.
  workers: ci ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci ? [["github"], htmlReport] : [["list"], htmlReport],
  outputDir: "test-results",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: ci
    ? {
        // The production server over the build the CI job made; the port is
        // the base URL's, so the two cannot drift apart.
        command: `pnpm exec next start -p ${new URL(baseURL).port || "80"}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
})

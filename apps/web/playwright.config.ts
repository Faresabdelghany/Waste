import { defineConfig } from "@playwright/test"

import { baseURL, browserUse, ci, managedServer, reporters } from "./playwright.shared"

// E2E suite for the Waste prototype. The app is UI-only (fixture data +
// localStorage), so every test gets a fresh browser context and therefore
// pristine fixture state — no reset step is needed between tests.
//
// Locally the dev server is NOT managed here on purpose: run `pnpm dev` (or
// `npm run dev`) yourself and keep it up — a Playwright-managed webServer once
// killed the shared dev server this prototype's browser sessions depend on.
// Under CI there is no such server to kill, so the managed server exists
// there and only there, and only while the base URL is loopback: the job has
// run `next build`, and Playwright serves that build on the base URL's port
// and waits for it to answer before the first test (playwright.shared.ts,
// `managedServer`, which the API suite's config shares). A base URL naming a
// deployment (`PLAYWRIGHT_BASE_URL=https://<preview>`) runs the suite
// against it instead and starts nothing.
//
// Both variables arrive through turbo's strict env mode because turbo.json
// declares them on `test:e2e`: `PLAYWRIGHT_BASE_URL` is dropped otherwise,
// and `CI`, which turbo passes through by itself, is declared so the switch
// does not rest on a default nobody wrote down.

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
  // A systemic failure — the shared page fixture never finding its tab — would
  // otherwise be every test × three attempts × 60 s over two workers, an hour
  // that outruns the job's 25 minutes and leaves an empty grouped log:
  // Playwright stops itself after ten failures or fifteen minutes, whichever
  // comes first, and still writes the report and the summary annotation.
  maxFailures: ci ? 10 : 0,
  globalTimeout: ci ? 15 * 60_000 : 0,
  expect: { timeout: 10_000 },
  reporter: reporters("playwright-report"),
  outputDir: "test-results",
  use: browserUse,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: managedServer(baseURL),
})

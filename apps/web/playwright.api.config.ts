import { defineConfig } from "@playwright/test"

// The API e2e suite (Issue #151): the web app in a browser against the API,
// the worker and the database on the trimmed local Supabase stack — real
// Auth, the real password grant, the real access token hook. Its own config
// over its own directory, apart from playwright.config.ts: the two suites'
// build-time adapter settings and server topologies differ, so one config
// would couple them without reuse.
//
// Topology. The web is built with the adapter on (`NEXT_PUBLIC_WASTE_API_URL`,
// the Supabase pair) and served on the base URL; the API and the worker run
// from source; the stack is `pnpm stack:start`. Locally none of that is
// managed here, as for the fixture suite — a Playwright-managed server once
// killed a shared dev server — so you start them yourself (root CLAUDE.md,
// Commands). Under CI on a loopback base URL the job has run `next build`,
// and the `webServer` block serves that build and waits for it to answer.
//
// Data. One disposable database per run, the seeded Kystbyen tenant shared by
// every spec, records uniquely named and never cleaned up. So the suite is
// serial: one worker, no parallelism inside a file, and a `setup` project
// that signs in once through /login and hands every other project its
// storage state (e2e-api/auth.setup.ts says what is and is not captured).
//
// The variables arrive through turbo's strict env mode because turbo.json
// declares them on `test:e2e:api`; e2e-api/env.ts reads them.

/** GitHub Actions sets `true`; a shell exporting `CI=false` must not switch the managed server on. */
const ci = process.env.CI === "true" || process.env.CI === "1"
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"
const base = new URL(baseURL)
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
const servesItself = ci && LOOPBACK_HOSTS.has(base.hostname)
const port = base.port || (base.protocol === "https:" ? "443" : "80")
const htmlReport = ["html", { open: "never", outputFolder: "playwright-report-api" }] as const

/** Where the setup project leaves the administrator's session for the other projects. */
export const ADMIN_STORAGE_STATE = "e2e-api/.auth/admin.json"

export default defineConfig({
  testDir: "./e2e-api",
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  // The fixture suite's failure policy: a spec that fails three times on the
  // runner is a failure, one that fails once is reported flaky; ten failures
  // or the global bound end the run with the report still written. The
  // global bound sits inside the job's timeout-minutes, so the job's own
  // limit is never what stops a run.
  retries: ci ? 2 : 0,
  maxFailures: ci ? 10 : 0,
  globalTimeout: ci ? 10 * 60_000 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: ci ? [["github"], htmlReport] : [["list"], htmlReport],
  outputDir: "test-results-api",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { browserName: "chromium", storageState: ADMIN_STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
  webServer: servesItself
    ? {
        command: `pnpm exec next start -p ${port}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
})

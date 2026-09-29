import { defineConfig } from "@playwright/test"
import path from "node:path"

import { baseURL, browserUse, ci, managedServer, reporters } from "./playwright.shared"

// The API e2e suite (Issue #151): the web app in a browser against the API,
// the worker and the database on the trimmed local Supabase stack — real
// Auth, the real password grant, the real access token hook. Its own config
// over its own directory, apart from playwright.config.ts: the two suites'
// build-time adapter settings and server topologies differ, so one config
// would couple them without reuse; what they decide alike is in
// playwright.shared.ts.
//
// Topology. The web is built with the adapter on (`NEXT_PUBLIC_WASTE_API_URL`,
// the Supabase pair) and served on the base URL; the API and the worker run
// from source; the stack is `pnpm stack:start`. Locally none of that is
// managed here, as for the fixture suite, so you start them yourself (root
// CLAUDE.md, Commands). Under CI on a loopback base URL the job has run
// `next build`, and the managed server serves that build and waits for it
// to answer.
//
// Data. One disposable database per run, the seeded Kystbyen tenant shared by
// every spec, records uniquely named and never cleaned up. So the suite is
// serial: one worker, no parallelism inside a file, and a `setup` project
// that signs in once through /login and hands every other project its
// storage state (e2e-api/auth.setup.ts says what is and is not captured).
//
// The variables arrive through turbo's strict env mode because turbo.json
// declares them on `test:e2e:api`; e2e-api/env.ts reads them.

/**
 * Where the setup project leaves the administrator's session for the other
 * projects: one absolute path, since `use.storageState` resolves against
 * this file and `context.storageState({ path })` against the working
 * directory, which need not be apps/web.
 */
export const ADMIN_STORAGE_STATE = path.join(__dirname, "e2e-api", ".auth", "admin.json")

export default defineConfig({
  testDir: "./e2e-api",
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  // The fixture suite's failure policy: a spec that fails three times on the
  // runner is a failure, one that fails once is reported flaky; ten failures
  // or the global bound end the run with the report still written. The
  // global bound sits well inside the job's timeout-minutes (ci.yml), so it
  // is Playwright that stops a runaway suite and the artifacts still upload;
  // a job that times out is cancelled and uploads nothing.
  retries: ci ? 2 : 0,
  maxFailures: ci ? 10 : 0,
  globalTimeout: ci ? 8 * 60_000 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: reporters("playwright-report-api"),
  outputDir: "test-results-api",
  use: browserUse,
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { browserName: "chromium", storageState: ADMIN_STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
  webServer: managedServer(baseURL),
})

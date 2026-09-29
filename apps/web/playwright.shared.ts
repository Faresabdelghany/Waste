import type { PlaywrightTestConfig } from "@playwright/test"

// What the two Playwright configs — the fixture suite's (playwright.config.ts)
// and the API suite's (playwright.api.config.ts, Issue #151) — decide the same
// way, spelled once: whether this is CI, the base URL, whether the config
// serves the build itself, the report shape and the browser settings. The
// two configs differ in what they test and how (their directories, projects,
// parallelism and bounds), and that stays in each.

/** GitHub Actions sets `true`; a shell exporting `CI=false` must not switch the managed server on. */
export const ci = process.env.CI === "true" || process.env.CI === "1"

/** Where the app under test answers; turbo.json declares the variable on both e2e tasks. */
export const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * The production server over the build the CI job made, on the base URL's
 * port (the scheme's default when it names none), so the two cannot drift
 * apart — under CI and only while the base URL is loopback. Locally the
 * server is never managed here: a Playwright-managed webServer once killed
 * the shared dev server the prototype's browser sessions depend on, and a
 * base URL naming a deployment runs the suite against it and starts nothing.
 */
export function managedServer(url: string): PlaywrightTestConfig["webServer"] {
  const base = new URL(url)
  if (!ci || !LOOPBACK_HOSTS.has(base.hostname)) return undefined
  const port = base.port || (base.protocol === "https:" ? "443" : "80")
  return {
    command: `pnpm exec next start -p ${port}`,
    url,
    reuseExistingServer: false,
    timeout: 120_000,
  }
}

/** The github annotations under CI, a list locally, and the HTML report in the suite's own folder either way. */
export function reporters(outputFolder: string): PlaywrightTestConfig["reporter"] {
  const html = ["html", { open: "never", outputFolder }] as const
  return ci ? [["github"], html] : [["list"], html]
}

/** One browser shape for both suites: the desktop viewport the prototype is laid out for, traces and screenshots kept for failures only. */
export const browserUse = {
  baseURL,
  viewport: { width: 1440, height: 900 },
  trace: "retain-on-failure",
  screenshot: "only-on-failure",
} satisfies PlaywrightTestConfig["use"]

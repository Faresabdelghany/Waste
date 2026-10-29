// Settings on the Pilot shows no pane that only this browser keeps (#487):
// Operations setup, Commercial defaults and the browser's Notifications save
// values nothing reads, so they are fixture mode's alone, and a link to one
// opens where its subject lives on the API — Notifications the API's own pane
// (O16 of #290), the one Notifications the nav offers. Account & appearance keeps its profile — /me's —
// and its theme, without the personal defaults nothing reads, and without a
// bar offering to save on this device what it does not hold.
import { expect, test } from "./fixtures"

test("the Settings nav on the Pilot offers no browser-only pane, and a link to one opens where its subject lives", async ({ page }) => {
  await page.goto("/settings?pane=account")
  const nav = page.getByRole("navigation", { name: "Settings sections" })
  await expect(nav.getByRole("button", { name: "Master data" })).toBeVisible()
  for (const label of ["Operations setup", "Commercial defaults"]) await expect(nav.getByRole("button", { name: label, exact: true })).toHaveCount(0)
  await expect(nav.getByRole("button", { name: "Notifications", exact: true })).toHaveCount(1)

  const pane = page.locator("#settings-content")
  await expect(pane.getByRole("heading", { name: "Account and appearance" })).toBeVisible()
  await expect(pane.getByText("Default project")).toHaveCount(0)
  await expect(pane.getByRole("button", { name: "Save changes" })).toHaveCount(0)

  await page.goto("/settings?pane=operations-setup")
  await expect(nav.getByRole("button", { name: "Master data" })).toHaveAttribute("aria-current", "page")
  await page.goto("/settings?pane=pricing")
  await expect(nav.getByRole("button", { name: "Products" })).toHaveAttribute("aria-current", "page")
  await page.goto("/settings?pane=notifications")
  await expect(nav.getByRole("button", { name: "Notifications", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(pane.getByRole("heading", { name: "E-mail me" })).toBeVisible()
})

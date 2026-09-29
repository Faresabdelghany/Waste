import { expect, test } from "./fixtures"

// Slice 1 of #81 (Issue #175): the planning configuration read from the API.
// The two tests that guarded it in fixture mode (e2e/tests/map-planning.spec.ts)
// ported by behaviour, per #131: the setup project's administrator session is
// the browser's, and the areas and calendars are the seeded tenant's (#143).

test("the Layers control draws a seeded planning area's outline from the API's boundary, and cannot switch on an area without one", async ({ page }) => {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.route("**/server.arcgisonline.com/**", (route) => route.abort())
  await page.goto("/plan")
  await expect(page.getByTestId("map-planning")).toBeVisible()
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  await expect(layers).toContainText("Planning areas")
  await expect(page.locator("[data-area-outline]")).toHaveCount(0)
  await layers.getByRole("checkbox", { name: /Indre By Operations/ }).click()
  await expect(page.locator('[data-area-outline="area-indreby"]')).toBeVisible()
  await expect(page.getByTestId("layers-count")).toHaveText(/^1\/\d+$/)
  // Cairo's area is seeded without a boundary and places no container: nothing to draw.
  await expect(layers.getByRole("checkbox", { name: /Nasr City Operations/ })).toBeDisabled()
})

test("a legacy Plan calendars link lands on Settings › Collection calendars, which lists the API's calendars", async ({ page }) => {
  await page.goto("/plan?module=calendars")
  await expect(page).toHaveURL(/\/settings\?pane=collection-calendars/)
  await expect(page.getByRole("heading", { name: "Collection calendars" }).first()).toBeVisible()
  await expect(page.getByRole("cell", { name: "Copenhagen Central 2026" }).first()).toBeVisible()
  await expect(page.getByRole("cell", { name: "Cairo Operations 2027" }).first()).toBeVisible()
})

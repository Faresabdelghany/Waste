import { expect, test } from "./fixtures"

// Slice 1 of #81 (Issue #175): the planning configuration read from the API.
// The setup project's administrator session is the browser's, and the areas
// and calendars are the seeded tenant's (#143): what the fixture suite's
// tests of the same surfaces (e2e/tests/map-planning.spec.ts) cannot say —
// a status read off the API's versions, a row the fixtures do not have, an
// id the server minted — is said here.

test("the Layers control draws a seeded planning area's outline from the API's boundary, and cannot switch on an area without one", async ({ page }) => {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.route("**/server.arcgisonline.com/**", (route) => route.abort())
  await page.goto("/plan")
  await expect(page.getByTestId("map-planning")).toBeVisible()
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  await expect(layers).toContainText("Planning areas")
  await expect(page.locator("[data-area-outline]")).toHaveCount(0)
  // A seeded area keeps its fixture id while the modules still on fixtures name it by it.
  await layers.getByRole("checkbox", { name: /Indre By Operations/ }).click()
  await expect(page.locator('[data-area-outline="area-indreby"]')).toBeVisible()
  await expect(page.getByTestId("layers-count")).toHaveText(/^1\/\d+$/)
  // Cairo's area is seeded without a boundary and places no container: nothing to draw.
  await expect(layers.getByRole("checkbox", { name: /Nasr City Operations/ })).toBeDisabled()
})

test("Settings › Areas & Zones lists the API's areas under the status their versions give them", async ({ page }) => {
  await page.goto("/settings?pane=areas")
  await expect(page.getByRole("heading", { name: "Areas & Zones" }).first()).toBeVisible()
  const indreby = page.getByRole("row", { name: /Indre By Operations/ })
  await expect(indreby).toContainText("OP-CEN-01")
  await expect(indreby).toContainText("Route planning")
  await expect(indreby).toContainText("Copenhagen Central")
  await expect(indreby).toContainText("Active")
  // Registered without a boundary: a draft, with no effective date to show.
  await expect(page.getByRole("row", { name: /Nasr City Operations/ })).toContainText("Draft")
})

test("a legacy Plan calendars link lands on Settings › Collection calendars, which lists the API's calendars and opens the one the link names", async ({ api, page }) => {
  await page.goto("/plan?module=calendars")
  await expect(page).toHaveURL(/\/settings\?pane=collection-calendars/)
  await expect(page.getByRole("heading", { name: "Collection calendars" }).first()).toBeVisible()
  await expect(page.getByRole("cell", { name: "Copenhagen Central 2026" }).first()).toBeVisible()
  await expect(page.getByRole("cell", { name: "Cairo Operations 2027" }).first()).toBeVisible()

  // A calendar's web id is the server's from the start (`calendar-<uuid>`), so the deep link names it by the API's id.
  const listed = await api.get("/collection-calendars?limit=200")
  expect(listed.status()).toBe(200)
  const { items } = (await listed.json()) as { items: { id: string; name: string }[] }
  const central = items.find((calendar) => calendar.name === "Copenhagen Central 2026")
  expect(central).toBeDefined()
  await page.goto(`/settings?pane=collection-calendars&record=calendar-${central?.id}`)
  const dialog = page.getByRole("dialog", { name: "Edit collection calendar" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Calendar name")).toHaveValue("Copenhagen Central 2026")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

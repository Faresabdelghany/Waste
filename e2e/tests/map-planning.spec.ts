// Map Planning (2026-09-16): the Plan entry's page. Tile requests are
// aborted so the suite needs no network: the base map reports itself
// unavailable and the markers, drawn from the registry, still stand.
import { expect, test, type Page } from "@playwright/test"

const COUNTER = '[data-testid="map-planning-counter"]'
const MARKERS = '[data-testid="planning-map-markers"]'
const DRAW = '[data-testid="planning-map-draw"]'

async function openMapPlanning(page: Page): Promise<void> {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.goto("/plan")
  await expect(page.getByRole("heading", { name: "Map Planning", level: 1 })).toBeVisible()
  await expect(page.locator(MARKERS)).toBeVisible()
  await expect(page.locator('[data-marker="cluster"]').first()).toBeVisible()
}

/** Drags a rectangle over the middle of the map with the rectangle tool. */
async function selectRectangle(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Select with a rectangle" }).click()
  const overlay = page.locator(DRAW)
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (!box) throw new Error("draw overlay has no box")
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.15)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.85, { steps: 6 })
  await page.mouse.up()
  await expect(overlay).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await openMapPlanning(page)
})

test("the sidebar entry is Map Planning and the page has no module tabs", async ({ page }) => {
  const sidebar = page.getByRole("complementary").first()
  await expect(page.getByRole("link", { name: "Map Planning" })).toBeVisible()
  await expect(sidebar.getByRole("link", { name: "Plan", exact: true })).toHaveCount(0)
  await expect(page.getByRole("tab")).toHaveCount(0)
  await expect(page.getByText("Collection Calendars")).toHaveCount(0)
})

test("the map opens on Any date with every in-service container placed", async ({ page }) => {
  const counter = page.locator(COUNTER)
  await expect(counter).toHaveText(/^(\d+) of \1 containers on the map$/)
  await expect(page.getByLabel("Collection window")).toContainText("Any date")
  await expect(page.getByRole("button", { name: "Reset all" })).toBeDisabled()
  await expect(page.getByRole("status")).toContainText("Base map unavailable")
})

test("clusters carry their count and fractions; lone containers are dots", async ({ page }) => {
  const cluster = page.locator('[data-marker="cluster"]').first()
  await expect(cluster).toHaveAttribute("aria-label", /^\d+ containers · /)
  await expect(cluster).toHaveAttribute("data-count", /^\d+$/)
  await expect(page.locator('[data-marker="point"]').first()).toHaveAttribute("aria-label", /BIN-/)
  await expect(page.getByRole("region", { name: "Legend" })).toContainText("Waste fractions")
})

test("Properties mode counts properties and re-labels the clusters", async ({ page }) => {
  await page.getByRole("radio", { name: "Properties" }).click()
  await expect(page.locator(COUNTER)).toContainText(/\d+ properties/)
  await expect(page.locator('[data-marker="cluster"]').first()).toHaveAttribute(
    "aria-label",
    /propert(y|ies)/,
  )
})

test("a rectangle selection fills the selection bar and Clear empties it", async ({ page }) => {
  await selectRectangle(page)
  const bar = page.getByRole("region", { name: "Selection" })
  await expect(bar).toBeVisible()
  await expect(bar).toContainText(/\d+ containers selected/)
  await expect(page.locator('[data-marker][data-selected="true"]').first()).toBeVisible()
  await bar.getByRole("button", { name: "Clear selection" }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.locator('[data-marker][data-selected="true"]')).toHaveCount(0)
})

test("Create route scheme opens the Guided Setup wizard seeded from the selection", async ({ page }) => {
  await selectRectangle(page)
  await page.getByRole("region", { name: "Selection" }).getByRole("button", { name: "Create route scheme" }).click()
  const dialog = page.getByRole("dialog", { name: "New route scheme" })
  await expect(dialog).toBeVisible()
  // Every fixture container in the default scope belongs to Copenhagen Central.
  await expect(dialog.getByLabel("Project", { exact: true })).toContainText("Copenhagen Central")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

test("the collection window narrows the map and Reset all restores it", async ({ page }) => {
  await page.getByLabel("Collection window").click()
  await page.getByRole("option", { name: "Next 7 days" }).click()
  await expect(page.locator(COUNTER)).toContainText("Next 7 days")
  const reset = page.getByRole("button", { name: "Reset all" })
  await expect(reset).toBeEnabled()
  await reset.click()
  await expect(page.locator(COUNTER)).not.toContainText("Next 7 days")
  await expect(reset).toBeDisabled()
})

test("a saved view is kept and re-applied", async ({ page }) => {
  await page.getByLabel("Collection window").click()
  await page.getByRole("option", { name: "Next 30 days" }).click()
  await page.getByRole("button", { name: "Saved views" }).click()
  await page.getByLabel("Saved view name").fill("Month ahead")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.getByRole("button", { name: "Reset all" }).click()
  await expect(page.locator(COUNTER)).not.toContainText("Next 30 days")
  await page.getByRole("button", { name: "Saved views" }).click()
  await page.getByRole("button", { name: "Month ahead", exact: true }).click()
  await expect(page.locator(COUNTER)).toContainText("Next 30 days")
})

test("a legacy Plan calendars link lands on the Settings pane", async ({ page }) => {
  await page.goto("/plan?module=calendars&record=calendar-central")
  await expect(page).toHaveURL(/\/settings\?pane=collection-calendars&record=calendar-central/)
  // The deep link opens that calendar for editing; the modal hides the pane
  // behind it until it closes.
  const dialog = page.getByRole("dialog", { name: "Edit collection calendar" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("Calendar name")).toHaveValue("Copenhagen Central 2026")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("heading", { name: "Collection calendars" }).first()).toBeVisible()
  await expect(page.getByRole("cell", { name: "Copenhagen Central 2026" }).first()).toBeVisible()
})

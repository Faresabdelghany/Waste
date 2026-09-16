// Map Planning (2026-09-16): the Plan entry's page. Tile requests are
// aborted so the suite needs no network: the base map reports itself
// unavailable and the markers, drawn from the registry, still stand.
import { expect, test, type Page } from "@playwright/test"

const MARKERS = '[data-testid="planning-map-markers"]'
const DRAW = '[data-testid="planning-map-draw"]'
const CANVAS = '[data-testid="planning-map-canvas"]'

async function openMapPlanning(page: Page): Promise<void> {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.route("**/server.arcgisonline.com/**", (route) => route.abort())
  await page.goto("/plan")
  await expect(page.getByTestId("map-planning")).toBeVisible()
  await expect(page.locator(MARKERS)).toBeVisible()
  await expect(page.locator('[data-marker="cluster"]').first()).toBeVisible()
}

/**
 * Drags a rectangle over the south-west of the initial view with the
 * rectangle tool — Copenhagen Central streets only; the Harbor Commercial
 * containers stand in Nordhavn, to the north-east.
 */
async function selectRectangle(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Select with a rectangle" }).click()
  const overlay = page.locator(DRAW)
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (!box) throw new Error("draw overlay has no box")
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.9, { steps: 6 })
  await page.mouse.up()
  await expect(overlay).toHaveCount(0)
}

const mapZoom = (page: Page) =>
  page.evaluate(
    (selector) =>
      (document.querySelector(selector) as HTMLElement & { __planningMap?: { getZoom(): number } })
        .__planningMap?.getZoom() ?? NaN,
    CANVAS,
  )

test.beforeEach(async ({ page }) => {
  await openMapPlanning(page)
})

test("the sidebar entry is Map Planning and the page has no title, counter, or module tabs", async ({ page }) => {
  const sidebar = page.getByRole("complementary").first()
  await expect(page.getByRole("link", { name: "Map Planning" })).toBeVisible()
  await expect(sidebar.getByRole("link", { name: "Plan", exact: true })).toHaveCount(0)
  await expect(page.getByRole("tab")).toHaveCount(0)
  await expect(page.getByText("Collection Calendars")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Map Planning", level: 1 })).toHaveCount(0)
  await expect(page.getByText(/containers on the map/)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Saved views" })).toHaveCount(0)
  await expect(page.getByRole("radiogroup", { name: "Marker mode" })).toHaveCount(0)
})

test("the map opens on Any date with the search, filters, and window in the toolbar", async ({ page }) => {
  await expect(page.getByRole("combobox", { name: "Search the map" })).toBeVisible()
  await expect(page.getByLabel("Collection window")).toContainText("Any date")
  await expect(page.getByRole("button", { name: "Reset all" })).toBeDisabled()
  await expect(page.getByRole("status")).toContainText("Base map unavailable")
})

test("clusters carry their count and fractions; lone containers are dots; the legend is a popover", async ({ page }) => {
  const cluster = page.locator('[data-marker="cluster"]').first()
  await expect(cluster).toHaveAttribute("aria-label", /^\d+ containers · /)
  await expect(cluster).toHaveAttribute("data-count", /^\d+$/)
  await expect(page.locator('[data-marker="point"]').first()).toHaveAttribute("aria-label", /BIN-/)
  await page.getByRole("button", { name: "Legend" }).click()
  await expect(page.getByRole("dialog", { name: "Legend" })).toContainText("Waste fractions")
})

test("a rectangle selection opens the Selected area panel with its statistics; the close button clears it", async ({ page }) => {
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId("selected-area-subtitle")).toHaveText(/^Rectangle · [\d.,]+ (km²|m²)$/)
  await expect(panel).toContainText("Properties")
  await expect(panel).toContainText("Collection points")
  await expect(panel).toContainText("Containers")
  await expect(panel.getByTestId("quantities-range")).toHaveText("Per collection")
  await expect(panel).toContainText("Assumed weight")
  await expect(panel).toContainText(/\d+ active agreements?/)
  await expect(panel).toContainText("Containers by waste fraction")
  await expect(panel).toContainText("Service areas")
  // Fixture containers sit in service-area zones.
  await expect(panel).toContainText(/CA-/)
  await expect(panel).toContainText("Existing routes in this area")
  const routeCounts = panel.getByTestId("area-routes")
  await expect(routeCounts).toContainText("Total routes")
  await expect(routeCounts).toContainText("Awaiting")
  await expect(routeCounts).toContainText("In progress")
  await expect(routeCounts).toContainText("Completed")
  // The fixture route days name the selected containers' planning areas.
  await expect(routeCounts.locator("dd").first()).not.toHaveText("0")
  // Fixture route days carry no stop positions, so See on map explains instead of drawing.
  await panel.getByRole("button", { name: "See on map" }).click()
  await expect(page.getByRole("region", { name: "Notifications alt+T" })).toContainText(
    "These routes carry no stop positions yet",
  )
  await expect(page.locator('[data-selection-shape="rectangle"]')).toBeVisible()
  await expect(page.locator('[data-marker][data-selected="true"]').first()).toBeVisible()
  await panel.getByRole("button", { name: "Clear selection" }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.locator('[data-selection-shape]')).toHaveCount(0)
  await expect(page.locator('[data-marker][data-selected="true"]')).toHaveCount(0)
})

test("Edit exposes draggable handles and dragging one reshapes the selection", async ({ page }) => {
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  const before = await panel.getByTestId("selected-area-subtitle").innerText()
  await panel.getByRole("button", { name: "Edit" }).click()
  await expect(page.locator('[data-selection-shape][data-editing="true"]')).toBeVisible()
  const handle = page.locator('[data-shape-handle="2"]')
  const box = await handle.boundingBox()
  if (!box) throw new Error("handle has no box")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 200, box.y - 150, { steps: 6 })
  await page.mouse.up()
  await expect(panel.getByTestId("selected-area-subtitle")).not.toHaveText(before)
  await panel.getByRole("button", { name: "Done" }).click()
  await expect(page.locator('[data-selection-shape][data-editing="true"]')).toHaveCount(0)
})

test("Create route scheme opens the Guided Setup wizard seeded from the selection", async ({ page }) => {
  await selectRectangle(page)
  await page.getByRole("region", { name: "Selected area" }).getByRole("button", { name: "Create route scheme" }).click()
  const dialog = page.getByRole("dialog", { name: "New route scheme" })
  await expect(dialog).toBeVisible()
  // The central rectangle holds Copenhagen Central containers only.
  await expect(dialog.getByLabel("Project", { exact: true })).toContainText("Copenhagen Central")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

test("the collection window dates the quantities and Reset all restores Per collection", async ({ page }) => {
  await selectRectangle(page)
  const range = page.getByRole("region", { name: "Selected area" }).getByTestId("quantities-range")
  await page.getByLabel("Collection window").click()
  await page.getByRole("option", { name: "Next 7 days" }).click()
  await expect(page.getByLabel("Collection window")).toContainText("Next 7 days")
  await expect(range).toHaveText(/^[A-Z][a-z]+ \d{1,2}, \d{4} – [A-Z][a-z]+ \d{1,2}, \d{4}$/)
  const reset = page.getByRole("button", { name: "Reset all" })
  await expect(reset).toBeEnabled()
  await reset.click()
  await expect(range).toHaveText("Per collection")
  await expect(reset).toBeDisabled()
})

test("the Layers control switches the base map and draws planning-area outlines", async ({ page }) => {
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  await expect(layers.getByRole("radiogroup", { name: "Base map" })).toBeVisible()
  await expect(layers.getByRole("radio", { name: "Streets" })).toHaveAttribute("aria-checked", "true")
  await layers.getByRole("radio", { name: "Satellite" }).click()
  await expect(layers.getByRole("radio", { name: "Satellite" })).toHaveAttribute("aria-checked", "true")
  await expect(layers).toContainText("Planning areas")
  await expect(page.locator("[data-area-outline]")).toHaveCount(0)
  await layers.getByRole("checkbox", { name: /Indre By Operations/ }).click()
  await expect(page.locator('[data-area-outline="area-indreby"]')).toBeVisible()
  await expect(page.getByTestId("layers-count")).toHaveText(/^1\/\d+$/)
  const zoomBefore = await mapZoom(page)
  await layers.getByRole("button", { name: "Zoom to Indre By Operations" }).click()
  await expect.poll(() => mapZoom(page)).not.toBe(zoomBefore)
  // Every registry container counts, whichever project it bills to; an area
  // with no containers in the system cannot be switched on or zoomed to.
  await expect(layers.getByRole("checkbox", { name: /Nordhavn Harbor Area/ })).toBeEnabled()
  await expect(layers.getByRole("checkbox", { name: /Nasr City Operations/ })).toBeDisabled()
})

test("the search flies to an address and the map zooms out to the whole world", async ({ page }) => {
  const search = page.getByRole("combobox", { name: "Search the map" })
  await search.fill("Ryesgade")
  const options = page.getByRole("option")
  await expect(options.first()).toContainText(/^Ryesgade \d+/)
  await options.first().click()
  await expect.poll(() => mapZoom(page)).toBeGreaterThan(16)
  await page.evaluate(
    (selector) =>
      (document.querySelector(selector) as HTMLElement & {
        __planningMap?: { jumpTo(options: { zoom: number }): void; getMinZoom(): number }
      }).__planningMap?.jumpTo({ zoom: 0 }),
    CANVAS,
  )
  // MapLibre keeps the world at least as tall as the viewport, so "zoom 0" lands just above it.
  await expect.poll(() => mapZoom(page)).toBeLessThan(1)
  await expect(page.locator('[data-marker="cluster"]')).toHaveCount(1)
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

// Map Planning (2026-09-16): the Plan entry's page. Tile requests are
// aborted so the suite needs no network: the base map reports itself
// unavailable and the markers, drawn from the registry, still stand. The
// Routes layer, the route card and Play route are the API suite's, over the
// routes generation writes (e2e-api/map-routes.spec.ts, #179).
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

test("clusters carry their count and fractions; lone containers are dots; there is no legend button", async ({ page }) => {
  const cluster = page.locator('[data-marker="cluster"]').first()
  await expect(cluster).toHaveAttribute("aria-label", /^\d+ containers · /)
  await expect(cluster).toHaveAttribute("data-count", /^\d+$/)
  await expect(page.locator('[data-marker="point"]').first()).toHaveAttribute("aria-label", /BIN-/)
  await expect(page.getByRole("button", { name: "Legend" })).toHaveCount(0)
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

test("removing a filter chip lifts the filter (#55)", async ({ page }) => {
  const reset = page.getByRole("button", { name: "Reset all" })
  const markersBefore = await page.locator("[data-marker]").count()

  await page.getByRole("button", { name: "Filter", exact: true }).click()
  const popover = page.getByRole("dialog").filter({ has: page.getByPlaceholder("Find a filter") })
  await popover.getByRole("button", { name: /^Status\b/ }).click()
  const option = popover.locator("label").first()
  const value = (await option.locator("span").first().innerText()).trim()
  await option.getByRole("checkbox").check()
  await popover.getByRole("button", { name: "Apply filters" }).click()

  const chip = page.getByText(`Status: ${value}`, { exact: true })
  await expect(chip).toBeVisible()
  await expect(reset).toBeEnabled()

  await page.getByRole("button", { name: `Remove Status: ${value}` }).click()
  await expect(chip).toHaveCount(0)
  await expect(reset).toBeDisabled()
  // The chip row coming and going resizes the map; the count proves the camera
  // held, not that the filter narrowed the set (the chip and Reset all do that).
  await expect(page.locator("[data-marker]")).toHaveCount(markersBefore)
})

// The fixture path, which slice 1 of #81 leaves as it was; the API's outlines
// are e2e-api/planning-configuration.spec.ts's.
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

// The fixture path, which slice 1 of #81 leaves as it was; the same deep link
// on an API calendar is e2e-api/planning-configuration.spec.ts's.
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

test("the Coverage gaps layer rings containers no Route Scheme lists and the panel counts them", async ({ page }) => {
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  const coverage = layers.getByTestId("coverage-layer")
  await expect(coverage).toContainText("Coverage gaps")
  await expect(coverage).toContainText(/\d+ of \d+ containers needing service are in no Route Scheme/)
  await expect(coverage).toContainText("2 schemes counted")
  await expect(page.locator("[data-uncovered-count]")).toHaveCount(0)
  await coverage.getByRole("checkbox", { name: /Coverage gaps/ }).click()
  await page.keyboard.press("Escape")
  await expect(layers).toHaveCount(0)
  // Clusters carry the count of their containers no scheme lists.
  await expect(page.locator("[data-uncovered-count]").first()).toBeVisible()

  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  const section = panel.getByTestId("selection-coverage")
  await expect(section).toContainText("Need service")
  await expect(section).toContainText("In no route scheme")
  await expect(section.getByRole("button", { name: "Hide gaps on map" })).toBeVisible()
  await section.getByRole("button", { name: "Create scheme for uncovered" }).click()
  await expect(page.getByRole("dialog", { name: "New route scheme" })).toBeVisible()
})

test("ticking two Route Schemes compares their stops on the map with A only, B only, both, and orphaned counts", async ({ page }) => {
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  const schemesLayer = layers.getByTestId("schemes-layer")
  await expect(schemesLayer).toContainText("Tick two to compare")
  await expect(schemesLayer).toContainText("RS-Central · Week A")
  await expect(schemesLayer).toContainText("RS-Østerbro · Organic B")
  await expect(page.getByTestId("compare-strip")).toHaveCount(0)
  await schemesLayer.getByRole("checkbox", { name: /RS-Central · Week A/ }).click()
  await expect(page.getByTestId("compare-strip")).toHaveCount(0)
  await schemesLayer.getByRole("checkbox", { name: /RS-Østerbro · Organic B/ }).click()
  await expect(schemesLayer).toContainText("Comparing")
  await page.keyboard.press("Escape")

  const strip = page.getByTestId("compare-strip")
  await expect(strip).toBeVisible()
  await expect(strip).toContainText("RS-Central · Week A")
  await expect(strip).toContainText("RS-Østerbro · Organic B")
  await expect(strip.getByTestId("compare-counts")).toContainText(/A only\s*\d+/)
  await expect(strip.getByTestId("compare-counts")).toContainText(/B only\s*\d+/)
  await expect(strip.getByTestId("compare-counts")).toContainText(/Both\s*\d+/)
  await expect(strip.getByTestId("compare-counts")).toContainText(/Orphaned\s*\d+/)
  // Markers take a side.
  await expect(page.locator("[data-marker][data-compare]").first()).toBeVisible()
  await expect(page.locator("[data-compare-hull]")).toHaveCount(1)

  await strip.getByRole("button", { name: "Stop comparing" }).click()
  await expect(strip).toHaveCount(0)
  await expect(page.locator("[data-marker][data-compare]")).toHaveCount(0)
})

test("a selection saves with its window, survives a reload, loads back, and can be renamed and deleted", async ({ page }) => {
  const trigger = page.getByTestId("saved-selections-trigger")
  const menu = () => page.getByRole("dialog", { name: "Saved selections" })
  await trigger.click()
  await expect(menu().getByLabel("Selection name")).toBeDisabled()
  await expect(menu()).toContainText("Nothing saved yet.")
  await page.keyboard.press("Escape")

  await page.getByLabel("Collection window").click()
  await page.getByRole("option", { name: "Next 7 days" }).click()
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  const subtitle = await panel.getByTestId("selected-area-subtitle").innerText()
  const rowCount = await panel.getByTestId("selected-containers").locator("[data-container-row]").count()

  await trigger.click()
  await expect(menu()).toContainText("Keeps the rectangle · next 7 days · no filters.")
  await menu().getByLabel("Selection name").fill("Vesterbro west")
  await menu().getByRole("button", { name: "Save", exact: true }).click()
  await expect(menu().getByTestId("saved-selections")).toContainText("Vesterbro west")
  await expect(menu().getByTestId("saved-selections")).toContainText("Rectangle · Next 7 days · No filters")
  await page.keyboard.press("Escape")
  await expect(trigger).toContainText("1")

  // Reload: the list is in the browser; the selection itself is not.
  await page.reload()
  await expect(page.locator(MARKERS)).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expect(page.getByLabel("Collection window")).toContainText("Any date")
  await trigger.click()
  await menu().getByRole("button", { name: /^Vesterbro west/ }).click()
  await expect(menu()).toHaveCount(0)
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId("selected-area-subtitle")).toHaveText(subtitle)
  await expect(panel.getByTestId("selected-containers").locator("[data-container-row]")).toHaveCount(rowCount)
  await expect(page.getByLabel("Collection window")).toContainText("Next 7 days")
  await expect(page.locator('[data-selection-shape="rectangle"]')).toBeVisible()

  await trigger.click()
  await menu().getByRole("button", { name: "Rename Vesterbro west" }).click()
  await menu().getByLabel("New name").fill("Vesterbro & Frederiksberg")
  await page.keyboard.press("Enter")
  await expect(menu().getByTestId("saved-selections")).toContainText("Vesterbro & Frederiksberg")
  await menu().getByRole("button", { name: "Delete Vesterbro & Frederiksberg" }).click()
  await expect(menu()).toContainText("Nothing saved yet.")
})

test("Create service area opens the Service Area form seeded from the selection; the new area is drawn and covers the selection", async ({ page }) => {
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  const rowCount = await panel.getByTestId("selected-containers").locator("[data-container-row]").count()
  await panel.getByRole("button", { name: "Create service area" }).click()

  const dialog = page.getByRole("dialog", { name: "Create service area" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel(/^Project/)).toContainText("Copenhagen Central")
  await expect(dialog.getByLabel("Geographic boundary")).toHaveValue(
    new RegExp(`^Drawn on Map Planning · ${rowCount} containers across \\d+ propert`),
  )
  await expect(dialog.getByLabel(/^Planning areas/)).not.toContainText("Select planning areas")

  await dialog.getByLabel("Service area name").fill("Vesterbro west award")
  await dialog.getByLabel("Area code").fill("CA-VW-1")
  await dialog.getByLabel(/^Service provider/).click()
  await page.getByRole("option").first().click()
  await dialog.getByLabel(/^Service responsibilities/).click()
  await page.getByRole("option", { name: "Residual waste collection" }).click()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(/^Starts/).fill("2026-10-01")
  await dialog.getByLabel(/^Ends/).fill("2027-09-30")
  await dialog.getByRole("button", { name: "Create service area" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Notifications alt+T" })).toContainText("Service area created")

  // The drawn boundary switches itself on and covers every selected container.
  const outline = page.locator("[data-service-area-outline]")
  await expect(outline).toHaveCount(1)
  await expect(outline).toContainText("Vesterbro west award")
  const coverage = panel.locator("li", { hasText: "Vesterbro west award" })
  await expect(coverage).toContainText(`${rowCount} containers`)

  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  const toggle = layers.getByTestId("service-areas-layer").getByRole("checkbox", { name: /Vesterbro west award/ })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(outline).toHaveCount(0)
})

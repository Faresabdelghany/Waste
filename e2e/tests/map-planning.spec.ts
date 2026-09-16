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

/** The app's own local-date "today" (lib/route-schemes/recurrence.ts todayIso). */
const localToday = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

const SEEDED_ROUTE_ID = "route-e2e-9001"
const OSRM_ROUTES = "https://router.project-osrm.org/**"

/**
 * Stand in for the routing server: the road through the requested stops
 * with one vertex bent 20 m or so off each straight leg (so it is plainly a
 * road, not the straight line), every leg 500 m and 90 s — or refuse every
 * request, which the map must survive by drawing straight dashed lines.
 */
async function stubRoads(page: Page, answer: "roads" | "refuse" = "roads"): Promise<void> {
  await page.route(OSRM_ROUTES, async (route) => {
    if (answer === "refuse") {
      await route.abort("failed")
      return
    }
    const path = new URL(route.request().url()).pathname.split("/driving/")[1] ?? ""
    const stops = path.split(";").map((pair) => pair.split(",").map(Number) as [number, number])
    const coordinates: [number, number][] = []
    stops.forEach(([lng, lat], index) => {
      if (index > 0) {
        const [previousLng, previousLat] = stops[index - 1]
        coordinates.push([(previousLng + lng) / 2, (previousLat + lat) / 2 + 0.0002])
      }
      coordinates.push([lng, lat])
    })
    await route.fulfill({
      json: {
        code: "Ok",
        routes: [
          {
            distance: 500 * (stops.length - 1),
            duration: 90 * (stops.length - 1),
            geometry: { type: "LineString", coordinates },
            legs: stops.slice(1).map(() => ({ distance: 500, duration: 90 })),
          },
        ],
        waypoints: stops.map(([lng, lat]) => ({ location: [lng, lat] })),
      },
    })
  })
}

/**
 * Fixture route days name pickups outside the registry, so nothing is
 * drawable until a Route Scheme generates routes. Seed one dated route with
 * three located stops the way generation writes them (typed routeId and
 * containerId on the pickups) and reload — the store merges browser records
 * with the fixtures.
 */
async function seedDrawableRoute(
  page: Page,
  stops: readonly string[] = ["asset-82014", "asset-66420", "asset-44831"],
  roads: "roads" | "refuse" = "roads",
  options: { status?: string; pickupStatus?: string; pickupFacts?: (index: number) => Record<string, string> } = {},
): Promise<void> {
  await stubRoads(page, roads)
  const blank = { context: "", owner: "", updated: "", description: "", related: [], source: "", freshness: "" }
  const seeded = {
    "route-studio.routes": [
      {
        ...blank,
        id: SEEDED_ROUTE_ID,
        name: "RC-9001",
        status: options.status ?? "Planned",
        value: `${stops.length} stops`,
        facts: { Vehicle: "WH-24", Driver: "Mads Jensen", "Time window": "06:00–14:00" },
        submittedValues: { serviceDate: localToday() },
      },
    ],
    "route-studio.pickups": stops.map((containerId, index) => ({
      ...blank,
      id: `pickup-e2e-${index + 1}`,
      name: `Pickup ${index + 1}`,
      status: options.pickupStatus ?? "Planned",
      value: "",
      facts: { Stop: String(index + 1), ...(options.pickupFacts?.(index) ?? {}) },
      submittedValues: { routeId: SEEDED_ROUTE_ID, containerId },
    })),
  }
  await page.addInitScript((payload) => {
    window.localStorage.setItem("wastehero-business-records-v1", JSON.stringify(payload))
  }, seeded)
  await page.reload()
  await expect(page.locator(MARKERS)).toBeVisible()
  await expect(page.locator('[data-marker="cluster"]').first()).toBeVisible()
}

/**
 * A point on a drawn route where its hit stroke is the topmost element: a
 * marker stands on every stop and clusters may sit on the segment, so walk
 * the first segment until the point under the pointer is the route itself.
 */
async function pointOnRouteLine(page: Page, routeId: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((id) => {
    const circles = Array.from(document.querySelectorAll(`[data-route-line="${id}"] circle`)).slice(0, 2)
    if (circles.length < 2) return null
    const [a, b] = circles.map((node) => {
      const box = node.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })
    for (let step = 1; step < 40; step += 1) {
      const t = step / 40
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      const hit = document.elementFromPoint(x, y)
      if (hit?.getAttribute("data-route-hit") === id) return { x, y }
    }
    return null
  }, routeId)
  if (!point) throw new Error(`no clear point on route ${routeId}`)
  return point
}

/**
 * Opens a route's card by clicking its line. The click is dispatched on the
 * route's own hit stroke, at a point on the line, so another route crossing
 * it (fixture route days draw alongside the seeded one) cannot take the click.
 */
async function clickRouteLine(page: Page, routeId: string): Promise<void> {
  const point = await pointOnRouteLine(page, routeId)
  await page
    .locator(`[data-route-hit="${routeId}"]`)
    .dispatchEvent("click", { clientX: point.x, clientY: point.y, bubbles: true })
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

test("the Routes layer counts the fixture route days by status and draws nothing until switched on", async ({ page }) => {
  // Fixture pickups name their stops by address; the ones on gazetteer streets make their route days drawable.
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  const routesLayer = layers.getByTestId("routes-layer")
  await expect(routesLayer).toContainText("Routes")
  await expect(routesLayer).toContainText("Any date")
  await expect(routesLayer.getByRole("checkbox", { name: /Routes in the collection window/ })).toBeEnabled()
  await expect(routesLayer).toContainText("2 in progress")
  await expect(routesLayer).toContainText("1 completed")
  await expect(routesLayer).not.toContainText("awaiting")
  await expect(page.locator("[data-route-line]")).toHaveCount(0)
})

test("the Routes layer draws a dated route coloured by status and a click on its line opens the route card", async ({ page }) => {
  await seedDrawableRoute(page)
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  const toggle = layers.getByTestId("routes-layer").getByRole("checkbox", { name: /Routes in the collection window/ })
  await expect(toggle).toBeEnabled()
  await expect(layers.getByTestId("routes-layer")).toContainText("1 awaiting")
  await toggle.click()
  const line = page.locator(`[data-route-line="${SEEDED_ROUTE_ID}"]`)
  await expect(line).toBeVisible()
  await expect(line).toHaveAttribute("data-route-status", "awaiting")
  // The line follows the road the routing server answered with, in the status colour.
  await expect(line).toHaveAttribute("data-route-geometry", "road")
  await expect(line.locator(`[data-route-road="${SEEDED_ROUTE_ID}"]`)).toHaveAttribute("stroke", "#f59e0b")
  await page.keyboard.press("Escape")
  await expect(layers).toHaveCount(0)

  // The window still holds the route: it runs today.
  await page.getByLabel("Collection window").click()
  await page.getByRole("option", { name: "Today" }).click()
  await expect(line).toBeVisible()

  await clickRouteLine(page, SEEDED_ROUTE_ID)
  const card = page.getByTestId("route-card")
  await expect(card).toBeVisible()
  await expect(card).toContainText("RC-9001")
  await expect(card).toContainText("Planned")
  await expect(card).toContainText("WH-24")
  await expect(card).toContainText("Mads Jensen")
  await expect(card).toContainText("06:00–14:00")
  await expect(card).toContainText("3")
  // Two legs of the stubbed road: 1 km in 3 minutes.
  await expect(card.getByTestId("route-card-drive")).toHaveText("1.0 km · 3 min")
  await expect(card.getByRole("link", { name: "Open route" })).toHaveAttribute(
    "href",
    `/route-studio?module=routes&record=${SEEDED_ROUTE_ID}`,
  )
  await page.keyboard.press("Escape")
  await expect(card).toHaveCount(0)
})

test("the Containers list mirrors the selection and hover highlights run both ways between rows and markers", async ({ page }) => {
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  const rows = panel.getByTestId("selected-containers").locator("[data-container-row]")
  const containerCount = Number(await panel.locator("dd").first().locator("xpath=../..").locator("dd").nth(2).innerText())
  await expect(rows).toHaveCount(containerCount)
  await expect(page.locator("[data-marker][data-highlighted]")).toHaveCount(0)

  // Row → marker.
  const firstRow = rows.first()
  await firstRow.hover()
  await expect(page.locator('[data-marker][data-highlighted="true"]').first()).toBeVisible()
  await panel.getByRole("heading", { name: "Selected area" }).hover()
  await expect(page.locator("[data-marker][data-highlighted]")).toHaveCount(0)

  // Fraction row → markers.
  await panel.locator("[data-fraction-row]").first().hover()
  await expect(page.locator('[data-marker][data-highlighted="true"]').first()).toBeVisible()

  // Marker → row: a selected marker clear of the panel, which covers the map's left edge.
  const marker = await page.evaluate(() => {
    const panelRight = document.querySelector('[data-testid="selected-area"]')!.getBoundingClientRect().right
    for (const node of document.querySelectorAll('[data-marker][data-selected="true"]')) {
      const box = node.getBoundingClientRect()
      if (box.left > panelRight + 8) return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    return null
  })
  if (!marker) throw new Error("no selected marker clear of the panel")
  await page.mouse.move(marker.x, marker.y)
  await expect(rows.locator('xpath=self::*[@data-highlighted="true"]').first()).toBeVisible()
  await page.locator(CANVAS).hover({ position: { x: 5, y: 5 } })
  await expect(rows.locator('xpath=self::*[@data-highlighted="true"]')).toHaveCount(0)

  // A row opens the container's details.
  const label = await firstRow.locator("span.font-medium").innerText()
  await firstRow.click()
  await expect(page.getByRole("dialog")).toContainText(label)
})

test("a route whose road cannot be fetched is drawn straight and dashed", async ({ page }) => {
  await seedDrawableRoute(page, undefined, "refuse")
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  await layers.getByTestId("routes-layer").getByRole("checkbox", { name: /Routes in the collection window/ }).click()
  const line = page.locator(`[data-route-line="${SEEDED_ROUTE_ID}"]`)
  await expect(line).toBeVisible()
  await expect(line).toHaveAttribute("data-route-geometry", "straight")
  await expect(line.locator("polyline").first()).toHaveAttribute("stroke-dasharray", "6 6")
  await expect(line.locator("[data-route-road]")).toHaveCount(0)
  // Still a route: its card opens from the dashed line.
  await clickRouteLine(page, SEEDED_ROUTE_ID)
  const card = page.getByTestId("route-card")
  await expect(card).toContainText("RC-9001")
  await expect(card.getByTestId("route-card-drive")).toHaveCount(0)
})

test("Play route replays a completed route stop by stop with planned and actual times", async ({ page }) => {
  const clock = (minutes: number) => `${String(6 + Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
  await seedDrawableRoute(page, undefined, "roads", {
    status: "Completed",
    pickupStatus: "Completed",
    // Planned every ten minutes from 06:10; each stop completed five minutes late.
    pickupFacts: (index) => ({ Scheduled: clock(10 + index * 10), "Completed at": clock(15 + index * 10) }),
  })
  await page.getByRole("button", { name: /^Layers/ }).click()
  await page.getByRole("dialog", { name: "Layers" }).getByTestId("routes-layer").getByRole("checkbox").click()
  await page.keyboard.press("Escape")
  await expect(page.locator(`[data-route-line="${SEEDED_ROUTE_ID}"]`)).toHaveAttribute("data-route-geometry", "road")

  await clickRouteLine(page, SEEDED_ROUTE_ID)
  await page.getByTestId("route-card").getByRole("button", { name: "Play route" }).click()
  const bar = page.getByTestId("playback-bar")
  await expect(bar).toBeVisible()
  await expect(page.getByTestId("route-card")).toHaveCount(0)
  await expect(bar).toContainText("RC-9001")
  await expect(page.getByTestId("playback-vehicle")).toBeVisible()
  await expect(page.locator(`[data-route-travelled="${SEEDED_ROUTE_ID}"]`)).toHaveCount(1)

  // Freeze the replay, then walk it with the scrubber.
  await bar.getByRole("button", { name: "Pause", exact: true }).click()
  const slider = bar.getByRole("slider", { name: "Route progress" })
  await slider.focus()
  await page.keyboard.press("Home")
  await expect(bar.getByTestId("playback-position")).toHaveText("Stop 1 of 3")
  await expect(bar.getByTestId("playback-times")).toHaveText("planned 06:10 · actual 06:15 · +5 min")
  await page.keyboard.press("End")
  await expect(bar.getByTestId("playback-position")).toHaveText("Stop 3 of 3")
  await expect(bar.getByTestId("playback-caption")).toContainText("3.")
  await expect(bar.getByTestId("playback-times")).toHaveText("planned 06:30 · actual 06:35 · +5 min")
  // At the last stop, Play starts over.
  await bar.getByRole("button", { name: "Play", exact: true }).click()
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible()

  await bar.getByRole("button", { name: "Close playback" }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.getByTestId("playback-vehicle")).toHaveCount(0)
})

test("a route row in the Selected area panel can be played without the Routes layer", async ({ page }) => {
  await seedDrawableRoute(page, ["asset-seed-91005", "asset-seed-91007", "asset-seed-91010"])
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  await panel.locator(`[data-route-row="${SEEDED_ROUTE_ID}"]`).getByRole("button", { name: "Play route RC-9001" }).click()
  const bar = page.getByTestId("playback-bar")
  await expect(bar).toBeVisible()
  // Playing draws the route even though nothing switched the Routes layer on.
  await expect(page.locator(`[data-route-line="${SEEDED_ROUTE_ID}"]`)).toBeVisible()
  await expect(page.getByTestId("playback-vehicle")).toBeVisible()
  await expect(bar.getByTestId("playback-times")).toHaveText("No times recorded")
})

test("hovering a route row highlights its line and hovering the line highlights the row", async ({ page }) => {
  // Three stops on Vesterbro and Frederiksberg streets, inside the rectangle.
  await seedDrawableRoute(page, ["asset-seed-91005", "asset-seed-91007", "asset-seed-91010"])
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  const row = panel.locator(`[data-route-row="${SEEDED_ROUTE_ID}"]`)
  await expect(row).toBeVisible()
  await expect(row).toContainText("RC-9001")
  await panel.getByRole("button", { name: "See on map" }).click()
  const line = page.locator(`[data-route-line="${SEEDED_ROUTE_ID}"]`)
  await expect(line).toBeVisible()
  await expect(line).not.toHaveAttribute("data-highlighted", "true")

  await row.hover()
  await expect(line).toHaveAttribute("data-highlighted", "true")
  await panel.getByRole("heading", { name: "Selected area" }).hover()
  await expect(line).not.toHaveAttribute("data-highlighted", "true")

  const point = await pointOnRouteLine(page, SEEDED_ROUTE_ID)
  await page.mouse.move(point.x, point.y)
  await expect(row).toHaveAttribute("data-highlighted", "true")
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

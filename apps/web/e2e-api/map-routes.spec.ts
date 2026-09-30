import type { Page } from "@playwright/test"

import { chainLanded, expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { routeRead, schemeWithRoutes } from "./routes-support"
import { listAll } from "./tester"

// Map Planning's routes on the Pilot (Issue #179, slice 6 of #81): the
// Routes layer, the route card, Play route and the Selected area's route
// rows, ported from the fixture suite's map-planning.spec.ts, whose seeded
// browser routes they replace, onto the routes generation wrote through the
// API. The map places an API route's stops at its containers, which stand
// where their placements in force deliver (#184). No
// road geometry is asserted here: how a route's line is measured is the legs
// layer's (#173), and roads come through the API alone (#214), so the suite
// asks no routing server; every route is drawn as the dashed estimate.

const MARKERS = '[data-testid="planning-map-markers"]'
const DRAW = '[data-testid="planning-map-draw"]'

type Container = { id: string; label: string }

/** The map without its tiles, which the suite never asks for. */
async function showMapPlanning(page: Page): Promise<void> {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.route("**/server.arcgisonline.com/**", (route) => route.abort())
  await page.goto("/plan")
  await expect(page.getByTestId("map-planning")).toBeVisible()
  await expect(page.locator(MARKERS)).toBeVisible()
}

async function openMapPlanning(page: Page): Promise<void> {
  await showMapPlanning(page)
  // The routes and the stops are the last modules the store reads: until they land, the map draws no route (#179).
  await chainLanded(page)
}

async function routesLayer(page: Page) {
  await page.getByRole("button", { name: /^Layers/ }).click()
  return page.getByRole("dialog", { name: "Layers" }).getByTestId("routes-layer")
}

/** Opens a route's card from its line: the click lands on the route's own hit stroke, on its first leg, since a route of another day may run the same streets over it. */
async function clickRouteLine(page: Page, routeId: string): Promise<void> {
  const point = await page.evaluate((id) => {
    const circles = Array.from(document.querySelectorAll(`[data-route-line="${id}"] circle`)).slice(0, 2)
    if (circles.length < 2) return null
    const [a, b] = circles.map((node) => {
      const box = node.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }, routeId)
  if (!point) throw new Error(`route ${routeId} has no drawn leg`)
  await page.locator(`[data-route-hit="${routeId}"]`).dispatchEvent("click", { clientX: point.x, clientY: point.y, bubbles: true })
}

/** Drags a rectangle over the south-west of the initial view, where the Indre By streets the seeded routes serve stand. */
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

test("the Routes layer counts the API's routes by status and draws them only once switched on, coloured by status", async ({ api, page }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Map layer"))
  await openMapPlanning(page)
  const layer = await routesLayer(page)
  await expect(layer).toContainText("Any date")
  const toggle = layer.getByRole("checkbox", { name: /Routes in the collection window/ })
  await expect(toggle).toBeEnabled()
  // Every planned route of the project is awaiting, the run's own among them: a lower bound, since the specs running beside this one generate routes of their own.
  const awaiting = Number((await layer.innerText()).match(/(\d+) awaiting/)?.[1] ?? 0)
  expect(awaiting).toBeGreaterThanOrEqual(routes.length)
  await expect(page.locator("[data-route-line]")).toHaveCount(0)

  await toggle.click()
  for (const route of routes) {
    const line = page.locator(`[data-route-line="route-${route.id}"]`)
    await expect(line).toBeVisible()
    await expect(line).toHaveAttribute("data-route-status", "awaiting")
  }
})

test("until the API's routes and stops are read the map draws no route: nothing before, never the fixtures' (#179)", async ({ api, page }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Map held"))
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  for (const list of ["**/waste-api/routes?*", "**/waste-api/pickups?*"]) {
    await page.route(list, async (route) => {
      await held
      await route.continue()
    })
  }
  await showMapPlanning(page)
  const layer = await routesLayer(page)
  await layer.getByRole("checkbox", { name: /Routes in the collection window/ }).click()
  // The fixtures' routes would count and draw here, over the Pilot's containers, were they shown before the API's rows.
  expect(Number((await layer.innerText()).match(/(\d+) awaiting/)?.[1] ?? 0)).toBe(0)
  await expect(page.locator("[data-route-line]")).toHaveCount(0)
  release()
  for (const route of routes) await expect(page.locator(`[data-route-line="route-${route.id}"]`)).toBeVisible()
})

test("a click on an API route's line opens its card with the route's own facts, and Open route lands on its details", async ({ api, page }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Map card"))
  const [route] = routes
  // Assigned through the API, so the card has a vehicle and a driver to show.
  const vehicle = (await listAll<{ id: string; callsign: string | null }>(api, "/vehicles")).find((row) => row.callsign === "WH-24")
  const driver = (await listAll<{ id: string; name: string }>(api, "/drivers")).find((row) => row.name === "Mads Jensen")
  const assigned = await api.post(`/routes/${route.id}/assign`, { data: { vehicleId: vehicle?.id, driverId: driver?.id } })
  expect(assigned.status(), await assigned.text()).toBe(200)

  await openMapPlanning(page)
  await (await routesLayer(page)).getByRole("checkbox", { name: /Routes in the collection window/ }).click()
  await page.keyboard.press("Escape")
  await expect(page.locator(`[data-route-line="route-${route.id}"]`)).toBeVisible()

  await clickRouteLine(page, `route-${route.id}`)
  const card = page.getByTestId("route-card")
  await expect(card).toBeVisible()
  await expect(card).toContainText(route.label)
  await expect(card).toContainText("Planned")
  await expect(card).toContainText("WH-24")
  await expect(card).toContainText("Mads Jensen")
  await expect(card).toContainText(String(route.progress.total))
  const open = card.getByRole("link", { name: "Open route" })
  await expect(open).toHaveAttribute("href", `/route-studio?module=routes&record=route-${route.id}`)
  await open.click()
  const details = page.getByRole("dialog", { name: route.label })
  await expect(details.getByTestId("route-commands")).toBeVisible()
})

test("Play route replays an API route stop by stop, from its card", async ({ api, page }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Map play"))
  const [route] = routes
  const [detail, containers] = await Promise.all([routeRead(api, route.id), listAll<Container>(api, "/containers")])
  const first = containers.find((container) => container.id === detail.pickups[0]?.containerId)?.label

  await openMapPlanning(page)
  await (await routesLayer(page)).getByRole("checkbox", { name: /Routes in the collection window/ }).click()
  await page.keyboard.press("Escape")
  await clickRouteLine(page, `route-${route.id}`)
  await page.getByTestId("route-card").getByRole("button", { name: "Play route" }).click()
  const bar = page.getByTestId("playback-bar")
  await expect(bar).toBeVisible()
  await expect(page.getByTestId("route-card")).toHaveCount(0)
  await expect(bar).toContainText(route.label)
  await expect(page.getByTestId("playback-vehicle")).toBeVisible()

  // Freeze the replay, then walk it with the scrubber: a planned route has no times yet.
  await bar.getByRole("button", { name: "Pause", exact: true }).click()
  await bar.getByRole("slider", { name: "Route progress" }).focus()
  await page.keyboard.press("Home")
  await expect(bar.getByTestId("playback-position")).toHaveText(`Stop 1 of ${detail.pickups.length}`)
  await expect(bar.getByTestId("playback-caption")).toContainText(`1. ${first}`)
  await expect(bar.getByTestId("playback-times")).toHaveText("No times recorded")
  await page.keyboard.press("End")
  await expect(bar.getByTestId("playback-position")).toHaveText(`Stop ${detail.pickups.length} of ${detail.pickups.length}`)

  await bar.getByRole("button", { name: "Close playback" }).click()
  await expect(bar).toHaveCount(0)
  await expect(page.getByTestId("playback-vehicle")).toHaveCount(0)
})

test("a route row in the Selected area panel plays without the Routes layer, and hovering it highlights its line and the line the row", async ({ api, page }) => {
  await schemeWithRoutes(api, uniqueName("E2E Map area"))
  await openMapPlanning(page)
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  // The panel lists the first routes by status and day; which API route comes first is the tenant's.
  const row = panel.locator("[data-route-row]").first()
  await expect(row).toBeVisible()
  const routeId = await row.getAttribute("data-route-row")
  expect(routeId).toMatch(/^route-[0-9a-f-]{36}$/)
  const label = (await row.innerText()).match(/RC-\d+/)?.[0]

  await panel.getByRole("button", { name: "See on map" }).click()
  const line = page.locator(`[data-route-line="${routeId}"]`)
  await expect(line).toBeVisible()
  await row.hover()
  await expect(line).toHaveAttribute("data-highlighted", "true")
  await panel.getByRole("heading", { name: "Selected area" }).hover()
  await expect(line).not.toHaveAttribute("data-highlighted", "true")
  await page.locator(`[data-route-hit="${routeId}"]`).dispatchEvent("mouseover")
  await expect(row).toHaveAttribute("data-highlighted", "true")
  await page.locator(`[data-route-hit="${routeId}"]`).dispatchEvent("mouseout")

  // Hidden again, then played from its row: playing draws it.
  await panel.getByRole("button", { name: "Hide from map" }).click()
  await expect(line).toHaveCount(0)
  await row.getByRole("button", { name: `Play route ${label}` }).click()
  await expect(page.getByTestId("playback-bar")).toBeVisible()
  await expect(line).toBeVisible()
  await expect(page.getByTestId("playback-vehicle")).toBeVisible()
})

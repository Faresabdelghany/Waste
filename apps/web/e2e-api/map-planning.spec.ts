import type { Page } from "@playwright/test"

import { uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"
import { schemeWithRoutes } from "./routes-support"

// Map Planning on the API (slice 9b of #81, Issue #184): the map places the
// server's containers where their placements in force today are delivered
// at — the seeded tenant's placed containers at their properties' points —
// so the fixture suite's Containers list test (e2e/tests/map-planning.spec.ts)
// lives here now, against the seeded registry, and since #186 its Create
// service area test too. Tile requests are aborted: the
// base map reports itself unavailable and the markers still stand.
const MARKERS = '[data-testid="planning-map-markers"]'
const DRAW = '[data-testid="planning-map-draw"]'
const CANVAS = '[data-testid="planning-map-canvas"]'

/** Opens Map Planning once the record store's chain has landed, so the markers are the server's containers and not the fixtures shown while it loads. */
async function openMapPlanning(page: Page): Promise<void> {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.route("**/server.arcgisonline.com/**", (route) => route.abort())
  const placed = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/placements")
  await page.goto("/plan")
  expect((await placed).status()).toBe(200)
  await chainLanded(page)
  await expect(page.getByTestId("map-planning")).toBeVisible()
  await expect(page.locator(MARKERS)).toBeVisible()
  await expect(page.locator("[data-marker]").first()).toBeVisible()
}

/** The middle and the east of the initial view: the seeded placed containers of central Copenhagen, and clear of the Selected area panel, which opens over the map's west. */
const CENTRAL = { from: { x: 0.3, y: 0.15 }, to: { x: 0.9, y: 0.9 } }
/** Its south: Copenhagen Central's containers alone, clear of Nordhavn's, which are Harbor Commercial's, to the north-east. */
const COPENHAGEN_SOUTH = { from: { x: 0.3, y: 0.45 }, to: { x: 0.95, y: 0.95 } }

/** Drags a rectangle over `area` of the initial view, as fractions of it, with the rectangle tool. */
async function selectRectangle(page: Page, area = CENTRAL): Promise<void> {
  await page.getByRole("button", { name: "Select with a rectangle" }).click()
  const overlay = page.locator(DRAW)
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (!box) throw new Error("draw overlay has no box")
  await page.mouse.move(box.x + box.width * area.from.x, box.y + box.height * area.from.y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * area.to.x, box.y + box.height * area.to.y, { steps: 8 })
  await page.mouse.up()
  await expect(overlay).toHaveCount(0)
}

test("the Containers list mirrors the selection of the server's placed containers and hover highlights run both ways between rows and markers", async ({ page }) => {
  await openMapPlanning(page)
  await selectRectangle(page)
  const panel = page.getByRole("region", { name: "Selected area" })
  const rows = panel.getByTestId("selected-containers").locator("[data-container-row]")
  const containerCount = Number(await panel.locator("dd").first().locator("xpath=../..").locator("dd").nth(2).innerText())
  expect(containerCount).toBeGreaterThan(0)
  await expect(rows).toHaveCount(containerCount)
  // The rows are the API's containers (`asset-<uuid>`), not the fixtures' (`asset-seed-91001`).
  for (const id of await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-container-row") ?? ""))) {
    expect(id).toMatch(/^asset-[0-9a-f]{8}-[0-9a-f]{4}-/)
  }
  await expect(page.locator("[data-marker][data-highlighted]")).toHaveCount(0)

  // Row → marker.
  const firstRow = rows.first()
  await firstRow.hover()
  await expect(page.locator('[data-marker][data-highlighted="true"]').first()).toBeVisible()
  await panel.getByRole("heading", { name: "Selected area" }).hover()
  await expect(page.locator("[data-marker][data-highlighted]")).toHaveCount(0)

  // Fraction row → markers; then back to the heading, so the markers have re-rendered unhighlighted before the pointer enters one.
  await panel.locator("[data-fraction-row]").first().hover()
  await expect(page.locator('[data-marker][data-highlighted="true"]').first()).toBeVisible()
  await panel.getByRole("heading", { name: "Selected area" }).hover()
  await expect(page.locator("[data-marker][data-highlighted]")).toHaveCount(0)

  // Marker → row: a selected marker clear of the panel, which covers the map's left edge, hovered as an element so the pointer lands once it stands still.
  const selectedMarkers = page.locator('[data-marker][data-selected="true"]')
  const clear = await selectedMarkers.evaluateAll((nodes) => {
    const panelRight = document.querySelector('[data-testid="selected-area"]')!.getBoundingClientRect().right
    return nodes.findIndex((node) => node.getBoundingClientRect().left > panelRight + 8)
  })
  if (clear < 0) throw new Error("no selected marker clear of the panel")
  await selectedMarkers.nth(clear).hover()
  await expect(rows.locator('xpath=self::*[@data-highlighted="true"]').first()).toBeVisible()
  await page.locator(CANVAS).hover({ position: { x: 5, y: 5 } })
  await expect(rows.locator('xpath=self::*[@data-highlighted="true"]')).toHaveCount(0)

  // A row opens the container's details.
  const label = await firstRow.locator("span.font-medium").innerText()
  await firstRow.click()
  await expect(page.getByRole("dialog")).toContainText(label)
})

test("the filters offer each scheme whose routes stop at a container, a name holding ' · ' whole, and narrow the map to its stops (#232)", async ({ api, page }) => {
  // A scheme of the run's own, generated: its routes stop at the seeded Residual containers in Indre By Operations.
  const { scheme } = await schemeWithRoutes(api, `${uniqueName("E2E Map scheme")} · Week A`, 7)
  await openMapPlanning(page)
  // Every seeded placed container across the tenant's areas, before the filter.
  const markers = page.locator("[data-marker]")
  const before = await markers.count()
  await page.getByRole("button", { name: "Filter", exact: true }).click()
  const popover = page.getByRole("dialog").filter({ has: page.getByPlaceholder("Find a filter") })
  await popover.getByRole("button", { name: /^Route scheme\b/ }).click()
  const option = popover.locator("label").filter({ hasText: scheme.name })
  await expect(option).toHaveCount(1)
  await option.getByRole("checkbox").check()
  await popover.getByRole("button", { name: "Apply filters" }).click()
  await expect(page.getByText(`Route scheme: ${scheme.name}`, { exact: true })).toBeVisible()
  // The scheme's stops alone: some, and fewer than the tenant's every container (Amager's and Nordhavn's are no stops of it).
  await expect.poll(() => markers.count(), { message: "the map narrows to the scheme's stops" }).toBeLessThan(before)
  expect(await markers.count()).toBeGreaterThan(0)
})

type ServiceAreaCreated = { id: string; name: string; code: string; planningAreaIds: string[]; wasteFractionIds: string[]; validFrom: string; validTo: string | null; assignment: { serviceProviderId: string } | null }

/** A day of this run's own, decades ahead: a planning area is awarded once at a time (#186), and the tenant keeps every earlier run's awards. */
function dayOfItsOwn(): { first: string; firstOut: string } {
  const at = Date.UTC(2100, 0, 1) + (Math.floor(Date.now() / 1000) % 25_000) * 4 * 86_400_000
  return { first: new Date(at).toISOString().slice(0, 10), firstOut: new Date(at + 86_400_000).toISOString().slice(0, 10) }
}

// Ported from the fixture suite (#186): on the API the award is the planning
// areas the selection touches — the drawn polygon is never persisted (#127)
// — and the map draws it as their stored boundaries.
test("Create service area opens the Pilot's award form on the selection's planning areas; the award is drawn as them and covers the selection", async ({ page }) => {
  await openMapPlanning(page)
  // Awards made before this visit — earlier runs' — load switched off.
  await expect(page.locator("[data-service-area-outline]")).toHaveCount(0)
  // One project's containers: an award is made in one project.
  await selectRectangle(page, COPENHAGEN_SOUTH)
  const panel = page.getByRole("region", { name: "Selected area" })
  const rowCount = await panel.getByTestId("selected-containers").locator("[data-container-row]").count()
  await panel.getByRole("button", { name: "Create service area" }).click()

  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Create service area", exact: true }) })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("combobox", { name: /^Project/ })).toContainText("Copenhagen Central")
  await expect(dialog.getByLabel("Geographic boundary")).toHaveValue(new RegExp(`^Drawn on Map Planning · ${rowCount} containers across \\d+ propert`))
  const planningAreas = dialog.getByRole("combobox", { name: /^Planning areas/ })
  await expect(planningAreas).not.toContainText(/^Select/)
  await expect(planningAreas).not.toHaveAttribute("aria-invalid", "true")

  const name = `E2E award ${Date.now().toString(36)}`
  const code = `E2E-${Date.now().toString(36)}`.toUpperCase()
  const { first, firstOut } = dayOfItsOwn()
  await dialog.getByLabel("Service area name").fill(name)
  await dialog.getByLabel("Area code").fill(code)
  await dialog.getByRole("combobox", { name: /^Service provider/ }).click()
  await page.getByRole("option", { name: /^NordRen/ }).click()
  await dialog.getByRole("combobox", { name: /^Waste fractions/ }).click()
  await page.getByRole("option", { name: "Residual" }).click()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await dialog.getByLabel(/^Starts/).fill(first)
  await dialog.getByLabel(/^Ends/).fill(first)
  const [created] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/waste-api/service-areas"),
    dialog.getByRole("button", { name: "Create service area" }).click(),
  ])
  expect(created.status()).toBe(201)
  // The award and its first assignment: no polygon among the fields.
  expect(Object.keys(created.request().postDataJSON() as object).sort()).toEqual(["assignment", "boundaryText", "code", "name", "planningAreaIds", "projectId", "validFrom", "validTo", "wasteFractionIds"])
  const award = (await created.json()) as ServiceAreaCreated
  expect(award).toMatchObject({ name, code, validFrom: first, validTo: firstOut })
  expect(award.planningAreaIds.length).toBeGreaterThan(0)
  expect(award.wasteFractionIds).toHaveLength(1)
  expect(award.assignment).not.toBeNull()
  await expect(dialog).toHaveCount(0)

  // Drawn as its planning areas' stored boundaries, switched on by itself, and covering every selected container.
  const outline = page.locator("[data-service-area-outline]").filter({ hasText: name })
  await expect(outline).toHaveCount(1)
  await expect(page.locator("[data-service-area-outline]")).toHaveCount(1)
  await expect(panel.locator("li", { hasText: name })).toContainText(`${rowCount} containers`)

  // The award's toast settles over the Layers button (1440 × 900: the toast's 356 × 74 at the bottom right covers the
  // button's centre). A click aimed through it would leave the pointer on the toast, and sonner holds a hovered toast for
  // as long as the pointer stays — CI's 107 intercepted retries. The pointer leaves the toaster and the toast goes first.
  await page.mouse.move(0, 0)
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)
  await page.getByRole("button", { name: /^Layers/ }).click()
  const layers = page.getByRole("dialog", { name: "Layers" })
  const toggle = layers.getByTestId("service-areas-layer").getByRole("checkbox", { name: new RegExp(name) })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(outline).toHaveCount(0)
})

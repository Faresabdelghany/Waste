import type { Page } from "@playwright/test"

import { chainLanded, expect, test } from "./fixtures"

// Map Planning on the API (slice 9b of #81, Issue #184): the map places the
// server's containers where their placements in force today are delivered
// at — the seeded tenant's placed containers at their properties' points —
// so the fixture suite's Containers list test (e2e/tests/map-planning.spec.ts)
// lives here now, against the seeded registry. Tile requests are aborted: the
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

/**
 * Drags a rectangle over the middle and the east of the initial view with
 * the rectangle tool: the seeded placed containers of central Copenhagen, and
 * clear of the Selected area panel, which opens over the map's west.
 */
async function selectRectangle(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Select with a rectangle" }).click()
  const overlay = page.locator(DRAW)
  await expect(overlay).toBeVisible()
  const box = await overlay.boundingBox()
  if (!box) throw new Error("draw overlay has no box")
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.15)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, { steps: 8 })
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

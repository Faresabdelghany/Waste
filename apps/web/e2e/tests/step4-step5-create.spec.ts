import type { Page } from "@playwright/test"

import { expect, test } from "../fixtures"
import {
  buildBaselineScheme,
  createButton,
  nextStep,
  optionTexts,
  pickOption,
  schemeRow,
  stepHeading,
  toasts,
  wizard,
} from "../helpers/route-schemes"

const OSRM_ROUTES = "https://router.project-osrm.org/**"

/**
 * Stand in for the routing server the way map-planning.spec.ts does: the
 * road through the requested stops with one vertex bent off each straight
 * leg, every leg 500 m and 90 s — or refuse every request, which the step
 * must survive by drawing straight dashed lines and saying the numbers are
 * an estimate.
 */
async function stubRoads(page: Page, answer: "roads" | "refuse"): Promise<void> {
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

/** The base map is not the point: tile requests are aborted so the suite needs no network. */
async function stubTiles(page: Page): Promise<void> {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.route("**/server.arcgisonline.com/**", (route) => route.abort())
}

test("step 4 draws the routes on a real map along the road and labels the numbers as the road's", async ({
  page,
}) => {
  await stubTiles(page)
  await stubRoads(page, "roads")
  await buildBaselineScheme(page, "Route map check")
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("How do the generated routes look?")
  const root = wizard(page)
  await expect(root.getByRole("switch")).toHaveCount(0)
  await expect(root.getByText("Keep manually edited routes")).toHaveCount(0)
  await expect(root.getByText("Edited")).toHaveCount(0)

  // A real map, not a block diagram: MapLibre's canvas, and one route drawn through the road.
  await expect(root.getByTestId("wizard-route-map-canvas")).toBeVisible()
  const line = root.locator("[data-wizard-route]")
  await expect(line).toHaveCount(1)
  await expect(line).toHaveAttribute("data-route-geometry", "road")
  await expect(line.locator("[data-wizard-road]")).toHaveCount(1)
  // The route stands on the map's stops — the seeded 140 L bins on Indre By's gazetteer streets.
  await expect(line.locator("circle")).toHaveCount(2)
  await expect(root.getByTestId("route-map-unplaced")).toHaveCount(0)

  // The numbers are the road's: one leg of the stubbed road, 500 m; 90 s of driving plus two catalogue
  // emptyings (2 min each) plus generation's 45-minute closeout past the last stop — 51 min.
  const card = root.locator("[data-route-basis]")
  await expect(card).toHaveAttribute("data-route-basis", "road")
  await expect(card.getByTestId("route-basis")).toHaveText("Road")
  await expect(card).toContainText("0.5 km")
  await expect(card).toContainText("51 min")
  await expect(root.getByTestId("route-map-basis")).toContainText("Road · Stops in generation order, not optimised")
  await expect(root.getByText("Estimate", { exact: true })).toHaveCount(0)
  // Every fixture container type is weighed by the catalogue since #39: no Fallback weight anywhere.
  await expect(root.getByText("Fallback weight")).toHaveCount(0)

  await root.getByRole("button", { name: "Regenerate" }).click()
  await expect(root.getByTestId("route-map-basis")).toHaveText(/Road · Stops in generation order, not optimised · Regenerated \d{2}:\d{2}$/)
  // Verdict badges are information only — Next is never blocked by them.
  await expect(root.getByRole("button", { name: "Next", exact: true })).toBeEnabled()
})

test("step 4 without a routing answer draws the stops straight and dashed and says the numbers are an estimate", async ({
  page,
}) => {
  await stubTiles(page)
  await stubRoads(page, "refuse")
  await buildBaselineScheme(page, "Route map offline")
  await nextStep(page)
  const root = wizard(page)
  const line = root.locator("[data-wizard-route]")
  await expect(line).toHaveAttribute("data-route-geometry", "straight")
  await expect(line.locator("polyline").first()).toHaveAttribute("stroke-dasharray", "6 6")
  await expect(line.locator("[data-wizard-road]")).toHaveCount(0)
  const card = root.locator("[data-route-basis]")
  await expect(card).toHaveAttribute("data-route-basis", "estimate")
  await expect(card.getByTestId("route-basis")).toHaveText("Estimate · road unavailable")
  // The prototype's coefficients over two stops: 11 km, 59 min.
  await expect(card).toContainText("11 km")
  await expect(card).toContainText("59 min")
  await expect(root.getByTestId("route-map-basis")).toContainText("Estimate · Stops in generation order, not optimised")
})

test("step 5 offers the running-scheme edit policy, asking by default, and creates the scheme onto the list", async ({
  page,
}) => {
  const name = `Guided create ${Date.now().toString(36)}`
  await buildBaselineScheme(page, name)
  await nextStep(page)
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("Ready to create this scheme?")
  const root = wizard(page)
  await expect(root.getByLabel("Create as", { exact: true })).toBeVisible()
  // "Changes to a running scheme" (issue #38): the three policies in the
  // vocabulary's order, "Ask each time" the default; picking another one
  // changes what the field says it does.
  const editPolicy = root.getByLabel("Changes to a running scheme", { exact: true })
  await expect(editPolicy).toContainText("Ask each time")
  expect(await optionTexts(page, root, "Changes to a running scheme")).toEqual([
    "Ask each time",
    "Apply to future collections",
    "This collection only",
  ])
  await pickOption(page, root, "Changes to a running scheme", "This collection only")
  await expect(root.getByText("applies to the next collection only", { exact: false })).toBeVisible()
  await expect(root.getByText("Danish public holidays")).toBeVisible()
  await expect(root.getByText("Waste fraction")).toBeVisible()
  await expect(root.getByText("Service type")).toBeVisible()
  await expect(root.getByText("Kerbside collection", { exact: true })).toBeVisible()
  await createButton(page).click()
  await expect(root).toBeHidden()
  await expect(toasts(page)).toContainText(`Route scheme created as Validated — ${name}`)
  // The list scans by fraction: the Holiday list column gave way to Waste fraction.
  await expect(page.getByRole("columnheader", { name: "Waste fraction" })).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Holiday list" })).toHaveCount(0)
  const row = schemeRow(page, name)
  await expect(row).toBeVisible()
  await expect(row).toContainText("Residual")
})

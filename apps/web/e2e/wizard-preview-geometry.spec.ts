import { expect, test } from "./fixtures"
import { buildBaselineScheme, nextStep, stepHeading, wizard } from "./helpers/route-schemes"

// The guided setup's step 4 in fixture mode (#173): without the API no road
// is asked for anywhere — the routing provider is the API's alone — so the
// drafted route is drawn straight and dashed on the real map and its numbers
// are the prototype's estimate, while the rest of step 4 stands as before.
// The road over the fake and the spent quota's estimate are the API's
// readings, tested in e2e-api against the preview (#173, #178).

/** The base map is not the point: tile requests are aborted so the suite needs no network. */
async function stubTiles(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/tiles.openfreemap.org/**", (route) => route.abort())
  await page.route("**/server.arcgisonline.com/**", (route) => route.abort())
}

test("step 4 without the API draws the stops straight and dashed on a real map, asks no road of anyone, and says the numbers are an estimate", async ({ page }) => {
  const asked: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (/project-osrm|openrouteservice|heigit|\/routing\//.test(url)) asked.push(url)
  })
  await stubTiles(page)
  await buildBaselineScheme(page, "Route map offline")
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("How do the generated routes look?")
  const root = wizard(page)
  await expect(root.getByRole("switch")).toHaveCount(0)
  await expect(root.getByText("Keep manually edited routes")).toHaveCount(0)
  await expect(root.getByText("Edited")).toHaveCount(0)

  // A real map, not a block diagram: MapLibre's canvas, and the one route drawn between its stops.
  await expect(root.getByTestId("wizard-route-map-canvas")).toBeVisible()
  const line = root.locator("[data-wizard-route]")
  await expect(line).toHaveCount(1)
  await expect(line).toHaveAttribute("data-route-geometry", "straight")
  await expect(line.locator("polyline").first()).toHaveAttribute("stroke-dasharray", "6 6")
  await expect(line.locator("[data-wizard-road]")).toHaveCount(0)
  // The route stands on the map's stops — the seeded 140 L bins on Indre By's gazetteer streets.
  await expect(line.locator("circle")).toHaveCount(2)
  await expect(root.getByTestId("route-map-unplaced")).toHaveCount(0)

  // The prototype's coefficients over two stops: 11 km, 59 min, and the label says what they are.
  const card = root.locator("[data-route-basis]")
  await expect(card).toHaveAttribute("data-route-basis", "estimate")
  await expect(card.getByTestId("route-basis")).toHaveText("Estimate")
  await expect(card).toContainText("11 km")
  await expect(card).toContainText("59 min")
  await expect(root.getByTestId("route-map-basis")).toContainText("Estimate · Stops in generation order, not optimised")
  // Every fixture container type is weighed by the catalogue since #39: no Fallback weight anywhere.
  await expect(root.getByText("Fallback weight")).toHaveCount(0)
  // No provider's geometry is drawn, so no attribution is owed, and no quota is read.
  await expect(root.getByTestId("routing-attribution")).toHaveCount(0)
  await expect(root.getByTestId("routing-quota-banner")).toHaveCount(0)

  await root.getByRole("button", { name: "Regenerate" }).click()
  await expect(root.getByTestId("route-map-basis")).toHaveText(/Estimate · Stops in generation order, not optimised · Regenerated \d{2}:\d{2}$/)
  // Verdict badges are information only — Next is never blocked by them.
  await expect(root.getByRole("button", { name: "Next", exact: true })).toBeEnabled()
  expect(asked, "no road request leaves the browser without the API").toEqual([])
})

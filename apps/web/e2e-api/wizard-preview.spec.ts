import type { APIRequestContext, Route } from "@playwright/test"

import { expect, test } from "./fixtures"

// The routing the office reads through the API (#173): the guided setup's
// road preview over the fake routing provider, asked under the signed-in
// browser's own token as step 4 asks it, and Route Studio's one routing
// banner off `GET /routing/quota`. The lane cannot script the fake or write
// a quota row, so the banner's readings are the browser's answer to the
// quota read; the API suite proves the engine's own paths. Step 4's browser
// pair — the road drawn along the preview, the spent quota's dashed estimate
// — joins once the guided setup reaches step 4 on the API (#178).

type Place = { id: string; name: string; location: { type: "Point"; coordinates: [number, number] } | null }
type PreviewLeg = { path: { type: "LineString"; coordinates: [number, number][] }; metres: number; seconds: number }

/** A seeded place by name, through the API the browser signs in to. */
async function placeNamed(api: APIRequestContext, path: "/depots" | "/unloading-stations", name: string): Promise<[number, number]> {
  const response = await api.get(`${path}?limit=200`)
  expect(response.status()).toBe(200)
  const { items } = (await response.json()) as { items: Place[] }
  const place = items.find((item) => item.name === name)
  expect(place?.location, `${name} is seeded with a location`).toBeTruthy()
  return place!.location!.coordinates
}

test("the guided setup's preview answers the road over the fake routing provider, one leg per pair of points, a repeated point a zero leg", async ({ api }) => {
  const depot = await placeNamed(api, "/depots", "Nordhavn Depot")
  const station = await placeNamed(api, "/unloading-stations", "ARC Amager")

  const response = await api.post("/routing/preview", { data: { points: [depot, depot, station] } })
  expect(response.status()).toBe(200)
  const answer = (await response.json()) as { basis: string; provider: string; legs: PreviewLeg[]; distanceMetres: number; durationSeconds: number }
  expect(answer.basis).toBe("road")
  expect(answer.provider).toBe("fake")
  expect(answer.legs).toHaveLength(2)
  expect(answer.legs[0]).toEqual({ path: { type: "LineString", coordinates: [depot, depot] }, metres: 0, seconds: 0 })
  expect(answer.legs[1].path.coordinates[0]).toEqual(depot)
  expect(answer.legs[1].path.coordinates.at(-1)).toEqual(station)
  expect(answer.distanceMetres).toBe(answer.legs[1].metres)
  expect(answer.distanceMetres).toBeGreaterThan(0)
  expect(answer.durationSeconds).toBe(answer.legs[1].seconds)

  // A body that will not do is the API's 400, and asks the provider nothing: one point, a member the contract does not know.
  const refused = await api.post("/routing/preview", { data: { points: [depot], profile: "driving-car" } })
  expect(refused.status()).toBe(400)
})

test("Route Studio shows the routing banner while the provider's quota is spent or its key refused, and none while it answers", async ({ page }) => {
  const now = Date.now()
  const reading = (overrides: Record<string, unknown> = {}) => ({
    family: "directions",
    remaining: 1_480,
    limit: 2_000,
    resetAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
    exhaustedAt: null,
    keyRefusedAt: null,
    updatedAt: new Date(now).toISOString(),
    ...overrides,
  })
  const answer = (families: unknown[]) => (route: Route) => route.fulfill({ json: { provider: "openrouteservice", families } })
  const banner = page.getByTestId("routing-quota-banner")

  await page.route("**/waste-api/routing/quota", answer([reading({ remaining: 0, exhaustedAt: new Date(now - 60_000).toISOString() }), reading({ family: "optimisation", remaining: 412, limit: 500 })]))
  await page.goto("/route-studio?module=routes")
  await expect(banner).toHaveAttribute("data-tone", "waiting")
  await expect(banner).toHaveText(/^Waiting for routing quota: road measurements resume (at|tomorrow at) \d{2}:\d{2}$/)

  await page.unroute("**/waste-api/routing/quota")
  await page.route("**/waste-api/routing/quota", answer([reading({ keyRefusedAt: new Date(now - 60_000).toISOString() })]))
  await page.reload()
  await expect(banner).toHaveAttribute("data-tone", "refused")
  await expect(banner).toHaveText("Routing unavailable: key refused")

  await page.unroute("**/waste-api/routing/quota")
  await page.route("**/waste-api/routing/quota", answer([reading(), reading({ family: "optimisation", remaining: 412, limit: 500 })]))
  const read = page.waitForResponse("**/waste-api/routing/quota")
  await page.reload()
  await read
  await expect(page.getByRole("tab", { name: "Routes" })).toBeVisible()
  await expect(banner).toHaveCount(0)
})

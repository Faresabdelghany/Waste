import type { APIRequestContext } from "@playwright/test"

import { dayIn } from "./dispatched-route"
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf } from "./routes-support"
import { projectNamed, TESTER_PROJECT } from "./tester"

// The address → zone read on the API (O29 of #290, row 1.13). The run draws a
// citizens' zone (a planning area of purpose `notification`) somewhere no
// other run's area is, and a property inside it. The property's details read
// its zone from `GET /properties/:id/zones` and name it; the same point asked
// of `GET /planning-areas/containing` answers the same zone, and a property
// with no point lies in none. Everything is made for the run, uniquely named,
// and never cleaned up.

type Named = { id: string; name: string }
type Zones = { on: string; purpose: string; items: { id: string; code: string; name: string }[] }

const made = async <T>(api: APIRequestContext, path: string, data: unknown): Promise<T> => {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

test("a property's details name the citizens' zone its point lies in today, and the same point asked alone answers it too", async ({ api, page }) => {
  test.setTimeout(90_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const today = dayIn("Europe/Copenhagen")
  // A square of about a hundred metres at a spot drawn for the run, far from the seed's areas.
  const [lng, lat] = [9 + Math.random() * 1.5, 56 + Math.random() * 1.2].map((value) => Math.round(value * 10_000) / 10_000)
  const d = 0.001
  const square = { type: "Polygon", coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] }
  const code = uniqueName("E2E-ZONE").replace(/\s+/g, "-").toUpperCase()
  const zone = await made<Named & { code: string }>(api, "/planning-areas", { projectId: project.id, code, name: uniqueName("E2E Zone"), purpose: "notification", boundary: { boundary: square, validFrom: today } })
  const placed = await made<Named>(api, "/properties", { projectId: project.id, name: uniqueName("E2E Zoned property"), address: "Skovvej 3, 8600 Silkeborg", kind: "residential", location: { type: "Point", coordinates: [lng, lat] } })
  const unplaced = await made<Named>(api, "/properties", { projectId: project.id, name: uniqueName("E2E Unplaced property"), address: "Skovvej 5, 8600 Silkeborg", kind: "residential" })

  // The API: the property's zones, the point's, and none for a property with no point.
  const own = (await (await api.get(`/properties/${placed.id}/zones`)).json()) as Zones
  expect([own.on, own.purpose, own.items.map((item) => item.id)]).toEqual([today, "notification", [zone.id]])
  const alone = await api.get(`/planning-areas/containing?projectId=${project.id}&lng=${lng}&lat=${lat}`)
  expect(alone.status(), await alone.text()).toBe(200)
  expect(((await alone.json()) as Zones).items.map((item) => item.id)).toEqual([zone.id])
  expect(((await (await api.get(`/properties/${unplaced.id}/zones`)).json()) as Zones).items).toEqual([])

  // The web: the property's details read the zone and name it.
  const read = answerOf(page, "GET", `/properties/${placed.id}/zones`)
  await page.goto(`/customers?module=properties&record=property-${placed.id}`)
  expect((await read).status()).toBe(200)
  const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("place-commands") })
  await expect(sheet.getByTestId("property-zones")).toContainText(`Notification zone on ${today}: ${zone.name} (${zone.code}).`, { timeout: 30_000 })
})

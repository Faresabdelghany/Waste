import type { APIRequestContext } from "@playwright/test"

import { dayIn, dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { expect, freshContext, signIn, test } from "./fixtures"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// Septic-tank emptying on the API (M11 of #293). The office's run: a house of
// its own with a tank's container placed there under a subscription, the
// Tanks section of the house's details registers the tank on that container
// and says when its next emptying is due, as the API reckons it, then records
// an inspection, which the tank lists. The driver's run: the office registers
// a tank on the first stop's container of a route dispatched to the seeded
// driver, whose stop then names the tank, and the litres the driver records
// are a `record-volume` the door applied. Everything the office's run makes
// is its own and uniquely named; the driver's tank is ended once the run is
// done, so the seed's routes plan its container as before.

type Named = { id: string; name: string }
type Tank = { id: string; containerId: string; validFrom: string; validTo: string | null; dueOn: string | null; lastEmptiedOn: string | null }
type Inspection = { id: string; inspectedOn: string; outcome: string; findings: string | null; nextInspectionOn: string | null }
type RouteStop = { id: string; position: number; sequence?: number; containerId: string | null; propertyId: string | null }
type Receipt = { id: string; kind: string; outcome: string; pickupId: string | null; body: { volumeLitres?: number } }

const made = async <T>(api: APIRequestContext, path: string, data: unknown): Promise<T> => {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

const daysAfter = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

test("the office registers a tank on the container at a house, reads when it is next due, and records an inspection", async ({ api, page }) => {
  test.setTimeout(120_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const today = dayIn("Europe/Copenhagen")
  const householder = await made<Named>(api, "/customers", { kind: "person", name: uniqueName("E2E Tank owner") })
  const house = await made<Named>(api, "/properties", { projectId: project.id, name: uniqueName("E2E Tank house"), address: "Slamvej 1, 4000 Roskilde", kind: "residential", parties: [{ customerId: householder.id, role: "owner" }] })
  const product = await made<Named>(api, "/products", { projectId: project.id, name: uniqueName("E2E Tank emptying"), kind: "container-collection", unit: "pickup", status: "active" })
  const agreement = await made<Named>(api, "/agreements", {
    projectId: project.id,
    number: uniqueName("AGR-E2E-TANK").replace(/\s+/g, "-"),
    customerId: householder.id,
    payerCustomerId: householder.id,
    status: "active",
    billingCadence: "annual",
    currency: "DKK",
    validFrom: today,
  })
  const subscription = await made<Named>(api, `/agreements/${agreement.id}/subscriptions`, { productId: product.id, propertyId: house.id, validFrom: today })
  const tankType = await made<Named>(api, "/container-types", { name: uniqueName("E2E Septic tank 3,000 L"), volumeLitres: 3000 })
  const sludge = (await listAll<Named & { key: string }>(api, "/waste-fractions")).find((fraction) => fraction.key === "residual")
  expect(sludge, "the seed holds the residual fraction").toBeTruthy()
  const warehouse = (await listAll<Named>(api, "/warehouses")).find((row) => row.name === "Nordhavn Warehouse")
  expect(warehouse, "the seed holds Nordhavn Warehouse").toBeTruthy()
  const label = uniqueName("TANK").replace(/\s+/g, "-")
  const container = await made<Named & { label: string }>(api, "/containers", { projectId: project.id, label, containerTypeId: tankType.id })
  await made(api, `/containers/${container.id}/receive`, { warehouseId: warehouse!.id })
  await made(api, `/containers/${container.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: sludge!.id, validFrom: today })
  const lastEmptied = daysAfter(today, -400)

  await page.goto(`/customers?module=properties&record=property-${house.id}`)
  const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("place-commands") })
  const tanks = sheet.getByTestId("property-tanks")
  await expect(tanks).toContainText("No septic tank, holding tank or separator is registered here.", { timeout: 30_000 })

  // Register tank: the container serving the house, what it holds, every two years, last emptied before the platform.
  await tanks.getByRole("button", { name: "Register tank…" }).click()
  const register = page.getByRole("dialog", { name: `Register a tank at ${house.name}` })
  await register.getByLabel("Container").click()
  await page.getByRole("option", { name: label }).click()
  await register.getByLabel("Volume (litres)").fill("3000")
  await register.getByLabel("Emptied every (months)").fill("24")
  await register.getByLabel("Last emptied (before the platform)").fill(lastEmptied)
  await register.getByRole("button", { name: "Register tank" }).click()
  await expect(register).toBeHidden()

  // The API's reckoning, said back: two years after the last emptying.
  const [tank] = await listAll<Tank>(api, "/tank-installations", { propertyId: house.id })
  expect([tank?.containerId, tank?.lastEmptiedOn, tank?.validFrom]).toEqual([container.id, lastEmptied, today])
  const item = tanks.getByTestId("tank")
  await expect(item).toContainText("Septic tank · 3,000 L · outlet to a soakaway")
  await expect(item.getByTestId("tank-due")).toHaveText(`Next emptying due ${tank!.dueOn}`)
  await expect(item.getByTestId("tank-last-emptying")).toHaveText(`Last emptied ${lastEmptied}, before the platform`)

  // An inspection with remarks, listed under the tank.
  await item.getByRole("button", { name: "Record inspection…" }).click()
  const inspection = page.getByRole("dialog", { name: "Record an inspection" })
  await inspection.getByLabel("Outcome").click()
  await page.getByRole("option", { name: "Remarks" }).click()
  await inspection.getByLabel("Findings").fill("Baffle cracked")
  await inspection.getByLabel("Next inspection").fill(daysAfter(today, 365))
  await inspection.getByRole("button", { name: "Record inspection" }).click()
  await expect(inspection).toBeHidden()
  await expect(item.getByTestId("tank-inspections")).toContainText(`${today} · Remarks — Baffle cracked · next ${daysAfter(today, 365)}`)
  const recorded = await listAll<Inspection>(api, `/tank-installations/${tank!.id}/inspections`)
  expect(recorded.map((row) => [row.inspectedOn, row.outcome, row.findings, row.nextInspectionOn])).toEqual([[today, "remarks", "Baffle cracked", daysAfter(today, 365)]])
})

test("a driver's stop at a tank names the tank, and the litres recorded there are a record-volume the door applied", async ({ api, browser }) => {
  test.setTimeout(120_000)
  const { route } = await dispatchedRouteFor(api)
  const detail = (await (await api.get(`/routes/${route.id}`)).json()) as { pickups: RouteStop[] }
  const [first] = [...detail.pickups].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position))
  if (first?.containerId == null || first.propertyId === null) throw new Error(`${route.label}'s first stop needs a container at a property`)

  // The first stop's container stands for a tank on the route's day: this run's, or one an earlier run of the day left.
  const standing = await listAll<Tank>(api, "/tank-installations", { containerId: first.containerId, validOn: route.serviceDate })
  const tank =
    standing[0] ??
    (await made<Tank>(api, "/tank-installations", { propertyId: first.propertyId, containerId: first.containerId, kind: "septic-tank", volumeLitres: 3000, outlet: "soakaway", emptyingIntervalMonths: 12, validFrom: route.serviceDate }))

  const context = await freshContext(browser, { viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await signIn(page, SEEDED_DRIVER.email, E2E.loginPassword)
    await expect(page).toHaveURL(/\/driver$/)
    const card = page.getByRole("article", { name: `Route ${route.label}` })
    await card.getByRole("button", { name: "Start route" }).click()
    await expect(card.getByText("Active", { exact: true })).toBeVisible()
    await card.getByRole("link", { name: "Open route" }).click()

    const stop = page.getByRole("article", { name: "Stop 1", exact: true })
    await expect(stop.getByRole("note", { name: "Tank" })).toHaveText("Septic tank · 3,000 L · outlet to a soakaway")
    await stop.getByRole("button", { name: "Volume" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Litres pumped").fill("2800")
    await dialog.getByRole("button", { name: "Record volume" }).click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(async () => (await listAll<Receipt>(api, `/routes/${route.id}/commands`)).filter((receipt) => receipt.kind === "record-volume" && receipt.pickupId === first.id).map((receipt) => [receipt.outcome, receipt.body.volumeLitres]), { timeout: 30_000 })
      .toEqual([["applied", 2800]])
  } finally {
    await context.close()
    await api.post(`/routes/${route.id}/cancel`, { data: { reasonCode: "other", reason: "Tank scenario done" } })
    // The seed's routes plan the container as before: the tank ends the day after.
    await api.patch(`/tank-installations/${tank.id}`, { data: { validTo: daysAfter(tank.validFrom, 1) } })
  }
})

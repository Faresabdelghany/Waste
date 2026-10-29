import type { Locator, Page } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { listAll } from "./tester"

// Weight to billing on the Pilot (O28 of #290, C32 of #291). A skip is sold
// by the tonne: the office makes a product per tonne priced on the project's
// default list, an agreement whose subscription is that product at a property
// of its own, and a container of its own placed under it. It puts the skip
// on a dispatched route (Add stop's request), the seeded driver collects it
// and ends the day, and the office captures the weighbridge ticket. Approved
// in Weight control, the worker's Finance consumer charges the stop the whole
// net at the tonne's price; the event's details read it as a Weight charge
// with its kilograms and the weighed load's amount. Every name is this run's,
// so nothing meets an earlier run's on a long-lived stack.

type Named = { id: string; name: string }
type Unload = { id: string; netKg: number }
type BillableEvent = { id: string; kind: string; status: string; weightKg: number | null; unitPriceMinor: number | null; netMinor: number | null; links: { pickupId: string | null; unloadId: string | null } }

/** The tonne's price: 512.50 kr. */
const RATE = 51_250
/** What the skip weighed at the weighbridge, and what the stop is charged: 2,480 kg at 512.50 kr is 1,271.00 kr. */
const NET_KG = 2_480
const CHARGED = 127_100

/** A day `offset` days from today on the UTC calendar. */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

/** The browser's API call a press makes: the answer of the request path `path`, method `method`. */
const answerOf = (page: Page, method: string, path: RegExp) => page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** A dialog by its heading: the details sheet and a form dialog may both be open. */
const dialogTitled = (page: Page, title: string) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) })

/** A fact's row in a record's details, by its label. */
const factOf = (details: Locator, label: string) => details.getByText(label, { exact: true }).locator("xpath=../..")

/** One command as the Driver App queues it. */
const commandOf = (kind: string, routeId: string, body: Record<string, unknown>, at: Date) => ({
  id: mintId(at.getTime(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))),
  kind,
  routeId,
  occurredAt: at.toISOString(),
  deviceId: "e2e-weight-charges",
  body,
})

test("a skip sold by the tonne, collected and weighed, is charged its reviewed weight once the office approves it in Weight control", async ({ page, api, browser }) => {
  test.setTimeout(180_000)
  const made = async <T>(path: string, data: unknown): Promise<T> => {
    const response = await api.post(path, { data })
    expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
    return (await response.json()) as T
  }
  const { route } = await dispatchedRouteFor(api)
  if (route.planned.vehicleId === null) throw new Error(`${route.label} was dispatched with no vehicle`)
  const projectId = route.projectId

  // The office's ground: a product per tonne priced on the default list, an agreement, a subscription, a skip placed under it.
  const residual = (await listAll<Named & { key: string }>(api, "/waste-fractions")).find((fraction) => fraction.key === "residual")
  const station = (await listAll<Named & { wasteFractionIds: string[] }>(api, "/unloading-stations")).find((candidate) => residual !== undefined && candidate.wasteFractionIds.includes(residual.id))
  const [containerType] = await listAll<Named>(api, "/container-types")
  const [warehouse] = await listAll<Named>(api, "/warehouses", { projectId })
  const defaultList = (await listAll<Named & { isDefault: boolean }>(api, "/price-lists", { projectId })).find((list) => list.isDefault)
  if (residual === undefined || station === undefined || containerType === undefined || warehouse === undefined || defaultList === undefined) throw new Error("the seed lacks a residual fraction, a station taking it, a container type, a warehouse or a default price list")
  const product = await made<Named>("/products", { projectId, name: uniqueName("E2E Skip per tonne"), kind: "container-collection", unit: "tonne", status: "active", vatPercent: 25 })
  await made(`/price-lists/${defaultList.id}/rows`, { productId: product.id, unitPriceMinor: RATE, validFrom: day(-30), validTo: null })
  const customer = await made<Named>("/customers", { kind: "organisation", name: uniqueName("E2E Builders") })
  const property = await made<Named>("/properties", { projectId, name: uniqueName("E2E Building site"), address: "Kalkbrænderihavnsgade 2, 2100 København Ø", kind: "commercial" })
  const agreement = await made<{ id: string; number: string }>("/agreements", { projectId, number: uniqueName("E2E-TONNE").replace(/\s+/g, "-").toUpperCase(), customerId: customer.id, payerCustomerId: customer.id, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: day(-30), validTo: null })
  const subscription = await made<{ id: string }>(`/agreements/${agreement.id}/subscriptions`, { productId: product.id, propertyId: property.id, validFrom: day(-30), validTo: null })
  const skip = await made<Named>("/containers", { projectId, label: uniqueName("E2E-SKIP"), containerTypeId: containerType.id })
  await made(`/containers/${skip.id}/receive`, { warehouseId: warehouse.id, occurredAt: new Date(Date.now() - 3_600_000).toISOString() })
  await made(`/containers/${skip.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: residual.id, validFrom: day(-30), occurredAt: new Date(Date.now() - 3_000_000).toISOString() })

  try {
    // The skip on the dispatched route, as Add stop asks for it.
    const stop = await made<{ id: string }>(`/routes/${route.id}/pickups`, { containerId: skip.id })

    // The driver collects it and ends the day.
    const context = await freshContext(browser)
    try {
      const driverPage = await context.newPage()
      await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
      const token = await accessTokenOf(context)
      if (token === null) throw new Error("the driver's browser holds no API session")
      const asDriver = await apiAs(token)
      try {
        const start = Date.now() - 300_000
        const commands = [
          commandOf("start-route", route.id, { vehicleId: route.planned.vehicleId }, new Date(start)),
          commandOf("complete-pickup", route.id, { pickupId: stop.id }, new Date(start + 1_000)),
          commandOf("end-route", route.id, {}, new Date(start + 2_000)),
        ]
        const sent = await asDriver.post("/driver/commands", { data: { commands } })
        expect(sent.status(), await sent.text()).toBe(200)
        expect(((await sent.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied", "applied"])
      } finally {
        await asDriver.dispose()
      }
    } finally {
      await context.close()
    }

    // The office captures the weighbridge ticket after the collection.
    const ticket = `WB-E2E-${Date.now().toString(36)}`.toUpperCase()
    const unload = await made<Unload>(`/routes/${route.id}/unloads`, { unloadingStationId: station.id, wasteFractionId: residual.id, netKg: NET_KG, weighbridgeTicket: ticket, occurredAt: new Date(Date.now() - 60_000).toISOString() })

    // Approved in Weight control.
    const loaded = answerOf(page, "GET", /^\/unloads$/)
    await page.goto(`/route-studio?module=weights&record=unload-${unload.id}`)
    expect((await loaded).status()).toBe(200)
    const details = page.getByRole("dialog").filter({ has: page.getByTestId("weight-review-commands") })
    await details.getByTestId("weight-review-commands").getByRole("button", { name: "Approve" }).click()
    const [approved] = await Promise.all([answerOf(page, "POST", new RegExp(`^/unloads/${unload.id}/approve$`)), dialogTitled(page, "Approve weight").getByRole("button", { name: "Approve" }).click()])
    expect(approved.status(), await approved.text()).toBe(201)

    // The worker charges the stop the whole net at the tonne's price.
    const chargeOf = async () => (await listAll<BillableEvent>(api, "/billable-events", { projectId, kind: "weight", routeId: route.id })).find((event) => event.links.unloadId === unload.id)
    await expect.poll(async () => (await chargeOf())?.status, { timeout: 60_000 }).toBe("ready")
    const charge = (await chargeOf())!
    expect([charge.links.pickupId, charge.weightKg, charge.unitPriceMinor, charge.netMinor]).toEqual([stop.id, NET_KG, CHARGED, CHARGED])

    // Its details read it as a Weight charge with its kilograms.
    const events = answerOf(page, "GET", /^\/billable-events$/)
    await page.goto(`/commercial?module=events&record=event-${charge.id}`)
    expect((await events).status()).toBe(200)
    const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("event-commands") })
    await expect(factOf(sheet, "Kind")).toContainText("Weight charge")
    await expect(factOf(sheet, "Weight")).toContainText("2,480 kg")
    await expect(factOf(sheet, "Origin")).toContainText("Reviewed weight charged by the tonne")
    await expect(factOf(sheet, "Product")).toContainText(product.name)
  } finally {
    // The driver holds one open session at a time; the route was ended, and a cancel of an ended route changes nothing.
    await api.post(`/routes/${route.id}/cancel`, { data: { reasonCode: "other", reason: "Ended by the weight charges end-to-end test" } })
  }
})

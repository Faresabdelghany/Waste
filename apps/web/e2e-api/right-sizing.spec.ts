// Right-sizing on the web (M23b of #293). A customer of this run's own, a
// subscription to the largest residual bin the seed's rear loader lifts, with
// one half its size sold beside it on a frequency of the run's own, and the
// bin placed under it; the seeded driver empties it four times
// today on the office's own routes, each time saying it was a quarter full
// or less. Customers › Right-sizing's Propose now makes the proposal — a size
// down to the half-size product — and the office approves it from tomorrow:
// the browser's body is the day and the suggested product, and the
// subscription is replaced from that day with the smaller product. Every row
// is the run's own, uniquely named and never cleaned up; each route is ended
// by the driver.
import type { APIRequestContext, Browser } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { addDays, dayIn, driverNamed, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, toasts } from "./routes-support"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

type Named = { id: string; name: string }
type Proposal = { id: string; direction: string; suggestedProductId: string | null; status: string; replacementSubscriptionId: string | null }
type Subscription = { id: string; productId: string; validFrom: string; validTo: string | null }

const fail = (why: string): never => {
  throw new Error(why)
}
const commandId = () => mintId(Date.now(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES)))

async function made<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

/** The seeded driver runs `routeIds` one after another: started, the bin's fill said, ended. */
async function driven(browser: Browser, runs: { routeId: string; pickupId: string; vehicleId: string; fill: string }[]) {
  const context = await freshContext(browser)
  try {
    const page = await context.newPage()
    await signIn(page, SEEDED_DRIVER.email, E2E.loginPassword)
    const asDriver = await apiAs((await accessTokenOf(context)) ?? fail("the driver's browser holds no API session"))
    try {
      for (const run of runs) {
        const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
        const envelope = (kind: string, body: unknown, occurredAt: string) => ({ id: commandId(), kind, routeId: run.routeId, occurredAt, deviceId: "e2e-right-sizing", body })
        const sent = await asDriver.post("/driver/commands", {
          data: { commands: [envelope("start-route", { vehicleId: run.vehicleId }, at(0)), envelope("complete-pickup", { pickupId: run.pickupId }, at(1_000)), envelope("record-fill", { pickupId: run.pickupId, fill: run.fill }, at(2_000)), envelope("end-route", {}, at(3_000))] },
        })
        expect(sent.status()).toBe(200)
        expect(((await sent.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied", "applied", "applied"])
      }
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }
}

test("a bin the drivers empty a quarter full is proposed a size down, and approved into the subscription's change from tomorrow (M23b of #293)", async ({ page, api, browser }) => {
  test.setTimeout(180_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const today = dayIn("Europe/Copenhagen")
  const tag = uniqueName("E2E RS")
  const residual = (await listAll<Named & { key: string }>(api, "/waste-fractions")).find((fraction) => fraction.key === "residual") ?? fail("the seed has no residual fraction")
  // The bin is of a type WH-24's rear loader lifts, the largest the seed has; the size down is a type of the run's own, half of it, sold and never lifted.
  const vehicle = (await listAll<{ id: string; callsign: string | null; vehicleTypeId: string }>(api, "/vehicles")).find((candidate) => candidate.callsign === "WH-24") ?? fail("the seed has no WH-24")
  const lifted = ((await (await api.get(`/vehicle-types/${vehicle.vehicleTypeId}`)).json()) as { containerTypeIds: string[] }).containerTypeIds
  const types = await listAll<Named & { volumeLitres: number | null }>(api, "/container-types")
  const big = types.filter((type) => lifted.includes(type.id) && type.volumeLitres !== null).sort((a, b) => (b.volumeLitres ?? 0) - (a.volumeLitres ?? 0))[0] ?? fail("WH-24 lifts no container type of a known size")
  const half = Math.max(1, Math.floor((big.volumeLitres ?? 2) / 2))
  const small = await made<Named>(api, "/container-types", { name: `${tag} ${half} L`, volumeLitres: half })
  // A frequency of the run's own: a size is suggested among the products of the same frequency, so no earlier run's product is nearer.
  const frequency = await made<Named>(api, "/service-frequencies", { projectId: project.id, name: tag, collectionsPerWeek: 1 })
  const product = (type: Named, litres: number) => made<Named>(api, "/products", { projectId: project.id, name: `${tag} residual ${litres} L`, kind: "container-collection", unit: "pickup", containerTypeId: type.id, wasteFractionId: residual.id, serviceFrequencyId: frequency.id, status: "active" })
  const [current, smaller] = [await product(big, big.volumeLitres ?? 0), await product(small, half)]
  const customer = await made<Named>(api, "/customers", { kind: "organisation", name: tag })
  const property = await made<Named>(api, "/properties", { projectId: project.id, name: `${tag} Allé 1`, address: `${tag} Allé 1, 2100 København Ø`, kind: "residential" })
  const agreement = await made<Named>(api, "/agreements", { projectId: project.id, number: tag.replace(/\W+/g, "-").toUpperCase(), customerId: customer.id, payerCustomerId: customer.id, billingCadence: "monthly", currency: "DKK", validFrom: today })
  const subscription = await made<Subscription>(api, `/agreements/${agreement.id}/subscriptions`, { productId: current.id, propertyId: property.id, validFrom: today })
  const warehouse = (await listAll<Named & { projectId: string; status: string }>(api, "/warehouses")).find((candidate) => candidate.projectId === project.id && candidate.status === "active") ?? fail("the seed has no active warehouse in Copenhagen")
  const bin = await made<Named>(api, "/containers", { projectId: project.id, label: tag.replace(/\W+/g, "-").toUpperCase(), containerTypeId: big.id })
  await made(api, `/containers/${bin.id}/receive`, { warehouseId: warehouse.id })
  await made(api, `/containers/${bin.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: residual.id, validFrom: today })

  // Four collections of the bin today, on the office's own routes, each a quarter full or less.
  const driver = await driverNamed(api, SEEDED_DRIVER.name)
  const runs: { routeId: string; pickupId: string; vehicleId: string; fill: string }[] = []
  for (const fill of ["quarter", "empty", "quarter", "half"]) {
    const route = await made<{ id: string }>(api, "/routes", { projectId: project.id, operatingDate: today, vehicleId: vehicle.id, driverId: driver.id, acceptSameDay: true })
    const stop = await made<{ id: string }>(api, `/routes/${route.id}/pickups`, { containerId: bin.id })
    const dispatched = await api.post(`/routes/${route.id}/dispatch`, { data: {} })
    expect(dispatched.status(), await dispatched.text()).toBe(200)
    runs.push({ routeId: route.id, pickupId: stop.id, vehicleId: vehicle.id, fill })
  }
  await driven(browser, runs)

  // Propose now, then the proposal's details: a size down to the half-size product, approved from tomorrow.
  const loaded = answerOf(page, "GET", "/right-sizing-proposals")
  await page.goto("/customers?module=right-sizing")
  expect((await loaded).status()).toBe(200)
  const [ran] = await Promise.all([answerOf(page, "POST", "/right-sizing-proposals/run"), page.getByRole("button", { name: "Propose now" }).click()])
  expect(ran.status(), await ran.text()).toBe(200)
  await expect(toasts(page)).toContainText(/proposals? made/)
  const proposal = ((await (await api.get(`/right-sizing-proposals?subscriptionId=${subscription.id}`)).json()) as { items: Proposal[] }).items[0] ?? fail("no proposal for the run's subscription")
  expect([proposal.direction, proposal.suggestedProductId]).toEqual(["smaller", smaller.id])

  await page.goto(`/customers?module=right-sizing&record=right-sizing-proposal-${proposal.id}`)
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("right-sizing-commands") })
  await expect(details).toContainText("a quarter full")
  const approve = details.getByTestId("right-sizing-commands").getByRole("button", { name: "Approve" })
  await expect(approve).toBeEnabled({ timeout: 30_000 })
  await approve.click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Approve right-sizing" }) })
  const tomorrow = addDays(today, 1)
  await dialog.getByLabel(/^From/).fill(tomorrow)
  await expect(dialog.getByRole("combobox", { name: /^Product/ })).toContainText(smaller.name)
  const [approved] = await Promise.all([answerOf(page, "POST", `/right-sizing-proposals/${proposal.id}/approve`), dialog.getByRole("button", { name: "Approve" }).click()])
  expect(approved.status(), await approved.text()).toBe(200)
  expect(approved.request().postDataJSON()).toEqual({ on: tomorrow, productId: smaller.id })
  await expect(details.getByTestId("right-sizing-commands").getByRole("button")).toHaveCount(0)

  const decided = (await approved.json()) as Proposal
  const replacement = (await (await api.get(`/subscriptions/${decided.replacementSubscriptionId}`)).json()) as Subscription
  expect([replacement.productId, replacement.validFrom]).toEqual([smaller.id, tomorrow])
  expect(((await (await api.get(`/subscriptions/${subscription.id}`)).json()) as Subscription).validTo).toBe(tomorrow)
})

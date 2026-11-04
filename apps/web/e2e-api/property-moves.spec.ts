import type { APIRequestContext } from "@playwright/test"

import { dayIn } from "./dispatched-route"
import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { answerOf } from "./routes-support"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// Move occupant on the API (#374, #291 C11). The run registers a tenant at a
// property of its own with an agreement and a subscription there, and a
// customer to move in. A move from today is not one — the tenant's role began
// today — so it is booked a week ahead: Review asks the API's dry run and says
// what ends and what begins, Move makes it, and the property's details then
// name it as Booked ahead while today's tenant is still the tenant. The API
// says the same: the incoming customer holds the role from the day, and the
// incoming agreement begins then. Everything is made for the run, uniquely
// named, and never cleaned up.

type Named = { id: string; name: string }
type Party = { customerId: string; role: string; validFrom: string; validTo: string | null }
type PropertyRead = Named & { parties: Party[] }
type AgreementRead = { id: string; number: string; customerId: string; validFrom: string; validTo: string | null }

const made = async <T>(api: APIRequestContext, path: string, data: unknown): Promise<T> => {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

/** A day `days` after `day`, both `YYYY-MM-DD`. */
const daysAfter = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

test("Move occupant reviews the move through the API's dry run, makes it, and the property's details name it as booked ahead", async ({ api, page }) => {
  test.setTimeout(120_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const today = dayIn("Europe/Copenhagen")
  const on = daysAfter(today, 7)
  const leaving = await made<Named>(api, "/customers", { kind: "person", name: uniqueName("E2E Leaving tenant") })
  const arriving = await made<Named>(api, "/customers", { kind: "person", name: uniqueName("E2E Arriving tenant") })
  const property = await made<Named>(api, "/properties", {
    projectId: project.id,
    name: uniqueName("E2E Moving house"),
    address: "Flyttevej 1, 2100 København Ø",
    kind: "residential",
    parties: [{ customerId: leaving.id, role: "tenant" }],
  })
  const product = await made<Named>(api, "/products", { projectId: project.id, name: uniqueName("E2E Move collection"), kind: "container-collection", unit: "pickup", status: "active" })
  const outgoing = await made<AgreementRead>(api, "/agreements", {
    projectId: project.id,
    number: uniqueName("AGR-E2E-OUT").replace(/\s+/g, "-"),
    customerId: leaving.id,
    payerCustomerId: leaving.id,
    status: "active",
    billingCadence: "monthly",
    currency: "DKK",
    validFrom: today,
  })
  await made(api, `/agreements/${outgoing.id}/subscriptions`, { productId: product.id, propertyId: property.id, validFrom: today })
  const number = uniqueName("AGR-E2E-IN").replace(/\s+/g, "-")

  await page.goto(`/customers?module=properties&record=property-${property.id}`)
  const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("place-commands") })
  await sheet.getByTestId("property-move").getByRole("button", { name: "Move occupant…" }).click()
  const dialog = page.getByTestId("move-dialog")
  await dialog.getByLabel("Moves in on").fill(on)
  await dialog.getByLabel("Moving out").click()
  await page.getByRole("option", { name: leaving.name }).click()
  await dialog.getByLabel("Moving in").click()
  await page.getByRole("option", { name: arriving.name }).click()
  await dialog.getByLabel("New agreement number").fill(number)

  // Review is the API's dry run: nothing written, the move said back.
  const rehearsed = answerOf(page, "POST", `/properties/${property.id}/moves`)
  await dialog.getByRole("button", { name: "Review" }).click()
  const rehearsal = await rehearsed
  expect(rehearsal.status(), await rehearsal.text()).toBe(200)
  expect(((await rehearsal.json()) as { dryRun: boolean }).dryRun).toBe(true)
  const review = dialog.getByTestId("move-review")
  await expect(review).toContainText(`From ${on} ${arriving.name} is the property's tenant.`)
  await expect(review).toContainText(`${outgoing.number} of ${leaving.name} ends on ${on}, its 1 subscription here with it.`)
  await expect(review).toContainText(`${number} begins on ${on} for ${arriving.name}, with 1 subscription.`)
  expect(((await (await api.get(`/properties/${property.id}`)).json()) as PropertyRead).parties.map((party) => party.customerId)).toEqual([leaving.id])

  // Move makes it, and the details say it is booked ahead while today's tenant stays.
  const moving = answerOf(page, "POST", `/properties/${property.id}/moves`)
  await dialog.getByRole("button", { name: "Move", exact: true }).click()
  expect((await moving).status()).toBe(200)
  await expect(dialog).toBeHidden()
  await expect(sheet).toContainText(`${leaving.name} leaves as tenant on ${on} · ${arriving.name} joins as tenant on ${on}`, { timeout: 30_000 })

  // The API agrees: the roles change hands on the day, and the incoming agreement begins then.
  const after = (await (await api.get(`/properties/${property.id}`)).json()) as PropertyRead
  expect(after.parties.map((party) => [party.customerId, party.role, party.validFrom, party.validTo]).sort()).toEqual(
    [
      [leaving.id, "tenant", today, on],
      [arriving.id, "tenant", on, null],
    ].sort(),
  )
  const incoming = (await listAll<AgreementRead>(api, "/agreements", { validOn: on })).find((candidate) => candidate.number === number)
  expect([incoming?.customerId, incoming?.validFrom, incoming?.validTo]).toEqual([arriving.id, on, null])
})

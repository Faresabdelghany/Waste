import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// Recycling-centre visits on the Pilot (#393 M4a), by API calls alone: the
// pages are M4b's. The office registers a recycling centre, a product sold
// per visit priced on the project's default list, a Visit Rule charging a
// business's visit at it, and a business's plate under one of the seeded
// agreements. The attendant's check-in admits the plate and answers what the
// visit costs; an unknown plate is turned away and still recorded. The
// worker's Finance consumer charges the admitted visit as a `visit` event at
// the product, and the visit's void cancels it.
//
// The stack lives across runs and one Visit Rule is in force per project at
// a time, so the rule holds one day alone, one no rule of an earlier run
// covers, inside the agreement's period; the product, the plate and the
// centre are this run's. The day lies in the past, which a check-in's
// instant may.

type Rule = { id: string; validFrom: string; validTo: string | null }
type Agreement = { id: string; customerId: string; status: string; priceListId: string | null; validFrom: string; validTo: string | null }
type Visit = { id: string; outcome: string; refusalReason: string | null; customerId: string | null; agreementId: string | null; voidedAt: string | null }
type CheckIn = { visit: Visit; charge: { basis: string; productId: string | null; price: { netMinor: number; currency: string } | null } | null }
type Event = { id: string; kind: string; status: string; cancelReason: string | null; netMinor: number | null; links: { visitId: string | null } }

const dayAfter = (day: string, days = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

test("the attendant's check-in admits a business's plate and answers its charge, the worker charges the visit, and its void cancels the charge", async ({ api }) => {
  test.setTimeout(120_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const today = new Date().toISOString().slice(0, 10)

  // A day inside the period of an active agreement priced under the project's default list, two days back at the least, that no Visit Rule of the project covers.
  const agreements = (await listAll<Agreement>(api, "/agreements", { projectId: project.id })).filter((agreement) => agreement.status === "active" && agreement.priceListId === null)
  const rules = await listAll<Rule>(api, "/visit-rules", { projectId: project.id })
  const covered = (day: string) => rules.some((rule) => rule.validFrom <= day && (rule.validTo === null || day < rule.validTo))
  let chosen: { agreement: Agreement; day: string } | undefined
  for (const agreement of agreements) {
    for (let back = 2; back < 400 && chosen === undefined; back += 1) {
      const day = dayAfter(today, -back - Math.floor(Math.random() * 3))
      if (day >= agreement.validFrom && (agreement.validTo === null || dayAfter(day) < agreement.validTo) && !covered(day)) chosen = { agreement, day }
    }
    if (chosen !== undefined) break
  }
  if (chosen === undefined) throw new Error(`no day of an active agreement of ${project.name} is free of a Visit Rule`)
  const { agreement, day } = chosen

  const [fraction] = await listAll<{ id: string }>(api, "/waste-fractions")
  if (fraction === undefined) throw new Error("the seed holds no waste fraction")
  const centre = await api.post("/drop-off-points", {
    data: {
      projectId: project.id,
      code: uniqueName("GS-E2E").replaceAll(" ", "-"),
      name: uniqueName("E2E Recycling Centre"),
      kind: "recycling-centre",
      address: "Kraftværksvej 31, 2300 København S",
      location: { type: "Point", coordinates: [12.6105, 55.6521] },
      status: "active",
      wasteFractionIds: [fraction.id],
    },
  })
  expect(centre.status(), await centre.text()).toBe(201)
  const siteId = ((await centre.json()) as { id: string }).id

  const made = await api.post("/products", { data: { projectId: project.id, name: uniqueName("E2E Business visit"), kind: "additional-service", status: "active", unit: "visit", vatPercent: 25 } })
  expect(made.status(), await made.text()).toBe(201)
  const productId = ((await made.json()) as { id: string }).id
  const [list] = (await listAll<{ id: string; isDefault: boolean; validFrom: string }>(api, "/price-lists", { projectId: project.id })).filter((candidate) => candidate.isDefault && candidate.validFrom <= day)
  if (list === undefined) throw new Error(`${project.name} has no default price list in force on ${day}`)
  const row = await api.post(`/price-lists/${list.id}/rows`, { data: { productId, unitPriceMinor: 15_000, validFrom: list.validFrom } })
  expect(row.status(), await row.text()).toBe(201)

  const rule = await api.post("/visit-rules", { data: { projectId: project.id, validFrom: day, validTo: dayAfter(day), businessVisitProductId: productId } })
  expect(rule.status(), await rule.text()).toBe(201)

  const plate = `E2E-${Date.now().toString(36).toUpperCase()}`
  const credential = await api.post("/access-credentials", { data: { projectId: project.id, kind: "plate", value: plate, customerId: agreement.customerId, agreementId: agreement.id, validFrom: day, validTo: dayAfter(day) } })
  expect(credential.status(), await credential.text()).toBe(201)

  const checkIn = async (value: string) => {
    const response = await api.post("/site-visits", { data: { siteId, identifier: { kind: "plate", value }, wasteFractionIds: [fraction.id], occurredAt: `${day}T11:00:00.000Z` } })
    expect(response.status(), await response.text()).toBe(201)
    return (await response.json()) as CheckIn
  }
  const admitted = await checkIn(plate.toLowerCase())
  expect(admitted.visit).toMatchObject({ outcome: "admitted", customerId: agreement.customerId, agreementId: agreement.id })
  expect(admitted.charge).toMatchObject({ basis: "per-visit", productId, price: { netMinor: 15_000 } })
  const unknown = await checkIn(`${plate}X`)
  expect(unknown.visit).toMatchObject({ outcome: "refused", refusalReason: "unknown-identifier" })
  expect(unknown.charge).toBeNull()

  // The worker's relay and Finance consumer turn the recording into the visit's charge.
  const chargeOf = async (): Promise<Event | undefined> => (await listAll<Event>(api, "/billable-events", { projectId: project.id, productId })).find((event) => event.links.visitId === admitted.visit.id)
  await expect.poll(async () => (await chargeOf())?.status, { timeout: 60_000 }).toBe("ready")
  expect(await chargeOf()).toMatchObject({ kind: "visit", netMinor: 15_000 })

  const voided = await api.post(`/site-visits/${admitted.visit.id}/void`, { data: { reason: "Checked in at the wrong site" } })
  expect(voided.status(), await voided.text()).toBe(200)
  expect(((await voided.json()) as Visit).voidedAt).not.toBeNull()
  await expect.poll(async () => (await chargeOf())?.status, { timeout: 60_000 }).toBe("cancelled")
  expect((await chargeOf())?.cancelReason).toBe("visit-voided")
})

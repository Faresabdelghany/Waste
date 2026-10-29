// The Finance consumer's two Site Visit kinds against Postgres (#393, M4 of
// #293): visits recorded through `recordVisit`, the door the attendant's
// check-in and the gate's read share, and the handler of
// `finance.record-billable-events` run directly over their events, as
// record-billable-events.test.ts runs it over a pickup's. A household's free
// visit records nothing and its next is a `visit` event at the ladder's step,
// priced on its day under the Property's fee-paying agreement, once however
// often the event is delivered; a refused visit and a recording delivered
// after its void record nothing; a void cancels an uninvoiced charge with
// `visit-voided` and reverses an invoiced one; a step with no price row is
// blocked as any event is; and the run's line names the site and the identifier.
// Skipped with the reason when `DATABASE_URL` or `DATABASE_ADMIN_URL` is
// unset, failed under `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { BillableEvent } from "@waste/contracts/billable-events"
import type { SiteVisit, VisitIdentifier } from "@waste/contracts/site-visits"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { runBilling } from "@waste/db/commands/billing-runs"
import { eventOf, eventsFrom } from "@waste/db/commands/billing-shapes"
import { recordVisit, visitById } from "@waste/db/commands/site-visits"
import { newId } from "@waste/db/ids"
import { subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { dropOffPoint, dropOffPointFraction } from "@waste/db/schema/drop-off-points"
import { billableEvent, invoiceLine, priceListRow } from "@waste/db/schema/finance"
import { accessCredential, siteVisit, visitRule, visitRuleStep } from "@waste/db/schema/site-visits"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import { and, asc, eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import type { JobContext } from "../jobs"
import { recordBillableEvents, type PublishedEvent, type Recorded } from "../jobs/record-billable-events"
import { consumerQueue } from "../outbox/subscribe"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { dropFinanceTenant, seedFinanceTenant, testId, type FinanceTenant } from "./finance-tenant"
import { fakeRouting, settlesNothing } from "./routing-context"

const database = databaseUnderTest()
const owner = ownerUnderTest()

const NOON = new Date("2026-10-06T12:00:00Z")

describe("finance.record-billable-events over a Site Visit's events (M4 of #293)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let admin: Database
  let tenant: FinanceTenant
  let copenhagen: string
  const site = testId()
  const visit70 = testId()
  const unpriced = testId()
  const lines: string[] = []

  const context = (): JobContext => ({ api: pool, worker: pool, now: () => NOON, log: (message) => void lines.push(message), send: async () => null, complete: settlesNothing, routing: fakeRouting() })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    admin = createDb(owner.url, { max: 1 })
    tenant = await seedFinanceTenant(pool)
    copenhagen = tenant.projects.copenhagen.id
    const { companyId } = tenant
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      await tx.insert(product).values([
        { id: visit70, companyId, projectId: copenhagen, name: "Recycling centre visit", kind: "additional-service", status: "active", unit: "visit", vatPercent: 25 },
        { id: unpriced, companyId, projectId: copenhagen, name: "Unpriced visit", kind: "additional-service", status: "active", unit: "visit", vatPercent: 25 },
      ])
      await tx.insert(priceListRow).values({ id: testId(), companyId, projectId: copenhagen, priceListId: tenant.priceList.id, productId: visit70, unitPriceMinor: 7_000, validFrom: "2026-01-01" })
      await tx.insert(dropOffPoint).values({ id: site, companyId, projectId: copenhagen, code: "GS-NORD", name: "Nordhavn Recycling Centre", kind: "recycling-centre", address: "Kraftværksvej 31", location: { type: "Point", coordinates: [12.6105, 55.6521] }, status: "active" })
      await tx.insert(dropOffPointFraction).values({ id: testId(), companyId, projectId: copenhagen, dropOffPointId: site, wasteFractionId: tenant.fractions.residual.id })
      // Parkvej 18 pays for collection under the housing association's agreement; Havnegade 3 does not.
      await tx.insert(subscription).values({ id: testId(), companyId, projectId: copenhagen, agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id, propertyId: tenant.properties.parkvej.id, quantity: 1, validFrom: "2026-01-01" })
      const ruleId = testId()
      await tx.insert(visitRule).values({ id: ruleId, companyId, projectId: copenhagen, freeVisits: 1, businessVisitProductId: unpriced, validFrom: "2026-01-01" })
      await tx.insert(visitRuleStep).values({ id: testId(), companyId, projectId: copenhagen, ruleId, position: 1, productId: visit70 })
    })
  })
  after(async () => {
    await dropFinanceTenant(pool, admin, tenant.companyId)
    await pool.close()
    await admin.close()
  })

  /** Records a visit at the site through the shared door, as the attendant's check-in does, and answers it on the wire. */
  const visit = (identifier: VisitIdentifier, occurredAt: string): Promise<SiteVisit> =>
    withCompany(pool.db, tenant.companyId, async (tx: Tx) =>
      (
        await recordVisit(tx, {
          companyId: tenant.companyId,
          projectId: copenhagen,
          siteId: site,
          occurredAt: new Date(occurredAt),
          source: "staff",
          externalId: null,
          identifier,
          wasteFractionIds: [tenant.fractions.residual.id],
          note: null,
          recordedBy: tenant.users.olivia.id,
          newId,
        })
      ).visit,
    )
  /** Voids a visit as the office's route does, and answers it on the wire. */
  const voided = (id: string): Promise<SiteVisit> =>
    withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
      await tx.update(siteVisit).set({ voidedAt: NOON, voidedBy: tenant.users.olivia.id, voidReason: "Checked in twice" }).where(and(eq(siteVisit.companyId, tenant.companyId), eq(siteVisit.id, id)))
      const found = await visitById(tx, tenant.companyId, id)
      assert.ok(found)
      return found.visit
    })

  const published = (kind: OutboxKind, payload: SiteVisit, id = testId()): PublishedEvent => ({
    id,
    companyId: tenant.companyId,
    projectId: copenhagen,
    kind,
    aggregateKind: "site-visit",
    aggregateId: payload.id,
    occurredAt: payload.occurredAt,
    payload,
    publishedAt: null,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
  })

  const handle = async (event: PublishedEvent): Promise<Recorded["did"]> => {
    const consumer = recordBillableEvents.find((job) => job.queue === consumerQueue(event.kind, "finance"))
    assert.ok(consumer, `${event.kind}: no Finance entry`)
    const job: Job<PublishedEvent> = { id: testId(), name: consumer.queue, data: event, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal }
    await consumer.handler([job], context())
    const line = lines.findLast((candidate) => candidate.includes(` ${event.id} → `))
    assert.ok(line, "the consumer logged the event")
    return line.slice(line.indexOf(" → ") + 3).split(" ")[0] as Recorded["did"]
  }

  const eventsOf = (visitId: string): Promise<BillableEvent[]> =>
    withCompany(pool.db, tenant.companyId, async (tx) => (await eventsFrom(tx, tenant.companyId).query.where(and(eq(billableEvent.companyId, tenant.companyId), eq(billableEvent.visitId, visitId))).orderBy(asc(billableEvent.id))).map(eventOf))

  test("a household's free visit records nothing, and its next is a visit event at the ladder's step under its fee-paying agreement, once however often delivered", async () => {
    const first = await visit({ kind: "property", propertyId: tenant.properties.parkvej.id }, "2026-03-02T09:00:00.000Z")
    assert.equal(await handle(published("site-visit-recorded", first)), "nothing")
    const second = await visit({ kind: "property", propertyId: tenant.properties.parkvej.id }, "2026-03-03T09:00:00.000Z")
    const recording = published("site-visit-recorded", second)
    assert.equal(await handle(recording), "recorded")
    assert.equal(await handle(recording), "nothing", "the visit's live event stands: charged once, as a pickup is")
    const [event, ...more] = await eventsOf(second.id)
    assert.deepEqual(more, [])
    assert.deepEqual(
      [event.kind, event.status, event.agreementId, event.productId, event.serviceDate, event.netMinor, event.vatMinor, event.links.visitId, event.sourceEventId, event.createdBy],
      ["visit", "ready", tenant.agreements.housing.id, visit70, "2026-03-03", 7_000, 1_750, second.id, recording.id, null],
    )
  })

  test("a refused visit, and a recording delivered after the void, record nothing", async () => {
    const refused = await visit({ kind: "property", propertyId: tenant.properties.havnegade.id }, "2026-03-04T09:00:00.000Z")
    assert.equal(refused.refusalReason, "not-fee-paying")
    assert.equal(await handle(published("site-visit-recorded", refused)), "nothing")
    const late = await visit({ kind: "property", propertyId: tenant.properties.parkvej.id }, "2026-03-05T09:00:00.000Z")
    const gone = await voided(late.id)
    assert.equal(await handle(published("site-visit-voided", gone)), "nothing", "nothing charged yet")
    assert.equal(await handle(published("site-visit-recorded", late)), "nothing", "stale news")
    assert.deepEqual(await eventsOf(late.id), [])
  })

  test("a void cancels an uninvoiced charge with visit-voided, and reverses an invoiced one; the run's line names the site and the plate", async () => {
    const cancelled = await visit({ kind: "property", propertyId: tenant.properties.parkvej.id }, "2026-04-01T09:00:00.000Z")
    assert.equal(await handle(published("site-visit-recorded", cancelled)), "recorded")
    assert.equal(await handle(published("site-visit-voided", await voided(cancelled.id))), "cancelled")
    const [stamped] = await eventsOf(cancelled.id)
    assert.deepEqual([stamped.status, stamped.cancelReason, stamped.cancelledBy], ["cancelled", "visit-voided", null])

    const unknown = await visit({ kind: "plate", value: "ZZ00000" }, "2026-04-02T09:00:00.000Z")
    assert.equal(unknown.refusalReason, "unknown-identifier", "no credential, no charge")
    const charged = await visit({ kind: "property", propertyId: tenant.properties.parkvej.id }, "2026-04-03T09:00:00.000Z")
    assert.equal(await handle(published("site-visit-recorded", charged)), "recorded")
    await runBilling((work) => withCompany(pool.db, tenant.companyId, work), { companyId: tenant.companyId, projectId: copenhagen, periodFrom: "2026-04-01", periodTo: "2026-04-30", note: null, requestedBy: null, newId, now: () => NOON })
    const [line] = await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
      const [event] = await eventsOf(charged.id)
      return tx.select({ description: invoiceLine.description }).from(invoiceLine).where(and(eq(invoiceLine.companyId, tenant.companyId), eq(invoiceLine.billableEventId, event.id)))
    })
    assert.equal(line?.description, `Recycling centre visit · 2026-04-03 · Nordhavn Recycling Centre · Parkvej 18`, "the Property's name where it was found by its address")
    assert.equal(await handle(published("site-visit-voided", await voided(charged.id))), "reversed")
    const [original, reversal] = await withCompany(pool.db, tenant.companyId, async (tx) =>
      (await eventsFrom(tx, tenant.companyId).query.where(and(eq(billableEvent.companyId, tenant.companyId), eq(billableEvent.projectId, copenhagen))).orderBy(asc(billableEvent.id))).map(eventOf).filter((event) => event.links.visitId === charged.id || event.kind === "reversal"),
    )
    assert.deepEqual([original.status, reversal.kind, reversal.links.reversesEventId, reversal.netMinor], ["reversed", "reversal", original.id, -7_000])
  })

  test("a void never re-tiers a later visit: the visit is charged at the product it was quoted when it was checked in, not one recounted at its event", async () => {
    const free = await visit({ kind: "property", propertyId: tenant.properties.parkvej.id }, "2027-02-01T09:00:00.000Z")
    const quoted = await visit({ kind: "property", propertyId: tenant.properties.parkvej.id }, "2027-02-02T09:00:00.000Z")
    assert.deepEqual([free.charge?.basis, quoted.charge?.n, quoted.charge?.productId], ["free-quota", 2, visit70])
    // The first is voided before the second's recording reaches the consumer: recounted, the second would be the year's first and free.
    assert.equal(await handle(published("site-visit-voided", await voided(free.id))), "nothing")
    assert.equal(await handle(published("site-visit-recorded", quoted)), "recorded")
    const [event] = await eventsOf(quoted.id)
    assert.deepEqual([event.productId, event.netMinor], [visit70, 7_000])
  })

  test("a business's visit at a step with no price row is blocked as any event is", async () => {
    await withCompany(pool.db, tenant.companyId, (tx: Tx) =>
      tx.insert(accessCredential).values({ id: testId(), companyId: tenant.companyId, projectId: copenhagen, kind: "plate", value: "VAN2", customerId: tenant.customers.anna.id, agreementId: tenant.agreements.anna.id, validFrom: "2026-01-01" }),
    )
    const van = await visit({ kind: "plate", value: "van 2" }, "2026-05-01T09:00:00.000Z")
    assert.deepEqual([van.outcome, van.customerId], ["admitted", tenant.customers.anna.id])
    assert.equal(await handle(published("site-visit-recorded", van)), "recorded")
    const [event] = await eventsOf(van.id)
    assert.deepEqual([event.status, event.blockReason, event.productId, event.agreementId], ["blocked", "no-price-row", unpriced, tenant.agreements.anna.id])
  })
})

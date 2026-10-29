// The Finance consumer's `weight-reviewed` against Postgres (O28 of #290,
// C32 of #291): an Unload of a completed route reviewed by the office, and
// the handler of `finance.record-billable-events` run directly over the
// review's event, as record-billable-events.test.ts runs it over a pickup's.
// An approval charges each stop the Unload carried under a product sold by
// the tonne its share of the reviewed net — by the stops' on-board weights —
// priced per tonne on the service date, once however often it is delivered;
// a stop sold per pickup is charged nothing here; a rejection cancels the
// charge with `weight-revised`; an approval again charges afresh; a correction
// moves the weight to the new Unload, uncharged until it is approved; and the
// run's line names the kilograms. Skipped with the reason when `DATABASE_URL`
// or `DATABASE_ADMIN_URL` is unset, failed under `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { BillableEvent } from "@waste/contracts/billable-events"
import type { WeightReview } from "@waste/contracts/weight-control"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { runBilling } from "@waste/db/commands/billing-runs"
import { eventOf, eventsFrom } from "@waste/db/commands/billing-shapes"
import { newId } from "@waste/db/ids"
import { product } from "@waste/db/schema/catalogue"
import { proofOfService, unload } from "@waste/db/schema/execution"
import { billableEvent, invoiceLine, priceListRow, weightReview } from "@waste/db/schema/finance"
import { unloadingStation } from "@waste/db/schema/places"
import { withCompany } from "@waste/db/tenant"
import type { WeightReviewDecision } from "@waste/domain/finance/vocabulary"
import { and, asc, eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import type { JobContext } from "../jobs"
import { recordBillableEvents, type PublishedEvent, type Recorded } from "../jobs/record-billable-events"
import { consumerQueue } from "../outbox/subscribe"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, dropFinanceTenant, FIXTURE_DAY, placeBin, seedCompletedRoute, seedFinanceTenant, testId, type FinanceTenant, type SeededRoute } from "./finance-tenant"
import { fakeRouting, settlesNothing } from "./routing-context"

const database = databaseUnderTest()
const owner = ownerUnderTest()

const NOON = new Date("2026-10-06T12:00:00Z")
/** The tonne's price for residual waste: 512.50 kr. */
const RATE = 51_250

describe("finance.record-billable-events over an Unload's weight review (O28 of #290)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let admin: Database
  let tenant: FinanceTenant
  let copenhagen: string
  let served: SeededRoute
  const tonne = testId()
  const station = testId()
  const tipped = testId()
  const lines: string[] = []

  const context = (): JobContext => ({ api: pool, worker: pool, now: () => NOON, log: (message) => void lines.push(message), send: async () => null, complete: settlesNothing, routing: fakeRouting() })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    admin = createDb(owner.url, { max: 1 })
    tenant = await seedFinanceTenant(pool)
    copenhagen = tenant.projects.copenhagen.id
    const { companyId } = tenant
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      await tx.insert(product).values({ id: tonne, companyId, projectId: copenhagen, name: "Residual waste · per tonne", kind: "container-collection", status: "active", unit: "tonne", vatPercent: 25 })
      await tx.insert(priceListRow).values({ id: testId(), companyId, projectId: copenhagen, priceListId: tenant.priceList.id, productId: tonne, unitPriceMinor: RATE, wasteFractionId: tenant.fractions.residual.id, validFrom: "2026-01-01" })
      await tx.insert(unloadingStation).values({ id: station, companyId, code: "AMV", name: "Amager Ressourcecenter", address: "Vindmøllevej 6", location: { type: "Point", coordinates: [12.6, 55.68] }, ownership: "external", weighbridge: true, status: "active" })
    })
    // Two bins on one route: one sold by the tonne, one per pickup; 300 kg and 600 kg on board.
    const perTonne = await placeBin(pool, tenant, "Skip", { agreementId: tenant.agreements.housing.id, productId: tonne })
    const perPickup = await placeBin(pool, tenant, "Bin", { agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id })
    served = await seedCompletedRoute(pool, tenant, [
      { containerId: perTonne.containerId, propertyId: perTonne.propertyId },
      { containerId: perPickup.containerId, propertyId: perPickup.propertyId },
    ])
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      const weighed = (pickupId: string | undefined, weightKg: number) => ({ id: testId(), companyId, projectId: copenhagen, routeId: served.id, pickupId, kind: "weight", source: "dispatch", occurredAt: at(FIXTURE_DAY, "06:46"), recordedBy: tenant.users.olivia.id, weightKg })
      await tx.insert(proofOfService).values([weighed(served.pickupIds[0], 300), weighed(served.pickupIds[1], 600)])
      await tx.insert(unload).values({ id: tipped, companyId, projectId: copenhagen, routeId: served.id, unloadingStationId: station, wasteFractionId: tenant.fractions.residual.id, source: "dispatch", occurredAt: at(FIXTURE_DAY, "09:00"), recordedBy: tenant.users.olivia.id, netKg: 1_000 })
    })
  })
  after(async () => {
    await dropFinanceTenant(pool, admin, tenant.companyId)
    await pool.close()
    await admin.close()
  })

  /** A review as the office's route appends it, answered as the route answers it; a correction writes its new Unload first. */
  const review = async (unloadId: string, decision: WeightReviewDecision, correction?: { netKg: number }): Promise<WeightReview> =>
    await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
      let correctionUnloadId: string | null = null
      if (correction !== undefined) {
        correctionUnloadId = testId()
        await tx.insert(unload).values({ id: correctionUnloadId, companyId: tenant.companyId, projectId: copenhagen, routeId: served.id, unloadingStationId: station, wasteFractionId: tenant.fractions.residual.id, source: "dispatch", occurredAt: at(FIXTURE_DAY, "09:00"), recordedBy: tenant.users.olivia.id, netKg: correction.netKg })
      }
      const [row] = await tx
        .insert(weightReview)
        .values({ id: testId(), companyId: tenant.companyId, projectId: copenhagen, unloadId, decision, note: decision === "approved" ? null : "Ticket says otherwise", correctionUnloadId, reviewedBy: tenant.users.olivia.id })
        .returning()
      return { id: row.id, recordedAt: row.recordedAt.toISOString(), projectId: row.projectId, unloadId: row.unloadId, decision: row.decision as WeightReviewDecision, note: row.note, correctionUnloadId: row.correctionUnloadId, reviewedBy: row.reviewedBy }
    })

  const published = (payload: WeightReview, id = testId()): PublishedEvent => ({
    id,
    companyId: tenant.companyId,
    projectId: copenhagen,
    kind: "weight-reviewed",
    aggregateKind: "unload",
    aggregateId: payload.unloadId,
    occurredAt: payload.recordedAt,
    payload,
    publishedAt: null,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
  })

  const handle = async (event: PublishedEvent): Promise<Recorded["did"][]> => {
    const consumer = recordBillableEvents.find((job) => job.queue === consumerQueue(event.kind, "finance"))
    assert.ok(consumer, `${event.kind}: no Finance entry`)
    const job: Job<PublishedEvent> = { id: testId(), name: consumer.queue, data: event, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal }
    await consumer.handler([job], context())
    const line = lines.findLast((candidate) => candidate.includes(` ${event.id} → `))
    assert.ok(line, "the consumer logged the event")
    return line
      .slice(line.indexOf(" → ") + 3)
      .split(", ")
      .map((part) => part.split(" ")[0] as Recorded["did"])
  }

  const weightEventsOf = (unloadId: string): Promise<BillableEvent[]> =>
    withCompany(pool.db, tenant.companyId, async (tx) => (await eventsFrom(tx, tenant.companyId).query.where(and(eq(billableEvent.companyId, tenant.companyId), eq(billableEvent.unloadId, unloadId))).orderBy(asc(billableEvent.id))).map(eventOf))

  test("an approval charges the stop sold by the tonne its share, priced per tonne on the service date, once however often delivered; the stop sold per pickup is charged nothing here", async () => {
    const approval = published(await review(tipped, "approved"))
    assert.deepEqual(await handle(approval), ["recorded"])
    const [charge, ...more] = await weightEventsOf(tipped)
    assert.equal(more.length, 0, "one stop is sold by the tonne")
    // 1,000 kg shared 300 : 600 is 333 kg; at 512.50 kr a tonne, 170.66 kr.
    assert.deepEqual(
      [charge.kind, charge.status, charge.serviceDate, charge.quantity, charge.weightKg, charge.productId, charge.unitPriceMinor, charge.netMinor, charge.vatMinor, charge.links.pickupId, charge.links.unloadId, charge.sourceEventId],
      ["weight", "ready", served.serviceDate, 1, 333, tonne, 17_066, 17_066, 4_267, served.pickupIds[0], tipped, approval.id],
    )
    assert.deepEqual(await handle(approval), ["nothing"], "the same event again finds the stop charged: the live charge is read first")
    assert.deepEqual(await handle(published(await review(tipped, "approved"))), ["nothing"], "an approval charged already charges nothing more")
    assert.equal((await weightEventsOf(tipped)).length, 1)
  })

  test("a rejection cancels the live charge with weight-revised; an approval again charges afresh", async () => {
    assert.deepEqual(await handle(published(await review(tipped, "rejected"))), ["cancelled"])
    const [cancelled] = await weightEventsOf(tipped)
    assert.deepEqual([cancelled.status, cancelled.cancelReason, cancelled.cancelledBy], ["cancelled", "weight-revised", null])
    assert.deepEqual(await handle(published(await review(tipped, "approved"))), ["recorded"])
    const charges = await weightEventsOf(tipped)
    assert.deepEqual(charges.map((event) => event.status), ["cancelled", "ready"])
  })

  test("the run's line names the kilograms the charge was weighed at", async () => {
    const run = await withCompany(pool.db, tenant.companyId, (tx: Tx) => runBilling(tx, { companyId: tenant.companyId, projectId: copenhagen, periodFrom: FIXTURE_DAY, periodTo: FIXTURE_DAY, note: null, requestedBy: null, newId, now: () => NOON }))
    assert.ok(run)
    const live = (await weightEventsOf(tipped)).find((event) => event.status !== "cancelled")!
    const [line] = await withCompany(pool.db, tenant.companyId, (tx: Tx) => tx.select({ description: invoiceLine.description }).from(invoiceLine).where(and(eq(invoiceLine.companyId, tenant.companyId), eq(invoiceLine.billableEventId, live.id))))
    assert.equal(line?.description, `Residual waste · per tonne · ${FIXTURE_DAY} · 333 kg`)
  })

  test("a correction of an invoiced weight reverses its charge, and the new Unload is charged only once approved", async () => {
    const correction = await review(tipped, "corrected", { netKg: 1_800 })
    assert.deepEqual(await handle(published(correction)), ["reversed"])
    assert.deepEqual((await weightEventsOf(tipped)).map((event) => event.status), ["cancelled", "reversed"])
    const fresh = correction.correctionUnloadId!
    assert.deepEqual(await handle(published(await review(fresh, "approved"))), ["recorded"])
    const [charge] = await weightEventsOf(fresh)
    // 1,800 kg shared 300 : 600 is 600 kg; at 512.50 kr a tonne, 307.50 kr.
    assert.deepEqual([charge.weightKg, charge.netMinor], [600, 30_750])
  })
})

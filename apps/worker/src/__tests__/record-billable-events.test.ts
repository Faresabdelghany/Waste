// The Finance consumer against Postgres (Issue #112 §6, part B): the handler
// of `finance.record-billable-events` run directly with pools of this suite's
// own — the API role's for the writes, as the process hands it — over a tenant
// minted here (finance-tenant.ts), so what is proved is the reads beside the
// payload, the domain's rule over them and the row each answer leaves, and
// not pg-boss's delivery, which boot.test.ts proves separately. Each test
// lays its own bins and routes on the tenant's ground and reads the
// `billable_event` rows back as the API would through `eventsFrom`.
//
// The table of §3, row by row: a `pickup-completed` records one priced event
// with the links, no person and the outbox event's id — the Centrum row
// winning over the default, since the scheme names the planning area, and the
// negotiated row winning for the housing association; the same job twice
// records one; a completion under a `month` product records nothing; one
// whose bin had no placement on the day is blocked `no-subscription`, under a
// draft agreement `agreement-draft`, under a product with no rate
// `no-vat-rate`; a `pickup-corrected` to `skipped` cancels an uninvoiced
// event with the consumer's reason and no person and reverses an invoiced
// one, in either order with the completion and under two workers at once; a
// `ticket-completed · recollected` records a `no-product` event on the day
// the ticket closed on Copenhagen's clock and `· no-action` nothing; and a
// payload that does not parse fails the job. Skipped with the reason when
// `DATABASE_URL` or `DATABASE_ADMIN_URL` is unset, failed under
// `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

import type { BillableEvent } from "@waste/contracts/billable-events"
import { createDb, type Database } from "@waste/db/client"
import { eventOf, eventsFrom } from "@waste/db/commands/billing-shapes"
import { issueInvoice } from "@waste/db/commands/invoice-writes"
import { HELD_FOR_REVIEW } from "@waste/db/commands/billable-writes"
import { lockRow } from "@waste/db/commands/shared"
import { newId } from "@waste/db/ids"
import { product } from "@waste/db/schema/catalogue"
import { pickup } from "@waste/db/schema/execution"
import { billableEvent, billingRun, ticketKindProduct, workOrderProduct } from "@waste/db/schema/finance"
import { contaminantCode, pickupExceptionRule, pickupExceptionRuleStep } from "@waste/db/schema/pickup-exceptions"
import { project } from "@waste/db/schema/organisation"
import { ticket } from "@waste/db/schema/resolution"
import { bulkyBooking } from "@waste/db/schema/bulky"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import type { Job } from "pg-boss"
import { and, asc, eq } from "drizzle-orm"

import type { JobContext } from "../jobs"
import { FINANCE_EVENT_KINDS, recordBillableEvents, type PublishedEvent, type Recorded } from "../jobs/record-billable-events"
import { consumerQueue } from "../outbox/subscribe"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, dropFinanceTenant, FIXTURE_DAY, movePickup, placeBin, seedBulkyBooking, seedCompletedRoute, seedCorrectionProof, seedExceptionRule, seedFinanceTenant, seedTicket, testId, type FinanceTenant } from "./finance-tenant"
import { fakeRouting, settlesNothing } from "./routing-context"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const skip = database.skip || owner.skip

/** The instant the suite's clock stands at. */
const NOON = new Date("2026-10-06T12:00:00Z")

describe("finance.record-billable-events against Postgres", { skip }, () => {
  let pool: Database
  let admin: Database
  let tenant: FinanceTenant
  const lines: string[] = []

  const context = (): JobContext => ({
    api: pool,
    worker: pool,
    now: () => NOON,
    log: (message) => void lines.push(message),
    send: async () => null,
    complete: settlesNothing,
    routing: fakeRouting(),
  })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    admin = createDb(owner.url, { max: 1 })
    tenant = await seedFinanceTenant(pool)
  })
  after(async () => {
    await dropFinanceTenant(pool, admin, tenant.companyId)
    await pool.close()
    await admin.close()
  })

  /** One published event as the relay would hand it to the queue: the outbox row on the wire with the tenant beside it, the payload the resource as the API answers it (the ids are all the consumer reads of it). */
  const published = (kind: OutboxKind, aggregateId: string, payload: PublishedEvent["payload"], id = testId()): PublishedEvent => ({
    id,
    companyId: tenant.companyId,
    projectId: tenant.projects.copenhagen.id,
    kind,
    aggregateKind: kind.startsWith("ticket") ? "ticket" : "pickup",
    aggregateId,
    occurredAt: at(FIXTURE_DAY, "06:45").toISOString(),
    payload,
    publishedAt: null,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
  })

  /** A pickup's payload as `PickupDetail` spells it, from the rows seeded: the consumer parses it for the ids and reads the rest from the table. */
  const pickupPayload = (routeId: string, pickupId: string, containerId: string | null, status: "completed" | "skipped" | "failed" = "completed") => ({
    id: pickupId,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
    projectId: tenant.projects.copenhagen.id,
    routeId,
    containerId,
    position: 1,
    status,
    reason: status === "completed" ? null : "not-presented",
    note: null,
    propertyId: tenant.properties.parkvej.id,
    sharedCollectionPointId: null,
    wasteFractionId: tenant.fractions.residual.id,
    arrivedAt: at(FIXTURE_DAY, "06:40").toISOString(),
    outcomeAt: at(FIXTURE_DAY, "06:45").toISOString(),
    proofs: [],
  })

  /** A ticket's payload as `Ticket` spells it, from the row seeded. */
  const ticketPayload = (ticketId: string, number: number, resolution: string, closedAt: Date, links: { agreementId?: string | null; routeId?: string | null; pickupId?: string | null } = {}) => ({
    id: ticketId,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
    projectId: tenant.projects.copenhagen.id,
    number,
    label: `T-${number}`,
    kind: "missed-collection",
    status: "completed",
    priority: "none",
    source: "phone",
    subject: "Bin not emptied",
    description: "The bin at Parkvej 18 was not emptied on Monday.",
    occurredAt: at(FIXTURE_DAY, "09:00").toISOString(),
    dueAt: null,
    assigneeUserAccountId: null,
    createdBy: tenant.users.olivia.id,
    sourceEventId: null,
    links: { routeId: links.routeId ?? null, pickupId: links.pickupId ?? null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: links.agreementId ?? null, driverId: null, parentTicketId: null },
    resolution,
    recollectionRouteId: null,
    closedAt: closedAt.toISOString(),
  })

  /** The registry entry that works Finance's queue of the kind: the seam's one job per kind. */
  const consumerOf = (kind: OutboxKind) => {
    const found = recordBillableEvents.find((job) => job.queue === consumerQueue(kind, "finance"))
    assert.ok(found, `${kind}: no entry of Finance's consumer works ${consumerQueue(kind, "finance")}`)
    return found
  }

  /** Runs the handler over one published event, as pg-boss would hand it in on the kind's queue — over the suite's context, or another worker's — and answers what it did. */
  const handle = async (event: PublishedEvent, on: JobContext = context()): Promise<Recorded> => {
    const consumer = consumerOf(event.kind)
    const job: Job<PublishedEvent> = { id: testId(), name: consumer.queue, data: event, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal }
    const output = (await consumer.handler([job], on)) as { events: string[] }
    assert.deepEqual(output.events, [event.id], "the seam answers the events it handled")
    const line = lines.findLast((candidate) => candidate.includes(` ${event.id} → `))
    assert.ok(line, "the consumer logged the event")
    // Every action the event came to, in order (a tagged collection is two, #293 M5); the first is the job's answer.
    const actions = [...line.slice(line.indexOf(" → ")).matchAll(/(recorded|cancelled|reversed|nothing|replayed)(?: \(billable event ([0-9a-f-]{36})\))?/g)].map(([, did, id]) => ({ did: did as Recorded["did"], billableEventId: id ?? null }))
    return { event: event.id, kind: event.kind, ...actions[0], actions: actions[0]?.did === "nothing" ? [] : actions }
  }

  /** The billable events of a pickup, as the API reads them, oldest first. */
  const eventsOfPickup = (pickupId: string): Promise<BillableEvent[]> =>
    withCompany(pool.db, tenant.companyId, async (tx) => (await eventsFrom(tx, tenant.companyId).query.where(and(eq(billableEvent.companyId, tenant.companyId), eq(billableEvent.pickupId, pickupId))).orderBy(asc(billableEvent.id))).map(eventOf))

  /** Every billable event the tenant holds, oldest first. */
  const allEvents = (): Promise<BillableEvent[]> => withCompany(pool.db, tenant.companyId, async (tx) => (await eventsFrom(tx, tenant.companyId).query.where(eq(billableEvent.companyId, tenant.companyId)).orderBy(asc(billableEvent.id))).map(eventOf))

  /** Puts an event on an invoice line the way a run does, so its reading is `invoiced`: a run row and one document through the commands' door. */
  const invoiced = async (event: BillableEvent): Promise<void> => {
    await withCompany(pool.db, tenant.companyId, async (tx) => {
      const [run] = await tx
        .insert(billingRun)
        .values({ id: newId(), companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, periodFrom: event.serviceDate, periodTo: event.serviceDate, status: "completed", requestedBy: tenant.users.olivia.id, completedAt: NOON, eventCount: 1, invoiceCount: 1, excludedCustomerCount: 0, netMinor: event.netMinor ?? 0, vatMinor: event.vatMinor ?? 0 })
        .returning({ id: billingRun.id })
      await issueInvoice(tx, {
        companyId: tenant.companyId,
        draft: { projectId: tenant.projects.copenhagen.id, kind: "invoice", customerId: tenant.customers.housing.id, currency: "DKK", issuedOn: "2026-10-06", dueOn: "2026-11-05", periodFrom: event.serviceDate, periodTo: event.serviceDate, billingRunId: run.id, creditsInvoiceId: null, creditReason: null, creditNote: null, issuedBy: tenant.users.olivia.id, paymentReferenceScheme: "none" },
        lines: [{ billableEventId: event.id, creditsLineId: null, description: `Restaffald 240 L · ${event.serviceDate}`, productId: event.productId, serviceDate: event.serviceDate, quantity: event.quantity, unitPriceMinor: event.unitPriceMinor ?? 0, netMinor: event.netMinor ?? 0, vatPercent: event.vatPercent ?? 0, vatMinor: event.vatMinor ?? 0 }],
        newId,
        now: () => NOON,
      })
    })
  }

  test("works the seven kinds Finance reads and no other, one entry per kind on Finance's own queue of the kind (#339): a missed stop's two for its Pickup Exception (#293 M5), and a Site Visit's two (M4 of #293)", () => {
    assert.deepEqual([...FINANCE_EVENT_KINDS], ["pickup-completed", "pickup-corrected", "pickup-failed", "pickup-skipped", "ticket-completed", "site-visit-recorded", "site-visit-voided"])
    assert.deepEqual(recordBillableEvents.map((job) => job.queue), FINANCE_EVENT_KINDS.map((kind) => consumerQueue(kind, "finance")))
    for (const job of recordBillableEvents) assert.equal(job.schedule, undefined, "sent by the relay, never by a cron")
  })

  test("a pickup-completed records one priced pickup event with its links, no person and the outbox event's id: the Centrum row wins under the scheme's planning area, and the same job twice records one", async () => {
    const bin = await placeBin(pool, tenant, "BIN-CEN-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
    const [pickupId] = seeded.pickupIds
    const event = published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId))

    const first = await handle(event)
    assert.equal(first.did, "recorded")
    const [recorded, ...rest] = await eventsOfPickup(pickupId)
    assert.deepEqual(rest, [])
    assert.deepEqual(
      [recorded.id, recorded.kind, recorded.status, recorded.serviceDate, recorded.agreementId, recorded.subscriptionId, recorded.productId, recorded.quantity],
      [first.billableEventId, "pickup", "ready", FIXTURE_DAY, tenant.agreements.anna.id, bin.subscriptionId, tenant.products.residual.id, 1],
    )
    assert.deepEqual([recorded.priceListRowId, recorded.unitPriceMinor, recorded.netMinor, recorded.vatPercent, recorded.vatMinor, recorded.currency], [tenant.priceList.rows.residualCentrum.id, 13_500, 13_500, 25, 3_375, "DKK"], "the Centrum row wins: the scheme names the planning area, and a row naming it scores over the default")
    assert.deepEqual(recorded.links, { routeId: seeded.id, pickupId, ticketId: null, reversesEventId: null, proofId: null, visitId: null })
    assert.deepEqual([recorded.createdBy, recorded.sourceEventId, recorded.blockReason, recorded.cancelledAt], [null, event.id, null, null])

    // At-least-once: the same job again is one row. The redelivery finds the pickup's live event and the domain says nothing; the index behind it (`billable_event_source_event_id_idx`) is the word for the race two workers make, proved below on the reversal.
    const again = await handle(event)
    assert.deepEqual([again.did, again.billableEventId], ["nothing", null])
    assert.equal((await eventsOfPickup(pickupId)).length, 1)
    assert.match(lines.at(-1) ?? "", /^finance\.record-billable-events: pickup-completed [0-9a-f-]{36} → nothing$/)
  })

  test("a stop the office added records nothing when it is completed — a placed container under a per-pickup product, or an address-only stop on an ad-hoc route — read without a dead letter, the extra collection's billable event being a follow-up's (#111)", async () => {
    const bin = await placeBin(pool, tenant, "BIN-OFF-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const extra = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, origin: "office" }])
    const [placedStop] = extra.pickupIds
    const placed = await handle(published("pickup-completed", placedStop, { ...pickupPayload(extra.id, placedStop, bin.containerId), origin: "office" }))
    assert.deepEqual([placed.did, placed.billableEventId], ["nothing", null], "the placement would price it, and the office's stop is not a pickup charge")
    assert.deepEqual(await eventsOfPickup(placedStop), [])
    const adHoc = await seedCompletedRoute(pool, tenant, [{ containerId: null, propertyId: tenant.properties.parkvej.id, origin: "office" }], FIXTURE_DAY, { adHoc: true })
    const [addressOnly] = adHoc.pickupIds
    assert.equal((await handle(published("pickup-completed", addressOnly, { ...pickupPayload(adHoc.id, addressOnly, null), origin: "office" }))).did, "nothing", "no scheme, no container: read all the same")
    assert.equal((await handle(published("pickup-corrected", addressOnly, { ...pickupPayload(adHoc.id, addressOnly, null), origin: "office" }))).did, "nothing", "a correction to completed records nothing either")
    assert.deepEqual(await eventsOfPickup(addressOnly), [])
  })

  test("a scheduled collection moved to another route (O23 of #290) is billed as the collection it is, once, moved once or twice; the stop taken off records nothing, and an office stop moved stays the office's", async () => {
    const bin = await placeBin(pool, tenant, "BIN-MOV-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    // The scheme's Monday stop taken off, then the office's stop of it on another route, taken off in turn and moved once more, and done there.
    const from = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, status: "skipped", reason: "removed-by-dispatcher" }])
    const [scheduled] = from.pickupIds
    const between = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", status: "skipped", reason: "removed-by-dispatcher", movedFrom: { routeId: from.id, pickupId: scheduled } }], FIXTURE_DAY, { adHoc: true })
    const [moved] = between.pickupIds
    const to = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", movedFrom: { routeId: between.id, pickupId: moved } }], FIXTURE_DAY, { adHoc: true })
    const [done] = to.pickupIds

    const taken = await handle(published("pickup-skipped", scheduled, { ...pickupPayload(from.id, scheduled, bin.containerId, "skipped"), reason: "removed-by-dispatcher" }))
    assert.deepEqual([taken.did, await eventsOfPickup(scheduled)], ["nothing", []], "the stop taken off is no collection and no exception")
    const collected = await handle(published("pickup-completed", done, { ...pickupPayload(to.id, done, bin.containerId), origin: "office", movedFromPickupId: moved }))
    assert.equal(collected.did, "recorded")
    const [recorded, ...rest] = await eventsOfPickup(done)
    assert.deepEqual(rest, [])
    assert.deepEqual(
      [recorded.kind, recorded.agreementId, recorded.subscriptionId, recorded.productId, recorded.blockReason, recorded.links.routeId, recorded.links.pickupId],
      ["pickup", tenant.agreements.anna.id, bin.subscriptionId, tenant.products.residual.id, null, to.id, done],
      "priced through its placement, as the scheduled collection it stands for, on the route it was done on",
    )

    // An extra emptying the office added, moved, is the office's still: nothing, as #111's stop.
    const extra = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", status: "skipped", reason: "removed-by-dispatcher" }], FIXTURE_DAY, { adHoc: true })
    const moves = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", movedFrom: { routeId: extra.id, pickupId: extra.pickupIds[0] } }], FIXTURE_DAY, { adHoc: true })
    const [extraDone] = moves.pickupIds
    assert.equal((await handle(published("pickup-completed", extraDone, { ...pickupPayload(moves.id, extraDone, bin.containerId), origin: "office", movedFromPickupId: extra.pickupIds[0] }))).did, "nothing")
    assert.deepEqual(await eventsOfPickup(extraDone), [])
  })

  test("the negotiated row wins for its customer, whatever the conditions score", async () => {
    const bin = await placeBin(pool, tenant, "BIN-HOUSING-1", { agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
    const [pickupId] = seeded.pickupIds
    await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
    const [recorded] = await eventsOfPickup(pickupId)
    assert.deepEqual([recorded.priceListRowId, recorded.unitPriceMinor, recorded.netMinor, recorded.vatMinor, recorded.agreementId], [tenant.priceList.rows.residualHousing.id, 10_000, 10_000, 2_500, tenant.agreements.housing.id])
  })

  test("a completion under a month product records nothing: the collection is inside a recurring charge", async () => {
    const bin = await placeBin(pool, tenant, "BIN-RENTAL-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.rental.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
    const [pickupId] = seeded.pickupIds
    const outcome = await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
    assert.deepEqual([outcome.did, outcome.billableEventId], ["nothing", null])
    assert.deepEqual(await eventsOfPickup(pickupId), [])
  })

  test("a work order the office booked records a job at the project's product for its service (M14 of #293), charged to the container's agreement — a delivery's through the subscription it books — and priced as a pickup is; nothing for a service the project prices nothing for; no-product for a product not sold by the job; and a correction away cancels it", async () => {
    const projectId = tenant.projects.copenhagen.id
    await withCompany(pool.db, tenant.companyId, async (tx) => {
      await tx.insert(workOrderProduct).values([
        { id: testId(), companyId: tenant.companyId, projectId, service: "deliver", productId: tenant.products.bulky.id },
        { id: testId(), companyId: tenant.companyId, projectId, service: "wash", productId: tenant.products.bulky.id },
        { id: testId(), companyId: tenant.companyId, projectId, service: "remove", productId: tenant.products.residual.id },
        { id: testId(), companyId: tenant.companyId, projectId, service: "swap", productId: tenant.products.bulky.id },
      ])
    })
    const job = async (event: Recorded) => {
      const row = (await allEvents()).find((candidate) => candidate.id === event.billableEventId)
      return [event.did, row?.kind, row?.status, row?.agreementId, row?.subscriptionId, row?.productId, row?.unitPriceMinor, row?.netMinor, row?.vatMinor, row?.blockReason]
    }
    // A wash of Anna's bin: the bulky pickup's default row, 350.00 kr and its VAT, under the placement's subscription.
    const washed = await placeBin(pool, tenant, "BIN-JOB-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    // A delivery for the housing association: the stop names the subscription it books, whatever the container stood under before.
    const delivered = await placeBin(pool, tenant, "BIN-JOB-2", { agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id })
    const stock = await placeBin(pool, tenant, "BIN-JOB-3", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    // A removal's and a swap's container: its placement ended on the day by the completion's return, as the driver door leaves it.
    const taken = await placeBin(pool, tenant, "BIN-JOB-4", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id, validTo: FIXTURE_DAY })
    const swapped = await placeBin(pool, tenant, "BIN-JOB-5", { agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id, validTo: FIXTURE_DAY })
    const stops = await seedCompletedRoute(pool, tenant, [
      { containerId: washed.containerId, propertyId: washed.propertyId, origin: "office", service: "wash" },
      { containerId: stock.containerId, propertyId: delivered.propertyId, origin: "office", service: "deliver", subscriptionId: delivered.subscriptionId },
      { containerId: washed.containerId, propertyId: washed.propertyId, origin: "office", service: "repair" },
      { containerId: taken.containerId, propertyId: taken.propertyId, origin: "office", service: "remove", warehouseId: tenant.warehouse.id },
      { containerId: swapped.containerId, propertyId: swapped.propertyId, origin: "office", service: "swap", warehouseId: tenant.warehouse.id, replacementContainerId: stock.containerId },
    ])
    const [wash, delivery, repair, removal, swap] = stops.pickupIds
    const office = (pickupId: string, containerId: string, service: string, status: "completed" | "skipped" = "completed") => ({ ...pickupPayload(stops.id, pickupId, containerId, status), origin: "office", service })
    const washJob = await handle(published("pickup-completed", wash, office(wash, washed.containerId, "wash")))
    assert.deepEqual(await job(washJob), ["recorded", "job", "ready", tenant.agreements.anna.id, washed.subscriptionId, tenant.products.bulky.id, 35_000, 35_000, 8_750, null])
    const [recorded] = await eventsOfPickup(wash)
    assert.deepEqual([recorded.links, recorded.quantity, recorded.priceListRowId], [{ routeId: stops.id, pickupId: wash, ticketId: null, reversesEventId: null, proofId: null, visitId: null }, 1, tenant.priceList.rows.bulky.id])
    assert.deepEqual(await job(await handle(published("pickup-completed", delivery, office(delivery, stock.containerId, "deliver")))), ["recorded", "job", "ready", tenant.agreements.housing.id, delivered.subscriptionId, tenant.products.bulky.id, 35_000, 35_000, 8_750, null])
    // A repair the project prices nothing for records nothing, as an office stop did before; a removal mapped to a product sold by the pickup is the office's to fix, blocked.
    assert.deepEqual([(await handle(published("pickup-completed", repair, office(repair, washed.containerId, "repair")))).did, await eventsOfPickup(repair)], ["nothing", []])
    assert.deepEqual(await job(await handle(published("pickup-completed", removal, office(removal, taken.containerId, "remove")))), ["recorded", "job", "blocked", tenant.agreements.anna.id, taken.subscriptionId, null, null, null, null, "no-product"], "the placement it took away, ended that day")
    assert.deepEqual(await job(await handle(published("pickup-completed", swap, office(swap, swapped.containerId, "swap")))), ["recorded", "job", "ready", tenant.agreements.housing.id, swapped.subscriptionId, tenant.products.bulky.id, 35_000, 35_000, 8_750, null], "a swap is charged to the placement it ended, as a removal is")
    // The job is the stop's live event: the same completion again is nothing, and a correction to skipped cancels it.
    assert.equal((await handle(published("pickup-completed", wash, office(wash, washed.containerId, "wash")))).did, "nothing")
    await movePickup(pool, tenant, wash, "skipped")
    assert.equal((await handle(published("pickup-corrected", wash, office(wash, washed.containerId, "wash", "skipped")))).did, "cancelled")
    assert.equal((await eventsOfPickup(wash))[0].status, "cancelled")
  })

  test("a bulky collection's completion records a job at its booking's product, charged to the booking's agreement with no subscription (O11 of #290), and a correction away cancels it", async () => {
    const booking = await seedBulkyBooking(pool, tenant, { agreementId: tenant.agreements.housing.id, customerId: tenant.customers.housing.id, propertyId: tenant.properties.havnegade.id })
    const stops = await seedCompletedRoute(pool, tenant, [{ containerId: null, propertyId: tenant.properties.havnegade.id, origin: "office", service: "bulky", bulkyBookingId: booking.id }], FIXTURE_DAY, { adHoc: true })
    const [collected] = stops.pickupIds
    const payload = { ...pickupPayload(stops.id, collected, null, "completed"), origin: "office", service: "bulky", bulkyBookingId: booking.id }
    const recorded = await handle(published("pickup-completed", collected, payload))
    const row = (await allEvents()).find((candidate) => candidate.id === recorded.billableEventId)
    assert.deepEqual(
      [recorded.did, row?.kind, row?.status, row?.agreementId, row?.subscriptionId, row?.productId, row?.unitPriceMinor, row?.vatMinor, row?.blockReason],
      ["recorded", "job", "ready", tenant.agreements.housing.id, null, tenant.products.bulky.id, 35_000, 8_750, null],
    )
    assert.equal((await handle(published("pickup-completed", collected, payload))).did, "nothing", "charged once")
    await movePickup(pool, tenant, collected, "failed")
    assert.equal((await handle(published("pickup-corrected", collected, { ...payload, status: "failed", reason: "not-presented" }))).did, "cancelled")
  })

  test("a cancelled bulky booking is charged nothing, whatever a stop of it says (O11 of #290)", async () => {
    const booking = await seedBulkyBooking(pool, tenant, { agreementId: tenant.agreements.housing.id, customerId: tenant.customers.housing.id, propertyId: tenant.properties.havnegade.id })
    await withCompany(pool.db, tenant.companyId, async (tx) => {
      await tx.update(bulkyBooking).set({ cancelledAt: NOON, cancelReason: "Customer called" }).where(eq(bulkyBooking.id, booking.id))
    })
    const stops = await seedCompletedRoute(pool, tenant, [{ containerId: null, propertyId: tenant.properties.havnegade.id, origin: "office", service: "bulky", bulkyBookingId: booking.id }], FIXTURE_DAY, { adHoc: true })
    const [collected] = stops.pickupIds
    const payload = { ...pickupPayload(stops.id, collected, null, "completed"), origin: "office", service: "bulky", bulkyBookingId: booking.id }
    assert.deepEqual([(await handle(published("pickup-completed", collected, payload))).did, await eventsOfPickup(collected)], ["nothing", []])
  })

  test("a stop a ticket was booked for and then booked away from records no job when it completes after all: the ticket's charge is the one, never two (#422)", async () => {
    const projectId = tenant.projects.copenhagen.id
    const priced = testId()
    // The project prices a repair, so a repair the office booked for nothing would be a job.
    await withCompany(pool.db, tenant.companyId, (tx) => tx.insert(workOrderProduct).values({ id: priced, companyId: tenant.companyId, projectId, service: "repair", productId: tenant.products.bulky.id }))
    try {
      const bin = await placeBin(pool, tenant, "BIN-REBOOK-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
      const stops = await seedCompletedRoute(pool, tenant, [
        { containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", service: "repair" },
        { containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", service: "repair" },
      ])
      const [missed, rebooked] = stops.pickupIds
      // The defect was booked for the first stop, which failed, and then for the second: the ticket names the second, the ledger both.
      await seedTicket(pool, tenant, { resolution: null, kind: "container-defect", booked: { routeId: stops.id, pickupId: rebooked }, bookedBefore: [{ routeId: stops.id, pickupId: missed }] })
      // The office corrects the first stop to completed: the ticket is serviced by it, and its charge is the one.
      const corrected = await handle(published("pickup-corrected", missed, { ...pickupPayload(stops.id, missed, bin.containerId), origin: "office", service: "repair" }))
      assert.deepEqual([corrected.did, await eventsOfPickup(missed)], ["nothing", []], "no job beside the ticket's charge")
      const done = await handle(published("pickup-completed", rebooked, { ...pickupPayload(stops.id, rebooked, bin.containerId), origin: "office", service: "repair" }))
      assert.deepEqual([done.did, await eventsOfPickup(rebooked)], ["nothing", []])
    } finally {
      await withCompany(pool.db, tenant.companyId, (tx) => tx.delete(workOrderProduct).where(eq(workOrderProduct.id, priced)))
    }
  })

  test("a work order's job of a project that holds its jobs for review is recorded held, with no person and the project's reason, for the office to release (M14 of #293)", async () => {
    const projectId = tenant.projects.copenhagen.id
    await withCompany(pool.db, tenant.companyId, (tx) => tx.update(project).set({ holdForReview: true }).where(eq(project.id, projectId)))
    try {
      const bin = await placeBin(pool, tenant, "BIN-HELD-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
      const stops = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", service: "wash" }])
      const [wash] = stops.pickupIds
      const done = await handle(published("pickup-completed", wash, { ...pickupPayload(stops.id, wash, bin.containerId), origin: "office", service: "wash" }))
      assert.equal(done.did, "recorded")
      const [recorded] = await eventsOfPickup(wash)
      assert.deepEqual([recorded.kind, recorded.status, recorded.hold?.by, recorded.hold?.reason], ["job", "held", null, HELD_FOR_REVIEW])
    } finally {
      await withCompany(pool.db, tenant.companyId, (tx) => tx.update(project).set({ holdForReview: false }).where(eq(project.id, projectId)))
    }
  })

  test("a collection under a product sold by the day records nothing: a billing run charges the hire's days (M14 of #293)", async () => {
    const day = testId()
    await withCompany(pool.db, tenant.companyId, (tx) => tx.insert(product).values({ id: day, companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, name: "Skip hire", kind: "recurring-service", status: "active", unit: "day", vatPercent: 25, freeDays: 7 }))
    const bin = await placeBin(pool, tenant, "BIN-HIRE-1", { agreementId: tenant.agreements.anna.id, productId: day })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
    const [pickupId] = seeded.pickupIds
    assert.deepEqual([(await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))).did, await eventsOfPickup(pickupId)], ["nothing", []])
  })

  test("a delivery the office booked to answer a container request records nothing as it completes, though the project prices deliveries: the ticket is priced once, from its own completion, and exactly one live event comes of the two (O3c of #290)", async () => {
    const bin = await placeBin(pool, tenant, "BIN-OFF-2", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const booked = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, origin: "office", service: "deliver", subscriptionId: bin.subscriptionId }])
    const [delivery] = booked.pickupIds
    const closedAt = new Date("2026-10-07T22:30:00Z")
    const request = await seedTicket(pool, tenant, { resolution: "serviced", kind: "container-request", agreementId: tenant.agreements.anna.id, closedAt, chargeProductId: tenant.products.bulky.id, booked: { routeId: booked.id, pickupId: delivery } })
    const done = await handle(published("pickup-completed", delivery, { ...pickupPayload(booked.id, delivery, bin.containerId), origin: "office", service: "deliver", subscriptionId: bin.subscriptionId }))
    assert.deepEqual([done.did, done.billableEventId], ["nothing", null], "the project's delivery product is not charged: the ticket the stop answered is the charge")
    assert.deepEqual(await eventsOfPickup(delivery), [])
    const charged = await handle(published("ticket-completed", request.id, { ...ticketPayload(request.id, 31, "serviced", closedAt, { agreementId: tenant.agreements.anna.id }), kind: "container-request" }))
    assert.equal(charged.did, "recorded")
    const live = (await allEvents()).filter((event) => (event.links.pickupId === delivery || event.links.ticketId === request.id) && event.cancelledAt === null)
    assert.deepEqual(
      live.map((event) => [event.kind, event.status, event.productId, event.netMinor]),
      [["ticket", "ready", tenant.products.bulky.id, 35_000]],
    )
  })

  test("is blocked with the actionable reason: no placement valid on the day, a draft agreement, a list with no row for the product — each a row the office reprices, none a failure", async () => {
    // A bin whose placement ended before the route's day: the stop was generated from a placement since ended.
    const ended = await placeBin(pool, tenant, "BIN-ENDED-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id, validFrom: "2026-01-01", validTo: "2026-09-01" })
    const drafted = await placeBin(pool, tenant, "BIN-DRAFT-1", { agreementId: tenant.agreements.draft.id, productId: tenant.products.residual.id })
    const unrated = await placeBin(pool, tenant, "BIN-GLASS-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.glass.id, wasteFractionId: tenant.fractions.glass.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: ended.containerId, propertyId: ended.propertyId }, { containerId: drafted.containerId, propertyId: drafted.propertyId }, { containerId: unrated.containerId, propertyId: unrated.propertyId, wasteFractionId: tenant.fractions.glass.id }])
    const [noSubscription, agreementDraft, noRow] = seeded.pickupIds
    for (const [pickupId, containerId] of [
      [noSubscription, ended.containerId],
      [agreementDraft, drafted.containerId],
      [noRow, unrated.containerId],
    ] as const) {
      assert.equal((await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, containerId)))).did, "recorded")
    }
    const [a] = await eventsOfPickup(noSubscription)
    assert.deepEqual([a.status, a.blockReason, a.agreementId, a.subscriptionId, a.productId, a.netMinor], ["blocked", "no-subscription", null, null, null, null])
    const [b] = await eventsOfPickup(agreementDraft)
    assert.deepEqual([b.status, b.blockReason, b.agreementId, b.subscriptionId, b.productId, b.netMinor], ["blocked", "agreement-draft", tenant.agreements.draft.id, drafted.subscriptionId, tenant.products.residual.id, null])
    const [c] = await eventsOfPickup(noRow)
    assert.deepEqual([c.status, c.blockReason, c.agreementId, c.productId, c.netMinor], ["blocked", "no-price-row", tenant.agreements.anna.id, tenant.products.glass.id, null], "the default list prices no glass collection, so the row is what blocks first — the rate is judged after a row has won")
  })

  test("a pickup-corrected to skipped cancels an uninvoiced live event with the consumer's reason and no person, records nothing when there is no live event, and does it once under two workers at once", async () => {
    const bin = await placeBin(pool, tenant, "BIN-CORR-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
    const [pickupId] = seeded.pickupIds
    await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
    const [live] = await eventsOfPickup(pickupId)
    assert.equal(live.status, "ready")

    // The office corrects the outcome: the pickup's row moves, and the correction's event arrives — twice, on two workers.
    await movePickup(pool, tenant, pickupId, "skipped")
    const correction = published("pickup-corrected", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId, "skipped"))
    const [one, two] = await Promise.all([handle(correction), handle(correction)])
    assert.deepEqual([one.did, two.did].sort(), ["cancelled", "nothing"], "one worker cancels, the other finds the cancellation there and does nothing")
    const [cancelled, ...rest] = await eventsOfPickup(pickupId)
    assert.deepEqual(rest, [])
    assert.deepEqual([cancelled.id, cancelled.status, cancelled.cancelReason, cancelled.cancelledBy], [live.id, "cancelled", "pickup-corrected", null])
    assert.ok(cancelled.cancelledAt !== null)

    // Delivered a third time, with nothing live: nothing.
    assert.equal((await handle(correction)).did, "nothing")

    // A completion delivered after the correction is stale news: the pickup stands skipped, and the correction's own event decided.
    const late = await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
    assert.equal(late.did, "nothing")
    assert.equal((await eventsOfPickup(pickupId)).length, 1)
  })

  test("a pickup-corrected to failed on an invoiced event records a reversal: the original's amounts negated, the original named, the correction's id as the source, once however often delivered", async () => {
    const bin = await placeBin(pool, tenant, "BIN-REV-1", { agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
    const [pickupId] = seeded.pickupIds
    await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
    const [original] = await eventsOfPickup(pickupId)
    await invoiced(original)
    assert.equal((await eventsOfPickup(pickupId))[0].status, "invoiced")

    await movePickup(pool, tenant, pickupId, "failed")
    const correction = published("pickup-corrected", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId, "failed"))
    const first = await handle(correction)
    assert.equal(first.did, "reversed")
    const reversal = (await allEvents()).find((event) => event.id === first.billableEventId)
    assert.ok(reversal)
    assert.deepEqual(
      [reversal.kind, reversal.status, reversal.serviceDate, reversal.agreementId, reversal.subscriptionId, reversal.productId, reversal.quantity, reversal.priceListRowId],
      ["reversal", "ready", original.serviceDate, original.agreementId, original.subscriptionId, original.productId, 1, null],
    )
    assert.deepEqual([reversal.unitPriceMinor, reversal.netMinor, reversal.vatPercent, reversal.vatMinor, reversal.currency], [10_000, -10_000, 25, -2_500, "DKK"])
    assert.deepEqual(reversal.links, { routeId: null, pickupId: null, ticketId: null, reversesEventId: original.id, proofId: null, visitId: null })
    assert.deepEqual([reversal.createdBy, reversal.sourceEventId], [null, correction.id])
    assert.equal((await eventsOfPickup(pickupId))[0].status, "reversed", "the original reads reversed now")

    // Redelivered: the original is reversed now, so the pickup has no live event and the correction is nothing; one reversal, however often it arrives.
    const again = await handle(correction)
    assert.deepEqual([again.did, again.billableEventId], ["nothing", null])
    assert.equal((await allEvents()).filter((event) => event.links.reversesEventId === original.id).length, 1)
  })

  test("a correction to completed on a pickup with no live event records a pickup event as a completion would; on one with a live event, nothing", async () => {
    const bin = await placeBin(pool, tenant, "BIN-RECOMP-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, status: "failed" }])
    const [pickupId] = seeded.pickupIds
    await movePickup(pool, tenant, pickupId, "completed")
    const fresh = await handle(published("pickup-corrected", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
    assert.equal(fresh.did, "recorded")
    const [recorded] = await eventsOfPickup(pickupId)
    assert.deepEqual([recorded.kind, recorded.status, recorded.netMinor], ["pickup", "ready", 13_500])
    // Corrected to completed again (a person re-saving the outcome): already charged for.
    assert.equal((await handle(published("pickup-corrected", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))).did, "nothing")
    assert.equal((await eventsOfPickup(pickupId)).length, 1)
  })

  test("two different events of one pickup that both say record — the driver's completion and the office's correction to completed — under two workers at once charge the pickup once: the handler waits on the pickup's row lock, and the second reads the first's live event", async () => {
    // The lock, shown by itself: a transaction holding the pickup's row keeps the handler waiting, and the handler goes on the instant it lets go.
    const held = await placeBin(pool, tenant, "BIN-LOCK-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const heldRoute = await seedCompletedRoute(pool, tenant, [{ containerId: held.containerId, propertyId: held.propertyId }])
    const [heldPickup] = heldRoute.pickupIds
    let racing: Promise<Recorded> | undefined
    await withCompany(pool.db, tenant.companyId, async (holding) => {
      await lockRow(holding, pickup, { companyId: tenant.companyId, id: heldPickup })
      racing = handle(published("pickup-completed", heldPickup, pickupPayload(heldRoute.id, heldPickup, held.containerId)))
      const first = await Promise.race([racing.then(() => "recorded" as const), sleep(500).then(() => "waiting" as const)])
      assert.equal(first, "waiting", "the handler takes the pickup's lock before it reads, so it waits on a transaction holding the row")
    })
    assert.equal((await racing!).did, "recorded", "and records once the row is let go")

    // The race the lock is for: E1 the driver's `pickup-completed`, E2 the office's `correct-outcome` to `completed` again minutes later (the same outcome with a new note is allowed), two events with two ids on two queues, both saying `record` over a pickup with no live event. On two pools, as two workers. Three pickups, since a race is a matter of chance and a lock a matter of fact.
    const other = createDb(database.url, { max: 2 })
    try {
      for (const n of [1, 2, 3]) {
        const bin = await placeBin(pool, tenant, `BIN-RACE-${n}`, { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
        const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
        const [pickupId] = seeded.pickupIds
        const completion = published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId))
        const correction = published("pickup-corrected", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId))
        const [one, two] = await Promise.all([handle(completion), handle(correction, { ...context(), api: other })])
        assert.deepEqual([one.did, two.did].sort(), ["nothing", "recorded"], `pickup ${n}: one worker records, the other reads the live event it left and does nothing — never two rows for two ids`)
        const events = await eventsOfPickup(pickupId)
        assert.equal(events.length, 1, `pickup ${n}: one live event`)
        assert.deepEqual([events[0].status, events[0].netMinor, events[0].sourceEventId], ["ready", 13_500, (one.did === "recorded" ? one : two).event])
      }
    } finally {
      await other.close()
    }
  })

  test("a ticket-completed with recollected records a no-product ticket event on the day the ticket closed on the project's clock, through its agreement or its pickup's placement; with no-action, or no agreement reachable, nothing", async () => {
    // 23:30 CEST on the 7th is 21:30Z: the day is the 7th on Copenhagen's clock and would be the 7th in UTC too, so a closing at 00:30 CEST on the 8th (22:30Z on the 7th) is what tells the two apart.
    const closedAt = new Date("2026-10-07T22:30:00Z")
    const direct = await seedTicket(pool, tenant, { resolution: "recollected", agreementId: tenant.agreements.housing.id, closedAt })
    const first = await handle(published("ticket-completed", direct.id, ticketPayload(direct.id, 1, "recollected", closedAt, { agreementId: tenant.agreements.housing.id })))
    assert.equal(first.did, "recorded")
    const recorded = (await allEvents()).find((event) => event.id === first.billableEventId)
    assert.ok(recorded)
    assert.deepEqual(
      [recorded.kind, recorded.status, recorded.blockReason, recorded.serviceDate, recorded.agreementId, recorded.subscriptionId, recorded.productId, recorded.quantity, recorded.netMinor, recorded.createdBy],
      ["ticket", "blocked", "no-product", "2026-10-08", tenant.agreements.housing.id, null, null, 1, null, null],
    )
    assert.deepEqual(recorded.links, { routeId: null, pickupId: null, ticketId: direct.id, reversesEventId: null, proofId: null, visitId: null })

    // Through the pickup it names: the placement's agreement on the route's service date, with that placement's subscription.
    const bin = await placeBin(pool, tenant, "BIN-TICKET-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, status: "failed" }])
    const viaPickup = await seedTicket(pool, tenant, { resolution: "serviced", pickup: { routeId: seeded.id, pickupId: seeded.pickupIds[0] } })
    const second = await handle(published("ticket-completed", viaPickup.id, ticketPayload(viaPickup.id, 2, "serviced", closedAt, { routeId: seeded.id, pickupId: seeded.pickupIds[0] })))
    const reached = (await allEvents()).find((event) => event.id === second.billableEventId)
    assert.deepEqual([second.did, reached?.agreementId, reached?.subscriptionId, reached?.links.ticketId], ["recorded", tenant.agreements.anna.id, bin.subscriptionId, viaPickup.id])

    // A ticket naming both — the Driver App's, since #258: the stop and the agreement it served under — reaches the placement's subscription too; one the office pointed at another agreement keeps its own, with no subscription.
    const both = await seedTicket(pool, tenant, { resolution: "recollected", agreementId: tenant.agreements.anna.id, pickup: { routeId: seeded.id, pickupId: seeded.pickupIds[0] } })
    const third = await handle(published("ticket-completed", both.id, ticketPayload(both.id, 7, "recollected", closedAt, { agreementId: tenant.agreements.anna.id, routeId: seeded.id, pickupId: seeded.pickupIds[0] })))
    const named = (await allEvents()).find((event) => event.id === third.billableEventId)
    assert.deepEqual([third.did, named?.agreementId, named?.subscriptionId], ["recorded", tenant.agreements.anna.id, bin.subscriptionId])
    const moved = await seedTicket(pool, tenant, { resolution: "recollected", agreementId: tenant.agreements.housing.id, pickup: { routeId: seeded.id, pickupId: seeded.pickupIds[0] } })
    const fourth = await handle(published("ticket-completed", moved.id, ticketPayload(moved.id, 8, "recollected", closedAt, { agreementId: tenant.agreements.housing.id, routeId: seeded.id, pickupId: seeded.pickupIds[0] })))
    const own = (await allEvents()).find((event) => event.id === fourth.billableEventId)
    assert.deepEqual([fourth.did, own?.agreementId, own?.subscriptionId], ["recorded", tenant.agreements.housing.id, null])

    // Redelivered: a ticket's event takes no lock, so the row it wrote the first time is read back by the outbox event's id — and two workers on one fresh event at once meet the index, one recording and the other reading the winner back.
    const replayed = await handle(published("ticket-completed", direct.id, ticketPayload(direct.id, 1, "recollected", closedAt, { agreementId: tenant.agreements.housing.id }), first.event))
    assert.deepEqual([replayed.did, replayed.billableEventId], ["replayed", recorded.id])
    const raced = await seedTicket(pool, tenant, { resolution: "recollected", agreementId: tenant.agreements.anna.id, closedAt })
    const race = published("ticket-completed", raced.id, ticketPayload(raced.id, 5, "recollected", closedAt, { agreementId: tenant.agreements.anna.id }))
    const [left, right] = await Promise.all([handle(race), handle(race)])
    assert.deepEqual([left.did, right.did].sort(), ["recorded", "replayed"])
    assert.equal(left.billableEventId, right.billableEventId, "both answer the one row")
    assert.equal((await allEvents()).filter((event) => event.links.ticketId === raced.id).length, 1)

    // No agreement reachable, and a resolution that is not billable: nothing.
    const unreachable = await seedTicket(pool, tenant, { resolution: "recollected" })
    assert.equal((await handle(published("ticket-completed", unreachable.id, ticketPayload(unreachable.id, 3, "recollected", closedAt)))).did, "nothing")
    const noAction = await seedTicket(pool, tenant, { resolution: "no-action", agreementId: tenant.agreements.housing.id })
    assert.equal((await handle(published("ticket-completed", noAction.id, ticketPayload(noAction.id, 4, "no-action", closedAt, { agreementId: tenant.agreements.housing.id })))).did, "nothing")
    const seededHere = new Set([direct.id, viaPickup.id, both.id, moved.id, raced.id, unreachable.id, noAction.id])
    assert.equal((await allEvents()).filter((event) => event.kind === "ticket" && event.links.ticketId !== null && seededHere.has(event.links.ticketId)).length, 5)
  })

  test("a ticket-completed charges the product its completion named, else its kind's while that one is offered, priced as a pickup is by the customer's rows; a retired kind's product is no-product (#291 C3)", async () => {
    const closedAt = new Date("2026-10-07T22:30:00Z")
    const priced = async (ticketId: string, number: number, resolution: "recollected" | "serviced", links: { agreementId: string }, kind = "missed-collection") => {
      const payload = { ...ticketPayload(ticketId, number, resolution, closedAt, links), kind }
      const done = await handle(published("ticket-completed", ticketId, payload))
      const event = (await allEvents()).find((row) => row.id === done.billableEventId)
      return [done.did, event?.status, event?.productId, event?.unitPriceMinor, event?.netMinor, event?.blockReason]
    }
    const { bulky, residual } = tenant.products
    const retired = testId()
    await withCompany(pool.db, tenant.companyId, async (tx) => {
      await tx.insert(product).values({ id: retired, companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, name: "Old crane lift", kind: "additional-service", status: "inactive", unit: "job", vatPercent: 25 })
      await tx.insert(ticketKindProduct).values([
        { id: testId(), companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, ticketKind: "overflow", productId: bulky.id },
        { id: testId(), companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, ticketKind: "container-request", productId: retired },
      ])
    })
    // The completion's product: the bulky pickup at 350.00 kr for the housing association.
    const named = await seedTicket(pool, tenant, { resolution: "serviced", agreementId: tenant.agreements.housing.id, closedAt, chargeProductId: bulky.id })
    assert.deepEqual(await priced(named.id, 21, "serviced", { agreementId: tenant.agreements.housing.id }), ["recorded", "ready", bulky.id, 35_000, 35_000, null])
    // The kind's: an overflow is charged at the bulky pickup.
    const mapped = await seedTicket(pool, tenant, { resolution: "recollected", agreementId: tenant.agreements.anna.id, closedAt, kind: "overflow" })
    assert.deepEqual(await priced(mapped.id, 22, "recollected", { agreementId: tenant.agreements.anna.id }, "overflow"), ["recorded", "ready", bulky.id, 35_000, 35_000, null])
    // The completion's beats the kind's: residual collection for Anna, the row for everyone, since a ticket's event names no zone.
    const both = await seedTicket(pool, tenant, { resolution: "recollected", agreementId: tenant.agreements.anna.id, closedAt, kind: "overflow", chargeProductId: residual.id })
    assert.deepEqual(await priced(both.id, 23, "recollected", { agreementId: tenant.agreements.anna.id }, "overflow"), ["recorded", "ready", residual.id, 12_000, 12_000, null])
    // A kind charged at a product retired since: no-product, the office's to price, never a silent charge.
    const stale = await seedTicket(pool, tenant, { resolution: "serviced", agreementId: tenant.agreements.anna.id, closedAt, kind: "container-request" })
    assert.deepEqual(await priced(stale.id, 24, "serviced", { agreementId: tenant.agreements.anna.id }, "container-request"), ["recorded", "blocked", null, null, null, "no-product"])
  })

  test("a ticket-completed for a ticket reopened since is stale news and nothing, not a failed job: the row stands open with no resolution and no closing instant, and its next completion is its own event", async () => {
    const closedAt = new Date("2026-10-07T22:30:00Z")
    const reopened = await seedTicket(pool, tenant, { resolution: "recollected", agreementId: tenant.agreements.housing.id, closedAt })
    const completion = published("ticket-completed", reopened.id, ticketPayload(reopened.id, 6, "recollected", closedAt, { agreementId: tenant.agreements.housing.id }))
    // The office reopens before the consumer runs: `reopen` clears the three closing columns together (`ticket_closed_shape`), which is the row the consumer then reads.
    await withCompany(pool.db, tenant.companyId, (tx) => tx.update(ticket).set({ status: "open", resolution: null, recollectionRouteId: null, closedAt: null }).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, reopened.id))))
    const before = (await allEvents()).length
    const stale = await handle(completion)
    assert.deepEqual([stale.did, stale.billableEventId], ["nothing", null], "the payload says completed; the table says open, and the table's word stands")
    assert.equal((await allEvents()).length, before, "nothing written")
    // Completed again: the second completion's own event records, on the day it closed this time.
    const again = new Date("2026-10-09T10:00:00Z")
    await withCompany(pool.db, tenant.companyId, (tx) => tx.update(ticket).set({ status: "completed", resolution: "serviced", closedAt: again }).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, reopened.id))))
    const second = await handle(published("ticket-completed", reopened.id, ticketPayload(reopened.id, 6, "serviced", again, { agreementId: tenant.agreements.housing.id })))
    assert.equal(second.did, "recorded")
    const recorded = (await allEvents()).find((event) => event.id === second.billableEventId)
    assert.deepEqual([recorded?.kind, recorded?.serviceDate, recorded?.links.ticketId], ["ticket", "2026-10-09", reopened.id])
    assert.equal((await allEvents()).filter((event) => event.links.ticketId === reopened.id).length, 1, "the stale completion left no row; the real one left one")
  })

  test("a payload that does not parse, or one naming a row that is not there, fails the job and writes nothing", async () => {
    const before = (await allEvents()).length
    await assert.rejects(handle({ ...published("pickup-completed", testId(), { not: "a pickup" }) }), /Invalid input|expected/i)
    await assert.rejects(handle({ ...published("pickup-completed", testId(), pickupPayload(testId(), testId(), testId())) }), /which is not in company/)
    await assert.rejects(handle({ ...published("ticket-completed", testId(), ticketPayload(testId(), 9, "recollected", NOON)) }), /which is not in company/)
    // The relayed envelope itself is parsed first, by the seam: a job whose data is not an event fails before any read, and so does an event of another kind on this queue.
    const consumer = consumerOf("pickup-completed")
    const job: Job<PublishedEvent> = { id: testId(), name: consumer.queue, data: { nothing: true } as unknown as PublishedEvent, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal }
    await assert.rejects(consumer.handler([job], context()))
    await assert.rejects(consumer.handler([{ ...job, data: published("ticket-completed", testId(), ticketPayload(testId(), 9, "recollected", NOON)) }], context()), /carries a ticket-completed event/)
    assert.equal((await allEvents()).length, before)
  })

  /** Runs a test under one Pickup Exception rule of the project (#293 M5), and takes the rule and any codes away after, so no other test meets them. */
  async function underRule<T>(rule: Parameters<typeof seedExceptionRule>[2], body: () => Promise<T>): Promise<T> {
    await seedExceptionRule(pool, tenant, rule)
    try {
      return await body()
    } finally {
      await withCompany(pool.db, tenant.companyId, async (tx) => {
        await tx.update(pickup).set({ contaminantCodeId: null }).where(eq(pickup.companyId, tenant.companyId))
        await tx.delete(pickupExceptionRuleStep).where(eq(pickupExceptionRuleStep.companyId, tenant.companyId))
        await tx.delete(pickupExceptionRule).where(eq(pickupExceptionRule.companyId, tenant.companyId))
        await tx.delete(contaminantCode).where(eq(contaminantCode.companyId, tenant.companyId))
      })
    }
  }

  /** The exception charges of a pickup, oldest first. */
  const chargesOf = async (pickupId: string) => (await eventsOfPickup(pickupId)).filter((event) => event.kind === "pickup-exception")

  test("a stop missed for a reason the customer caused is charged at its rule's step once the free count is spent, its proof the evidence, once however often delivered (#293 M5)", () =>
    underRule({ outcome: "failed", freeCount: 1, ladder: [tenant.products.bulky.id] }, async () => {
      const bin = await placeBin(pool, tenant, "BIN-EXC-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
      const earlier = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, status: "failed" }], "2026-09-28")
      const later = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, status: "failed" }])
      const [first] = earlier.pickupIds
      const [second] = later.pickupIds
      const free = await handle(published("pickup-failed", first, pickupPayload(earlier.id, first, bin.containerId, "failed")))
      assert.deepEqual([free.did, free.actions], ["nothing", []], "the first is free")
      assert.deepEqual(await eventsOfPickup(first), [])

      const proof = await seedCorrectionProof(pool, tenant, { routeId: later.id, pickupId: second }, "failed")
      const failed = published("pickup-failed", second, pickupPayload(later.id, second, bin.containerId, "failed"))
      const charged = await handle(failed)
      assert.equal(charged.did, "recorded")
      const [fee] = await chargesOf(second)
      assert.deepEqual(
        [fee.kind, fee.status, fee.productId, fee.agreementId, fee.subscriptionId, fee.netMinor, fee.links.proofId, fee.links.pickupId, fee.sourceEventId],
        ["pickup-exception", "ready", tenant.products.bulky.id, tenant.agreements.anna.id, bin.subscriptionId, tenant.priceList.rows.bulky.unitPriceMinor, proof.id, second, failed.id],
      )
      assert.equal((await handle(failed)).did, "nothing", "already charged: the live charge stands")
      assert.equal((await chargesOf(second)).length, 1)
    }))

  test("a tagged collection is two charges from one event, each its own row under the widened key, and a correction to plain completed cancels the exception's alone (#293 M5)", () =>
    underRule({ outcome: "completed", freeCount: 0, ladder: [tenant.products.bulky.id] }, async () => {
      const bin = await placeBin(pool, tenant, "BIN-EXC-2", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
      const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
      const [pickupId] = seeded.pickupIds
      const codeId = testId()
      await withCompany(pool.db, tenant.companyId, async (tx) => {
        await tx.insert(contaminantCode).values({ id: codeId, companyId: tenant.companyId, code: "plastic", name: "Plastic in residual", status: "active" })
        await tx.update(pickup).set({ contaminantCodeId: codeId }).where(eq(pickup.id, pickupId))
      })
      const completion = published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId))
      const both = await handle(completion)
      assert.deepEqual(both.actions.map((action) => action.did), ["recorded", "recorded"])
      assert.deepEqual((await eventsOfPickup(pickupId)).map((event) => [event.kind, event.sourceEventId]), [["pickup", completion.id], ["pickup-exception", completion.id]], "one outbox event, a row of each kind")
      const again = await handle(completion)
      assert.deepEqual(again.actions, [], "redelivered: both charges live, nothing more")

      // The office takes the tag back: the collection stands, the exception's charge is cancelled with the consumer's reason.
      await withCompany(pool.db, tenant.companyId, (tx) => tx.update(pickup).set({ contaminantCodeId: null }).where(eq(pickup.id, pickupId)))
      const untagged = await handle(published("pickup-corrected", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
      assert.deepEqual(untagged.actions.map((action) => action.did), ["cancelled"])
      const [collection, exception] = await eventsOfPickup(pickupId)
      assert.deepEqual([collection.status, exception.status, exception.cancelReason], ["ready", "cancelled", "pickup-corrected"])
    }))

  test("one correction reverses a pickup's two invoiced charges, each keyed by the event it undoes, once however often delivered (#293 M5)", () =>
    underRule({ outcome: "completed", freeCount: 0, ladder: [tenant.products.bulky.id] }, async () => {
      const bin = await placeBin(pool, tenant, "BIN-EXC-3", { agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id })
      const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId }])
      const [pickupId] = seeded.pickupIds
      const codeId = testId()
      await withCompany(pool.db, tenant.companyId, async (tx) => {
        await tx.insert(contaminantCode).values({ id: codeId, companyId: tenant.companyId, code: "food", name: "Food in paper", status: "active" })
        await tx.update(pickup).set({ contaminantCodeId: codeId }).where(eq(pickup.id, pickupId))
      })
      await handle(published("pickup-completed", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId)))
      const [collection, exception] = await eventsOfPickup(pickupId)
      await invoiced(collection)
      await invoiced(exception)

      // Corrected to a stop not presented, which no rule here charges: both invoiced charges are reversed by the one event.
      await withCompany(pool.db, tenant.companyId, (tx) => tx.update(pickup).set({ contaminantCodeId: null }).where(eq(pickup.id, pickupId)))
      await movePickup(pool, tenant, pickupId, "failed")
      const correction = published("pickup-corrected", pickupId, pickupPayload(seeded.id, pickupId, bin.containerId, "failed"))
      const done = await handle(correction)
      assert.deepEqual(done.actions.map((action) => action.did), ["reversed", "reversed"])
      const reversals = (await allEvents()).filter((event) => event.kind === "reversal" && event.sourceEventId === correction.id)
      assert.deepEqual(reversals.map((event) => event.links.reversesEventId).sort(), [collection.id, exception.id].sort())
      const again = await handle(correction)
      assert.deepEqual(again.actions, [], "redelivered: both are reversed, nothing is live")
      assert.equal((await allEvents()).filter((event) => event.kind === "reversal" && event.sourceEventId === correction.id).length, 2)
    }))
})

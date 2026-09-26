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

import type { BillableEvent } from "@waste/contracts/billable-events"
import { createDb, type Database } from "@waste/db/client"
import { eventOf, eventsFrom } from "@waste/db/commands/billing-shapes"
import { issueInvoice } from "@waste/db/commands/invoice-writes"
import { newId } from "@waste/db/ids"
import { billableEvent, billingRun } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import type { Job } from "pg-boss"
import { and, asc, eq } from "drizzle-orm"

import type { JobContext } from "../jobs"
import { FINANCE_EVENT_KINDS, recordBillableEvents, type Recorded } from "../jobs/record-billable-events"
import type { PublishedEvent } from "../outbox/queues"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, dropFinanceTenant, FIXTURE_DAY, movePickup, placeBin, seedCompletedRoute, seedFinanceTenant, seedTicket, testId, type FinanceTenant } from "./finance-tenant"

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
    publish: async () => undefined,
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
  const pickupPayload = (routeId: string, pickupId: string, containerId: string, status: "completed" | "skipped" | "failed" = "completed") => ({
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

  /** Runs the handler over one published event, as pg-boss would hand it in, and answers what it did. */
  const handle = async (event: PublishedEvent): Promise<Recorded> => {
    const job: Job<PublishedEvent> = { id: testId(), name: recordBillableEvents.queue, data: event, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal }
    const output = (await recordBillableEvents.handler([job], context())) as { outcomes: Recorded[] }
    assert.equal(output.outcomes.length, 1)
    return output.outcomes[0]
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
        draft: { projectId: tenant.projects.copenhagen.id, kind: "invoice", customerId: tenant.customers.housing.id, currency: "DKK", issuedOn: "2026-10-06", dueOn: "2026-11-05", periodFrom: event.serviceDate, periodTo: event.serviceDate, billingRunId: run.id, creditsInvoiceId: null, creditReason: null, creditNote: null, issuedBy: tenant.users.olivia.id },
        lines: [{ billableEventId: event.id, creditsLineId: null, description: `Restaffald 240 L · ${event.serviceDate}`, productId: event.productId, serviceDate: event.serviceDate, quantity: event.quantity, unitPriceMinor: event.unitPriceMinor ?? 0, netMinor: event.netMinor ?? 0, vatPercent: event.vatPercent ?? 0, vatMinor: event.vatMinor ?? 0 }],
        newId,
        now: () => NOON,
      })
    })
  }

  test("subscribes to the three kinds Finance reads and no other, and names its queue as the issue does", () => {
    assert.equal(recordBillableEvents.queue, "finance.record-billable-events")
    assert.deepEqual([...FINANCE_EVENT_KINDS], ["pickup-completed", "pickup-corrected", "ticket-completed"])
    assert.deepEqual(recordBillableEvents.subscribes, FINANCE_EVENT_KINDS)
    assert.equal(recordBillableEvents.schedule, undefined, "sent by the relay, never by a cron")
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
    assert.deepEqual(recorded.links, { routeId: seeded.id, pickupId, ticketId: null, reversesEventId: null })
    assert.deepEqual([recorded.createdBy, recorded.sourceEventId, recorded.blockReason, recorded.cancelledAt], [null, event.id, null, null])

    // At-least-once: the same job again is one row. The redelivery finds the pickup's live event and the domain says nothing; the index behind it (`billable_event_source_event_id_idx`) is the word for the race two workers make, proved below on the reversal.
    const again = await handle(event)
    assert.deepEqual([again.did, again.billableEventId], ["nothing", null])
    assert.equal((await eventsOfPickup(pickupId)).length, 1)
    assert.match(lines.at(-1) ?? "", /pickup-completed .* → nothing \(job /)
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
    assert.deepEqual(reversal.links, { routeId: null, pickupId: null, ticketId: null, reversesEventId: original.id })
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
    assert.deepEqual(recorded.links, { routeId: null, pickupId: null, ticketId: direct.id, reversesEventId: null })

    // Through the pickup it names: the placement's agreement on the route's service date, with that placement's subscription.
    const bin = await placeBin(pool, tenant, "BIN-TICKET-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const seeded = await seedCompletedRoute(pool, tenant, [{ containerId: bin.containerId, propertyId: bin.propertyId, status: "failed" }])
    const viaPickup = await seedTicket(pool, tenant, { resolution: "serviced", pickup: { routeId: seeded.id, pickupId: seeded.pickupIds[0] } })
    const second = await handle(published("ticket-completed", viaPickup.id, ticketPayload(viaPickup.id, 2, "serviced", closedAt, { routeId: seeded.id, pickupId: seeded.pickupIds[0] })))
    const reached = (await allEvents()).find((event) => event.id === second.billableEventId)
    assert.deepEqual([second.did, reached?.agreementId, reached?.subscriptionId, reached?.links.ticketId], ["recorded", tenant.agreements.anna.id, bin.subscriptionId, viaPickup.id])

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
    assert.equal((await allEvents()).filter((event) => event.kind === "ticket").length, 3)
  })

  test("a payload that does not parse, or one naming a row that is not there, fails the job and writes nothing", async () => {
    const before = (await allEvents()).length
    await assert.rejects(handle({ ...published("pickup-completed", testId(), { not: "a pickup" }) }), /Invalid input|expected/i)
    await assert.rejects(handle({ ...published("pickup-completed", testId(), pickupPayload(testId(), testId(), testId())) }), /which is not in company/)
    await assert.rejects(handle({ ...published("ticket-completed", testId(), ticketPayload(testId(), 9, "recollected", NOON)) }), /which is not in company/)
    // The published envelope itself is parsed first: a job whose data is not an event fails before any read.
    const job: Job<PublishedEvent> = { id: testId(), name: recordBillableEvents.queue, data: { nothing: true } as unknown as PublishedEvent, expireInSeconds: 900, heartbeatSeconds: null, signal: new AbortController().signal }
    await assert.rejects(recordBillableEvents.handler([job], context()))
    assert.equal((await allEvents()).length, before)
  })
})

// The outbox's first consumer against Postgres (Issue #109 §6, part B), on the
// shared local database with a tenant of this file's own: each of the four
// kinds becomes the ticket §3's table says — its kind, priority, source, the
// subject spelled from what was read beside the payload, the links the event
// named, `created_by` null and `source_event_id` the event's — with its
// `created` row and its `ticket-opened` event as `wms_api`; a driver's own
// skip (`not-presented`) completes with nothing written; a replay of the same
// event opens no second ticket, through the read and through the key alike;
// two rejections of one driver are one ticket and one comment, in either
// order and under two workers at once, and a stop's events are one case
// the same way whatever order they arrive in (#258) — a problem folds into
// the stop's open case, never into a rejected command naming the stop, and a
// missed collection supersedes the stop's open problem: its duplicate while
// nobody has touched it, named from both sides when the office works it; a
// case the office closes meanwhile is never written on; a problem on the route alone links no
// container and no place; a payload that does not parse throws, so pg-boss
// fails the job. The rule itself (`ticketFor`) is the domain's and proved
// there over every kind and reason; here the question is whether the job
// reads the right facts, writes through `openTicket` fenced as the tenant,
// and is idempotent by the event's id. The handler is called directly with
// the job's data, since what pg-boss does with a queue is boot.test.ts's to
// prove; the one wiring fact this file holds is the registry's four entries,
// one per kind on the queue the relay publishes, and boot.test.ts holds that
// a `RelayedEvent` sent there is worked by them.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { newId } from "@waste/db/ids"
import { appendTicketEvent, openTicket } from "@waste/db/commands/open-ticket"
import { outboxEvent } from "@waste/db/schema/execution"
import { driver } from "@waste/db/schema/fleet"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { OPEN_TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, inArray, sql } from "drizzle-orm"

import { JOBS } from "../jobs"
import { OPEN_TICKETS_QUEUE_OPTIONS, openTicketFor, openTickets, RESOLUTION_KINDS, type OpenTicketsOutcome } from "../jobs/open-tickets"
import { CONSUMED_OUTBOX_QUEUE_OPTIONS, outboxQueue } from "../outbox/subscribe"
import { at, dropConsumerTenant, outboxJob, pickupPayload, proofPayload, receiptPayload, routePayload, seedConsumerTenant, seedReceipt, seedRoute, testId, type ConsumerTenant } from "./consumer-fixtures"
import { databaseUnderTest, ownerUnderTest } from "./database"

const api = databaseUnderTest()
const owner = ownerUnderTest()

describe("resolution.open-tickets", { skip: api.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let tenant: ConsumerTenant
  const lines: string[] = []
  const NOW = at("13:30")
  const context = () => ({ api: pool, now: () => NOW, log: (line: string) => void lines.push(line) })

  before(async () => {
    pool = createDb(api.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    tenant = await seedConsumerTenant(pool)
  })
  after(async () => {
    if (tenant !== undefined) await dropConsumerTenant(pool, ownerPool, tenant.companyId)
    await pool?.close()
    await ownerPool?.close()
  })

  /** The tickets of the tenant made from an event, with their history and their outbox rows, read as `wms_api` under the fence. */
  const ticketsFrom = async (sourceEventId: string) =>
    withCompany(pool.db, tenant.companyId, async (tx) => {
      const rows = await tx.select().from(ticket).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.sourceEventId, sourceEventId))).orderBy(asc(ticket.id))
      return rows
    })
  const historyOf = async (ticketId: string) => withCompany(pool.db, tenant.companyId, (tx) => tx.select().from(ticketEvent).where(and(eq(ticketEvent.companyId, tenant.companyId), eq(ticketEvent.ticketId, ticketId))).orderBy(asc(ticketEvent.id)))
  const outboxAbout = async (ticketId: string) => withCompany(pool.db, tenant.companyId, (tx) => tx.select().from(outboxEvent).where(and(eq(outboxEvent.companyId, tenant.companyId), eq(outboxEvent.aggregateId, ticketId))).orderBy(asc(outboxEvent.id)))
  const ticketById = async (id: string) => withCompany(pool.db, tenant.companyId, async (tx) => (await tx.select().from(ticket).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, id))))[0])

  test("is in the registry, one entry per kind Resolution reads on the queue the relay publishes and none for route-cancelled, with a retry policy", () => {
    assert.deepEqual(RESOLUTION_KINDS, ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"])
    assert.deepEqual(
      openTickets.map((job) => job.queue),
      ["outbox.pickup-failed", "outbox.pickup-skipped", "outbox.pickup-problem-reported", "outbox.command-rejected"],
    )
    for (const job of openTickets) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.equal(job.schedule, undefined, "sent by the relay, never by a clock")
      assert.deepEqual(job.queueOptions, { ...CONSUMED_OUTBOX_QUEUE_OPTIONS, ...OPEN_TICKETS_QUEUE_OPTIONS }, "the consumer's retry policy over the seam's dead letter and retention")
    }
    assert.deepEqual(OPEN_TICKETS_QUEUE_OPTIONS, { retryLimit: 3, retryDelay: 5, retryBackoff: true })
    assert.ok(!openTickets.some((job) => job.queue === outboxQueue("route-cancelled")), "§7.10: a cancellation makes no ticket of its own")
  })

  test("a pickup-failed opens one missed-collection ticket, high, from the driver app, naming the stop, its container, its address and the route's actual driver, with created_by null and the event's id, a created row and a ticket-opened event", async () => {
    const seeded = await seedRoute(pool, tenant)
    const [failedId] = seeded.pickupIds
    const proof = proofPayload(tenant, seeded.id, failedId, "failure", { reason: "not-presented", note: "No bin at the kerb", recordedBy: testId() })
    const event = outboxJob(tenant, { kind: "pickup-failed", aggregateKind: "pickup", aggregateId: failedId, payload: pickupPayload(tenant, seeded.id, failedId, { container: "bin1", status: "failed", reason: "not-presented", note: "No bin at the kerb" }, [proof]) })

    const outcome = await openTicketFor(event, context())
    assert.equal(outcome.outcome, "opened")
    const made = await ticketsFrom(event.id)
    assert.equal(made.length, 1)
    const [row] = made
    assert.equal(row.id, (outcome as { ticketId: string }).ticketId)
    assert.deepEqual(
      [row.kind, row.priority, row.source, row.status, row.subject, row.description],
      ["missed-collection", "high", "driver-app", "open", "Missed collection: BIN-1 at Parkvej 18, 2100 København Ø", "The driver could not collect this stop. Reason: not-presented. Note: No bin at the kerb"],
    )
    assert.deepEqual(
      [row.routeId, row.pickupId, row.containerId, row.propertyId, row.sharedCollectionPointId, row.driverId, row.customerId, row.agreementId, row.parentTicketId],
      [seeded.id, failedId, tenant.containers.bin1.id, tenant.properties.parkvej.id, null, tenant.driverId, tenant.customerId, tenant.agreementId, null],
      "the links the event named, the driver the route's actual one, and the customer and agreement BIN-1 served under on the service date",
    )
    assert.deepEqual([row.createdBy, row.sourceEventId, row.assigneeUserAccountId, row.dueAt, row.projectId], [null, event.id, null, null, tenant.projectId], "an event's ticket: nobody's, the event's id, no SLA")
    assert.equal(row.occurredAt.toISOString(), event.occurredAt, "when it happened is the event's instant")
    assert.ok(row.number >= 1000, "numbered from the company's counter")

    const history = await historyOf(row.id)
    assert.deepEqual(
      history.map((entry) => [entry.kind, entry.status, entry.recordedBy, entry.sourceEventId, entry.body]),
      [["created", "open", null, null, null]],
      "one created row, nobody's; the source event is the ticket's key and not the created row's",
    )
    const emitted = await outboxAbout(row.id)
    assert.deepEqual(
      emitted.map((entry) => [entry.kind, entry.aggregateKind, entry.projectId, entry.occurredAt.toISOString()]),
      [["ticket-opened", "ticket", tenant.projectId, NOW.toISOString()]],
      "ticket-opened emitted in the same transaction, at the worker's clock",
    )
    const payload = emitted[0].payload as { id: string; label: string; createdBy: string | null; sourceEventId: string | null; links: { pickupId: string | null } }
    assert.deepEqual([payload.id, payload.label, payload.createdBy, payload.sourceEventId, payload.links.pickupId], [row.id, `T-${row.number}`, null, event.id, failedId], "the payload is the Ticket as the route would answer it")
    assert.match(lines.at(-1)!, new RegExp(`^resolution\\.open-tickets: pickup-failed ${event.id} → opened \\(ticket ${row.id}\\)$`))
  })

  test("a pickup-skipped closed by the route's end is a medium missed-collection from the driver app with the actual driver; one by the dispatcher's cancellation is from dispatch with the planned driver, since nobody started a cancelled route", async () => {
    const ended = await seedRoute(pool, tenant)
    const [, endedStop] = ended.pickupIds
    const endedEvent = outboxJob(tenant, { kind: "pickup-skipped", aggregateKind: "pickup", aggregateId: endedStop, payload: pickupPayload(tenant, ended.id, endedStop, { container: "bin2", status: "skipped", reason: "route-ended", position: 2 }, []) })
    assert.equal((await openTicketFor(endedEvent, context())).outcome, "opened")
    const [byEnd] = await ticketsFrom(endedEvent.id)
    assert.deepEqual([byEnd.kind, byEnd.priority, byEnd.source, byEnd.subject, byEnd.driverId, byEnd.containerId, byEnd.propertyId], ["missed-collection", "medium", "driver-app", "Missed collection: BIN-2 at Havnegade 3, 1058 København K", tenant.driverId, tenant.containers.bin2.id, tenant.properties.havnegade.id])
    assert.deepEqual([byEnd.customerId, byEnd.agreementId], [null, null], "BIN-2 served under no agreement that day")
    assert.equal(byEnd.description, "The route ended before this stop was collected. Reason: route-ended.")

    const cancelled = await seedRoute(pool, tenant, { status: "cancelled", pickups: [{ container: "bin1", status: "skipped", reason: "route-cancelled" }] })
    const [cancelledStop] = cancelled.pickupIds
    // The office's cancellation emits the bare Pickup, no proofs beside it (routes/routes.ts).
    const cancelledEvent = outboxJob(tenant, { kind: "pickup-skipped", aggregateKind: "pickup", aggregateId: cancelledStop, payload: pickupPayload(tenant, cancelled.id, cancelledStop, { container: "bin1", status: "skipped", reason: "route-cancelled" }) })
    assert.equal((await openTicketFor(cancelledEvent, context())).outcome, "opened")
    const [byCancel] = await ticketsFrom(cancelledEvent.id)
    assert.deepEqual([byCancel.kind, byCancel.priority, byCancel.source, byCancel.driverId, byCancel.routeId, byCancel.pickupId], ["missed-collection", "medium", "dispatch", tenant.driverId, cancelled.id, cancelledStop], "a cancelled route's actual driver is nobody, so the planned one is named")
  })

  test("a driver's own skip makes no ticket, writes nothing, and completes", async () => {
    const seeded = await seedRoute(pool, tenant, { pickups: [{ container: "bin1", status: "skipped", reason: "not-presented", note: "Nothing out" }] })
    const [stop] = seeded.pickupIds
    const event = outboxJob(tenant, { kind: "pickup-skipped", aggregateKind: "pickup", aggregateId: stop, payload: pickupPayload(tenant, seeded.id, stop, { container: "bin1", status: "skipped", reason: "not-presented", note: "Nothing out" }, [proofPayload(tenant, seeded.id, stop, "skip", { reason: "not-presented", note: "Nothing out", recordedBy: testId() })]) })
    assert.deepEqual(await openTicketFor(event, context()), { outcome: "nothing" })
    assert.deepEqual(await ticketsFrom(event.id), [])
    const removed = outboxJob(tenant, { kind: "pickup-skipped", aggregateKind: "pickup", aggregateId: stop, payload: pickupPayload(tenant, seeded.id, stop, { container: "bin1", status: "skipped", reason: "removed-by-dispatcher", note: "Bin collected on Friday" }) })
    assert.deepEqual(await openTicketFor(removed, context()), { outcome: "nothing" }, "a dispatcher's removal is a decision too")
    assert.deepEqual(await ticketsFrom(removed.id), [])
  })

  test("a pickup-problem-reported on a stop is a medium reported-problem naming the stop; on the route alone it names the route and the driver and no container and no place, whatever the route's stops have", async () => {
    const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    const [stop] = seeded.pickupIds
    const onStop = outboxJob(tenant, {
      kind: "pickup-problem-reported",
      aggregateKind: "pickup",
      aggregateId: stop,
      payload: pickupPayload(tenant, seeded.id, stop, { container: "bin1", status: "planned" }, [proofPayload(tenant, seeded.id, stop, "problem", { reason: "inaccessible", note: "Car parked in front of the bin", recordedBy: testId() })]),
    })
    assert.equal((await openTicketFor(onStop, context())).outcome, "opened")
    const [stopTicket] = await ticketsFrom(onStop.id)
    assert.deepEqual(
      [stopTicket.kind, stopTicket.priority, stopTicket.source, stopTicket.subject, stopTicket.description, stopTicket.routeId, stopTicket.pickupId, stopTicket.containerId, stopTicket.propertyId, stopTicket.driverId],
      ["reported-problem", "medium", "driver-app", "Problem reported: inaccessible at BIN-1", "The driver reported a problem. Reason: inaccessible. Note: Car parked in front of the bin", seeded.id, stop, tenant.containers.bin1.id, tenant.properties.parkvej.id, tenant.driverId],
    )

    const onRoute = outboxJob(tenant, {
      kind: "pickup-problem-reported",
      aggregateKind: "route",
      aggregateId: seeded.id,
      payload: { ...routePayload(tenant, seeded), proofs: [proofPayload(tenant, seeded.id, null, "problem", { reason: "safety", note: "Road closed at the harbour", recordedBy: testId() })] },
    })
    assert.equal((await openTicketFor(onRoute, context())).outcome, "opened")
    const [routeTicket] = await ticketsFrom(onRoute.id)
    assert.deepEqual(
      [routeTicket.kind, routeTicket.subject, routeTicket.routeId, routeTicket.pickupId, routeTicket.containerId, routeTicket.propertyId, routeTicket.sharedCollectionPointId, routeTicket.driverId],
      ["reported-problem", "Problem reported: safety", seeded.id, null, null, null, null, tenant.driverId],
      "on the route alone: no stop, so no container and no place",
    )
    assert.deepEqual([routeTicket.customerId, routeTicket.agreementId], [null, null], "nor a customer or an agreement")
    assert.deepEqual(
      [stopTicket.customerId, stopTicket.agreementId],
      [tenant.customerId, tenant.agreementId],
      "a problem on a stop names whom the stop served",
    )
    assert.equal(routeTicket.description, "The driver reported a problem. Reason: safety. Note: Road closed at the harbour")

    // A payload the outbox took before the route had its hold (#209) carries no `heldAt`, and is still a ticket rather than a dead letter.
    const { heldAt: _heldAt, ...before209 } = routePayload(tenant, seeded)
    const older = outboxJob(tenant, {
      kind: "pickup-problem-reported",
      aggregateKind: "route",
      aggregateId: seeded.id,
      payload: { ...before209, proofs: [proofPayload(tenant, seeded.id, null, "problem", { reason: "safety", note: "Bridge closed", recordedBy: testId() })] },
    })
    assert.equal((await openTicketFor(older, context())).outcome, "opened")
  })

  test("a command-rejected opens a low rejected-command ticket of the driver's naming the receipt's route and pickup; one for a route the driver does not reach names no route", async () => {
    const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }] })
    const [stop] = seeded.pickupIds
    const receipt = receiptPayload(tenant, { routeId: seeded.id, pickupId: stop, detail: "Pickup 1 is already completed", driverId: tenant.otherDriverId })
    await seedReceipt(pool, tenant, receipt)
    const event = outboxJob(tenant, { kind: "command-rejected", aggregateKind: "command", aggregateId: receipt.id, payload: receipt })
    assert.equal((await openTicketFor(event, context())).outcome, "opened")
    const [row] = await ticketsFrom(event.id)
    assert.deepEqual(
      [row.kind, row.priority, row.source, row.subject, row.description, row.routeId, row.pickupId, row.driverId, row.containerId],
      ["rejected-command", "low", "driver-app", "Rejected command: Pickup 1 is already completed", "The driver's device sent a command the server refused. Note: Pickup 1 is already completed", seeded.id, stop, tenant.otherDriverId, null],
    )

    const unreached = receiptPayload(tenant, { routeId: null, detail: `No route ${testId()} is assigned to this driver`, status: 404, driverId: tenant.otherDriverId })
    await seedReceipt(pool, tenant, unreached)
    const second = outboxJob(tenant, { kind: "command-rejected", aggregateKind: "command", aggregateId: unreached.id, payload: unreached })
    const outcome = await openTicketFor(second, context())
    assert.equal(outcome.outcome, "commented", "the driver already has an open rejected-command ticket, so the second rejection folds into it")
    assert.equal((outcome as { ticketId: string }).ticketId, row.id)
  })

  test("two rejections of one driver are one ticket and two lines: the first opens, the second and third comment with the event's id, the case's row untouched", async () => {
    const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    const receipts = [
      receiptPayload(tenant, { routeId: seeded.id, pickupId: seeded.pickupIds[0], detail: "Pickup 1 is already completed" }),
      receiptPayload(tenant, { routeId: seeded.id, pickupId: seeded.pickupIds[1], detail: "Pickup 2 is already skipped" }),
      receiptPayload(tenant, { routeId: seeded.id, detail: `Route ${seeded.label} is completed and does not change` }),
    ]
    for (const receipt of receipts) await seedReceipt(pool, tenant, receipt)
    const events = receipts.map((receipt) => outboxJob(tenant, { kind: "command-rejected", aggregateKind: "command", aggregateId: receipt.id, payload: receipt }))

    const outcomes: OpenTicketsOutcome[] = []
    for (const event of events) outcomes.push(await openTicketFor(event, context()))
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome),
      ["opened", "commented", "commented"],
    )
    const ticketId = (outcomes[0] as { ticketId: string }).ticketId
    assert.ok(outcomes.every((outcome) => "ticketId" in outcome && outcome.ticketId === ticketId), "every rejection lands on the one case")
    assert.deepEqual((await ticketsFrom(events[0].id)).map((row) => row.id), [ticketId])
    assert.deepEqual(await ticketsFrom(events[1].id), [], "the second rejection opened nothing of its own")
    assert.deepEqual(await ticketsFrom(events[2].id), [])

    const history = await historyOf(ticketId)
    assert.deepEqual(
      history.map((entry) => [entry.kind, entry.status, entry.visibility, entry.recordedBy, entry.sourceEventId, entry.body]),
      [
        ["created", "open", "internal", null, null, null],
        ["comment", "open", "internal", null, events[1].id, "The driver's device sent a command the server refused. Note: Pickup 2 is already skipped"],
        ["comment", "open", "internal", null, events[2].id, `The driver's device sent a command the server refused. Note: Route ${seeded.label} is completed and does not change`],
      ],
      "one created row and one comment per folded event, each carrying the event's id",
    )
    const row = await ticketById(ticketId)
    assert.equal(row.subject, "Rejected command: Pickup 1 is already completed", "the case is the first rejection's; a comment moves nothing of the row")
    assert.deepEqual((await outboxAbout(ticketId)).map((entry) => entry.kind), ["ticket-opened"], "one ticket-opened for the case, and none for a comment")
  })

  test("two rejections of one driver arriving together, under two workers, make one ticket and one comment: the second waits on the driver's key and reads what the first committed", async () => {
    const other = createDb(api.url, { max: 2 })
    try {
      const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }] })
      const fresh = testId()
      // A driver of their own for this race, so the fold has no open ticket to find before it starts.
      await withCompany(pool.db, tenant.companyId, async (tx) => {
        await tx.insert(driver).values({ id: fresh, companyId: tenant.companyId, projectId: tenant.projectId, name: "Race Driver", employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
      })
      const receipts = [receiptPayload(tenant, { routeId: seeded.id, detail: "Route is not active", driverId: fresh }), receiptPayload(tenant, { routeId: seeded.id, detail: "Route is still not active", driverId: fresh })]
      for (const receipt of receipts) await seedReceipt(pool, tenant, receipt)
      const events = receipts.map((receipt) => outboxJob(tenant, { kind: "command-rejected", aggregateKind: "command", aggregateId: receipt.id, payload: receipt }))
      const [first, second] = await Promise.all([openTicketFor(events[0], context()), openTicketFor(events[1], { ...context(), api: other })])
      const outcomes = [first.outcome, second.outcome].sort()
      assert.deepEqual(outcomes, ["commented", "opened"], "one opened, one commented, whichever went first")
      const ticketId = (first as { ticketId: string }).ticketId
      assert.equal((second as { ticketId: string }).ticketId, ticketId)
      const history = await historyOf(ticketId)
      assert.deepEqual(history.map((entry) => entry.kind), ["created", "comment"])
      assert.deepEqual(
        history.map((entry) => entry.sourceEventId).filter((id) => id !== null).sort(),
        [events[first.outcome === "opened" ? 1 : 0].id],
        "the comment carries the loser's event id; the winner's is the ticket's",
      )
    } finally {
      await other.close()
    }
  })

  /** Polls `holds` until it does, or fails with `what` after five seconds. */
  const expectEventually = async (holds: () => Promise<boolean>, what: string) => {
    for (const started = Date.now(); Date.now() - started < 5_000; await new Promise((resolve) => setTimeout(resolve, 25))) if (await holds()) return
    assert.fail(what)
  }

  /** A driver of the tenant's with no ticket yet, so a rejection of theirs opens one. */
  const driverOfItsOwn = async (name: string) => {
    const id = testId()
    await withCompany(pool.db, tenant.companyId, async (tx) => {
      await tx.insert(driver).values({ id, companyId: tenant.companyId, projectId: tenant.projectId, name, employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
    })
    return id
  }
  /** The stop's open cases, oldest first. */
  const openCasesOf = async (pickupId: string) =>
    withCompany(pool.db, tenant.companyId, (tx) =>
      tx.select().from(ticket).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.pickupId, pickupId), inArray(ticket.status, [...OPEN_TICKET_STATUSES]))).orderBy(asc(ticket.id)),
    )

  /** A problem the driver reports on a stop, with the problem proof the command made. */
  const problemOn = (seeded: { id: string }, stop: string, container: "bin1" | "bin2", note: string, status: "planned" | "failed" = "failed") =>
    outboxJob(tenant, {
      kind: "pickup-problem-reported",
      aggregateKind: "pickup",
      aggregateId: stop,
      payload: pickupPayload(tenant, seeded.id, stop, { container, status }, [proofPayload(tenant, seeded.id, stop, "problem", { reason: "inaccessible", note, recordedBy: testId() })]),
    })
  const failureOn = (seeded: { id: string }, stop: string, container: "bin1" | "bin2") =>
    outboxJob(tenant, {
      kind: "pickup-failed",
      aggregateKind: "pickup",
      aggregateId: stop,
      payload: pickupPayload(tenant, seeded.id, stop, { container, status: "failed", reason: "inaccessible", note: "Gate locked" }, [proofPayload(tenant, seeded.id, stop, "failure", { reason: "inaccessible", note: "Gate locked", recordedBy: testId() })]),
    })

  // #258: a stop the driver fails and then reports a problem on, to ask for a recollection, is one case — the problem
  // folds into the stop's open case as a comment, as a rejection folds into the driver's.
  test("a problem reported on a stop whose failure is an open case folds into it, a comment carrying the reason and the note: one case per stop", async () => {
    const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "failed", reason: "inaccessible", note: "Gate locked" }] })
    const [stop] = seeded.pickupIds
    const failed = failureOn(seeded, stop, "bin1")
    const opened = await openTicketFor(failed, context())
    assert.equal(opened.outcome, "opened")
    const ticketId = (opened as { ticketId: string }).ticketId

    const problems = [problemOn(seeded, stop, "bin1", "Please send someone back today"), problemOn(seeded, stop, "bin1", "The gate is open now")]
    for (const problem of problems) assert.deepEqual(await openTicketFor(problem, context()), { outcome: "commented", ticketId })
    for (const problem of problems) assert.deepEqual(await ticketsFrom(problem.id), [], "the problem opened nothing of its own")
    const history = await historyOf(ticketId)
    assert.deepEqual(
      history.map((entry) => [entry.kind, entry.status, entry.visibility, entry.recordedBy, entry.sourceEventId, entry.body]),
      [
        ["created", "open", "internal", null, null, null],
        ["comment", "open", "internal", null, problems[0].id, "The driver reported a problem. Reason: inaccessible. Note: Please send someone back today"],
        ["comment", "open", "internal", null, problems[1].id, "The driver reported a problem. Reason: inaccessible. Note: The gate is open now"],
      ],
    )
    const row = await ticketById(ticketId)
    assert.deepEqual([row.kind, row.subject], ["missed-collection", "Missed collection: BIN-1 at Parkvej 18, 2100 København Ø"], "the case is the failure's; a comment moves nothing of the row")
    assert.deepEqual((await outboxAbout(ticketId)).map((entry) => entry.kind), ["ticket-opened"], "one ticket-opened for the case, and none for a comment")
    assert.match(lines.at(-1)!, new RegExp(`^resolution\\.open-tickets: pickup-problem-reported ${problems[1].id} → commented \\(ticket ${ticketId}\\)$`))
    assert.deepEqual(await openTicketFor(problems[0], context()), { outcome: "replayed", ticketId }, "a folded problem delivered again comments no second time")
    assert.equal((await historyOf(ticketId)).length, 3)
  })

  test("a problem on a stop with no open case of its own opens one: the stop's case closed, another stop's case, or a rejected command naming the stop", async () => {
    const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "failed", reason: "inaccessible" }, { container: "bin2", status: "planned" }] })
    const [failedStop, otherStop] = seeded.pickupIds
    const failed = await openTicketFor(failureOn(seeded, failedStop, "bin1"), context())
    const failedTicket = (failed as { ticketId: string }).ticketId

    const elsewhere = await openTicketFor(problemOn(seeded, otherStop, "bin2", "Bin behind a locked fence", "planned"), context())
    assert.equal(elsewhere.outcome, "opened", "another stop's case is not this one's")
    assert.notEqual((elsewhere as { ticketId: string }).ticketId, failedTicket)

    await withCompany(pool.db, tenant.companyId, (tx) => tx.update(ticket).set({ status: "rejected", closedAt: NOW }).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, failedTicket))))
    const afterClosed = await openTicketFor(problemOn(seeded, failedStop, "bin1", "Still locked"), context())
    assert.equal(afterClosed.outcome, "opened", "a closed case is closed: the problem is a case of its own")
    assert.equal((await ticketById((afterClosed as { ticketId: string }).ticketId)).kind, "reported-problem")

    // A rejected command naming a stop is the driver's device case, never the stop's: a driver of its own, so the rejection opens a ticket naming the stop.
    const rejectedStop = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin2", status: "planned" }] })
    const [stop] = rejectedStop.pickupIds
    const device = await driverOfItsOwn("Device Driver")
    const receipt = receiptPayload(tenant, { routeId: rejectedStop.id, pickupId: stop, detail: "Pickup 1 is already completed", driverId: device })
    await seedReceipt(pool, tenant, receipt)
    const rejection = await openTicketFor(outboxJob(tenant, { kind: "command-rejected", aggregateKind: "command", aggregateId: receipt.id, payload: receipt }), context())
    assert.equal(rejection.outcome, "opened")
    assert.deepEqual([(await ticketById((rejection as { ticketId: string }).ticketId)).kind, (await ticketById((rejection as { ticketId: string }).ticketId)).pickupId], ["rejected-command", stop])
    const problem = await openTicketFor(problemOn(rejectedStop, stop, "bin2", "Container stuck in the ice", "planned"), context())
    assert.equal(problem.outcome, "opened")
    assert.notEqual((problem as { ticketId: string }).ticketId, (rejection as { ticketId: string }).ticketId)
  })

  test("a failure on a stop whose problem nobody has touched opens the missed collection and completes the problem as its duplicate, as the office's complete writes it, the problem's words copied over", async () => {
    const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "failed", reason: "inaccessible" }] })
    const [stop] = seeded.pickupIds
    const reported = await openTicketFor(problemOn(seeded, stop, "bin1", "Gate locked, please come back"), context())
    assert.equal(reported.outcome, "opened")
    const problemId = (reported as { ticketId: string }).ticketId
    const problem = await ticketById(problemId)
    const again = problemOn(seeded, stop, "bin1", "Gate open now, come back today")
    assert.deepEqual(await openTicketFor(again, context()), { outcome: "commented", ticketId: problemId }, "a second problem folds into the first: still nobody's")

    const failed = await openTicketFor(failureOn(seeded, stop, "bin1"), context())
    assert.equal(failed.outcome, "opened")
    const missedId = (failed as { ticketId: string }).ticketId
    assert.deepEqual((failed as { superseded?: unknown }).superseded, { ticketId: problemId, as: "duplicate" })
    const missed = await ticketById(missedId)
    assert.equal(missed.kind, "missed-collection", "the missed collection leads: its kind and its priority")

    const closed = await ticketById(problemId)
    assert.deepEqual([closed.status, closed.resolution, closed.closedAt?.toISOString(), closed.parentTicketId], ["completed", "duplicate", NOW.toISOString(), missedId], "the missed collection is its parent")
    assert.deepEqual(
      (await historyOf(problemId)).map((entry) => [entry.kind, entry.status, entry.resolution, entry.recordedBy, entry.sourceEventId, entry.body]),
      [
        ["created", "open", null, null, null, null],
        ["comment", "open", null, null, again.id, "The driver reported a problem. Reason: inaccessible. Note: Gate open now, come back today"],
        ["status-changed", "completed", "duplicate", null, null, `The stop was not collected: this problem is part of T-${missed.number}, its missed collection.`],
      ],
      "a status change nobody recorded, as the office's complete shapes it",
    )
    assert.deepEqual((await outboxAbout(problemId)).map((entry) => entry.kind), ["ticket-opened", "ticket-completed"], "ticket-completed emitted, as for the office's")
    assert.deepEqual(
      (await historyOf(missedId)).map((entry) => [entry.kind, entry.recordedBy, entry.body]),
      [
        ["created", null, null],
        ["comment", null, `From T-${problem.number}, completed as a duplicate of this case: The driver reported a problem. Reason: inaccessible. Note: Gate locked, please come back`],
        ["comment", null, `From T-${problem.number}: The driver reported a problem. Reason: inaccessible. Note: Gate open now, come back today`],
      ],
      "the problem's words, and the problem folded into it since",
    )
    assert.match(lines.at(-1)!, new RegExp(`→ opened \\(ticket ${missedId}, ticket ${problemId} its duplicate\\)$`))
    assert.deepEqual((await openCasesOf(stop)).map((row) => row.id), [missedId], "one open case for the stop")
    assert.deepEqual(await openTicketFor(problemOn(seeded, stop, "bin1", "Still locked"), context()), { outcome: "commented", ticketId: missedId }, "a later problem folds into the missed collection")
  })

  test("a failure on a stop whose problem a person made or works opens the missed collection and leaves the problem as the office left it, each case naming the other: never close a case someone is working", async () => {
    const touches = ["in-progress", "on-hold", "assigned", "edited", "commented", "the office's own"] as const
    for (const touched of touches) {
      const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin2", status: "failed", reason: "inaccessible" }] })
      const [stop] = seeded.pickupIds
      const problemId =
        touched === "the office's own"
          ? await withCompany(pool.db, tenant.companyId, async (tx) => {
              const links = { routeId: seeded.id, pickupId: stop, containerId: tenant.containers.bin2.id, propertyId: tenant.properties.havnegade.id, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }
              const draft = { projectId: tenant.projectId, kind: "reported-problem" as const, priority: "medium" as const, source: "phone" as const, subject: "Caller: bin blocked", description: "The customer called: the bin is blocked.", occurredAt: NOW, dueAt: null, assigneeUserAccountId: null, links, alertId: null }
              return (await openTicket(tx, { companyId: tenant.companyId, draft, createdBy: tenant.officeUserId, sourceEventId: null, newId, now: () => NOW })).row.id
            })
          : ((await openTicketFor(problemOn(seeded, stop, "bin2", "Blocked by scaffolding"), context())) as { ticketId: string }).ticketId
      await withCompany(pool.db, tenant.companyId, async (tx) => {
        const row = and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, problemId))
        if (touched === "in-progress" || touched === "on-hold") await tx.update(ticket).set({ status: touched }).where(row)
        if (touched === "assigned") await tx.update(ticket).set({ assigneeUserAccountId: tenant.officeUserId }).where(row)
        if (touched === "edited") await tx.update(ticket).set({ priority: "high" }).where(row)
        if (touched === "commented") {
          await appendTicketEvent(tx, { companyId: tenant.companyId, projectId: tenant.projectId, id: problemId }, { kind: "comment", status: "open", assigneeUserAccountId: null, resolution: null, body: "Called the customer; someone goes at 15:00", visibility: "internal", objectKey: null, recordedBy: tenant.officeUserId, sourceEventId: null }, newId)
        }
      })
      const before = await ticketById(problemId)

      const failed = await openTicketFor(failureOn(seeded, stop, "bin2"), context())
      const missedId = (failed as { ticketId: string }).ticketId
      assert.deepEqual((failed as { superseded?: unknown }).superseded, { ticketId: problemId, as: "named" }, touched)
      const missed = await ticketById(missedId)
      const after = await ticketById(problemId)
      assert.deepEqual([after.status, after.assigneeUserAccountId, after.resolution, after.closedAt], [before.status, before.assigneeUserAccountId, null, null], `${touched}: as the office left it`)
      const named = (await historyOf(problemId)).at(-1)
      assert.deepEqual([named?.kind, named?.status, named?.body], ["comment", before.status, `The stop was not collected: T-${missed.number} is its missed collection.`], touched)
      assert.deepEqual((await historyOf(missedId)).map((entry) => [entry.kind, entry.body]).slice(1), [["comment", `T-${before.number} is a problem reported on this stop, which the office is working.`]])
      assert.deepEqual((await outboxAbout(problemId)).map((entry) => entry.kind), ["ticket-opened"], "nothing completed")
      // Both open now: a later problem folds into the missed collection, the case the stop's events lead to.
      assert.deepEqual(await openTicketFor(problemOn(seeded, stop, "bin2", "Gate open now"), context()), { outcome: "commented", ticketId: missedId }, `${touched}: the missed collection first`)
    }
  })

  test("a failure and a problem on one stop arriving together, under two workers, leave one open case whichever goes first: the problem folds into the missed collection, or the missed collection supersedes it", async () => {
    const other = createDb(api.url, { max: 2 })
    try {
      for (let round = 0; round < 3; round++) {
        const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "failed", reason: "inaccessible" }] })
        const [stop] = seeded.pickupIds
        const [failed, reported] = await Promise.all([openTicketFor(failureOn(seeded, stop, "bin1"), context()), openTicketFor(problemOn(seeded, stop, "bin1", "Please come back"), { ...context(), api: other })])
        const open = await openCasesOf(stop)
        assert.deepEqual(open.map((row) => row.kind), ["missed-collection"], `round ${round}: one open case, the missed collection`)
        assert.equal(open[0].id, (failed as { ticketId: string }).ticketId)
        if (reported.outcome === "commented") assert.equal(reported.ticketId, open[0].id)
        else assert.deepEqual((failed as { superseded?: unknown }).superseded, { ticketId: (reported as { ticketId: string }).ticketId, as: "duplicate" })
      }
    } finally {
      await other.close()
    }
  })

  test("a problem whose stop's case the office closes while the fold waits on the case's row is a case of its own, never a comment on a closed case", async () => {
    const office = createDb(api.url, { max: 1 })
    try {
      const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "failed", reason: "inaccessible" }] })
      const [stop] = seeded.pickupIds
      const caseId = ((await openTicketFor(failureOn(seeded, stop, "bin1"), context())) as { ticketId: string }).ticketId
      let held!: () => void
      const holding = new Promise<void>((resolve) => (held = resolve))
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      // The office's complete: the case's row lock, then the closing, committed once the job is waiting on it.
      const closing = withCompany(office.db, tenant.companyId, async (tx) => {
        await tx.select({ id: ticket.id }).from(ticket).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, caseId))).for("update")
        held()
        await released
        await tx.update(ticket).set({ status: "completed", resolution: "recollected", closedAt: NOW }).where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.id, caseId)))
      })
      await holding
      const job = openTicketFor(problemOn(seeded, stop, "bin1", "Please come back"), context())
      // Until the job waits on the case's row lock: the read under `for no key update`, as the office holds the row.
      const waiting = async () => {
        const rows = (await pool.db.execute(sql`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%for no key update%'`)) as unknown as { waiting: number }[]
        return rows[0]?.waiting ?? 0
      }
      await expectEventually(async () => (await waiting()) > 0, "the job waits on the case's row lock")
      release()
      await closing
      const outcome = await job
      assert.equal(outcome.outcome, "opened", "the closed case is not the stop's open case any more")
      assert.notEqual((outcome as { ticketId: string }).ticketId, caseId)
      assert.deepEqual((await historyOf(caseId)).map((entry) => entry.kind), ["created"], "nothing written on the case the office closed")
    } finally {
      await office.close()
    }
  })

  test("two problems on one stop arriving together, under two workers, are one case: the second waits on the stop's key and reads what the first committed", async () => {
    const other = createDb(api.url, { max: 2 })
    try {
      const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin2", status: "planned" }] })
      const [stop] = seeded.pickupIds
      const events = [problemOn(seeded, stop, "bin2", "Blocked by a van", "planned"), problemOn(seeded, stop, "bin2", "Still blocked", "planned")]
      const [first, second] = await Promise.all([openTicketFor(events[0], context()), openTicketFor(events[1], { ...context(), api: other })])
      assert.deepEqual([first.outcome, second.outcome].sort(), ["commented", "opened"], "one opened, one commented, whichever went first")
      const ticketId = (first as { ticketId: string }).ticketId
      assert.equal((second as { ticketId: string }).ticketId, ticketId)
      assert.deepEqual((await historyOf(ticketId)).map((entry) => entry.kind), ["created", "comment"])
    } finally {
      await other.close()
    }
  })

  test("a replay opens no second ticket: the same event delivered again completes as replayed with the ticket it made, through the read; and a delivery that met the key reads the ticket back", async () => {
    const seeded = await seedRoute(pool, tenant)
    const [failedId] = seeded.pickupIds
    const event = outboxJob(tenant, { kind: "pickup-failed", aggregateKind: "pickup", aggregateId: failedId, payload: pickupPayload(tenant, seeded.id, failedId, { container: "bin1", status: "failed", reason: "not-presented" }, []) })
    const first = await openTicketFor(event, context())
    assert.equal(first.outcome, "opened")
    const again = await openTicketFor(event, context())
    assert.deepEqual(again, { outcome: "replayed", ticketId: (first as { ticketId: string }).ticketId })
    const thrice = await openTicketFor(event, context())
    assert.deepEqual(thrice, again)
    assert.equal((await ticketsFrom(event.id)).length, 1)
    assert.deepEqual((await outboxAbout((first as { ticketId: string }).ticketId)).map((entry) => entry.kind), ["ticket-opened"], "one event for one ticket, however often it is delivered")

    // The key's door: a second ticket of the same event inserted by hand as the consumer would, met at ticket_source_event_id_idx.
    await assert.rejects(
      withCompany(pool.db, tenant.companyId, (tx) =>
        openTicket(tx, {
          companyId: tenant.companyId,
          draft: { projectId: tenant.projectId, kind: "missed-collection", priority: "high", source: "driver-app", subject: "Again", description: "Again", occurredAt: NOW, dueAt: null, assigneeUserAccountId: null, links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }, alertId: null },
          createdBy: null,
          sourceEventId: event.id,
          newId,
          now: () => NOW,
        }),
      ),
      (error: unknown) => (error as { cause?: { constraint_name?: string } }).cause?.constraint_name === "ticket_source_event_id_idx",
      "the partial unique index is the backstop behind the read",
    )
  })

  test("a replayed rejection comments no second time: the folded event's id is the comment's key, read before the write", async () => {
    const seeded = await seedRoute(pool, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }] })
    const receipts = [receiptPayload(tenant, { routeId: seeded.id, detail: "First" }), receiptPayload(tenant, { routeId: seeded.id, detail: "Second" })]
    for (const receipt of receipts) await seedReceipt(pool, tenant, receipt)
    const events = receipts.map((receipt) => outboxJob(tenant, { kind: "command-rejected", aggregateKind: "command", aggregateId: receipt.id, payload: receipt }))
    const first = await openTicketFor(events[0], context())
    const second = await openTicketFor(events[1], context())
    const ticketId = (second as { ticketId: string }).ticketId
    assert.deepEqual(await openTicketFor(events[1], context()), { outcome: "replayed", ticketId })
    assert.deepEqual(await openTicketFor(events[0], context()), { outcome: "replayed", ticketId: (first as { ticketId: string }).ticketId })
    const history = await historyOf(ticketId)
    assert.equal(history.filter((entry) => entry.sourceEventId === events[1].id).length, 1, "one comment for the folded event, however often it is delivered")
    assert.equal(history.filter((entry) => entry.sourceEventId === events[0].id).length, first.outcome === "commented" ? 1 : 0, "and one for the first where it folded too")
  })

  test("a payload that does not parse throws, so pg-boss retries and then fails the job; nothing is written", async () => {
    const event = outboxJob(tenant, { kind: "pickup-failed", aggregateKind: "pickup", aggregateId: testId(), payload: { id: "not-an-id", status: "failed" } })
    await assert.rejects(openTicketFor(event, context()), /Invalid|invalid|expected/i)
    assert.deepEqual(await ticketsFrom(event.id), [])
    await assert.rejects(openTicketFor({ ...event, companyId: "nobody" }, context()), /Invalid|invalid/i, "a job without its tenant is a contract drift, not a fact")
    await assert.rejects(openTicketFor({ kind: "pickup-failed" }, context()), /Invalid|invalid|expected/i, "and so is a job that is not an outbox row")
  })

  test("a kind of another consumer's, handed to the handler directly, is news and not a case, whatever its payload", async () => {
    const event = outboxJob(tenant, { kind: "route-cancelled", aggregateKind: "route", aggregateId: testId(), payload: { anything: true } })
    assert.deepEqual(await openTicketFor(event, context()), { outcome: "nothing" })
    const completed = outboxJob(tenant, { kind: "pickup-completed", aggregateKind: "pickup", aggregateId: testId(), payload: { anything: true } })
    assert.deepEqual(await openTicketFor(completed, context()), { outcome: "nothing" })
  })
})

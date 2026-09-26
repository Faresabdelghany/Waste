// The outbox's first consumer (Issue #109 part B, §3, ADR-0004): the queue
// `resolution.open-tickets`, subscribed to the four kinds Resolution reads —
// `pickup-failed`, `pickup-skipped`, `pickup-problem-reported` and
// `command-rejected` — whose handler turns an execution event into a Ticket,
// or into nothing. `route-cancelled` is not among them on purpose (§7.10): a
// cancellation makes no ticket of its own, since each stop it closed arrives
// as its own `pickup-skipped · route-cancelled`. The relay (#104 part C)
// publishes each `outbox_event` row under `outboxQueue(kind)` and stamps
// `published_at` in its own transaction; this job consumes what pg-boss
// fans out and never reads the outbox table (src/outbox/queues.ts holds
// that one assumption).
//
// Per job, in order. The event is parsed with the contracts — `OutboxJob`
// first, then the kind's payload: a `Pickup` with the proof the command made
// (`PickupDetail`, the proofs optional since the office's cancellation writes
// a bare `Pickup`), a `Route` with its `proofs` for a problem reported on the
// route alone, a `DriverCommandReceipt` for a rejection — and a payload that
// does not parse is thrown, so pg-boss retries and, after its retries, fails
// the job for `/readyz` to count: a contract drift between the API and the
// worker is a bug and not a fact to swallow. Then one transaction as
// `wms_api` under `withCompany(event.companyId)`, the job's tenant, in which
// the worker's cross-tenant role reads nothing, since the job carries its
// company: the container's label, the place's address and the route's two
// drivers are read beside the payload in one statement each, the plain facts
// go to the domain's `ticketFor`, and where it answers a draft the ticket is
// opened through the same `openTicket` the office's create runs
// (`@waste/db/commands/open-ticket`) with `createdBy` null and
// `sourceEventId` the event's id, which `ticket_origin_shape` ties together
// and `ticket_source_event_id_idx` makes the idempotency key; `ticket-opened`
// is emitted inside it, as for the office's. `occurredAt` is the event's
// instant, `dueAt` null (no SLA yet), and the draft's links are what the
// event named — a problem on the route alone names no stop and so no
// container and no place, whatever was read.
//
// A `command-rejected` folds (§7.9): under the driver's row lock the
// driver's open `rejected-command` ticket is looked up, and where there is
// one a `comment` is appended to it — the draft's description as the body,
// the words a ticket of its own would have carried, `source_event_id` the
// event's id under `ticket_event_source_event_id_idx`, the second key — so a
// device back after three days uploading a hundred and fifty rejections is
// one case with a hundred and fifty lines and not a hundred and fifty cases;
// where there is none the ticket is opened as above. The lock is what makes
// two rejections of one driver arriving together, under two workers, one
// ticket and one comment: the second waits on the first's lock and then
// reads the ticket the first committed.
//
// pg-boss delivers at least once, so every job is idempotent by the event's
// id: before the write, the event is looked for among the tickets and the
// comments already made from it (`handled`, after the lock where there is
// one, so a redelivery racing its own first delivery reads what that one
// committed and does not comment on its own ticket), and a job whose event
// was handled completes with `replayed` and writes nothing; and where two
// workers pass that read together, the loser meets one of the two partial
// indexes with 23505, its transaction rolls back, and the ticket the winner
// made is read in a transaction of its own — a duplicate read back and the
// job completed, never a failure. The output is what happened, for the
// job's row: `opened`, `commented`, `replayed` or `nothing`, with the
// ticket's id where there is one.
//
// The retry policy: three retries with a short backoff, since what fails a
// handler here is the database not answering or a payload that will never
// parse — the first is over in seconds and the second is a failed job after
// a minute, which is what the readiness count is for. Jobs are worked one
// at a time in this process; a batch would put two events in one handler
// and their failures together.
import { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { OutboxEvent } from "@waste/contracts/outbox"
import { Pickup } from "@waste/contracts/pickups"
import { ProofOfService } from "@waste/contracts/proofs"
import { routeFields } from "@waste/contracts/routes"
import type { Database, Tx } from "@waste/db/client"
import { appendTicketEvent, openTicket, type TicketDraft } from "@waste/db/commands/open-ticket"
import { ticketColumns, type TicketRow } from "@waste/db/commands/resolution-rows"
import { lockRow } from "@waste/db/commands/shared"
import { newId } from "@waste/db/ids"
import { tableObjectName } from "@waste/db/names"
import { container } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { route } from "@waste/db/schema/execution"
import { driver } from "@waste/db/schema/fleet"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { uniqueConstraintOf } from "@waste/db/sqlstate"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import { ticketFor, type EventFacts, type OtherEventFacts, type TicketDraft as DomainDraft } from "@waste/domain/resolution/from-event"
import { OPEN_TICKET_STATUSES, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, inArray } from "drizzle-orm"
import * as z from "zod"

import { outboxQueue, type OutboxJob } from "../outbox/queues"
import { defineJob, type JobContext } from "./definition"

/** The kinds Resolution consumes (#104 §6, #109 §3): what the queue is subscribed to. `route-cancelled` is not one (§7.10). */
export const RESOLUTION_KINDS = ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"] as const satisfies readonly OutboxKind[]
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number]

/** The job's data as the relay publishes it: the contracts' outbox row with its tenant beside it. */
export const OutboxJobData = OutboxEvent.extend({ companyId: z.uuid() })

/** A pickup's event as the applier emits it: the `Pickup`, with the proof the command made where the door wrote one (the office's cancellation writes none). */
const PickupPayload = Pickup.extend({ proofs: z.array(ProofOfService).optional() })

/** A problem reported on the route alone: the `Route` with the problem proof beside it (`readRouteWithProofs`, the applier's). */
const RoutePayload = z.object({ ...routeFields, proofs: z.array(ProofOfService) })

/** The two partial unique indexes that are the consumer's idempotency keys; a 23505 on either is an event handled before. */
const TICKET_SOURCE_INDEX = tableObjectName(ticket, "source_event_id_idx", "openTickets")
const EVENT_SOURCE_INDEX = tableObjectName(ticketEvent, "source_event_id_idx", "openTickets")

/** What one job did, for its output. */
export type OpenTicketsOutcome = { outcome: "opened" | "commented" | "replayed"; ticketId: string } | { outcome: "nothing" }

/** The ticket already made from an event, or the ticket a comment already made from it was appended to. */
async function handled(tx: Tx, companyId: string, eventId: string): Promise<string | undefined> {
  const [own] = await tx
    .select({ id: ticket.id })
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.sourceEventId, eventId)))
    .limit(1)
  if (own !== undefined) return own.id
  const [comment] = await tx
    .select({ ticketId: ticketEvent.ticketId })
    .from(ticketEvent)
    .where(and(eq(ticketEvent.companyId, companyId), eq(ticketEvent.sourceEventId, eventId)))
    .limit(1)
  return comment?.ticketId
}

/** The container's label, where the pickup names a container the company has. */
async function containerLabel(tx: Tx, companyId: string, containerId: string): Promise<string | null> {
  const [found] = await tx.select({ label: container.label }).from(container).where(and(eq(container.companyId, companyId), eq(container.id, containerId))).limit(1)
  return found?.label ?? null
}

/** The place's address as one text: the property's, or the shared collection point's. */
async function addressOf(tx: Tx, companyId: string, place: { propertyId: string | null; sharedCollectionPointId: string | null }): Promise<string | null> {
  if (place.propertyId !== null) {
    const [found] = await tx.select({ address: property.address }).from(property).where(and(eq(property.companyId, companyId), eq(property.id, place.propertyId))).limit(1)
    return found?.address ?? null
  }
  if (place.sharedCollectionPointId !== null) {
    const [found] = await tx
      .select({ address: sharedCollectionPoint.address })
      .from(sharedCollectionPoint)
      .where(and(eq(sharedCollectionPoint.companyId, companyId), eq(sharedCollectionPoint.id, place.sharedCollectionPointId)))
      .limit(1)
    return found?.address ?? null
  }
  return null
}

/** The route's Actual Assignment driver — null while nobody started it — and its Planned one. */
async function driversOf(tx: Tx, companyId: string, routeId: string): Promise<{ actualDriverId: string | null; plannedDriverId: string | null }> {
  const [found] = await tx.select({ actualDriverId: route.actualDriverId, plannedDriverId: route.plannedDriverId }).from(route).where(and(eq(route.companyId, companyId), eq(route.id, routeId))).limit(1)
  return found ?? { actualDriverId: null, plannedDriverId: null }
}

/**
 * The plain facts of the event, for `ticketFor`: the payload parsed with its
 * kind's contract, and what was read beside it. A pickup's reason is the
 * pickup's and the note the pickup's or, where the pickup carries none, the
 * proof's the command made, which is where a device's note lands; a problem's
 * reason and note are the problem proof's, on the stop or on the route.
 */
async function factsOf(tx: Tx, event: OutboxJob): Promise<EventFacts> {
  const { companyId } = event
  switch (event.kind) {
    case "pickup-failed":
    case "pickup-skipped": {
      const pickup = PickupPayload.parse(event.payload)
      const proof = pickup.proofs?.[0]
      const [label, address, drivers] = [await containerLabel(tx, companyId, pickup.containerId), await addressOf(tx, companyId, pickup), await driversOf(tx, companyId, pickup.routeId)]
      return {
        kind: event.kind,
        routeId: pickup.routeId,
        pickupId: pickup.id,
        containerId: pickup.containerId,
        propertyId: pickup.propertyId,
        sharedCollectionPointId: pickup.sharedCollectionPointId,
        reason: pickup.reason ?? proof?.reason ?? null,
        note: pickup.note ?? proof?.note ?? null,
        containerLabel: label,
        address,
        ...drivers,
      }
    }
    case "pickup-problem-reported": {
      if (event.aggregateKind === "route") {
        const found = RoutePayload.parse(event.payload)
        const problem = found.proofs[0]
        return { kind: event.kind, routeId: found.id, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, reason: problem?.reason ?? null, note: problem?.note ?? null, containerLabel: null, address: null, ...(await driversOf(tx, companyId, found.id)) }
      }
      const pickup = PickupPayload.parse(event.payload)
      const problem = pickup.proofs?.[0]
      const [label, address, drivers] = [await containerLabel(tx, companyId, pickup.containerId), await addressOf(tx, companyId, pickup), await driversOf(tx, companyId, pickup.routeId)]
      return {
        kind: event.kind,
        routeId: pickup.routeId,
        pickupId: pickup.id,
        containerId: pickup.containerId,
        propertyId: pickup.propertyId,
        sharedCollectionPointId: pickup.sharedCollectionPointId,
        reason: problem?.reason ?? null,
        note: problem?.note ?? null,
        containerLabel: label,
        address,
        ...drivers,
      }
    }
    case "command-rejected": {
      const receipt = DriverCommandReceipt.parse(event.payload)
      return { kind: event.kind, routeId: receipt.routeId, pickupId: receipt.pickupId, driverId: receipt.driverId, detail: receipt.problem?.detail ?? receipt.problem?.title ?? "The command was refused" }
    }
    default:
      // A kind the queue is not subscribed to: the two pickup events Finance reads are news here whatever their payload, and every other kind the domain reads the kind of and nothing else.
      return { kind: event.kind as OtherEventFacts["kind"] }
  }
}

/** The domain's draft as `openTicket` takes it: the event's project and instant, no due date, nobody assigned, the nine links with the three the consumer never names null, no alert. */
const asTicketDraft = (event: OutboxJob, draft: DomainDraft): TicketDraft => ({
  projectId: event.projectId,
  kind: draft.kind,
  priority: draft.priority,
  source: draft.source,
  subject: draft.subject,
  description: draft.description,
  occurredAt: new Date(event.occurredAt),
  dueAt: null,
  assigneeUserAccountId: null,
  links: { ...draft.links, customerId: null, agreementId: null, parentTicketId: null },
  alertId: null,
})

/** The driver's open `rejected-command` ticket in the event's project, the oldest where there are several; read under the driver's lock. */
async function openRejectedCommandTicket(tx: Tx, companyId: string, projectId: string, driverId: string): Promise<TicketRow | undefined> {
  const [found] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.projectId, projectId), eq(ticket.driverId, driverId), eq(ticket.kind, "rejected-command"), inArray(ticket.status, [...OPEN_TICKET_STATUSES])))
    .orderBy(asc(ticket.id))
    .limit(1)
  return found
}

/** One event, in one transaction as the tenant: the reads, the rule, the fold or the ticket. */
async function consume(api: Database, event: OutboxJob, now: () => Date): Promise<OpenTicketsOutcome> {
  return await withCompany(api.db, event.companyId, async (tx) => {
    const { companyId } = event
    const facts = await factsOf(tx, event)
    const draft = ticketFor(facts)
    if (draft === undefined) return { outcome: "nothing" }
    const folds = facts.kind === "command-rejected" ? facts.driverId : null
    if (folds !== null) await lockRow(tx, driver, { companyId, id: folds })
    const before = await handled(tx, companyId, event.id)
    if (before !== undefined) return { outcome: "replayed", ticketId: before }
    if (folds !== null) {
      const open = await openRejectedCommandTicket(tx, companyId, event.projectId, folds)
      if (open !== undefined) {
        await appendTicketEvent(
          tx,
          { companyId, projectId: open.projectId, id: open.id },
          { kind: "comment", status: open.status as TicketStatus, assigneeUserAccountId: open.assigneeUserAccountId, resolution: null, body: draft.description, visibility: "internal", objectKey: null, recordedBy: null, sourceEventId: event.id },
          newId,
        )
        return { outcome: "commented", ticketId: open.id }
      }
    }
    const { row } = await openTicket(tx, { companyId, draft: asTicketDraft(event, draft), createdBy: null, sourceEventId: event.id, newId, now })
    return { outcome: "opened", ticketId: row.id }
  })
}

/** The event read back after a 23505 on one of the two keys: the ticket another delivery made from it, in a transaction of its own since the loser's rolled back. */
async function readBack(api: Database, event: OutboxJob): Promise<string | undefined> {
  return await withCompany(api.db, event.companyId, (tx) => handled(tx, event.companyId, event.id))
}

/** One job's event to its outcome: parsed, consumed, and a duplicate met at a key read back. */
export async function openTicketFor(data: unknown, { api, now, log }: Pick<JobContext, "api" | "now" | "log">): Promise<OpenTicketsOutcome> {
  const event = OutboxJobData.parse(data) as OutboxJob
  try {
    const outcome = await consume(api, event, now)
    log(`resolution.open-tickets: ${event.kind} ${event.id} → ${outcome.outcome}${"ticketId" in outcome ? ` (ticket ${outcome.ticketId})` : ""}`)
    return outcome
  } catch (error) {
    const constraint = uniqueConstraintOf(error)
    if (constraint !== TICKET_SOURCE_INDEX && constraint !== EVENT_SOURCE_INDEX) throw error
    const ticketId = await readBack(api, event)
    if (ticketId === undefined) throw error
    log(`resolution.open-tickets: ${event.kind} ${event.id} → replayed (ticket ${ticketId}, met at ${constraint})`)
    return { outcome: "replayed", ticketId }
  }
}

export const openTickets = defineJob<OutboxJob>({
  queue: "resolution.open-tickets",
  description: "Opens a Ticket from each execution event that is a case — a failed stop, a stop closed unserved, a reported problem, a rejected command — one per event, a rejection folding into the driver's open one.",
  subscriptions: RESOLUTION_KINDS.map(outboxQueue),
  queueOptions: { retryLimit: 3, retryDelay: 5, retryBackoff: true },
  handler: async (jobs, context) => {
    const outcomes: OpenTicketsOutcome[] = []
    for (const job of jobs) outcomes.push(await openTicketFor(job.data, context))
    return outcomes.length === 1 ? outcomes[0] : outcomes
  },
})

// The outbox's first consumer (Issue #109 part B, §3, ADR-0004): the four
// `outbox.<kind>` queues of the kinds Resolution reads — `pickup-failed`,
// `pickup-skipped`, `pickup-problem-reported` and `command-rejected` — taken
// through `defineOutboxConsumer` (../outbox/subscribe.ts), one registry entry
// per kind, whose handler turns an execution event into a Ticket, or into
// nothing. `route-cancelled` is not among them on purpose (§7.10): a
// cancellation makes no ticket of its own, since each stop it closed arrives
// as its own `pickup-skipped · route-cancelled`. The relay (#104 part C)
// sends each `outbox_event` row to its kind's queue and stamps `published_at`
// in the same transaction; this consumer works those queues and never reads
// the outbox table.
//
// Per job, in order. The event is parsed with the contracts — `RelayedEvent`
// first (the seam does that before the handler is called; `openTicketFor`
// parses again for the tests that call it with raw data), then the kind's
// payload: a `Pickup` with the proof the command made
// (`PickupDetail`, the proofs optional since the office's cancellation writes
// a bare `Pickup`), a `Route` with its `proofs` for a problem reported on the
// route alone, a `DriverCommandReceipt` for a rejection — and a payload that
// does not parse is thrown, so pg-boss retries and, after its retries, fails
// the job for `/readyz` to count: a contract drift between the API and the
// worker is a bug and not a fact to swallow. Then one transaction as
// `wms_api` under `withCompany(event.companyId)`, the job's tenant, in which
// the worker's cross-tenant role reads nothing, since the job carries its
// company: the container's label, the place's address, the route's two
// drivers and the agreement and customer the container served under on the
// route's service date are read beside the payload in one statement each, the plain facts
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
// Which case an event's ticket belongs to is the domain's (`caseRuleOf`,
// `@waste/domain/resolution/cases`, #258): one case per driver's device and
// one per stop. A `command-rejected` folds (§7.9) into the driver's open
// `rejected-command` ticket: a `comment` appended to it — the draft's
// description as the body, the words a ticket of its own would have carried,
// `source_event_id` the event's id under `ticket_event_source_event_id_idx`,
// the second key — so a device back after three days uploading a hundred and
// fifty rejections is one case with a hundred and fifty lines and not a
// hundred and fifty cases. A problem reported on a stop folds the same way
// into the stop's open missed collection or earlier problem, and a missed
// collection into the stop's open missed collection; where there is none the
// ticket is opened as above. A missed collection that opens leads the stop's
// case whatever order its events arrived in: the stop's open reported problem
// is completed as its `duplicate` — a `status-changed` with `recordedBy`
// null, the row's `resolution` and `closedAt`, and `ticket-completed`
// emitted, as the office's `complete` shapes them — while nobody has touched
// it, `open` and unassigned, and the problem's words are copied onto the
// missed collection; a problem the office works stays as the office left it,
// and each case gets a comment naming the other. A comment moves nothing of
// the case it lands on: a pending or on-hold case stays so.
//
// The events of one driver or one stop meet their case one at a time: each
// takes a transaction advisory lock on the rule's key, the driver's or the
// stop's, and reads the case under the case's own row lock (`for no key
// update`, which the office's commands wait on and a foreign key's check
// does not), so two rejections of one driver, or a failure and a problem on
// one stop, arriving together under two workers are one case — the second
// waits on the first's key and reads what it committed — and a case the
// office closes meanwhile is not one written on. An advisory lock and not the
// driver's or the pickup's row, which the API's commands take after the
// route's and before rows that check a key to them, the other way round.
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
// a minute, which is what the readiness count is for. Each queue's jobs are
// worked one at a time — a batch would put two events in one handler and
// their failures together — and each of the four queues has a loop of its
// own, so events of one stop on two queues can meet: the key above is for
// that.
import { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { Pickup } from "@waste/contracts/pickups"
import { ProofOfService } from "@waste/contracts/proofs"
import { routeFields } from "@waste/contracts/routes"
import type { Database, Tx } from "@waste/db/client"
import { appendTicketEvent, openTicket, type TicketDraft, type TicketEventDraft } from "@waste/db/commands/open-ticket"
import { emit } from "@waste/db/commands/outbox"
import { ticketColumns, ticketOf, type TicketRow } from "@waste/db/commands/resolution-rows"
import { newId } from "@waste/db/ids"
import { tableObjectName } from "@waste/db/names"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { route } from "@waste/db/schema/execution"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { uniqueConstraintOf } from "@waste/db/sqlstate"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import { caseRuleOf, superseding, supersededNote, supersedingNote, type CaseRule, type Superseding } from "@waste/domain/resolution/cases"
import { ticketFor, type EventFacts, type OtherEventFacts, type TicketDraft as DomainDraft } from "@waste/domain/resolution/from-event"
import { OPEN_TICKET_STATUSES, type TicketKind, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"
import * as z from "zod"

import { defineOutboxConsumer, RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"

/** The kinds Resolution consumes (#104 §6, #109 §3): the queues the consumer works. `route-cancelled` is not one (§7.10). */
export const RESOLUTION_KINDS = ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"] as const satisfies readonly OutboxKind[]
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number]

/** The job's data as the relay sends it: the contracts' outbox row with its tenant beside it — the seam's `RelayedEvent`, under the name this module always used. */
export type OutboxJob = RelayedEvent

/** A pickup's event as the applier emits it: the `Pickup`, with the proof the command made where the door wrote one (the office's cancellation writes none). */
const PickupPayload = Pickup.extend({ proofs: z.array(ProofOfService).optional() })

/**
 * A problem reported on the route alone: the `Route` with the problem proof
 * beside it (`readRouteWithProofs`, the applier's). The hold arrived on the
 * wire with #209, so a payload the outbox took before then carries no
 * `heldAt` and reads as a route the scheme's, never a dead letter.
 */
const RoutePayload = z.object({ ...routeFields, heldAt: routeFields.heldAt.default(null), proofs: z.array(ProofOfService) })

/** The two partial unique indexes that are the consumer's idempotency keys; a 23505 on either is an event handled before. */
const TICKET_SOURCE_INDEX = tableObjectName(ticket, "source_event_id_idx", "openTickets")
const EVENT_SOURCE_INDEX = tableObjectName(ticketEvent, "source_event_id_idx", "openTickets")

/** What one job did, for its output. */
export type OpenTicketsOutcome =
  | { outcome: "opened"; ticketId: string; superseded?: { ticketId: string; as: Superseding } }
  | { outcome: "commented" | "replayed"; ticketId: string }
  | { outcome: "nothing" }

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

/**
 * The agreement the container served under on the route's service date, and
 * its customer: the container's placement valid that day — the one
 * generation named the stop's place from — through its subscription. Nulls
 * for a container placed under none that day.
 */
async function servedUnder(tx: Tx, companyId: string, routeId: string, containerId: string): Promise<{ agreementId: string | null; customerId: string | null }> {
  const placed = containerServicePlacement
  const [found] = await tx
    .select({ agreementId: agreement.id, customerId: agreement.customerId })
    .from(route)
    .innerJoin(placed, and(eq(placed.companyId, route.companyId), eq(placed.containerId, containerId), lte(placed.validFrom, route.serviceDate), or(isNull(placed.validTo), gt(placed.validTo, route.serviceDate))))
    .innerJoin(subscription, and(eq(subscription.companyId, placed.companyId), eq(subscription.id, placed.subscriptionId)))
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
    .where(and(eq(route.companyId, companyId), eq(route.id, routeId)))
    .limit(1)
  return found ?? { agreementId: null, customerId: null }
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
      const [label, address, drivers, served] = [await containerLabel(tx, companyId, pickup.containerId), await addressOf(tx, companyId, pickup), await driversOf(tx, companyId, pickup.routeId), await servedUnder(tx, companyId, pickup.routeId, pickup.containerId)]
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
        ...served,
      }
    }
    case "pickup-problem-reported": {
      if (event.aggregateKind === "route") {
        const found = RoutePayload.parse(event.payload)
        const problem = found.proofs[0]
        return { kind: event.kind, routeId: found.id, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, reason: problem?.reason ?? null, note: problem?.note ?? null, containerLabel: null, address: null, ...(await driversOf(tx, companyId, found.id)), agreementId: null, customerId: null }
      }
      const pickup = PickupPayload.parse(event.payload)
      const problem = pickup.proofs?.[0]
      const [label, address, drivers, served] = [await containerLabel(tx, companyId, pickup.containerId), await addressOf(tx, companyId, pickup), await driversOf(tx, companyId, pickup.routeId), await servedUnder(tx, companyId, pickup.routeId, pickup.containerId)]
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
        ...served,
      }
    }
    case "command-rejected": {
      const receipt = DriverCommandReceipt.parse(event.payload)
      return { kind: event.kind, routeId: receipt.routeId, pickupId: receipt.pickupId, driverId: receipt.driverId, detail: receipt.problem?.detail ?? receipt.problem?.title ?? "The command was refused" }
    }
    default:
      // A kind of another consumer's (reaching here only when a test calls the handler directly, since the seam refuses another kind's event on a queue): the two pickup events Finance reads are news here whatever their payload, and every other kind the domain reads the kind of and nothing else.
      return { kind: event.kind as OtherEventFacts["kind"] }
  }
}

/** The domain's draft as `openTicket` takes it: the event's project and instant, no due date, nobody assigned, the nine links with the parent the consumer never names null, no alert. */
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
  links: { ...draft.links, parentTicketId: null },
  alertId: null,
})

/** The rule's key, held to the end of the transaction: the events of one driver or one stop meet their case one at a time. */
async function serialise(tx: Tx, rule: CaseRule): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`resolution.open-tickets:${rule.by}:${rule.id}`}, 0))`)
}

/** The oldest open case of `kinds` that is the rule's — the driver's, or the stop's — in the event's project, under its row lock. */
async function openCaseOf(tx: Tx, companyId: string, projectId: string, rule: CaseRule, kinds: readonly TicketKind[]): Promise<TicketRow | undefined> {
  if (kinds.length === 0) return undefined
  const [found] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.projectId, projectId), eq(rule.by === "driver" ? ticket.driverId : ticket.pickupId, rule.id), inArray(ticket.kind, [...kinds]), inArray(ticket.status, [...OPEN_TICKET_STATUSES])))
    .orderBy(asc(ticket.id))
    .limit(1)
    .for("no key update")
  return found
}

/** A comment on a case, nobody's, as the history's snapshot of the case. */
const commentOn = (row: TicketRow, body: string, sourceEventId: string | null): TicketEventDraft => ({
  kind: "comment",
  status: row.status as TicketStatus,
  assigneeUserAccountId: row.assigneeUserAccountId,
  resolution: null,
  body,
  visibility: "internal",
  objectKey: null,
  recordedBy: null,
  sourceEventId,
})

const refOf = (companyId: string, row: TicketRow) => ({ companyId, projectId: row.projectId, id: row.id })
const labelOf = (row: TicketRow) => `T-${row.number}`

/**
 * A stop's new missed collection over the stop's open reported problem: the
 * problem completed as its duplicate while nobody has touched it — the row,
 * a `status-changed` nobody recorded and `ticket-completed`, as the office's
 * `complete` writes them — and its words copied onto the missed collection;
 * otherwise each case names the other in a comment.
 */
async function supersede(tx: Tx, companyId: string, problem: TicketRow, missed: TicketRow, at: Date): Promise<Superseding> {
  const how = superseding({ status: problem.status as TicketStatus, assigneeUserAccountId: problem.assigneeUserAccountId })
  if (how === "duplicate") {
    const [completed] = await tx.update(ticket).set({ status: "completed", resolution: "duplicate", closedAt: at }).where(and(eq(ticket.companyId, companyId), eq(ticket.id, problem.id))).returning(ticketColumns)
    await appendTicketEvent(
      tx,
      refOf(companyId, completed),
      { kind: "status-changed", status: "completed", assigneeUserAccountId: completed.assigneeUserAccountId, resolution: "duplicate", body: supersededNote(how, labelOf(missed)), visibility: "internal", objectKey: null, recordedBy: null, sourceEventId: null },
      newId,
    )
    await emit(tx, { companyId }, { aggregate: "ticket", aggregateId: completed.id, kind: "ticket-completed", payload: ticketOf(completed), projectId: completed.projectId, occurredAt: at })
  } else {
    await appendTicketEvent(tx, refOf(companyId, problem), commentOn(problem, supersededNote(how, labelOf(missed)), null), newId)
  }
  await appendTicketEvent(tx, refOf(companyId, missed), commentOn(missed, supersedingNote(how, { label: labelOf(problem), description: problem.description }), null), newId)
  return how
}

/** One event, in one transaction as the tenant: the reads, the rule, the fold or the ticket, and what the ticket supersedes. */
async function consume(api: Database, event: OutboxJob, now: () => Date): Promise<OpenTicketsOutcome> {
  return await withCompany(api.db, event.companyId, async (tx) => {
    const { companyId, projectId } = event
    const facts = await factsOf(tx, event)
    const draft = ticketFor(facts)
    if (draft === undefined) return { outcome: "nothing" }
    const rule = caseRuleOf(facts, draft)
    if (rule !== undefined) await serialise(tx, rule)
    const before = await handled(tx, companyId, event.id)
    if (before !== undefined) return { outcome: "replayed", ticketId: before }
    if (rule !== undefined) {
      const open = await openCaseOf(tx, companyId, projectId, rule, rule.foldsInto)
      if (open !== undefined) {
        await appendTicketEvent(tx, refOf(companyId, open), commentOn(open, draft.description, event.id), newId)
        return { outcome: "commented", ticketId: open.id }
      }
    }
    const { row } = await openTicket(tx, { companyId, draft: asTicketDraft(event, draft), createdBy: null, sourceEventId: event.id, newId, now })
    // The case opened first, then the one it supersedes locked: the counter before a case's row, as the office's create takes them.
    const superseded = rule === undefined ? undefined : await openCaseOf(tx, companyId, projectId, rule, rule.supersedes)
    if (superseded === undefined) return { outcome: "opened", ticketId: row.id }
    return { outcome: "opened", ticketId: row.id, superseded: { ticketId: superseded.id, as: await supersede(tx, companyId, superseded, row, now()) } }
  })
}

/** The event read back after a 23505 on one of the two keys: the ticket another delivery made from it, in a transaction of its own since the loser's rolled back. */
async function readBack(api: Database, event: OutboxJob): Promise<string | undefined> {
  return await withCompany(api.db, event.companyId, (tx) => handled(tx, event.companyId, event.id))
}

/** One job's event to its outcome: parsed, consumed, and a duplicate met at a key read back. */
export async function openTicketFor(data: unknown, { api, now, log }: Pick<JobContext, "api" | "now" | "log">): Promise<OpenTicketsOutcome> {
  const event: OutboxJob = RelayedEvent.parse(data)
  try {
    const outcome = await consume(api, event, now)
    const superseded = outcome.outcome === "opened" && outcome.superseded !== undefined ? `, ticket ${outcome.superseded.ticketId} ${outcome.superseded.as === "duplicate" ? "its duplicate" : "named"}` : ""
    log(`resolution.open-tickets: ${event.kind} ${event.id} → ${outcome.outcome}${"ticketId" in outcome ? ` (ticket ${outcome.ticketId}${superseded})` : ""}`)
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

/** The consumer's queue options: three retries with a short backoff, written over the relay's defaults on the four queues at every start. */
export const OPEN_TICKETS_QUEUE_OPTIONS = { retryLimit: 3, retryDelay: 5, retryBackoff: true } as const

/** The four registry entries, one per kind on `outbox.<kind>`; spread into `JOBS`. */
export const openTickets = defineOutboxConsumer({
  kinds: RESOLUTION_KINDS,
  description: "Opens a Ticket from each execution event that is a case — a failed stop, a stop closed unserved, a reported problem, a rejected command — one case per stop and per driver's device: a rejection folds into the driver's open one, a stop's event into the stop's, and a missed collection supersedes the stop's open problem.",
  queueOptions: OPEN_TICKETS_QUEUE_OPTIONS,
  handler: (event, context) => openTicketFor(event, context),
})

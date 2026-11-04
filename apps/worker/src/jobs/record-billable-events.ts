// The outbox's second consumer (Issue #112 §3, part B): the `outbox.<kind>`
// queues of the kinds the relay publishes that Finance reads —
// `pickup-completed`, `pickup-corrected` and `ticket-completed`, and since
// O28 of #290 `weight-reviewed` (`unload-recorded` is not read: only a
// reviewed weight is billable, and the review is its own event) — taken through `defineOutboxConsumer` (../outbox/subscribe.ts), one
// registry entry per kind, whose handler takes the job's event parsed with the
// contracts (`RelayedEvent`), reads the facts beside the payload in one
// statement each under `withCompany` (finance-facts.ts), hands the plain facts
// to the domain's `billableFor`, and does what it answers: records the draft through
// `recordBillableEvent` with no person and the event's id, cancels the
// pickup's live event with the consumer's reason, records the reversal of an
// invoiced one, or nothing. Every write runs as `wms_api` under `withCompany`
// on the event's `companyId`, so a job's rows are fenced by the tenant
// exactly as a request's are; the worker's pool reads nothing here, since
// every fact is the one company's.
//
// pg-boss delivers at least once, so the handler is idempotent by the
// event's id: every row it writes carries `source_event_id = event.id` under
// `billable_event_source_event_id_idx`, and a redelivery meets the index —
// `uniqueConstraintOf` on that one constraint — reads the row it wrote the
// first time (`eventBySource`) and completes. A correction that stamps rather than
// writes reads the pickup's live event under its row lock (`liveEventOf`) and
// finds the cancellation already there, or no live event at all, and does
// nothing; and a reversal is a row with the correction's id, so a second
// delivery of the correction is the same 23505 read back. Two different
// events of one pickup are another matter — the driver's completion and the
// office's correction to `completed` minutes later are two ids, on two
// queues, and the index holds one row per id — so every pickup's event
// begins with the pickup's own row lock (`pickupRow` with `lock`,
// finance-facts.ts): two workers on two events of one pickup take turns, the
// second reads the first's live event, and the pickup is charged for once. A
// ticket's event takes the ticket's lock the same way. The facts are the
// table's word and not the payload's — the pickup's status now, the live
// event now — so a completion delivered after the correction that undid it
// records nothing (from-event.ts says why); the payload is parsed for the
// ids and the kind and trusted for nothing else.
//
// A pickup's event may be worth two charges since #293 M5 — its collection
// and its Pickup Exception — so the domain answers a list of actions
// (`billableActionsFor`) and each is done in turn, idempotent on its own key:
// a record by the event and its kind (`billable_event_source_event_id_idx`
// is `(source_event_id, kind)`, reversals aside), a reversal by the event it
// undoes (`billable_event_reverses_event_id_idx`, an event is reversed once),
// a cancellation by the reading it stamps. The driver's `pickup-failed` and
// `pickup-skipped` are read for the exception alone.
//
// A Site Visit's two events (#393, M4 of #293) are Finance's since M4a: a
// `site-visit-recorded` of an admitted visit is a `visit` event at the step
// its Visit Rule charges, priced through `priceDraft` on its day and
// idempotent by the source event like any other, and a `site-visit-voided`
// cancels the visit's live charge, or reverses it once invoiced. Each begins
// with the visit's own row lock, as a pickup's events do with the pickup's.
//
// An Unload's weight review (O28 of #290, C32 of #291) may charge every stop
// the Unload carried, so its records are keyed by the event and the stop
// (`billable_event_weight_charge_idx`), and its facts are read under the
// route's row lock every review takes, so a review and the consumer of an
// earlier one take turns.
//
// One job, one transaction: the reads and the write commit together, and a
// handler that throws — a payload that does not parse, a row the event names
// that is not there, a shape the domain drafted that the table would refuse —
// fails the job, which pg-boss retries on the queue's policy, then counts on
// `/readyz` and copies to `outbox.dead` for an operator to redrive
// (../outbox/subscribe.ts). A row that is not there is thrown and not skipped,
// since an event about a pickup nobody can find is a relay or a fence gone
// wrong and never news to drop. The retry policy is five retries backing off
// from ten seconds and capped at five minutes — 10, 20, 40, 80 s and then up
// to the cap, each with pg-boss's jitter, five to ten minutes in all, longer
// than an ordinary failover of the database, so a job that met one is retried
// past it and not failed under it — the retention a week, written over the
// relay's defaults on the three queues at every start.
import { PickupDetail } from "@waste/contracts/pickups"
import { SiteVisit } from "@waste/contracts/site-visits"
import { Ticket } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { WeightReview } from "@waste/contracts/weight-control"
import { cancelLiveEvent, eventBySource, ONE_REVERSAL_PER_EVENT, ONE_ROW_PER_SOURCE_EVENT, ONE_WEIGHT_CHARGE_PER_STOP, recordBillableEvent, reversalOfEvent, weightChargeBySource } from "@waste/db/commands/billable-writes"
import { eventOf, type EventReading } from "@waste/db/commands/billing-shapes"
import { lockRow } from "@waste/db/commands/shared"
import { visitById } from "@waste/db/commands/site-visits"
import { siteVisit } from "@waste/db/schema/site-visits"
import { uniqueConstraintOf } from "@waste/db/sqlstate"
import { newId } from "@waste/db/ids"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import { billableActionsFor, PICKUP_EVENT_KINDS, VISIT_EVENT_KINDS, WEIGHT_EVENT_KINDS, type BillableAction, type EventFacts } from "@waste/domain/finance/from-event"

import { defineOutboxConsumer, type RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"
import { pickupFacts, pickupRow, ticketFacts, ticketRow, visitFacts, weightFacts } from "./finance-facts"

/** The kinds this consumer takes, one queue each: what Finance reads of the outbox (§3's table, the visits' two and the weight review; `unload-recorded` is not read, since only a reviewed weight is billable). */
export const FINANCE_EVENT_KINDS = [...PICKUP_EVENT_KINDS, "ticket-completed", ...VISIT_EVENT_KINDS, ...WEIGHT_EVENT_KINDS] as const satisfies readonly OutboxKind[]

/** The job's data as the relay sends it: the seam's `RelayedEvent`, under the name this module always used. */
export type PublishedEvent = RelayedEvent

/** What one action came to. */
export type Done = { did: "recorded" | "cancelled" | "reversed" | "nothing" | "replayed"; billableEventId: string | null }

/** What one job answered, for the log and the job's output: its first action's outcome, or nothing, and every action's in order (a tagged collection's two, #293 M5). */
export type Recorded = { event: string; kind: OutboxKind; actions: Done[] } & Done

/**
 * The facts of one event, read under the company's fence: the payload
 * parsed with its kind's schema for the ids it names, the rows those ids
 * name read as they stand now. A kind this consumer takes and the
 * domain reads as news answers `OtherEventFacts`, so the rule says nothing
 * and the job completes with nothing.
 */
async function factsOf(tx: Tx, event: PublishedEvent) {
  switch (event.kind) {
    case "pickup-completed":
    case "pickup-corrected":
    case "pickup-failed":
    case "pickup-skipped": {
      const detail = PickupDetail.parse(event.payload)
      // The pickup's row lock first: two Finance events of one pickup — its completion and a correction to `completed`, on two queues, under two workers — would otherwise both read no live event and both record, and the source-event index holds one row per event, not per pickup.
      const found = await pickupRow(tx, event.companyId, detail.routeId, detail.id, { lock: true })
      if (found === undefined) throw new Error(`${event.kind} ${event.id} names pickup ${detail.id} of route ${detail.routeId}, which is not in company ${event.companyId}`)
      return await pickupFacts(tx, event.companyId, event.kind, found, detail.id)
    }
    case "ticket-completed": {
      const answered = Ticket.parse(event.payload)
      const found = await ticketRow(tx, event.companyId, answered.id)
      if (found === undefined) throw new Error(`ticket-completed ${event.id} names ticket ${answered.id}, which is not in company ${event.companyId}`)
      return { facts: await ticketFacts(tx, event.companyId, answered.id, found), live: [] }
    }
    case "site-visit-recorded":
    case "site-visit-voided": {
      const answered = SiteVisit.parse(event.payload)
      // The visit's row lock first: its recording and its void, on two queues, take turns, and the second reads the first's charge.
      await lockRow(tx, siteVisit, { companyId: event.companyId, id: answered.id })
      const found = await visitById(tx, event.companyId, answered.id)
      if (found === undefined) throw new Error(`${event.kind} ${event.id} names site visit ${answered.id}, which is not in company ${event.companyId}`)
      return await visitFacts(tx, event.companyId, event.kind, found)
    }
    case "weight-reviewed": {
      const review = WeightReview.parse(event.payload)
      return await weightFacts(tx, event.companyId, review.unloadId)
    }
    default:
      return { facts: { kind: event.kind } as EventFacts, live: [] }
  }
}

/** Does one action the domain answered, in the event's company and project, and says what it did. */
async function act(tx: Tx, event: PublishedEvent, action: BillableAction, live: readonly EventReading[]): Promise<Done> {
  if (action.action === "cancel") {
    // The live event was read under its lock a statement ago; the row is what the lock let through.
    const reading = live.find((row) => row.id === action.eventId)
    if (reading === undefined) throw new Error(`${event.kind} ${event.id}: the domain cancels event ${action.eventId}, which was not a live event read`)
    const cancelled = await cancelLiveEvent(tx, event.companyId, reading, action.reason)
    return { did: "cancelled", billableEventId: cancelled.id }
  }
  const did = action.action === "reverse" ? "reversed" : "recorded"
  // A record is one row of its kind with the event's id, a reversal one row naming the event it undoes. The row written the first time is read before the write — the common redelivery — and the index is the word behind it for two workers on one event at once: the insert runs in a savepoint, so a 23505 on it rolls the savepoint back and not the transaction, and the winner's row is read back.
  const weighed = action.action === "record" && action.draft.kind === "weight" ? action.draft.links.pickupId : null
  const already = () =>
    action.action === "reverse"
      ? reversalOfEvent(tx, event.companyId, action.eventId)
      : weighed !== null
        ? weightChargeBySource(tx, event.companyId, event.id, weighed)
        : eventBySource(tx, event.companyId, event.id, action.draft.kind)
  const before = await already()
  if (before !== undefined) return { did: "replayed", billableEventId: before.id }
  try {
    const { answered } = await tx.transaction((savepoint) =>
      recordBillableEvent(savepoint, { companyId: event.companyId, projectId: event.projectId, draft: action.draft, overrideReason: null, note: null, createdBy: null, sourceEventId: event.id, newId }),
    )
    return { did, billableEventId: answered.id }
  } catch (error) {
    const constraint = uniqueConstraintOf(error)
    if (constraint !== ONE_ROW_PER_SOURCE_EVENT && constraint !== ONE_REVERSAL_PER_EVENT && constraint !== ONE_WEIGHT_CHARGE_PER_STOP) throw error
    const winner = await already()
    if (winner === undefined) throw error
    return { did: "replayed", billableEventId: eventOf(winner).id }
  }
}

/** One event to what was done with it: the facts read and the write made in one fenced transaction as the tenant. */
export async function recordBillableEventFor(event: PublishedEvent, { api, log }: Pick<JobContext, "api" | "log">): Promise<Recorded> {
  const outcome = await withCompany(api.db, event.companyId, async (tx): Promise<Recorded> => {
    const { facts, live } = await factsOf(tx, event)
    const actions: Done[] = []
    for (const action of billableActionsFor(facts)) actions.push(await act(tx, event, action, live))
    const first = actions[0] ?? { did: "nothing" as const, billableEventId: null }
    return { event: event.id, kind: event.kind, ...first, actions }
  })
  const said = (done: Done) => `${done.did}${done.billableEventId === null ? "" : ` (billable event ${done.billableEventId})`}`
  log(`finance.record-billable-events: ${outcome.kind} ${outcome.event} → ${outcome.actions.length === 0 ? said(outcome) : outcome.actions.map(said).join(", ")}`)
  return outcome
}

/** The consumer's queue options: five retries backing off from ten seconds and capped at five minutes (five to ten minutes in all, past an ordinary failover), a finished job kept a week, written over the relay's defaults on the three queues at every start. */
export const RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS = { retryLimit: 5, retryDelay: 10, retryBackoff: true, retryDelayMax: 5 * 60, deleteAfterSeconds: 60 * 60 * 24 * 7 } as const

/** The three registry entries, one per kind on `outbox.<kind>`; spread into `JOBS`. */
export const recordBillableEvents = defineOutboxConsumer({
  name: "finance",
  kinds: FINANCE_EVENT_KINDS,
  description:
    "Records a Billable Event from each pickup-completed, pickup-corrected and ticket-completed the relay publishes, a Pickup Exception's charge from a pickup's completion, failure, skip or correction, a recycling-centre visit's charge from site-visit-recorded, and a stop's share of an approved Unload's weight under a product sold by the tonne from weight-reviewed, or cancels or reverses a pickup's live charges on a correction, a visit's on site-visit-voided and an Unload's weight charges on a review that takes the approval back; one row of a kind per outbox event however often it is delivered.",
  queueOptions: RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS,
  handler: (event, context) => recordBillableEventFor(event, context),
})

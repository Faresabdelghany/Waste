// The outbox's second consumer (Issue #112 §3, part B): the `outbox.<kind>`
// queues of the kinds the relay publishes that Finance reads —
// `pickup-completed`, `pickup-corrected` and `ticket-completed`
// (`unload-recorded` waits for the tonnage component that reads a weight, §1)
// — taken through `defineOutboxConsumer` (../outbox/subscribe.ts), one
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
// delivery of the correction is the same 23505 read back. The facts are the
// table's word and not the payload's — the pickup's status now, the live
// event now — so a completion delivered after the correction that undid it
// records nothing (from-event.ts says why); the payload is parsed for the
// ids and the kind and trusted for nothing else.
//
// One job, one transaction: the reads and the write commit together, and a
// handler that throws — a payload that does not parse, a row the event names
// that is not there, a shape the domain drafted that the table would refuse —
// fails the job, which pg-boss retries on the queue's policy and then counts
// on `/readyz`. A row that is not there is thrown and not skipped, since an
// event about a pickup nobody can find is a relay or a fence gone wrong and
// never news to drop. The retry policy is two retries with a short backoff,
// the retention a week, written over the relay's defaults on the three queues
// at every start.
import { PickupDetail } from "@waste/contracts/pickups"
import { Ticket } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { cancelLiveEvent, eventBySource, ONE_ROW_PER_SOURCE_EVENT, recordBillableEvent } from "@waste/db/commands/billable-writes"
import { eventOf } from "@waste/db/commands/billing-shapes"
import { uniqueConstraintOf } from "@waste/db/sqlstate"
import { newId } from "@waste/db/ids"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import { billableFor, PICKUP_EVENT_KINDS, type BillableAction, type EventFacts } from "@waste/domain/finance/from-event"

import { defineOutboxConsumer, type RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"
import { pickupFacts, pickupRow, ticketFacts, ticketRow } from "./finance-facts"

/** The kinds this consumer takes, one queue each: what Finance reads of the outbox (§3's table; `unload-recorded` is the deferred tonnage component's). */
export const FINANCE_EVENT_KINDS = [...PICKUP_EVENT_KINDS, "ticket-completed"] as const satisfies readonly OutboxKind[]

/** The job's data as the relay sends it: the seam's `RelayedEvent`, under the name this module always used. */
export type PublishedEvent = RelayedEvent

/** What one job answered, for the log and the job's output. */
export type Recorded = { event: string; kind: OutboxKind; did: "recorded" | "cancelled" | "reversed" | "nothing" | "replayed"; billableEventId: string | null }

/**
 * The facts of one event, read under the company's fence: the payload
 * parsed with its kind's schema for the ids it names, the rows those ids
 * name read as they stand now. A kind the queue is subscribed to and the
 * domain reads as news answers `OtherEventFacts`, so the rule says nothing
 * and the job completes with nothing.
 */
async function factsOf(tx: Tx, event: PublishedEvent) {
  switch (event.kind) {
    case "pickup-completed":
    case "pickup-corrected": {
      const detail = PickupDetail.parse(event.payload)
      const found = await pickupRow(tx, event.companyId, detail.routeId, detail.id)
      if (found === undefined) throw new Error(`${event.kind} ${event.id} names pickup ${detail.id} of route ${detail.routeId}, which is not in company ${event.companyId}`)
      return await pickupFacts(tx, event.companyId, event.kind, found, detail.id)
    }
    case "ticket-completed": {
      const answered = Ticket.parse(event.payload)
      const found = await ticketRow(tx, event.companyId, answered.id)
      if (found === undefined) throw new Error(`ticket-completed ${event.id} names ticket ${answered.id}, which is not in company ${event.companyId}`)
      return { facts: await ticketFacts(tx, event.companyId, answered.id, found), live: undefined }
    }
    default:
      return { facts: { kind: event.kind } as EventFacts, live: undefined }
  }
}

/** Does what the domain answered, in the event's company and project, and says what it did. */
async function act(tx: Tx, event: PublishedEvent, action: BillableAction | undefined, live: Awaited<ReturnType<typeof factsOf>>["live"]): Promise<Recorded> {
  const answer = (did: Recorded["did"], billableEventId: string | null): Recorded => ({ event: event.id, kind: event.kind, did, billableEventId })
  if (action === undefined) return answer("nothing", null)
  if (action.action === "cancel") {
    // The live event was read under its lock a statement ago; the row is what the lock let through.
    if (live === undefined || live.id !== action.eventId) throw new Error(`${event.kind} ${event.id}: the domain cancels event ${action.eventId}, which was not the live event read`)
    const cancelled = await cancelLiveEvent(tx, event.companyId, live, action.reason)
    return answer("cancelled", cancelled.id)
  }
  const did = action.action === "reverse" ? "reversed" : "recorded"
  // A record or a reversal is one row with the event's id. The row it wrote the first time is read before the write — the common redelivery — and the index is the word behind it for two workers on one event at once: the insert runs in a savepoint, so a 23505 on it rolls the savepoint back and not the transaction, and the winner's row is read back.
  const before = await eventBySource(tx, event.companyId, event.id)
  if (before !== undefined) return answer("replayed", before.id)
  try {
    const { answered } = await tx.transaction((savepoint) =>
      recordBillableEvent(savepoint, { companyId: event.companyId, projectId: event.projectId, draft: action.draft, overrideReason: null, note: null, createdBy: null, sourceEventId: event.id, newId }),
    )
    return answer(did, answered.id)
  } catch (error) {
    if (uniqueConstraintOf(error) !== ONE_ROW_PER_SOURCE_EVENT) throw error
    const winner = await eventBySource(tx, event.companyId, event.id)
    if (winner === undefined) throw error
    return answer("replayed", eventOf(winner).id)
  }
}

/** One event to what was done with it: the facts read and the write made in one fenced transaction as the tenant. */
export async function recordBillableEventFor(event: PublishedEvent, { api, log }: Pick<JobContext, "api" | "log">): Promise<Recorded> {
  const outcome = await withCompany(api.db, event.companyId, async (tx) => {
    const { facts, live } = await factsOf(tx, event)
    return await act(tx, event, billableFor(facts), live)
  })
  log(`finance.record-billable-events: ${outcome.kind} ${outcome.event} → ${outcome.did}${outcome.billableEventId === null ? "" : ` (billable event ${outcome.billableEventId})`}`)
  return outcome
}

/** The consumer's queue options: two retries with a short backoff, kept a week, written over the relay's defaults on the three queues at every start. */
export const RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS = { retryLimit: 2, retryDelay: 5, retryBackoff: true, deleteAfterSeconds: 60 * 60 * 24 * 7 } as const

/** The three registry entries, one per kind on `outbox.<kind>`; spread into `JOBS`. */
export const recordBillableEvents = defineOutboxConsumer({
  kinds: FINANCE_EVENT_KINDS,
  description: "Records a Billable Event from each pickup-completed, pickup-corrected and ticket-completed the relay publishes, or cancels or reverses the pickup's live event on a correction; one row per outbox event however often it is delivered.",
  queueOptions: RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS,
  handler: (event, context) => recordBillableEventFor(event, context),
})

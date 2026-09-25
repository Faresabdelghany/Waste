// The ticket-opening statements, once (Issue #109 §5), and the one function
// that follows a write to `ticket`'s row with a row of its history.
//
// `openTicket` is what `POST /tickets` runs with the caller's account, and
// what part B's consumer will run with `null` and the outbox event's id: the
// number from the company's counter, the `ticket` row, the `created` event,
// `alert.ticket_id` where an alert was named, the `ticket-opened` outbox
// event — in that order, in the caller's transaction. It takes `tx`, a
// company, the draft, `createdBy`, `sourceEventId`, an id minter and a clock,
// and never a Principal or a Context, so a worker with no request in hand can
// call it (§7.24; where it lives once `apps/worker` exists is decided with
// #97 part B). The number is one `update … returning` under the company's row
// lock, the route's rule (`next_route_number`) one at a time: a ticket is one
// create, and the lock is held for the rest of the request, which tens of
// tickets a day do not notice.
//
// `appendTicketEvent` is the allocation's `appendEvent` rule (#101): every
// write to the ticket's row is followed by one `ticket_event` in the same
// transaction, a snapshot of the status and the assignee after the event, so
// the history is complete by construction and reads without the row. A
// comment is a row here that touches the ticket's row not at all. The shape
// the domain gives each kind (@waste/domain/resolution/event-shapes) is
// consulted before the insert: the API composes every row itself, so a row
// that disagrees with its kind is a bug in a route and thrown as one, never
// left for `ticket_event_kind_shape` to answer as a 500 naming a constraint.
import type { Ticket, TicketLinks } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { company } from "@waste/db/schema/organisation"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { ticketEventShapeIssue } from "@waste/domain/resolution/event-shapes"
import type { TicketEventKind, TicketKind, TicketPriority, TicketResolution, TicketSource, TicketStatus, TicketVisibility } from "@waste/domain/resolution/vocabulary"
import { eq, sql } from "drizzle-orm"

import { newId as processId, type IdMinter } from "../ids"
import { emit } from "../outbox"
import { linkAlert } from "./alert-links"
import { eventColumns, ticketColumns, ticketOf, type TicketEventRow, type TicketRow } from "./resolution-shapes"

/** The case as a caller opens it: what the office's body or the consumer's `ticketFor` says, with every link spelled (null where none). */
export type TicketDraft = {
  projectId: string
  kind: TicketKind
  priority: TicketPriority
  source: TicketSource
  subject: string
  description: string
  /** When the issue or request happened: the body's word, the request's clock, or the event's instant. */
  occurredAt: Date
  dueAt: Date | null
  assigneeUserAccountId: string | null
  links: TicketLinks
  /** The alert the ticket answers, linked in the same transaction; null for none. */
  alertId: string | null
}

export type OpenTicketInput = {
  companyId: string
  draft: TicketDraft
  /** The caller's account, or null for the consumer's ticket. */
  createdBy: string | null
  /** The outbox event the consumer made it from, or null for a person's. */
  sourceEventId: string | null
  /** Mints the ticket's and the event's ids: the API's process minter, or the worker's. */
  newId: IdMinter
  /** The instant the ticket is opened: the `ticket-opened` event's `occurredAt`. */
  now: () => Date
}

/** The ticket the caller is appending to: the three ids every history row carries. */
export type TicketRef = { companyId: string; projectId: string; id: string }

/** One history row as a command hands it in: the kind, the snapshot after the event, and what the kind carries. */
export type TicketEventDraft = {
  /** The row's id where the caller minted it; the minter's otherwise. */
  id?: string
  kind: TicketEventKind
  /** The ticket's status after the event. */
  status: TicketStatus
  /** The assignee after the event. */
  assigneeUserAccountId: string | null
  resolution: TicketResolution | null
  body: string | null
  visibility: TicketVisibility
  objectKey: string | null
  /** The caller, or null for the consumer's rows. */
  recordedBy: string | null
  /** The outbox event a consumer's comment came from; null otherwise. */
  sourceEventId: string | null
}

/** The next ticket number of the company: one `update … returning` under the company's row lock, never renumbered. */
export async function nextTicketNumber(tx: Tx, companyId: string): Promise<number> {
  const [row] = await tx
    .update(company)
    .set({ nextTicketNumber: sql`${company.nextTicketNumber} + 1` })
    .where(eq(company.id, companyId))
    .returning({ next: company.nextTicketNumber })
  if (row === undefined) throw new Error(`no company ${companyId} to number a ticket in`)
  return row.next - 1
}

/**
 * Appends one history row after a write to the ticket's row — or a comment,
 * which follows no write. The shape is checked before the insert; the row
 * comes back as inserted.
 */
export async function appendTicketEvent(tx: Tx, ticketRef: TicketRef, event: TicketEventDraft, mint: IdMinter = processId): Promise<TicketEventRow> {
  const issue = ticketEventShapeIssue(event.kind, event)
  if (issue !== undefined) throw new Error(`ticket ${ticketRef.id}: ${issue}`)
  const [row] = await tx
    .insert(ticketEvent)
    .values({
      id: event.id ?? mint(),
      companyId: ticketRef.companyId,
      projectId: ticketRef.projectId,
      ticketId: ticketRef.id,
      kind: event.kind,
      status: event.status,
      assigneeUserAccountId: event.assigneeUserAccountId,
      resolution: event.resolution,
      body: event.body,
      visibility: event.visibility,
      objectKey: event.objectKey,
      sourceEventId: event.sourceEventId,
      recordedBy: event.recordedBy,
    })
    .returning(eventColumns)
  return row
}

/**
 * Opens a ticket: the counter, the row, the `created` event, the alert's
 * link where one was named, the `ticket-opened` event — in the caller's
 * transaction, so a refusal anywhere (a resolved alert, a key the database
 * refuses) leaves nothing behind, the counter's step included. Answers the
 * row and the `Ticket` as the outbox carried it, which is what the route
 * answers too.
 */
export async function openTicket(tx: Tx, input: OpenTicketInput): Promise<{ row: TicketRow; answered: Ticket }> {
  const { companyId, draft, createdBy, sourceEventId } = input
  const number = await nextTicketNumber(tx, companyId)
  const [row] = await tx
    .insert(ticket)
    .values({
      id: input.newId(),
      companyId,
      projectId: draft.projectId,
      number,
      kind: draft.kind,
      status: "open",
      priority: draft.priority,
      source: draft.source,
      subject: draft.subject,
      description: draft.description,
      occurredAt: draft.occurredAt,
      dueAt: draft.dueAt,
      assigneeUserAccountId: draft.assigneeUserAccountId,
      createdBy,
      sourceEventId,
      ...draft.links,
      resolution: null,
      recollectionRouteId: null,
      closedAt: null,
    })
    .returning(ticketColumns)
  await appendTicketEvent(
    tx,
    { companyId, projectId: row.projectId, id: row.id },
    { kind: "created", status: "open", assigneeUserAccountId: row.assigneeUserAccountId, resolution: null, body: null, visibility: "internal", objectKey: null, recordedBy: createdBy, sourceEventId: null },
    input.newId,
  )
  if (draft.alertId !== null) await linkAlert(tx, { companyId, projectId: row.projectId }, draft.alertId, row.id)
  const answered = ticketOf(row)
  await emit(tx, { companyId }, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-opened", payload: answered, projectId: row.projectId, occurredAt: input.now() })
  return { row, answered }
}

// The ticket-opening statements, once (Issue #109 §5), and the one function
// that follows a write to `ticket`'s row with a row of its history. In
// `packages/db/src/commands/` since part B, the home §7.24 proposed for the
// write statements both processes run: `POST /tickets` calls `openTicket`
// with the caller's account inside the request's transaction, and the
// worker's consumer (apps/worker/src/jobs/open-tickets.ts) calls it with
// `null` and the outbox event's id inside a job's transaction under
// `withCompany`, so an office ticket and an event's ticket are one write
// spelled in one place.
//
// `openTicket` is the number from the company's counter, the `ticket` row,
// the `created` event, `alert.ticket_id` where an alert was named, the
// `ticket-opened` outbox event, `ticket-assigned` where the draft names an
// assignee, then the type's opening actions (#546 of #544,
// commands/ticket-automation.ts), the row read back as they leave it — in
// that order, in the caller's transaction.
// It takes `tx`, a company, the draft, `createdBy`, `sourceEventId`, an id
// minter and a clock, and never a Principal, a Context or a Job. The number
// is `nextNumber` (commands/shared.ts), one `update … returning` under the
// company's row lock, the route's rule (`next_route_number`) one at a time: a
// ticket is one create, and the lock is held for the rest of the transaction,
// which tens of tickets a day do not notice. A draft whose due date is
// `BY_SLA` is due by the project's SLA target of its kind and priority,
// counted from its `occurredAt` (`ticket_sla`, `slaTargetFor`), or never where
// the project sets none (O4 of #290): the office's create when its body names
// no due date, and every ticket the consumer opens — so a job the queue held
// back hands its ticket no extra time. A draft that names no team waits with
// the project's default team for its kind (`ticket_team_default`, O30 of
// #290, row 7.20), while that team is active, and with none otherwise: the
// office's create when its body names none, and every ticket the consumer, a
// work order or a weighbridge deviation opens. A draft that names no Ticket
// Type is of its kind's default type (#545 of #544, `defaultTicketTypeOf`),
// which is every ticket an event opens; the office's create names the type it
// judged, with the fields' values it held to it.
//
// `appendTicketEvent` is the allocation's `appendEvent` rule (#101): every
// write to the ticket's row is followed by one `ticket_event` in the same
// transaction, a snapshot of the status and the assignee after the event, so
// the history is complete by construction and reads without the row. A
// comment is a row here that touches the ticket's row not at all — the
// office's `POST /tickets/:id/comments`, and the consumer's fold of a
// rejected command into the driver's open case, whose `sourceEventId` is the
// second idempotency key. The shape the domain gives each kind
// (@waste/domain/resolution/event-shapes) is consulted before the insert:
// the callers compose every row themselves, so a row that disagrees with its
// kind is a bug in a route or a job and thrown as one, never left for
// `ticket_event_kind_shape` to answer as a 500 naming a constraint.
import type { TicketFieldValues } from "@waste/contracts/ticket-types"
import type { Ticket, TicketCountedBy, TicketLinks } from "@waste/contracts/tickets"
import { ticketEventShapeIssue } from "@waste/domain/resolution/event-shapes"
import { dueBySla, slaTargetFor } from "@waste/domain/resolution/sla"
import type { TicketEventKind, TicketKind, TicketPriority, TicketResolution, TicketSource, TicketStatus, TicketVisibility } from "@waste/domain/resolution/vocabulary"
import { and, eq, isNull, or } from "drizzle-orm"

import type { Tx } from "../client"
import { newId as processId, type IdMinter } from "../ids"
import { team, ticket, ticketEvent, ticketSla, ticketTeamDefault } from "../schema/resolution"
import { linkAlert } from "./alert-links"
import { emit } from "./outbox"
import { eventColumns, ticketColumns, ticketOf, type TicketEventRow, type TicketRow } from "./resolution-rows"
import { nextNumber } from "./shared"
import { runTicketAutomation, type AutomationCause } from "./ticket-automation"
import { defaultTicketTypeOf } from "./ticket-types"

/** A draft's due date that is the project's SLA target of the ticket's kind and priority, from when its issue or request happened. */
export const BY_SLA = "sla"

/** The case as a caller opens it: what the office's body or the consumer's `ticketFor` says, with every link spelled (null where none). */
export type TicketDraft = {
  projectId: string
  kind: TicketKind
  /** A type of the kind, the caller having judged it; absent, the kind's default type. */
  ticketTypeId?: string
  /** The type's fields' values, the caller having held them to the type; absent, none. */
  fieldValues?: TicketFieldValues
  priority: TicketPriority
  source: TicketSource
  subject: string
  description: string
  /** When the issue or request happened: the body's word, the request's clock, or the event's instant. */
  occurredAt: Date
  /** The opener's due date, null for none, or `BY_SLA`: the project's target, none where it sets none. */
  dueAt: Date | null | typeof BY_SLA
  assigneeUserAccountId: string | null
  /** The team it waits with, null for none; absent, the project's default team for the kind, none where it sets none. */
  teamId?: string | null
  links: TicketLinks
  /** The alert the ticket answers, linked in the same transaction; null for none. */
  alertId: string | null
  /** What a Counting Rule's ticket records (#547 of #544); absent on every other. */
  countedBy?: TicketCountedBy
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
  /** What its type's actions on opening run with (#546 of #544): the job sender a message is queued through, who set it going, how deep in a chain. Every opener names it, so no ticket skips its type's actions. */
  automation: AutomationCause
}

/** The ticket the caller is appending to: the three ids every history row carries. */
export type TicketRef = { companyId: string; projectId: string; id: string }

/** One history row as a command hands it in: the kind, the snapshot after the event, and what the kind carries. */
export type TicketEventDraft = {
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
      id: mint(),
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
 * link where one was named, the `ticket-opened` event, then its type's
 * actions on opening (#546 of #544) — in the caller's transaction, so a
 * refusal anywhere (a resolved alert, a key the database refuses) leaves
 * nothing behind, the counter's step included. Answers the row and the
 * `Ticket` as the actions left them, which is what the route answers, and
 * the `Ticket` as the outbox carried it on opening.
 */
export async function openTicket(tx: Tx, input: OpenTicketInput): Promise<{ row: TicketRow; answered: Ticket; opened: Ticket }> {
  const { companyId, draft, createdBy, sourceEventId } = input
  const dueAt = draft.dueAt === BY_SLA ? await dueBySlaOf(tx, companyId, draft) : draft.dueAt
  const teamId = draft.teamId === undefined ? await defaultTeamOf(tx, companyId, draft) : draft.teamId
  const ticketTypeId = draft.ticketTypeId ?? (await defaultTicketTypeOf(tx, companyId, draft.kind, input.newId))
  const number = await nextNumber(tx, companyId, "nextTicketNumber")
  const [row] = await tx
    .insert(ticket)
    .values({
      id: input.newId(),
      companyId,
      projectId: draft.projectId,
      number,
      kind: draft.kind,
      ticketTypeId,
      fieldValues: draft.fieldValues ?? {},
      status: "open",
      priority: draft.priority,
      source: draft.source,
      subject: draft.subject,
      description: draft.description,
      occurredAt: draft.occurredAt,
      dueAt,
      assigneeUserAccountId: draft.assigneeUserAccountId,
      teamId,
      createdBy,
      sourceEventId,
      ...draft.links,
      countingRuleId: draft.countedBy?.countingRuleId ?? null,
      countedFrom: draft.countedBy?.periodFrom ?? null,
      counted: draft.countedBy?.count ?? null,
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
  const opened = ticketOf(row)
  await emit(tx, { companyId }, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-opened", payload: opened, projectId: row.projectId, occurredAt: input.now() })
  // The draft's assignee hears of it as it opened, before any action of its type hands it on (O16 of #290).
  if (row.assigneeUserAccountId !== null) await emit(tx, { companyId }, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-assigned", payload: opened, projectId: row.projectId, occurredAt: input.now() })
  // Its type's actions on opening (#546 of #544), after the news of its opening; the ticket is answered as they leave it.
  await runTicketAutomation(tx, { ...input.automation, companyId, newId: input.newId, now: input.now }, row.id, "opened")
  const [latest] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, row.id)))
    .limit(1)
  return { row: latest, answered: ticketOf(latest), opened }
}

/** The due date the project's SLA gives a ticket of the draft's kind and priority, from when it happened: its kind's target, else every kind's; null where neither is set. */
async function dueBySlaOf(tx: Tx, companyId: string, draft: Pick<TicketDraft, "projectId" | "kind" | "priority" | "occurredAt">): Promise<Date | null> {
  const targets = await tx
    .select({ kind: ticketSla.kind, priority: ticketSla.priority, hours: ticketSla.hours })
    .from(ticketSla)
    .where(and(eq(ticketSla.companyId, companyId), eq(ticketSla.projectId, draft.projectId), eq(ticketSla.priority, draft.priority), or(isNull(ticketSla.kind), eq(ticketSla.kind, draft.kind))))
  const target = slaTargetFor(
    targets.map((row) => ({ kind: row.kind as TicketKind | null, priority: row.priority as TicketPriority, hours: row.hours })),
    draft.kind,
    draft.priority,
  )
  return target === undefined ? null : dueBySla(draft.occurredAt, target.hours)
}

/** The project's default team for the draft's kind, while it takes tickets; null where the project names none or its team is retired. */
async function defaultTeamOf(tx: Tx, companyId: string, draft: Pick<TicketDraft, "projectId" | "kind">): Promise<string | null> {
  const [found] = await tx
    .select({ teamId: ticketTeamDefault.teamId })
    .from(ticketTeamDefault)
    .innerJoin(team, and(eq(team.companyId, ticketTeamDefault.companyId), eq(team.id, ticketTeamDefault.teamId)))
    .where(and(eq(ticketTeamDefault.companyId, companyId), eq(ticketTeamDefault.projectId, draft.projectId), eq(ticketTeamDefault.kind, draft.kind), eq(team.status, "active")))
    .limit(1)
  return found?.teamId ?? null
}

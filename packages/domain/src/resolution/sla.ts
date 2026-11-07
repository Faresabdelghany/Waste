// A ticket's SLA (O4 of #290). A project gives a priority a target — the
// hours a ticket has from when its issue or request happened to its due date
// — for every kind at once, for one kind, or for one Ticket Type (#548 of
// #544): the type's own winning, then its kind's, then every kind's. Opening a
// ticket whose opener names no due date sets one from the target
// (`@waste/db/commands/open-ticket`, both doors), counted from the ticket's
// `occurredAt`: a complaint made yesterday and recorded today, or a failure a
// driver's offline phone sent late, is due by the hours since it happened,
// not since a person or a queue got to it. A ticket whose kind and priority
// have none is due never, as before. The hours are the wall clock's: a
// calendar of working hours is a later refinement. A later change of kind or
// priority, or a reopen, moves nothing; the office sets a due date by hand.
//
// `slaStateOf` is what a due date reads as at an instant: an open ticket is
// `overdue` past it and `due` until then, a closed one `met` it when it closed
// by it and `breached` it after, and a ticket without one is `none`. A closed
// ticket is timed to its close whatever it ended in, a rejection included, as
// the tickets report's `withinDue` counts it: deciding a case is a duplicate
// is handling it. The API's `overdue` filter is the first reading in SQL; the
// web's list reads all five.
import { eachOnceSentence } from "../requests"
import { isClosedTicketStatus, type TicketKind, type TicketPriority, type TicketStatus } from "./vocabulary"

/** The longest target: a year, in hours. */
export const TICKET_SLA_HOURS_MAX = 365 * 24

/** A project's target for a priority: one Ticket Type's, one kind's, or every kind's where both are null; never a kind's and a type's at once. */
export type SlaTarget = { kind: TicketKind | null; ticketTypeId: string | null; priority: TicketPriority; hours: number }

/** The target a ticket of this type, kind and priority is due by: its type's own, else its kind's, else the one for every kind; undefined where the project sets none. */
export function slaTargetFor<T extends SlaTarget>(targets: readonly T[], ticket: { kind: TicketKind; ticketTypeId: string | null }, priority: TicketPriority): T | undefined {
  const atPriority = targets.filter((target) => target.priority === priority)
  return (
    (ticket.ticketTypeId === null ? undefined : atPriority.find((target) => target.ticketTypeId === ticket.ticketTypeId)) ??
    atPriority.find((target) => target.ticketTypeId === null && target.kind === ticket.kind) ??
    atPriority.find((target) => target.ticketTypeId === null && target.kind === null)
  )
}

/** What names a target within a project: its kind or its type, every kind counting as one, and its priority. The one spelling the set's checks and its writes compare by. */
export const slaTargetKey = (target: { kind: string | null; ticketTypeId?: string | null; priority: string }): string => `${target.kind ?? ""}:${target.ticketTypeId ?? ""}:${target.priority}`

/** What a target naming both a kind and a type is told: a type is of one kind already. */
export const SLA_KIND_OR_TYPE = "Name a kind or a ticket type, or neither for every kind; not both"

/** What a set naming a kind or a type and a priority twice is told. */
export const SLA_TARGET_ONCE = eachOnceSentence("kind or ticket type and priority", "a ticket is due by one target")

const HOUR_MS = 60 * 60 * 1000

/** The due date a target sets: when the issue or request happened, plus its hours. */
export const dueBySla = (occurredAt: Date, hours: number): Date => new Date(occurredAt.getTime() + hours * HOUR_MS)

/** The index of the first target naming a kind and a priority an earlier one named; undefined when each pair is named once. */
export function duplicateSlaTarget<T extends Pick<SlaTarget, "kind" | "priority"> & { ticketTypeId?: string | null }>(targets: readonly T[]): number | undefined {
  const seen = new Set<string>()
  for (const [index, target] of targets.entries()) {
    const key = slaTargetKey(target)
    if (seen.has(key)) return index
    seen.add(key)
  }
  return undefined
}

/** What a ticket's due date reads as, in the order a list offers them. */
export const SLA_STATES = ["overdue", "due", "met", "breached", "none"] as const
export type SlaState = (typeof SLA_STATES)[number]

/** What the due date of a ticket reads as at `now`. Instants are ISO strings, as the wire spells them. */
export function slaStateOf(ticket: { status: TicketStatus; dueAt: string | null; closedAt: string | null }, now: Date): SlaState {
  if (ticket.dueAt === null) return "none"
  const due = Date.parse(ticket.dueAt)
  if (!isClosedTicketStatus(ticket.status)) return due < now.getTime() ? "overdue" : "due"
  return ticket.closedAt !== null && Date.parse(ticket.closedAt) > due ? "breached" : "met"
}

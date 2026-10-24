// A ticket's SLA (O4 of #290). A project gives a priority a target — the
// hours a ticket has from when its issue or request happened to its due date
// — for every kind at once or for one kind, the kind's own winning. Opening a
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
import { isClosedTicketStatus, type TicketKind, type TicketPriority, type TicketStatus } from "./vocabulary"

/** The longest target: a year, in hours. */
export const TICKET_SLA_HOURS_MAX = 365 * 24

/** A project's target for a priority: one kind's, or every kind's where `kind` is null. */
export type SlaTarget = { kind: TicketKind | null; priority: TicketPriority; hours: number }

/** The target a ticket of this kind and priority is due by: the kind's own, else the one for every kind; undefined where the project sets none. */
export function slaTargetFor<T extends SlaTarget>(targets: readonly T[], kind: TicketKind, priority: TicketPriority): T | undefined {
  return targets.find((target) => target.priority === priority && target.kind === kind) ?? targets.find((target) => target.priority === priority && target.kind === null)
}

/** What names a target within a project: its kind, every kind counting as one, and its priority. The one spelling the set's checks and its writes compare by. */
export const slaTargetKey = (target: { kind: string | null; priority: string }): string => `${target.kind ?? ""}:${target.priority}`

const HOUR_MS = 60 * 60 * 1000

/** The due date a target sets: when the issue or request happened, plus its hours. */
export const dueBySla = (occurredAt: Date, hours: number): Date => new Date(occurredAt.getTime() + hours * HOUR_MS)

/** The index of the first target naming a kind and a priority an earlier one named; undefined when each pair is named once. */
export function duplicateSlaTarget<T extends Pick<SlaTarget, "kind" | "priority">>(targets: readonly T[]): number | undefined {
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

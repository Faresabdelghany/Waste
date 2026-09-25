// The two state machines of Resolution (Issue #109, ADR-0005), as pure
// functions over the vocabulary's tokens with their sentences: what a Ticket
// does under the office's six commands, and what an Alert does under its two.
// The API reads a row under its lock, asks here, and either writes the next
// status and appends the history row or answers the sentence as its 409
// (#109 §3); the shape is Execution's `Transition` (execution/transitions.ts),
// so a reader of one machine reads the other.
//
// A transition answers one of three things. `move` is the next status; `stay`
// is a command already done — starting a ticket in progress, holding a held
// one, reopening an open one, acknowledging an acknowledged alert — which the
// API answers 200 without a write, the rule `confirm` set for allocations
// (#101); `refuse` carries the sentence and nothing else, since the ticket is
// named in it and the caller has nothing to add. A ticket is named by its
// label (`T-8831`, the contracts' `ticketLabel`) as a route is by `RC-1042`.
//
// The ticket machine (#109 §3): `open | pending | on-hold → in-progress` by
// `start`, `open | in-progress | on-hold → pending` by `wait` (waiting for the
// customer), `open | in-progress | pending → on-hold` by `hold` (waiting on
// us), any open status `→ completed` by `complete` and `→ rejected` by
// `reject`, and `completed | rejected → open` by `reopen`. A command on the
// status it leads to is `stay`; `reopen` on an open ticket is `stay`; and
// every other command on a closed ticket is `refuse` with `closedTicket`,
// "Ticket T-8831 is completed; reopen it first" — `complete` and `reject`
// included, which are not idempotent: a second resolution is a change a
// person meant, and "reopen it first" tells them how (§7.21). `PATCH` asks
// nothing here but reads `closedTicket` for the same refusal, and a comment
// asks nothing at all: a note after the fact is a note.
//
// The alert machine: `new → acknowledged` by `acknowledge`, `new |
// acknowledged → resolved` by `resolve`, each on its own status `stay`, and
// anything else on `resolved` a refusal, "This alert is resolved and does not
// change" — the sentence the link command reads too, since a resolved alert
// does not change through any door.
import type { Transition } from "../execution/transitions"
import { isClosedTicketStatus, type AlertStatus, type ClosedTicketStatus, type TicketStatus } from "./vocabulary"

export type { Transition }

/** What moves a ticket: the office's six commands. `assign` moves the assignee and not the status, and a comment moves nothing, so neither is here. */
export const TICKET_COMMANDS = ["start", "wait", "hold", "complete", "reject", "reopen"] as const
export type TicketCommand = (typeof TICKET_COMMANDS)[number]

/** The status each command leads to; `reopen` leads back to `open`. */
export const TICKET_COMMAND_TARGETS: Readonly<Record<TicketCommand, TicketStatus>> = {
  start: "in-progress",
  wait: "pending",
  hold: "on-hold",
  complete: "completed",
  reject: "rejected",
  reopen: "open",
}

/** A closed ticket asked to change by anything but `reopen`: "Ticket T-8831 is completed; reopen it first". */
export const closedTicket = (label: string, status: ClosedTicketStatus): string => `Ticket ${label} is ${status}; reopen it first`

/** The one place the ticket machine is spelled: status by status, what each command does. */
export function ticketTransition(status: TicketStatus, command: TicketCommand, label: string): Transition<TicketStatus> {
  if (isClosedTicketStatus(status)) {
    return command === "reopen" ? { kind: "move", to: "open" } : { kind: "refuse", sentence: closedTicket(label, status) }
  }
  // An open ticket: reopening it is nothing to do, and a command leading to the status it is in is nothing to do either.
  if (command === "reopen") return { kind: "stay" }
  const to = TICKET_COMMAND_TARGETS[command]
  return to === status ? { kind: "stay" } : { kind: "move", to }
}

/** What moves an alert: acknowledge and resolve. Linking a ticket moves no status and is not here, though it reads the same refusal. */
export const ALERT_COMMANDS = ["acknowledge", "resolve"] as const
export type AlertCommand = (typeof ALERT_COMMANDS)[number]

/** A resolved alert asked to change: the one sentence, read by acknowledge and by the link command alike. */
export const ALERT_DOES_NOT_CHANGE = "This alert is resolved and does not change"

/** The alert machine: new is acknowledged or resolved, acknowledged is resolved, resolved changes no more. */
export function alertTransition(status: AlertStatus, command: AlertCommand): Transition<AlertStatus> {
  switch (status) {
    case "new":
      return { kind: "move", to: command === "acknowledge" ? "acknowledged" : "resolved" }
    case "acknowledged":
      return command === "acknowledge" ? { kind: "stay" } : { kind: "move", to: "resolved" }
    case "resolved":
      return command === "resolve" ? { kind: "stay" } : { kind: "refuse", sentence: ALERT_DOES_NOT_CHANGE }
  }
}

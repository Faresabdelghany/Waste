// The case an event's ticket belongs to (Issue #258, §3 of #109): where the
// outbox's consumer opens a ticket of its own, where it folds the event into
// a case already open as a comment, and what a stop's missed collection does
// to a problem the driver reported on the stop. The worker serialises the
// events of one driver or one stop on the key this answers, reads the oldest
// open case of the kinds it names, and writes what is decided here; every
// rule is here, so it is a table test without a database.
//
// One case per stop and one per driver's device. A rejection folds into the
// driver's open rejected-command ticket, whatever stop it names. A problem
// reported on a stop folds into the stop's open case — its missed collection
// or an earlier problem — and a missed collection, a failure or a stop closed
// unserved, folds into the stop's open missed collection. A missed collection
// that opens leads the stop's case whatever order the events arrived in,
// since a stop's events travel on two queues worked by two loops: the stop's
// open reported problem is completed as a `duplicate` of it while nobody has
// touched it — a problem the driver's device opened, still `open`, nobody
// assigned, never edited, nothing in its history a person recorded — and its
// words, and the problems folded into it since, are copied onto the missed
// collection; one a person made or works stays as the office left it, and
// each case names the other. Where a stop has both open, its missed
// collection is the case a later event folds into. A problem on the route
// alone names no stop and belongs to no case but its own.
import { boundedDescription, type EventFacts, type TicketDraft } from "./from-event"
import type { TicketKind, TicketStatus } from "./vocabulary"

/** The kinds of ticket that are a stop's own case. */
export const STOP_CASE_KINDS = ["missed-collection", "reported-problem"] as const satisfies readonly TicketKind[]

/** How an event's ticket meets the case it may belong to. */
export type CaseRule = {
  /** What serialises the events that may meet one case: the driver, or the stop. */
  by: "driver" | "pickup"
  id: string
  /** The kinds of open case the event folds into as a comment, before it opens one of its own: the first kind listed first, then the oldest. */
  foldsInto: readonly TicketKind[]
  /** The kinds of open case a ticket it opens supersedes. */
  supersedes: readonly TicketKind[]
}

/** The rule for an event the consumer makes `draft` of; undefined for one that belongs to no case but its own. */
export function caseRuleOf(facts: EventFacts, draft: TicketDraft): CaseRule | undefined {
  if (facts.kind === "command-rejected") return { by: "driver", id: facts.driverId, foldsInto: ["rejected-command"], supersedes: [] }
  if (!("pickupId" in facts) || facts.pickupId === null) return undefined
  if (draft.kind === "reported-problem") return { by: "pickup", id: facts.pickupId, foldsInto: [...STOP_CASE_KINDS], supersedes: [] }
  if (draft.kind === "missed-collection") return { by: "pickup", id: facts.pickupId, foldsInto: ["missed-collection"], supersedes: ["reported-problem"] }
  return undefined
}

/** What a stop's new missed collection does to the stop's open reported problem: a duplicate of it, or a case of its own that the two name. */
export type Superseding = "duplicate" | "named"

/** The problem as the guard reads it: its status and assignee, who made it, whether its row was ever edited, and whether a person recorded anything in its history. */
export type ProblemAsFound = { status: TicketStatus; assigneeUserAccountId: string | null; createdBy: string | null; edited: boolean; personInHistory: boolean }

/** A duplicate only while nobody has touched the problem: the device's, still `open`, nobody assigned, never edited, no person in its history; never a case someone made or works. */
export function superseding(problem: ProblemAsFound): Superseding {
  const untouched = problem.status === "open" && problem.assigneeUserAccountId === null && problem.createdBy === null && !problem.edited && !problem.personInHistory
  return untouched ? "duplicate" : "named"
}

/** What the problem's history says: the duplicate's status change, or a comment, naming the missed collection by its label. */
export const supersededNote = (how: Superseding, missed: string): string =>
  how === "duplicate" ? `The stop was not collected: this problem is part of ${missed}, its missed collection.` : `The stop was not collected: ${missed} is its missed collection.`

/** A problem folded into the duplicate before it was completed, copied onto the missed collection under the duplicate's label. */
export const copiedNote = (label: string, body: string): string => boundedDescription(`From ${label}: ${body}`)

/** What the missed collection's history says of the problem: its words, where it became a duplicate, or its label. */
export const supersedingNote = (how: Superseding, problem: { label: string; description: string }): string =>
  how === "duplicate" ? boundedDescription(`From ${problem.label}, completed as a duplicate of this case: ${problem.description}`) : `${problem.label} is a problem reported on this stop, which the office is working.`

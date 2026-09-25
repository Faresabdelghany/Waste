// The pure half of the outbox's first consumer (Issue #109 §3, ADR-0004):
// which outbox event becomes which Ticket. The worker (part B) parses the
// job's event with the contracts, reads the container's label, the place's
// address and the route's driver beside the payload, hands the plain facts
// here, and opens the draft this answers — or does nothing where it answers
// nothing — under the idempotency keys the schema holds. Every rule of the
// table in §3 is decided here and nowhere else, so it is a table test without
// a database.
//
// The rule in one sentence: a ticket is made where nobody decided about the
// address. A `pickup-failed` is a stop the driver worked and could not
// collect; a `pickup-skipped` with `route-ended` or `route-cancelled` is a
// stop closed by the day ending or the dispatcher's cancellation, with nobody
// having looked at it; both are a `missed-collection`. A `pickup-skipped` with
// any other reason is a decision — the driver's own skip (`inaccessible`,
// `not-presented`, …), the dispatcher's removal, generation's regeneration —
// that the proof or the note records, and makes nothing. A
// `pickup-problem-reported` is a `reported-problem`, on the stop it named or
// on the route alone; a `command-rejected` is a `rejected-command`, the
// driver's, and the worker folds it into the driver's open one where there is
// one (§3). The route's own events, the completions, the corrections and the
// unloads are news nobody has to act on here — a `route-cancelled` makes
// nothing of its own, since its closed stops each arrive as `pickup-skipped ·
// route-cancelled` (#104 §5) — and Finance reads three of them.
//
// The priority and the source follow the table: a failure is `high`, a
// closed stop `medium`, a problem `medium`, a rejection `low`; the source is
// `driver-app` for what the device said and `dispatch` for a stop the
// dispatcher's cancellation closed, whose driver is then the planned one,
// since nobody started the route. The subject is spelled from what the worker
// read beside the payload — "Missed collection: BIN-82014 at Parkvej 18" —
// and cut to `TICKET_SUBJECT_MAX`, the bound the wire holds `Ticket.subject`
// to as a `Label`, so a rejection's long detail cannot make a subject the
// API's create refuses; the description carries the sentence, the reason and
// the note, cut the same way to `TICKET_DESCRIPTION_MAX`, the `Paragraph`
// bound `Ticket.description` is held to, since a device's note has no bound
// of its own. What a ticket links to is what the event named: a problem on the
// route alone names no stop, so it links no container and no place either,
// whatever the worker read (§3: "container and place then", then being when
// a pickup was named). What the draft does not carry is the API's:
// `occurredAt` is the event's, `dueAt` null (no SLA yet), `createdBy` null
// and `sourceEventId` the event's id, which `ticket_origin_shape` ties
// together.
import { CLOSING_REASONS, type ClosingReason, type OutboxKind, type PickupReason } from "../execution/vocabulary"
import type { TicketKind, TicketPriority, TicketSource } from "./vocabulary"

/** The events about a pickup, whose payload is the Pickup (or, for a problem on the route alone, the Route). */
export const PICKUP_EVENT_KINDS = ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "pickup-completed", "pickup-corrected"] as const satisfies readonly OutboxKind[]
export type PickupEventKind = (typeof PICKUP_EVENT_KINDS)[number]

/** A pickup's event as the worker reads it: the payload's fields, and what it read beside them. */
export type PickupEventFacts = {
  kind: PickupEventKind
  routeId: string
  /** The pickup; null for a problem reported on the route alone. */
  pickupId: string | null
  containerId: string | null
  propertyId: string | null
  sharedCollectionPointId: string | null
  /** The pickup's reason on a skip or a failure, the proof's on a problem; null otherwise. */
  reason: PickupReason | null
  /** The pickup's note, or the problem's. */
  note: string | null
  /** Read beside the payload: the container's label and the place's address, where the worker found them. */
  containerLabel: string | null
  address: string | null
  /** The route's Actual Assignment driver — null while nobody started it — and its Planned one. */
  actualDriverId: string | null
  plannedDriverId: string | null
}

/** A rejected command as the worker reads it off the receipt. */
export type CommandRejectedFacts = {
  kind: "command-rejected"
  /** The route the receipt names, where it names one the driver reaches. */
  routeId: string | null
  pickupId: string | null
  driverId: string
  /** The receipt's `problem.detail`: the sentence the applier answered. */
  detail: string
}

/** Every other event, which this module reads the kind of and nothing else. */
export type OtherEventFacts = { kind: Exclude<OutboxKind, PickupEventKind | "command-rejected"> }

/** An outbox event as the worker hands it here: the kind, and the plain facts that kind's payload and the reads beside it give. */
export type EventFacts = PickupEventFacts | CommandRejectedFacts | OtherEventFacts

/** What a ticket links to: the ids the event named, each null where it named none. */
export type TicketDraftLinks = {
  routeId: string | null
  pickupId: string | null
  containerId: string | null
  propertyId: string | null
  sharedCollectionPointId: string | null
  driverId: string | null
}

/** The ticket the consumer opens: what the API's create takes from the draft, the rest being the event's. */
export type TicketDraft = {
  kind: TicketKind
  priority: TicketPriority
  source: TicketSource
  subject: string
  description: string
  links: TicketDraftLinks
}

/**
 * What a skip under each closing reason makes: the route ended, or the
 * dispatcher cancelled it. Keyed by Execution's `ClosingReason` and not
 * hand-listed over `PickupReason`, so a reason added to `CLOSING_REASONS` is a
 * compile error here until this table says what it makes. Every other skip is
 * a decision.
 */
const CLOSED_BY_ROUTE: Readonly<Record<ClosingReason, { priority: TicketPriority; source: TicketSource; sentence: string }>> = {
  "route-ended": { priority: "medium", source: "driver-app", sentence: "The route ended before this stop was collected" },
  "route-cancelled": { priority: "medium", source: "dispatch", sentence: "The route was cancelled before this stop was collected" },
}

/** Whether a reason is one the route's end or cancellation wrote: the list's membership, never the table's keys, so a stray string finds nothing on the object's prototype. */
const isClosingReason = (reason: PickupReason): reason is ClosingReason => (CLOSING_REASONS as readonly string[]).includes(reason)

/** The longest a subject may be: the contracts' `Label` bound (`LABEL_MAX`), which `Ticket.subject` is held to on the wire. The domain cannot import it, so `packages/db`'s `ticket-text.test.ts`, which sees both, holds the two equal. */
export const TICKET_SUBJECT_MAX = 200

/** The longest a description may be: the contracts' `Paragraph` bound (`PARAGRAPH_MAX`), which `Ticket.description` is held to; the same test holds these two equal. */
export const TICKET_DESCRIPTION_MAX = 2000

/**
 * Text cut to a bound: whole where it fits, else its head to the last space
 * before the bound with an ellipsis, so a rejection's long detail reads as a
 * sentence cut short and not a word cut in half. The head is kept whole where
 * the last space falls in its first half, since text that is one long token
 * is better cut than emptied.
 */
const bounded = (text: string, max: number): string => {
  if (text.length <= max) return text
  const head = text.slice(0, max - 1)
  const space = head.lastIndexOf(" ")
  return `${space > max / 2 ? head.slice(0, space) : head}…`
}

/** A subject cut to `TICKET_SUBJECT_MAX`. */
export const boundedSubject = (subject: string): string => bounded(subject, TICKET_SUBJECT_MAX)

/** A description cut to `TICKET_DESCRIPTION_MAX` the same way: a 5000-character note from a device is a note cut short, not a ticket the API's create refuses. */
export const boundedDescription = (description: string): string => bounded(description, TICKET_DESCRIPTION_MAX)

/** "Missed collection: BIN-82014 at Parkvej 18", with whichever of the two the worker found. */
export const missedCollectionSubject = (containerLabel: string | null, address: string | null): string =>
  boundedSubject(`Missed collection${containerLabel === null ? "" : `: ${containerLabel}`}${address === null ? "" : ` at ${address}`}`)

/** "Problem reported: inaccessible at BIN-82014", the place after the reason where the worker found one. */
export const reportedProblemSubject = (reason: PickupReason | null, containerLabel: string | null, address: string | null): string => {
  const where = containerLabel ?? address
  return boundedSubject(`Problem reported${reason === null ? "" : `: ${reason}`}${where === null ? "" : ` at ${where}`}`)
}

/** "Rejected command: Pickup 12 is already completed", cut to the bound where the detail runs long. */
export const rejectedCommandSubject = (detail: string): string => boundedSubject(`Rejected command: ${detail}`)

/** The description: the sentence, then the reason and the note where there are any, each its own sentence, cut to the bound. */
export const describe = (sentence: string, reason: string | null, note: string | null): string =>
  boundedDescription([`${sentence}.`, reason === null ? undefined : `Reason: ${reason}.`, note === null ? undefined : `Note: ${note}`].filter((part) => part !== undefined).join(" "))

/** The stop's links, with the driver given. An event on the route alone names no stop, so it names no container and no place either, whatever the worker read. */
const pickupLinks = (facts: PickupEventFacts, driverId: string | null): TicketDraftLinks => {
  const onStop = facts.pickupId !== null
  return {
    routeId: facts.routeId,
    pickupId: facts.pickupId,
    containerId: onStop ? facts.containerId : null,
    propertyId: onStop ? facts.propertyId : null,
    sharedCollectionPointId: onStop ? facts.sharedCollectionPointId : null,
    driverId,
  }
}

/** The ticket an event is worth, or undefined for an event that is news and not a case. */
export function ticketFor(event: EventFacts): TicketDraft | undefined {
  switch (event.kind) {
    case "pickup-failed":
      return {
        kind: "missed-collection",
        priority: "high",
        source: "driver-app",
        subject: missedCollectionSubject(event.containerLabel, event.address),
        description: describe("The driver could not collect this stop", event.reason, event.note),
        links: pickupLinks(event, event.actualDriverId),
      }
    case "pickup-skipped": {
      if (event.reason === null || !isClosingReason(event.reason)) return undefined
      const closing = CLOSED_BY_ROUTE[event.reason]
      return {
        kind: "missed-collection",
        priority: closing.priority,
        source: closing.source,
        subject: missedCollectionSubject(event.containerLabel, event.address),
        description: describe(closing.sentence, event.reason, event.note),
        // A cancelled route was started by nobody, so its driver is the planned one; an ended route's is the one who ran it.
        links: pickupLinks(event, closing.source === "dispatch" ? event.plannedDriverId : event.actualDriverId),
      }
    }
    case "pickup-problem-reported":
      return {
        kind: "reported-problem",
        priority: "medium",
        source: "driver-app",
        subject: reportedProblemSubject(event.reason, event.containerLabel, event.address),
        description: describe("The driver reported a problem", event.reason, event.note),
        links: pickupLinks(event, event.actualDriverId),
      }
    case "command-rejected":
      return {
        kind: "rejected-command",
        priority: "low",
        source: "driver-app",
        subject: rejectedCommandSubject(event.detail),
        description: describe("The driver's device sent a command the server refused", null, event.detail),
        links: { routeId: event.routeId, pickupId: event.pickupId, containerId: null, propertyId: null, sharedCollectionPointId: null, driverId: event.driverId },
      }
    default:
      return undefined
  }
}

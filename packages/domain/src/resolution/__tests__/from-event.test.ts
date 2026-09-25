import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CLOSING_REASONS, OUTBOX_KINDS, PICKUP_REASONS, type OutboxKind, type PickupReason } from "../../execution/vocabulary"
import {
  boundedDescription,
  boundedSubject,
  describe as described,
  missedCollectionSubject,
  PICKUP_EVENT_KINDS,
  rejectedCommandSubject,
  reportedProblemSubject,
  TICKET_DESCRIPTION_MAX,
  TICKET_SUBJECT_MAX,
  ticketFor,
  type CommandRejectedFacts,
  type EventFacts,
  type PickupEventFacts,
  type PickupEventKind,
} from "../from-event"

const ROUTE = "route"
const PICKUP = "pickup"
const CONTAINER = "container"
const PROPERTY = "property"
const MADS = "mads"
const KAREN = "karen"

/** A pickup's event with everything the worker could read, but for what a test overrides: Mads ran the route Karen was planned for. */
const pickupEvent = (kind: PickupEventKind, values: Partial<PickupEventFacts> = {}): PickupEventFacts => ({
  kind,
  routeId: ROUTE,
  pickupId: PICKUP,
  containerId: CONTAINER,
  propertyId: PROPERTY,
  sharedCollectionPointId: null,
  reason: null,
  note: null,
  containerLabel: "BIN-82014",
  address: "Parkvej 18",
  actualDriverId: MADS,
  plannedDriverId: KAREN,
  ...values,
})

const rejection = (values: Partial<CommandRejectedFacts> = {}): CommandRejectedFacts => ({ kind: "command-rejected", routeId: ROUTE, pickupId: PICKUP, driverId: MADS, detail: "Pickup 12 is already completed", ...values })

/** The links a pickup event's ticket carries: the stop's, with the driver given. */
const stopLinks = (driverId: string | null) => ({ routeId: ROUTE, pickupId: PICKUP, containerId: CONTAINER, propertyId: PROPERTY, sharedCollectionPointId: null, driverId })

describe("ticketFor", () => {
  test("a failed pickup is a high missed collection from the driver's device, naming the stop and the driver who ran the route", () => {
    for (const reason of PICKUP_REASONS) {
      assert.deepEqual(
        ticketFor(pickupEvent("pickup-failed", { reason, note: "Gate locked" })),
        {
          kind: "missed-collection",
          priority: "high",
          source: "driver-app",
          subject: "Missed collection: BIN-82014 at Parkvej 18",
          description: `The driver could not collect this stop. Reason: ${reason}. Note: Gate locked`,
          links: stopLinks(MADS),
        },
        reason,
      )
    }
  })

  test("a skipped pickup is a medium missed collection under each of Execution's closing reasons, and nothing for a reason outside them", () => {
    let tickets = 0
    for (const reason of PICKUP_REASONS) {
      const draft = ticketFor(pickupEvent("pickup-skipped", { reason }))
      if ((CLOSING_REASONS as readonly string[]).includes(reason)) {
        tickets += 1
        assert.deepEqual([draft?.kind, draft?.priority], ["missed-collection", "medium"], `${reason} closes the stop with nobody having looked at it`)
      } else {
        assert.equal(draft, undefined, `${reason} is a decision the proof or the note records`)
      }
      if (reason === "route-ended") {
        assert.deepEqual(draft, {
          kind: "missed-collection",
          priority: "medium",
          source: "driver-app",
          subject: "Missed collection: BIN-82014 at Parkvej 18",
          description: "The route ended before this stop was collected. Reason: route-ended.",
          links: stopLinks(MADS),
        })
      } else if (reason === "route-cancelled") {
        // The dispatcher's word, and the driver the planned one: nobody started the route.
        assert.deepEqual(draft, {
          kind: "missed-collection",
          priority: "medium",
          source: "dispatch",
          subject: "Missed collection: BIN-82014 at Parkvej 18",
          description: "The route was cancelled before this stop was collected. Reason: route-cancelled.",
          links: stopLinks(KAREN),
        })
      }
    }
    assert.equal(tickets, CLOSING_REASONS.length, "every closing reason makes a ticket, and only those")
    assert.deepEqual([...CLOSING_REASONS], ["route-ended", "route-cancelled"], "the two the sentences above are spelled for")
    assert.equal(ticketFor(pickupEvent("pickup-skipped", { reason: null })), undefined, "a skip without a reason is not one the route closed")
    assert.equal(ticketFor(pickupEvent("pickup-skipped", { reason: "toString" as PickupReason })), undefined, "a reason outside the vocabulary finds nothing: the lookup is the list's, not the table's prototype's")
    // A cancelled route somebody had started keeps the planned driver on the ticket, since the source is the dispatcher's.
    assert.equal(ticketFor(pickupEvent("pickup-skipped", { reason: "route-cancelled", actualDriverId: MADS }))?.links.driverId, KAREN)
    assert.equal(ticketFor(pickupEvent("pickup-skipped", { reason: "route-ended", plannedDriverId: KAREN }))?.links.driverId, MADS)
  })

  test("a reported problem is a medium reported-problem, on the stop it named or on the route alone, with the reason and the note", () => {
    for (const reason of PICKUP_REASONS) {
      assert.deepEqual(ticketFor(pickupEvent("pickup-problem-reported", { reason, note: "Road closed" })), {
        kind: "reported-problem",
        priority: "medium",
        source: "driver-app",
        subject: `Problem reported: ${reason} at BIN-82014`,
        description: `The driver reported a problem. Reason: ${reason}. Note: Road closed`,
        links: stopLinks(MADS),
      })
    }
    // On the route alone: no stop, so no container and no place either — §3's "container and place then" — even where the facts carry them, and the subject says where only if the worker found an address.
    const onRoute = ticketFor(pickupEvent("pickup-problem-reported", { pickupId: null, containerId: CONTAINER, propertyId: PROPERTY, sharedCollectionPointId: "point", containerLabel: null, address: null, reason: "safety", note: "Road closed" }))
    assert.deepEqual(onRoute?.links, { routeId: ROUTE, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, driverId: MADS })
    assert.equal(onRoute?.subject, "Problem reported: safety")
    // Named a stop, the three travel with it.
    assert.deepEqual(ticketFor(pickupEvent("pickup-problem-reported", { sharedCollectionPointId: "point" }))?.links, { ...stopLinks(MADS), sharedCollectionPointId: "point" })
  })

  test("a rejected command is a low rejected-command of the driver's, naming the route and the pickup where the receipt has them", () => {
    assert.deepEqual(ticketFor(rejection()), {
      kind: "rejected-command",
      priority: "low",
      source: "driver-app",
      subject: "Rejected command: Pickup 12 is already completed",
      description: "The driver's device sent a command the server refused. Note: Pickup 12 is already completed",
      links: { routeId: ROUTE, pickupId: PICKUP, containerId: null, propertyId: null, sharedCollectionPointId: null, driverId: MADS },
    })
    // A command refused because no such route is assigned to the driver names no route and no pickup, and is still the driver's case.
    const noRoute = ticketFor(rejection({ routeId: null, pickupId: null, detail: "No route x assigned to this driver" }))
    assert.deepEqual(noRoute?.links, { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, driverId: MADS })
  })

  test("every other kind is news and not a case: the route's own events, the completions, the corrections and the unloads answer nothing", () => {
    const cases: OutboxKind[] = []
    const news: OutboxKind[] = []
    for (const kind of OUTBOX_KINDS) {
      const event: EventFacts = (PICKUP_EVENT_KINDS as readonly string[]).includes(kind)
        ? pickupEvent(kind as PickupEventKind, { reason: "route-ended", note: "x" })
        : kind === "command-rejected"
          ? rejection()
          : ({ kind } as EventFacts)
      ;(ticketFor(event) === undefined ? news : cases).push(kind)
    }
    assert.deepEqual(cases, ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"])
    assert.deepEqual(news, ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-completed", "pickup-corrected", "unload-recorded", "ticket-opened", "ticket-completed", "ticket-rejected", "invoice-issued", "settlement-closed"])
    // A completed or corrected pickup answers nothing whatever its reason.
    for (const kind of ["pickup-completed", "pickup-corrected"] as const) {
      for (const reason of [...PICKUP_REASONS, null] as (PickupReason | null)[]) assert.equal(ticketFor(pickupEvent(kind, { reason })), undefined, `${kind} ${reason}`)
    }
  })

  test("the subjects and the description are spelled from what the worker found, each part left out where it found nothing", () => {
    assert.equal(missedCollectionSubject("BIN-82014", "Parkvej 18"), "Missed collection: BIN-82014 at Parkvej 18")
    assert.equal(missedCollectionSubject("BIN-82014", null), "Missed collection: BIN-82014")
    assert.equal(missedCollectionSubject(null, "Parkvej 18"), "Missed collection at Parkvej 18")
    assert.equal(missedCollectionSubject(null, null), "Missed collection")
    assert.equal(reportedProblemSubject("inaccessible", "BIN-82014", "Parkvej 18"), "Problem reported: inaccessible at BIN-82014")
    assert.equal(reportedProblemSubject("inaccessible", null, "Parkvej 18"), "Problem reported: inaccessible at Parkvej 18")
    assert.equal(reportedProblemSubject(null, null, null), "Problem reported")
    assert.equal(rejectedCommandSubject("Route RC-1042 is not active"), "Rejected command: Route RC-1042 is not active")
    assert.equal(described("The driver could not collect this stop", "inaccessible", "Gate locked"), "The driver could not collect this stop. Reason: inaccessible. Note: Gate locked")
    assert.equal(described("The driver could not collect this stop", "inaccessible", null), "The driver could not collect this stop. Reason: inaccessible.")
    assert.equal(described("The driver could not collect this stop", null, null), "The driver could not collect this stop.")
  })

  test("a subject is cut to the wire's Label bound — at the last space with an ellipsis where a word would otherwise be cut in half — and a short one is left alone", () => {
    // The contracts' LABEL_MAX, which this package cannot import; packages/db's ticket-text.test.ts holds the two equal.
    assert.equal(TICKET_SUBJECT_MAX, 200)
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")
    assert.equal(words.length > 500, true)
    const cut = rejectedCommandSubject(words)
    assert.equal(cut.length <= TICKET_SUBJECT_MAX, true)
    assert.equal(cut.endsWith("…"), true)
    assert.match(cut, /^Rejected command: word0 word1 .*\S…$/, "cut at a space, so the ellipsis follows a whole word")
    assert.equal(words.startsWith(cut.slice("Rejected command: ".length, -1)), true, "what stands before the ellipsis is the detail's own head")
    // A detail that is one long token: the only space is the prefix's, in the head's first half, so the head is kept to a character before the bound rather than cut back to "Rejected command:".
    const token = rejectedCommandSubject("x".repeat(500))
    assert.equal(token, `Rejected command: ${"x".repeat(TICKET_SUBJECT_MAX - 1 - "Rejected command: ".length)}…`)
    assert.equal(token.length, TICKET_SUBJECT_MAX)
    // Exactly the bound is whole; one over is cut.
    assert.equal(boundedSubject("z".repeat(TICKET_SUBJECT_MAX)), "z".repeat(TICKET_SUBJECT_MAX))
    assert.equal(boundedSubject("z".repeat(TICKET_SUBJECT_MAX + 1)), `${"z".repeat(TICKET_SUBJECT_MAX - 1)}…`)
    // Every door is bounded: the three builders and the draft.
    assert.equal(missedCollectionSubject("B".repeat(300), "Parkvej 18").length, TICKET_SUBJECT_MAX)
    assert.equal(reportedProblemSubject("other", null, "A".repeat(300)).length, TICKET_SUBJECT_MAX)
    assert.equal(ticketFor(rejection({ detail: words }))?.subject, cut)
    assert.equal(ticketFor(rejection({ detail: words }))?.description, `The driver's device sent a command the server refused. Note: ${words}`, "the description keeps a detail that fits its own bound")
  })

  test("a description is cut to the wire's Paragraph bound the same way, and a short one is left alone", () => {
    // The contracts' PARAGRAPH_MAX, which this package cannot import; packages/db's ticket-text.test.ts holds the two equal.
    assert.equal(TICKET_DESCRIPTION_MAX, 2000)
    assert.equal(boundedDescription("z".repeat(TICKET_DESCRIPTION_MAX)), "z".repeat(TICKET_DESCRIPTION_MAX))
    assert.equal(boundedDescription("z".repeat(TICKET_DESCRIPTION_MAX + 1)), `${"z".repeat(TICKET_DESCRIPTION_MAX - 1)}…`)
    const words = Array.from({ length: 800 }, (_, i) => `word${i}`).join(" ")
    assert.equal(words.length > 5000, true)
    const cut = ticketFor(rejection({ detail: words }))?.description ?? ""
    assert.equal(cut.length <= TICKET_DESCRIPTION_MAX, true)
    assert.match(cut, /^The driver's device sent a command the server refused\. Note: word0 word1 .*\S…$/, "cut at a space, so the ellipsis follows a whole word")
    assert.equal(ticketFor(rejection({ detail: "Pickup 12 is already completed" }))?.description, "The driver's device sent a command the server refused. Note: Pickup 12 is already completed")
  })
})

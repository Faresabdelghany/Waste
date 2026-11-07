// The text the outbox's consumer spells for a ticket
// (@waste/domain/resolution/from-event, Issue #109 §3) goes onto the wire as
// `Ticket.subject`, a `Label` of the contracts (@waste/contracts/text), and as
// `Ticket.description`, a `Paragraph`, both cut to the bounds of
// @waste/domain/text that those schemas read: a subject or a description the
// domain builds from text far past the bound parses on the wire, so the
// worker's first long rejection opens its ticket.
//
// No database: every bound is source.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Label, Paragraph } from "@waste/contracts/text"
import { ticketFor } from "@waste/domain/resolution/from-event"
import { LABEL_MAX, PARAGRAPH_MAX } from "@waste/domain/text"

const DRIVER = "018f7c33-a000-7000-8000-000000000010"
const ROUTE = "018f7c33-a000-7000-8000-000000000011"
const PICKUP = "018f7c33-a000-7000-8000-000000000012"

/** Text past a bound two ways: so many words, and one token with no space to cut at. */
const long = (words: number, token: number): string[] => [Array.from({ length: words }, (_, i) => `word${i}`).join(" "), "x".repeat(token)]

/** The row of the table whose description carries a device's note: the driver could not collect, and said so at length. */
const failed = (note: string) =>
  ticketFor({ kind: "pickup-failed", routeId: ROUTE, pickupId: PICKUP, containerId: null, propertyId: null, sharedCollectionPointId: null, agreementId: null, customerId: null, reason: "inaccessible", note, containerLabel: "BIN-82014", address: "Parkvej 18", actualDriverId: DRIVER, plannedDriverId: DRIVER })

/** The row whose subject and description both carry the applier's detail. */
const rejected = (detail: string) => ticketFor({ kind: "command-rejected", routeId: null, pickupId: null, driverId: DRIVER, detail })

describe("the consumer's ticket text and the wire's bounds", () => {
  test("a subject built from a 500-character detail parses as a Label, cut at a space or, with none to cut at, at the bound", () => {
    for (const detail of long(100, 500)) {
      assert.ok(detail.length >= 500)
      const draft = rejected(detail)
      assert.ok(draft, "a rejected command is a ticket")
      const parsed = Label.safeParse(draft.subject)
      assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues))
      assert.equal(draft.subject.length <= LABEL_MAX, true)
      assert.equal(draft.subject.endsWith("…"), true)
    }
    // A short one is what the domain spelled, whole.
    const short = rejected("Pickup 12 is already completed")
    assert.equal(short?.subject, "Rejected command: Pickup 12 is already completed")
    assert.equal(Label.safeParse(short?.subject).success, true)
  })

  test("a description built from a 5000-character note or detail parses as a Paragraph, cut the same way", () => {
    for (const text of long(800, 5000)) {
      assert.ok(text.length >= 5000)
      for (const draft of [failed(text), rejected(text)]) {
        assert.ok(draft, "a failed pickup and a rejected command are both tickets")
        const parsed = Paragraph.safeParse(draft.description)
        assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues))
        assert.equal(draft.description.length <= PARAGRAPH_MAX, true)
        assert.equal(draft.description.endsWith("…"), true)
      }
    }
    // A short one is what the domain spelled, whole.
    const short = rejected("Pickup 12 is already completed")
    assert.equal(short?.description, "The driver's device sent a command the server refused. Note: Pickup 12 is already completed")
    assert.equal(Paragraph.safeParse(short?.description).success, true)
  })
})

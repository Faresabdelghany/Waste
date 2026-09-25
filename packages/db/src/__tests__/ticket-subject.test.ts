// The subject the outbox's consumer spells for a ticket
// (@waste/domain/resolution/from-event, Issue #109 §3) goes onto the wire as
// `Ticket.subject`, a `Label` of the contracts (@waste/contracts/text), and
// the domain — which depends on nothing — cannot import the contracts' bound,
// nor the contracts' tests the domain's module, whose purity allowlist names
// vocabularies and shape tables only. Two bounds, one rule: like
// statuses.test.ts, this package sees both sides, so it holds them together —
// the domain's `TICKET_SUBJECT_MAX` is `LABEL_MAX`, and a subject the domain
// builds from a detail far past it parses as a `Label` — so a bound moved on
// either side fails here and not on the worker's first long rejection.
//
// No database: both bounds are source.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Label, LABEL_MAX } from "@waste/contracts/text"
import { TICKET_SUBJECT_MAX, ticketFor } from "@waste/domain/resolution/from-event"

const DRIVER = "018f7c33-a000-7000-8000-000000000010"

describe("the consumer's ticket subject and the wire's Label", () => {
  test("are bounded alike", () => {
    assert.equal(TICKET_SUBJECT_MAX, LABEL_MAX)
  })

  test("a subject built from a 500-character detail parses as a Label, cut at a space or, with none to cut at, at the bound", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ")
    const token = "x".repeat(500)
    for (const detail of [words, token]) {
      assert.ok(detail.length >= 500)
      const draft = ticketFor({ kind: "command-rejected", routeId: null, pickupId: null, driverId: DRIVER, detail })
      assert.ok(draft, "a rejected command is a ticket")
      const parsed = Label.safeParse(draft.subject)
      assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues))
      assert.equal(draft.subject.length <= LABEL_MAX, true)
      assert.equal(draft.subject.endsWith("…"), true)
    }
    // A short one is what the domain spelled, whole.
    const short = ticketFor({ kind: "command-rejected", routeId: null, pickupId: null, driverId: DRIVER, detail: "Pickup 12 is already completed" })
    assert.equal(short?.subject, "Rejected command: Pickup 12 is already completed")
    assert.equal(Label.safeParse(short?.subject).success, true)
  })
})

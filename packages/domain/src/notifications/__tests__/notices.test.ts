// A staff notice (O16 of #290): an alert's at or above the severity a person
// picked, the e-mail an alert and an assigned ticket become, and the one
// person a ticket's notice goes to.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OUTBOX_KINDS } from "../../execution/vocabulary"
import { alertNotice, customerNoticeOf, severityReaches, ticketAssignedNotice } from "../notices"

describe("an alert's severity against a person's threshold", () => {
  test("reaches it at the threshold and above, never below", () => {
    assert.equal(severityReaches("critical", "high"), true)
    assert.equal(severityReaches("high", "high"), true)
    assert.equal(severityReaches("medium", "high"), false)
    assert.equal(severityReaches("low", "low"), true)
  })
})

describe("the notices", () => {
  test("an alert says its severity, its title and its details, with the project it was raised in", () => {
    assert.deepEqual(alertNotice({ severity: "critical", title: "Route 1042 not started", details: "Planned for 06:30; no session.", detectedAt: "2026-10-29T06:45:00.000Z" }, { projectName: "Copenhagen Central", companyName: "Kystbyen" }), {
      subject: "Critical alert · Route 1042 not started",
      body: "A critical alert was raised in Copenhagen Central.\n\nRoute 1042 not started\nPlanned for 06:30; no session.\n\nDetected 2026-10-29T06:45:00.000Z.\n\n— Kystbyen",
    })
  })

  test("a ticket assigned names its number, subject and priority, and who it is for", () => {
    assert.deepEqual(ticketAssignedNotice({ number: 1207, subject: "Missed collection at Parkvej 18", priority: "high", dueAt: null }, { projectName: "Copenhagen Central", companyName: "Kystbyen", recipientName: "Olivia Larsen" }), {
      subject: "Ticket T-1207 assigned to you · Missed collection at Parkvej 18",
      body: "Olivia Larsen, ticket T-1207 in Copenhagen Central is now yours.\n\nMissed collection at Parkvej 18\nPriority: high.\n\n— Kystbyen",
    })
    assert.match(ticketAssignedNotice({ number: 7, subject: "x", priority: "none", dueAt: "2026-10-30T12:00:00.000Z" }, { projectName: "P", companyName: "C", recipientName: "R" }).body, /Due 2026-10-30T12:00:00\.000Z\./)
  })
})

describe("the customer notice an outbox event is", () => {
  const booking = { bulkyBookingId: "01a0d3a5-e5e0-7000-8000-000000000001" }
  test("a booking booked or cancelled is its own, and its stop's completion or failure its collection or its miss", () => {
    assert.equal(customerNoticeOf("bulky-booking-booked", null), "bulky-booking-booked")
    assert.equal(customerNoticeOf("bulky-booking-cancelled", null), "bulky-booking-cancelled")
    assert.equal(customerNoticeOf("pickup-completed", booking), "bulky-booking-collected")
    assert.equal(customerNoticeOf("pickup-failed", booking), "bulky-booking-not-collected")
  })

  test("a stop that collects no booking, and every other kind, is no notice", () => {
    assert.equal(customerNoticeOf("pickup-completed", { bulkyBookingId: null }), null)
    assert.equal(customerNoticeOf("pickup-failed", null), null)
    const quiet = OUTBOX_KINDS.filter((kind) => customerNoticeOf(kind, booking) === null)
    assert.equal(quiet.length, OUTBOX_KINDS.length - 4)
    assert.ok(quiet.includes("pickup-skipped"), "a skipped stop was never tried: the office books it again")
  })
})

// A staff notice (O16 of #290): an alert's at or above the severity a person
// picked, the e-mail an alert and an assigned ticket become, and the one
// person a ticket's notice goes to.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { alertNotice, countingTicketNotice, CUSTOMER_NOTICE_KINDS, customerNoticeOf, NOTICE_VALUES, REMINDER_BATCH, REMINDER_DAILY_CAP, REMINDER_HOUR, reminderDayAt, severityReaches, ticketAssignedNotice, unfilledByNotice } from "../notices"
import { CUSTOMER_NOTICE_EVENTS } from "../vocabulary"

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

  test("a counting rule's ticket names its number, the team it waits with, and what was counted", () => {
    assert.deepEqual(countingTicketNotice({ number: 88, subject: "Emptied too often", description: "13 completed emptyings at this property in March 2026 reached the counting rule." }, { projectName: "Copenhagen Central", companyName: "Kystbyen", teamName: "Customer service" }), {
      subject: "Ticket T-88 for Customer service · Emptied too often",
      body: "A counting rule opened ticket T-88 in Copenhagen Central, waiting with Customer service.\n\nEmptied too often\n13 completed emptyings at this property in March 2026 reached the counting rule.\n\n— Kystbyen",
    })
  })
})

describe("the customer notice an outbox event is", () => {
  const booking = { bulkyBookingId: "01a0d3a5-e5e0-7000-8000-000000000001" }
  test("a booking booked or cancelled is its own, and its stop's completion or failure its collection or its miss", () => {
    assert.equal(customerNoticeOf("bulky-booking-booked"), "bulky-booking-booked")
    assert.equal(customerNoticeOf("bulky-booking-cancelled"), "bulky-booking-cancelled")
    assert.equal(customerNoticeOf("pickup-completed", booking), "bulky-booking-collected")
    assert.equal(customerNoticeOf("pickup-failed", booking), "bulky-booking-not-collected")
  })

  test("a reply and a completion are the ticket's, a cancelled route its own, and a route not started is late (C18 of #291)", () => {
    assert.equal(customerNoticeOf("ticket-replied"), "ticket-replied")
    assert.equal(customerNoticeOf("ticket-completed"), "ticket-completed")
    assert.equal(customerNoticeOf("route-cancelled"), "route-cancelled")
    assert.equal(customerNoticeOf("alert-raised", { alertRule: "route-not-started" }), "route-late")
    assert.equal(customerNoticeOf("alert-raised", { alertRule: "session-silent" }), null, "a silent device is the office's, not the customer's")
    assert.equal(customerNoticeOf("alert-raised"), null, "an alert raised by hand")
  })

  test("a stop that collects no booking is no notice, and a notice comes from eight kinds alone", () => {
    assert.equal(customerNoticeOf("pickup-completed", { bulkyBookingId: null }), null)
    assert.equal(customerNoticeOf("pickup-failed"), null)
    for (const kind of CUSTOMER_NOTICE_KINDS) assert.notEqual(customerNoticeOf(kind, { ...booking, alertRule: "route-not-started" }), null, kind)
    assert.deepEqual([...CUSTOMER_NOTICE_KINDS], ["bulky-booking-booked", "bulky-booking-cancelled", "pickup-completed", "pickup-failed", "ticket-replied", "ticket-completed", "route-cancelled", "alert-raised"])
    assert.ok(!(CUSTOMER_NOTICE_KINDS as readonly string[]).includes("pickup-skipped"), "a skipped stop was never tried: the office books it again")
  })
})

describe("what each notice fills, and the reminders' clock", () => {
  test("a notice refuses a template naming a value it does not fill", () => {
    assert.deepEqual(unfilledByNotice("collection-reminder", "Dear {{recipientName}}, we come on {{collectionDate}}"), [])
    assert.deepEqual(unfilledByNotice("collection-reminder", "Ticket {{ticketNumber}}: {{replyText}}"), ["ticketNumber", "replyText"])
    assert.deepEqual(unfilledByNotice("ticket-replied", "T-{{ticketNumber}}: {{replyText}} {{collectionDate}}"), ["collectionDate"])
    for (const notice of CUSTOMER_NOTICE_EVENTS) assert.ok(NOTICE_VALUES[notice] !== undefined, notice)
  })

  test("the next day's reminders go once the project's clock passes two in the afternoon", () => {
    assert.equal(REMINDER_HOUR, 14)
    assert.equal(reminderDayAt("2026-10-29", 13), null)
    assert.equal(reminderDayAt("2026-10-29", 14), "2026-10-30")
    assert.equal(reminderDayAt("2026-12-31", 23), "2027-01-01")
  })

  test("a day's reminders are bounded per run and per day, the cap what the afternoon's hourly runs reach", () => {
    assert.equal(REMINDER_BATCH, 200)
    assert.equal(REMINDER_DAILY_CAP, 2000)
  })
})

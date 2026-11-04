// A staff member's notices on the wire (O16 of #290): the whole set replaced,
// strict, none asked for by default.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NO_NOTIFICATIONS, NotificationPreferences, NotificationPreferencesPut } from "../notifications"
import { refusal } from "./expect"

describe("a staff member's notification preferences", () => {
  test("ask for nothing until chosen", () => {
    assert.deepEqual(NotificationPreferences.parse(NO_NOTIFICATIONS), { alertRaisedMinSeverity: null, ticketAssigned: false })
  })

  test("are replaced whole: a severity or none, and the assignment's yes or no, nothing else", () => {
    assert.deepEqual(NotificationPreferencesPut.parse({ alertRaisedMinSeverity: "high", ticketAssigned: true }), { alertRaisedMinSeverity: "high", ticketAssigned: true })
    assert.deepEqual(refusal(NotificationPreferencesPut.safeParse({ ticketAssigned: true })).map(({ path }) => path), ["alertRaisedMinSeverity"])
    assert.deepEqual(refusal(NotificationPreferencesPut.safeParse({ alertRaisedMinSeverity: "urgent", ticketAssigned: false })).map(({ path }) => path), ["alertRaisedMinSeverity"])
    assert.deepEqual(refusal(NotificationPreferencesPut.safeParse({ alertRaisedMinSeverity: null, ticketAssigned: false, userAccountId: "01a0d3a5-e5e0-7000-8000-000000000001" })).map(({ path }) => path), [""])
  })
})

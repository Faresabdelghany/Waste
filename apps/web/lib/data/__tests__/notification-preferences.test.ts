import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NotificationPreferencesPut } from "@waste/contracts/notifications"
import { ALERT_SEVERITIES } from "@waste/domain/resolution/vocabulary"

import { ALERT_THRESHOLD_OPTIONS, alertsWithheldBecause, alertThresholdOf, NO_ALERTS, noticeRowOf, preferencesBodyOf } from "../notification-preferences"

describe("Settings › Notifications on the API (O16 of #290)", () => {
  test("offers no alerts and every severity, most severe first, and sends a body the API takes", () => {
    assert.deepEqual(ALERT_THRESHOLD_OPTIONS.map((option) => option.value), [NO_ALERTS, ...ALERT_SEVERITIES])
    for (const option of ALERT_THRESHOLD_OPTIONS) assert.ok(NotificationPreferencesPut.safeParse(preferencesBodyOf(option.value, true)).success, option.value)
    assert.deepEqual(preferencesBodyOf(NO_ALERTS, false), { alertRaisedMinSeverity: null, ticketAssigned: false })
    assert.equal(alertThresholdOf({ alertRaisedMinSeverity: null, ticketAssigned: true }), NO_ALERTS)
    assert.equal(alertThresholdOf({ alertRaisedMinSeverity: "high", ticketAssigned: false }), "high")
  })

  test("says when the role reads no alerts, so none will reach it", () => {
    assert.equal(alertsWithheldBecause([{ moduleKey: "operate.exceptions", actions: ["view"] }]), null)
    assert.match(alertsWithheldBecause([{ moduleKey: "operate.tickets", actions: ["view"] }]) ?? "", /does not read alerts/)
  })

  test("shows a notice by its subject, its address and how its sending stands", () => {
    const notice = {
      id: "01a0d3a5-e5e0-7000-8000-000000000001",
      createdAt: "2026-10-29T07:00:00.000Z",
      updatedAt: "2026-10-29T07:00:05.000Z",
      projectId: "01a0d3a5-e5e0-7000-8000-000000000002",
      templateId: null,
      customerId: null,
      contactId: null,
      userAccountId: "01a0d3a5-e5e0-7000-8000-000000000003",
      channel: "email",
      purpose: "staff",
      recipient: "olivia@kystbyen.example",
      subject: "Critical alert · Truck on fire",
      body: "A critical alert…",
      status: "sent",
      attempts: 1,
      provider: "log",
      providerMessageId: "log-1",
      reason: null,
      sentAt: "2026-10-29T07:00:05.000Z",
    } as const
    assert.deepEqual(noticeRowOf(notice), { id: notice.id, subject: "Critical alert · Truck on fire", to: "olivia@kystbyen.example", status: "Sent", sentAt: notice.sentAt, reason: null })
  })
})

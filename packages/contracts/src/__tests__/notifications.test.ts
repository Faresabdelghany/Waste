// A staff member's notices on the wire (O16 of #290): the whole set replaced,
// strict, none asked for by default.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NO_NOTIFICATIONS, NotificationPreferences, NotificationPreferencesPut, NotificationRule, NotificationRulesPut, ONE_RULE_PER_NOTICE, AREAS_ARE_A_BROADCASTS } from "../notifications"
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

describe("a project's notification rules (part b)", () => {
  const template = "01a0d3a5-e5e0-7000-8000-000000000001"
  test("are replaced whole: each notice once, from a template, an empty set sending none", () => {
    assert.deepEqual(NotificationRulesPut.parse({ rules: [] }), { rules: [] })
    assert.ok(NotificationRulesPut.safeParse({ rules: [{ event: "bulky-booking-booked", templateId: template }, { event: "bulky-booking-not-collected", templateId: template }] }).success)
    assert.deepEqual(refusal(NotificationRulesPut.safeParse({ rules: [{ event: "bulky-booking-booked", templateId: template }, { event: "bulky-booking-booked", templateId: template }] })), [{ path: "rules.1.event", message: ONE_RULE_PER_NOTICE }])
    assert.deepEqual(refusal(NotificationRulesPut.safeParse({ rules: [{ event: "ticket-assigned", templateId: template }] })).map(({ path }) => path), ["rules.0.event"], "a staff event is a person's, not a project's")
    assert.equal(NotificationRulesPut.safeParse({ rules: [], projectId: template }).success, false, "the project is the path's")
  })
})

describe("a broadcast's areas (C18 of #291)", () => {
  const template = "01a0d3a5-e5e0-7000-8000-000000000001"
  const area = "01a0d3a5-e5e0-7000-8000-000000000002"
  test("a route cancelled or late may name areas, each once; no other notice may", () => {
    assert.ok(NotificationRulesPut.safeParse({ rules: [{ event: "route-cancelled", templateId: template, planningAreaIds: [area] }, { event: "route-late", templateId: template }] }).success)
    assert.deepEqual(refusal(NotificationRulesPut.safeParse({ rules: [{ event: "collection-reminder", templateId: template, planningAreaIds: [area] }] })), [{ path: "rules.0.planningAreaIds", message: AREAS_ARE_A_BROADCASTS }])
    assert.deepEqual(refusal(NotificationRulesPut.safeParse({ rules: [{ event: "route-late", templateId: template, planningAreaIds: [area, area] }] })).map(({ path }) => path), ["rules.0.planningAreaIds"])
    assert.deepEqual(NotificationRule.parse({ event: "ticket-replied", templateId: template }).planningAreaIds, [], "a rule read without areas has none")
  })
})

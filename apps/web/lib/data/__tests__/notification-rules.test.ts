import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NotificationRulesPut } from "@waste/contracts/notifications"
import { CUSTOMER_NOTICE_EVENTS } from "@waste/domain/notifications/vocabulary"

import { CUSTOMER_NOTICES, isBroadcast, NOT_SENT, noticePicksOf, noticeRulesBody, noticeTemplateOptions } from "../notification-rules"

const template = (id: string, purpose: "service" | "billing", status: "active" | "inactive", body = "Hi") =>
  ({ id, createdAt: "", updatedAt: "", projectId: "p", name: id, purpose, channel: "sms", subject: null, body, status }) as const

describe("Settings › Message templates' customer notices (O16 of #290, part b; C18 of #291)", () => {
  test("names every notice of the vocabulary, in its order", () => {
    assert.deepEqual(CUSTOMER_NOTICES.map((notice) => notice.event), [...CUSTOMER_NOTICE_EVENTS])
  })

  test("offers only the active service templates whose placeholders the notice fills, as the API would take", () => {
    const templates = [template("a", "service", "active"), template("b", "billing", "active"), template("c", "service", "inactive"), template("d", "service", "active", "Reply to {{ticketNumber}}: {{replyText}}")]
    assert.deepEqual(noticeTemplateOptions(templates, "bulky-booking-booked").map((row) => row.id), ["a"])
    assert.deepEqual(noticeTemplateOptions(templates, "ticket-replied").map((row) => row.id), ["a", "d"])
    assert.deepEqual(noticeTemplateOptions(templates, "ticket-completed").map((row) => row.id), ["a"], "a completion has no reply's words")
  })

  test("reads the picks off the rules and sends back only the notices with a template, a broadcast with its areas, a body the API takes", () => {
    const id = "01a0d3a5-e5e0-7000-8000-000000000001"
    const area = "01a0d3a5-e5e0-7000-8000-000000000002"
    const picks = noticePicksOf({ projectId: id, rules: [{ event: "bulky-booking-collected", templateId: id, planningAreaIds: [] }, { event: "route-late", templateId: id, planningAreaIds: [area] }] })
    const none = { templateId: NOT_SENT, planningAreaIds: [] }
    assert.deepEqual(picks["bulky-booking-booked"], none)
    assert.deepEqual(picks["bulky-booking-collected"], { templateId: id, planningAreaIds: [] })
    assert.deepEqual(picks["route-late"], { templateId: id, planningAreaIds: [area] })
    const body = noticeRulesBody({ ...picks, "bulky-booking-booked": { templateId: id, planningAreaIds: [] } })
    assert.deepEqual(body, {
      rules: [
        { event: "bulky-booking-booked", templateId: id },
        { event: "bulky-booking-collected", templateId: id },
        { event: "route-late", templateId: id, planningAreaIds: [area] },
      ],
    })
    assert.ok(NotificationRulesPut.safeParse(body).success)
  })

  test("only the two broadcasts name areas", () => {
    assert.deepEqual(CUSTOMER_NOTICES.filter((notice) => isBroadcast(notice.event)).map((notice) => notice.event), ["route-cancelled", "route-late"])
  })
})

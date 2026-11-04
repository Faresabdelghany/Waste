import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NotificationRulesPut } from "@waste/contracts/notifications"
import { CUSTOMER_NOTICE_EVENTS } from "@waste/domain/notifications/vocabulary"

import { CUSTOMER_NOTICES, NOT_SENT, noticePicksOf, noticeRulesBody, noticeTemplateOptions } from "../notification-rules"

const template = (id: string, purpose: "service" | "billing", status: "active" | "inactive") =>
  ({ id, createdAt: "", updatedAt: "", projectId: "p", name: id, purpose, channel: "sms", subject: null, body: "Hi", status }) as const

describe("Settings › Message templates' customer notices (O16 of #290, part b)", () => {
  test("names every notice of the vocabulary, in its order", () => {
    assert.deepEqual(CUSTOMER_NOTICES.map((notice) => notice.event), [...CUSTOMER_NOTICE_EVENTS])
  })

  test("offers only the active service templates, as the API would take", () => {
    assert.deepEqual(noticeTemplateOptions([template("a", "service", "active"), template("b", "billing", "active"), template("c", "service", "inactive")]).map((row) => row.id), ["a"])
  })

  test("reads the picks off the rules and sends back only the notices with a template, a body the API takes", () => {
    const id = "01a0d3a5-e5e0-7000-8000-000000000001"
    const picks = noticePicksOf({ projectId: id, rules: [{ event: "bulky-booking-collected", templateId: id }] })
    assert.deepEqual(picks, { "bulky-booking-booked": NOT_SENT, "bulky-booking-cancelled": NOT_SENT, "bulky-booking-collected": id, "bulky-booking-not-collected": NOT_SENT })
    const body = noticeRulesBody({ ...picks, "bulky-booking-booked": id })
    assert.deepEqual(body, { rules: [{ event: "bulky-booking-booked", templateId: id }, { event: "bulky-booking-collected", templateId: id }] })
    assert.ok(NotificationRulesPut.safeParse(body).success)
  })
})

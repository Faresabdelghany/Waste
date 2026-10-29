// Messaging on the wire (#291 C15): a template's channel shape and its
// placeholders refused at their fields in the domain's sentences, a patch
// field by field, the office's request strict, and the log's query.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SMS_BODY_MAX } from "@waste/domain/messaging/template"

import { MessageCreate, MessageListQuery, MessageTemplateCreate, MessageTemplatePatch, unknownPlaceholderSentence } from "../messaging"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const email = { projectId: PROJECT, name: "Collection moved", purpose: "service", channel: "email", subject: "Your collection, {{customerName}}", body: "Dear {{recipientName}}, …\n{{companyName}}" }

describe("a message template", () => {
  test("is a project's, active unless said otherwise, an e-mail with a subject and a text message without one", () => {
    assert.equal(MessageTemplateCreate.parse(email).status, "active")
    assert.ok(MessageTemplateCreate.safeParse({ ...email, channel: "sms", subject: null }).success)
    assert.ok(MessageTemplateCreate.safeParse({ ...email, channel: "sms", subject: undefined }).success)
    assert.deepEqual(refusal(MessageTemplateCreate.safeParse({ ...email, subject: undefined })), [{ path: "subject", message: "An e-mail template has a subject" }])
    assert.deepEqual(refusal(MessageTemplateCreate.safeParse({ ...email, channel: "sms" })), [{ path: "subject", message: "A text message has no subject" }])
    assert.deepEqual(refusal(MessageTemplateCreate.safeParse({ ...email, channel: "sms", subject: null, body: "x".repeat(SMS_BODY_MAX + 1) })), [{ path: "body", message: `A text message is at most ${SMS_BODY_MAX} characters` }])
    refusesWhatTheServerOwns(MessageTemplateCreate, email)
  })

  test("names only placeholders a message fills, refused at the field that names them", () => {
    assert.deepEqual(refusal(MessageTemplateCreate.safeParse({ ...email, body: "Invoice {{invoiceNumber}} for {{ firstName }}" })), [{ path: "body", message: unknownPlaceholderSentence(["invoiceNumber", "firstName"]) }])
    assert.deepEqual(refusal(MessageTemplatePatch.safeParse({ subject: "Hi {{nobody}}" })), [{ path: "subject", message: unknownPlaceholderSentence(["nobody"]) }])
    assert.equal(unknownPlaceholderSentence(["nobody"]), "{{nobody}} is filled by no message; use {{recipientName}}, {{customerName}}, {{companyName}}, {{collectionDate}}, {{ticketNumber}}, {{replyText}}")
  })

  test("is for service or billing, never for staff: a staff notice is the domain's text (O16 of #290)", () => {
    assert.equal(MessageTemplateCreate.safeParse({ ...email, purpose: "staff" }).success, false)
    assert.equal(MessageTemplatePatch.safeParse({ purpose: "staff" }).success, false)
  })

  test("is patched field by field; its project is its own for good", () => {
    assert.deepEqual(MessageTemplatePatch.parse({ status: "inactive" }), { status: "inactive" })
    assert.equal(MessageTemplatePatch.safeParse({ projectId: OTHER }).success, false)
    refusesAnEmptyPatch(MessageTemplatePatch)
  })
})

describe("the office's request to send a message", () => {
  test("names a template and a customer, and a contact person where it goes to one", () => {
    assert.deepEqual(MessageCreate.parse({ templateId: PROJECT, customerId: OTHER }), { templateId: PROJECT, customerId: OTHER })
    assert.ok(MessageCreate.safeParse({ templateId: PROJECT, customerId: OTHER, contactId: null }).success)
    assert.equal(MessageCreate.safeParse({ templateId: PROJECT, customerId: OTHER, recipient: "x@example.dk" }).success, false)
    assert.equal(MessageCreate.safeParse({ templateId: PROJECT, customerId: OTHER, body: "typed" }).success, false)
  })

  test("and the log is read by customer, project or status", () => {
    assert.deepEqual(MessageListQuery.parse({ customerId: OTHER, status: "withheld" }), { customerId: OTHER, status: "withheld", limit: 50 })
    assert.equal(MessageListQuery.safeParse({ status: "delivered" }).success, false)
  })
})

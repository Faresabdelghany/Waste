// A message template's rules (#291 C15): which placeholders a text names and
// which of them nobody fills, a text rendered from its values, what a channel
// asks of a template, which purposes need the customer's consent, and an
// address told in a log line without being spelled out.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { channelShapeIssue, maskedAddress, MESSAGE_VARIABLES, needsConsent, placeholdersOf, renderTemplate, SMS_BODY_MAX, unfilledPlaceholders, unfilledSentence, unknownPlaceholders } from "../template"

describe("a template's placeholders", () => {
  test("are the names between double braces, spaces allowed, each once in the order first named", () => {
    assert.deepEqual(placeholdersOf("Dear {{recipientName}}, {{ customerName }}'s bins — {{recipientName}}"), ["recipientName", "customerName"])
    assert.deepEqual(placeholdersOf("No placeholder, {single} braces, {{ }} empty"), [])
  })

  test("that no message fills are named back, so a template is refused before it is ever sent", () => {
    assert.deepEqual(unknownPlaceholders("Hello {{recipientName}} from {{companyName}}"), [])
    assert.deepEqual(unknownPlaceholders("Hello {{firstName}}, invoice {{invoiceNumber}} {{customerName}}"), ["firstName", "invoiceNumber"])
    assert.deepEqual([...MESSAGE_VARIABLES], ["recipientName", "customerName", "companyName", "collectionDate", "ticketNumber", "replyText"])
  })
})

describe("a template rendered", () => {
  test("fills each placeholder with its value, however it was spaced, and leaves the rest of the text as written", () => {
    assert.equal(renderTemplate("Dear {{ recipientName }}, about {{customerName}}: {{recipientName}}.", { recipientName: "Hanne", customerName: "Østerbro Boligforening", companyName: "Kystbyen" }), "Dear Hanne, about Østerbro Boligforening: Hanne.")
  })

  test("a known value its sender does not have is named back, so the send is refused rather than sent with a hole (O16 of #290, part b)", () => {
    const office = { recipientName: "Hanne", customerName: "X", companyName: "Y" }
    assert.deepEqual(unfilledPlaceholders("Your collection on {{collectionDate}}, {{recipientName}} {{invoiceNumber}}", office), ["collectionDate"], "an unknown name is the template's refusal, not the send's")
    assert.deepEqual(unfilledPlaceholders("On {{collectionDate}}", { ...office, collectionDate: "2026-11-02" }), [])
    assert.equal(renderTemplate("On {{collectionDate}}", { ...office, collectionDate: "2026-11-02" }), "On 2026-11-02")
    assert.equal(unfilledSentence("Collection booked", ["collectionDate"]), "The template Collection booked names {{collectionDate}}, which this message has no value for; pick a template without it")
  })

  test("never interprets a value as a placeholder of its own", () => {
    assert.equal(renderTemplate("{{recipientName}} / {{customerName}}", { recipientName: "{{customerName}}", customerName: "X", companyName: "Y" }), "{{customerName}} / X")
  })
})

describe("a channel's demands", () => {
  test("an e-mail has a subject, a text message none and a body of at most a few segments", () => {
    assert.equal(channelShapeIssue({ channel: "email", subject: "Your collection", body: "Hi" }), undefined)
    assert.deepEqual(channelShapeIssue({ channel: "email", subject: null, body: "Hi" }), { path: "subject", message: "An e-mail template has a subject" })
    assert.deepEqual(channelShapeIssue({ channel: "sms", subject: "Nope", body: "Hi" }), { path: "subject", message: "A text message has no subject" })
    assert.equal(channelShapeIssue({ channel: "sms", subject: null, body: "x".repeat(SMS_BODY_MAX) }), undefined)
    assert.deepEqual(channelShapeIssue({ channel: "sms", subject: null, body: "x".repeat(SMS_BODY_MAX + 1) }), { path: "body", message: `A text message is at most ${SMS_BODY_MAX} characters` })
  })
})

describe("consent", () => {
  test("a service message needs the customer's consent; a billing message is owed whatever they chose", () => {
    assert.equal(needsConsent("service"), true)
    assert.equal(needsConsent("billing"), false)
    assert.equal(needsConsent("staff"), false)
  })
})

describe("an address in a log line", () => {
  test("keeps the domain of an e-mail and the last digits of a phone, and hides the rest", () => {
    assert.equal(maskedAddress("email", "hanne.holm@example.dk"), "h***@example.dk")
    assert.equal(maskedAddress("sms", "+45 20 30 40 50"), "***50")
    assert.equal(maskedAddress("email", "odd"), "***")
  })
})

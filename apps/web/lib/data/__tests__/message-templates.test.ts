// Settings › Message templates (#291 C15): a draft as the contracts' bodies,
// refused here at its field in the API's sentences before the API sees it, a
// text message's subject dropped, a patch of the moved fields alone, and the
// pane offered on the Pilot alone.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MessageTemplateCreate, MessageTemplatePatch, unknownPlaceholderSentence as contractsSentence, type MessageTemplate } from "@waste/contracts/messaging"

import { MESSAGE_TEMPLATES_SETTINGS_PANE_ID, NEW_TEMPLATE, templateCreateBody, templateDraftOf, templateLine, templatePatchBody, templatesAccessOf, unknownPlaceholderSentence } from "../message-templates"
import { settingsPaneOffered } from "../settings-panes"

const PROJECT = "01a0d2a4-a280-7002-8000-000000000001"
const stored: MessageTemplate = {
  id: "01a0d2a4-a280-7099-8000-000000000001",
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  projectId: PROJECT,
  name: "Collection moved",
  purpose: "service",
  channel: "email",
  subject: "About {{customerName}}",
  body: "Dear {{recipientName}}",
  status: "active",
}

describe("a message template's draft (#291 C15)", () => {
  test("goes out as the create body the contracts take", () => {
    const body = templateCreateBody(PROJECT, { ...NEW_TEMPLATE, name: " Collection moved ", subject: "About {{customerName}}", body: "Dear {{recipientName}}" })
    assert.deepEqual(body, { projectId: PROJECT, name: "Collection moved", purpose: "service", channel: "email", subject: "About {{customerName}}", body: "Dear {{recipientName}}", status: "active" })
    assert.ok(MessageTemplateCreate.safeParse(body).success)
  })

  test("drops a text message's subject, never sends it", () => {
    const body = templateCreateBody(PROJECT, { ...NEW_TEMPLATE, name: "Due", channel: "sms", subject: "left over", body: "Your invoice is due" })
    assert.ok(!("field" in body))
    assert.equal(body.subject, null)
    assert.ok(MessageTemplateCreate.safeParse(body).success)
  })

  test("is refused at its field, in the API's sentences, where the API would refuse it", () => {
    assert.deepEqual(templateCreateBody(PROJECT, { ...NEW_TEMPLATE, body: "x" }), { field: "name", message: "A template needs a name" })
    assert.deepEqual(templateCreateBody(PROJECT, { ...NEW_TEMPLATE, name: "N", body: "x" }), { field: "subject", message: "An e-mail template has a subject" })
    assert.deepEqual(templateCreateBody(PROJECT, { ...NEW_TEMPLATE, name: "N", subject: "S", body: "Invoice {{invoiceNumber}}" }), { field: "body", message: unknownPlaceholderSentence(["invoiceNumber"]) })
    assert.equal(unknownPlaceholderSentence(["a", "b"]), contractsSentence(["a", "b"]))
  })

  test("is patched with the fields that moved alone, and nothing where none did", () => {
    assert.equal(templatePatchBody(stored, templateDraftOf(stored)), null)
    const patch = templatePatchBody(stored, { ...templateDraftOf(stored), status: "inactive" })
    assert.deepEqual(patch, { status: "inactive" })
    assert.ok(MessageTemplatePatch.safeParse(patch).success)
    assert.deepEqual(templatePatchBody(stored, { ...templateDraftOf(stored), channel: "sms" }), { channel: "sms", subject: null })
  })

  test("reads its channel, its purpose and whether it is retired, and is the Pilot's pane under Tickets & communication's grants", () => {
    assert.equal(templateLine({ ...stored, status: "inactive" }), "E-mail · Service · Inactive")
    assert.equal(settingsPaneOffered(MESSAGE_TEMPLATES_SETTINGS_PANE_ID, true), true)
    assert.equal(settingsPaneOffered(MESSAGE_TEMPLATES_SETTINGS_PANE_ID, false), false)
    assert.deepEqual(templatesAccessOf([{ moduleKey: "configure.templates", actions: ["view"] }]), { view: true, create: false, edit: false })
  })
})

// Settings › Message templates (#291 C15): a project's templates as the
// pane edits them, and the bodies `POST /message-templates` and `PATCH
// /message-templates/:id` take. The pane reads and writes the API directly
// (components/settings/message-templates-settings.tsx), as the Ticket SLA's
// does: a template is one project's configuration, not a record of a
// workspace module. Offered on the Pilot alone, where it takes the
// templates of the fixtures' Tickets & communication onto the API. A draft
// the API would refuse is refused here first, at its field, in the domain's
// sentence (@waste/domain/messaging/template, which the contracts read too).
import type { MessageChannel, MessagePurpose, MessageTemplate, MessageTemplateStatus } from "@waste/contracts/messaging"
import { channelShapeIssue, MESSAGE_VARIABLES, unknownPlaceholders } from "@waste/domain/messaging/template"

import { allows, type Grants } from "../api/grants"

/** The pane, offered on the Pilot alone: the templates are the API's. */
export const MESSAGE_TEMPLATES_SETTINGS_PANE_ID = "message-templates"

/** The module the templates are granted under: Tickets & communication's. */
export const MESSAGE_TEMPLATES_MODULE_KEY = "configure.templates"

export const CHANNEL_LABELS: Readonly<Record<MessageChannel, string>> = { email: "E-mail", sms: "Text message" }
export const PURPOSE_LABELS: Readonly<Record<MessagePurpose, string>> = { service: "Service", billing: "Billing" }
/** What each purpose means for consent, as the form says it beside the picker. */
export const PURPOSE_HINTS: Readonly<Record<MessagePurpose, string>> = {
  service: "Sent only to customers who allow service messages.",
  billing: "Sent whatever the customer chose about service messages.",
}

/** The placeholders a text may name, as a person types them. */
export const PLACEHOLDERS = MESSAGE_VARIABLES.map((name) => `{{${name}}}`)

/** What a role may do in the pane. */
export const templatesAccessOf = (grants: Grants | undefined) => ({
  view: allows(grants, MESSAGE_TEMPLATES_MODULE_KEY, "view"),
  create: allows(grants, MESSAGE_TEMPLATES_MODULE_KEY, "create"),
  edit: allows(grants, MESSAGE_TEMPLATES_MODULE_KEY, "edit"),
})

/** A template as the dialog holds it: every field as typed, the template's id where it is an edit. */
export type TemplateDraft = {
  id?: string
  name: string
  purpose: MessagePurpose
  channel: MessageChannel
  subject: string
  body: string
  status: MessageTemplateStatus
}

export const NEW_TEMPLATE: TemplateDraft = { name: "", purpose: "service", channel: "email", subject: "", body: "", status: "active" }

export const templateDraftOf = (template: MessageTemplate): TemplateDraft => ({
  id: template.id,
  name: template.name,
  purpose: template.purpose,
  channel: template.channel,
  subject: template.subject ?? "",
  body: template.body,
  status: template.status,
})

/** A field the draft has wrong, with the sentence the API would answer. */
export type TemplateRefusal = { field: "name" | "subject" | "body"; message: string }

export const isTemplateRefusal = (value: unknown): value is TemplateRefusal => typeof value === "object" && value !== null && "field" in value && "message" in value

/** The sentence a placeholder no message fills earns (`@waste/contracts/messaging`, `unknownPlaceholderSentence`); the test holds the two equal. */
export const unknownPlaceholderSentence = (names: readonly string[]) =>
  `${names.map((name) => `{{${name}}}`).join(", ")} ${names.length === 1 ? "is" : "are"} filled by no message; use ${PLACEHOLDERS.join(", ")}`

type TemplateFields = { name: string; purpose: MessagePurpose; channel: MessageChannel; subject: string | null; body: string; status: MessageTemplateStatus }

/** The draft as the wire spells a template, or the first field the API would refuse: a text message's subject is dropped, never sent. */
export function templateFieldsOf(draft: TemplateDraft): TemplateFields | TemplateRefusal {
  const name = draft.name.trim()
  if (name === "") return { field: "name", message: "A template needs a name" }
  const subject = draft.channel === "sms" ? null : draft.subject.trim() === "" ? null : draft.subject.trim()
  const body = draft.body
  if (body.trim() === "") return { field: "body", message: "A template needs a body" }
  const shape = channelShapeIssue({ channel: draft.channel, subject, body })
  if (shape !== undefined) return { field: shape.path, message: shape.message }
  for (const field of ["subject", "body"] as const) {
    const text = field === "subject" ? subject : body
    const unknown = text === null ? [] : unknownPlaceholders(text)
    if (unknown.length > 0) return { field, message: unknownPlaceholderSentence(unknown) }
  }
  return { name, purpose: draft.purpose, channel: draft.channel, subject, body, status: draft.status }
}

/** The create body: the project and the fields. */
export function templateCreateBody(projectId: string, draft: TemplateDraft): (TemplateFields & { projectId: string }) | TemplateRefusal {
  const fields = templateFieldsOf(draft)
  return isTemplateRefusal(fields) ? fields : { projectId, ...fields }
}

/** The patch body: the fields that moved from the stored template, or null where nothing did. */
export function templatePatchBody(stored: MessageTemplate, draft: TemplateDraft): Partial<TemplateFields> | TemplateRefusal | null {
  const fields = templateFieldsOf(draft)
  if (isTemplateRefusal(fields)) return fields
  const patch: Partial<TemplateFields> = {}
  for (const key of Object.keys(fields) as Array<keyof TemplateFields>) {
    if (fields[key] !== stored[key]) (patch as Record<string, unknown>)[key] = fields[key]
  }
  return Object.keys(patch).length === 0 ? null : patch
}

/** A template's line in the pane: "E-mail · Service · Inactive". */
export const templateLine = (template: Pick<MessageTemplate, "channel" | "purpose" | "status">): string =>
  [CHANNEL_LABELS[template.channel], PURPOSE_LABELS[template.purpose], ...(template.status === "inactive" ? ["Inactive"] : [])].join(" · ")

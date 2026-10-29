// Messaging on the wire (#291 C15): a project's message templates, written
// in Settings › Message templates, and the delivery log of every message sent
// from one, with the office's request to send one to a customer or to one of
// its contact persons. Sending is the worker's, through a provider door that
// is log-only until a card-free provider is verified (the owner's decision on
// #291), so a message is answered `queued` and read again to learn whether it
// was sent, failed past its attempts, or withheld for want of the customer's
// consent to service messages.
//
// A template's text names its values as `{{placeholders}}`; one no message
// fills is refused at its field, and an e-mail carries a subject and a text
// message none and a body that fits (@waste/domain/messaging/template, whose
// sentences these are). A patch is judged whole by the API against the
// stored template, since a channel moved alone changes what the subject must
// be.
import { channelShapeIssue, MESSAGE_VARIABLES, unknownPlaceholders } from "@waste/domain/messaging/template"
import { MESSAGE_CHANNELS, MESSAGE_PURPOSES, MESSAGE_STATUSES, MESSAGE_TEMPLATE_STATUSES } from "@waste/domain/messaging/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, NonNegativeInt, somethingToChange, stamped } from "./resource"
import { Label } from "./text"

export const MessageChannel = z.enum(MESSAGE_CHANNELS)
export type MessageChannel = z.infer<typeof MessageChannel>
export const MessagePurpose = z.enum(MESSAGE_PURPOSES)
export type MessagePurpose = z.infer<typeof MessagePurpose>
export const MessageStatus = z.enum(MESSAGE_STATUSES)
export type MessageStatus = z.infer<typeof MessageStatus>
export const MessageTemplateStatus = z.enum(MESSAGE_TEMPLATE_STATUSES)
export type MessageTemplateStatus = z.infer<typeof MessageTemplateStatus>

/** A template's body: room for an e-mail of a few paragraphs; a text message's own bound is the channel's rule. */
const TEMPLATE_BODY_MAX = 10_000
const TemplateBody = z.string().min(1).max(TEMPLATE_BODY_MAX).refine((text) => text.trim().length > 0, { message: "Say something other than whitespace" })

/** The sentence a placeholder nobody fills earns, naming the ones that are filled. */
export const unknownPlaceholderSentence = (names: readonly string[]) =>
  `${names.map((name) => `{{${name}}}`).join(", ")} ${names.length === 1 ? "is" : "are"} filled by no message; use ${MESSAGE_VARIABLES.map((name) => `{{${name}}}`).join(", ")}`

/** The placeholders of the subject and the body, held to the ones a message fills, each refused at its own field. */
function placeholdersIssues(template: { subject?: string | null; body?: string }, context: z.RefinementCtx): void {
  for (const path of ["subject", "body"] as const) {
    const text = template[path]
    if (typeof text !== "string") continue
    const unknown = unknownPlaceholders(text)
    if (unknown.length > 0) context.addIssue({ code: "custom", path: [path], message: unknownPlaceholderSentence(unknown) })
  }
}

export const MessageTemplate = z.object({
  ...stamped,
  projectId: Id,
  name: Label,
  purpose: MessagePurpose,
  channel: MessageChannel,
  subject: Label.nullable(),
  body: z.string(),
  status: MessageTemplateStatus,
})
export type MessageTemplate = z.infer<typeof MessageTemplate>

export const MessageTemplateCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    purpose: MessagePurpose,
    channel: MessageChannel,
    subject: Label.nullable().optional().describe("An e-mail's subject, required for one; a text message has none."),
    body: TemplateBody,
    status: MessageTemplateStatus.default("active").describe("Defaults to active when absent: a template is written to be used."),
  })
  .superRefine((template, context) => {
    const issue = channelShapeIssue({ channel: template.channel, subject: template.subject ?? null, body: template.body })
    if (issue !== undefined) context.addIssue({ code: "custom", path: [issue.path], message: issue.message })
    placeholdersIssues(template, context)
  })
export type MessageTemplateCreate = z.infer<typeof MessageTemplateCreate>

/** Every field optional but the project, which a template keeps; the channel's demands are the API's to judge against the stored template. */
export const MessageTemplatePatch = z
  .strictObject({
    name: Label.optional(),
    purpose: MessagePurpose.optional(),
    channel: MessageChannel.optional(),
    subject: Label.nullable().optional(),
    body: TemplateBody.optional(),
    status: MessageTemplateStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
  .superRefine(placeholdersIssues)
export type MessageTemplatePatch = z.infer<typeof MessageTemplatePatch>

export const MessageTemplateListQuery = ProjectScopedListQuery
export type MessageTemplateListQuery = z.infer<typeof MessageTemplateListQuery>

/** One message on the delivery log: what was rendered, to whom, and how its sending stands. */
export const Message = z.object({
  ...stamped,
  projectId: Id,
  templateId: Id.nullable(),
  customerId: Id,
  contactId: Id.nullable(),
  channel: MessageChannel,
  purpose: MessagePurpose,
  /** The address it went to, copied when it was queued. */
  recipient: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  status: MessageStatus,
  /** How many times the provider was asked to send it. */
  attempts: NonNegativeInt,
  /** The provider that sent it (`log` for the log-only fake), and its id for the message. */
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  /** Why it was withheld, or why its last attempt failed. */
  reason: z.string().nullable(),
  sentAt: IsoDateTime.nullable(),
})
export type Message = z.infer<typeof Message>

/** The office's request: a template sent to a customer, or to one of its contact persons; the server mints the id and renders the text. */
export const MessageCreate = z.strictObject({
  templateId: Id,
  customerId: Id,
  contactId: Id.nullable().optional().describe("A contact person of the customer to send it to; null or absent sends it to the customer's own address."),
})
export type MessageCreate = z.infer<typeof MessageCreate>

/** The delivery log, newest first, narrowed to a customer, a project or a status. */
export const MessageListQuery = PageRequest.extend({
  projectId: Id.optional(),
  customerId: Id.optional(),
  status: MessageStatus.optional(),
})
export type MessageListQuery = z.infer<typeof MessageListQuery>


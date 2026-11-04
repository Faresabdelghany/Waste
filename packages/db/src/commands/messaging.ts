// A message queued (#291 C15), once: the office's `POST /messages` calls it
// in the request's transaction today, and the slices that send on their own
// account — an invoice delivered (C16), a reminder (C17), a service notice
// (C18) — call it from the worker's job under `withCompany`, so every
// message reaches the delivery log and the send queue by one write.
//
// `queueMessage` reads the template, the customer and, where one is named,
// the contact; picks the recipient's address on the template's channel — the
// contact's where the message goes to a contact, the customer's own
// otherwise; renders the subject and the body from the values
// (@waste/domain/messaging/template), copying what was rendered and to whom
// onto the row, so a template or an address changed later never rewrites
// what was sent; writes the row `queued`; and sends the worker's job in the
// same transaction (`sendInTransaction`), so the job commits with the row or
// not at all. Consent is not judged here: the worker judges it at the send
// (apps/worker/src/jobs/send-message.ts), against the customer as they stand
// then, so a consent withdrawn while a message waits is honoured.
//
// It throws `Refused`: a template that is not active, a contact that is not
// the customer's or has left, and a recipient with no address on the
// channel. A template, a customer or a contact the company does not have is
// the caller's to have answered first (each its family's 404); here it is a
// refusal of the same shape, in case a worker's caller did not.
//
// `queueStaffMessage` (O16 of #290) is the staff notices' writer: an e-mail
// to one of the company's own user accounts, its text rendered by the domain
// (@waste/domain/notifications/notices) from the outbox event it is sent
// for. The event and the recipient key it once, so a redelivered event
// writes nothing and sends nothing the second time.
import { renderTemplate, type MessageValues } from "@waste/domain/messaging/template"
import type { MessageChannel, MessagePurpose } from "@waste/domain/messaging/vocabulary"
import { and, eq, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { sendInTransaction, type Send } from "../jobs"
import { userAccount } from "../schema/access"
import { customer, customerContact } from "../schema/customers"
import { message, messageTemplate } from "../schema/messaging"
import { company } from "../schema/organisation"
import { Refused, RefusedField } from "./shared"

/** The worker's queue a queued message is sent on. */
export const SEND_MESSAGE_QUEUE = "messaging.send"

/** The job's payload: which company's message to send. */
export type SendMessageData = { companyId: string; messageId: string }

/** What a message is queued from: a template, a customer, and the contact it goes to where it goes to one. */
export type MessageDraft = {
  /** The message's id, minted by the caller (the API's `newId()`, a job's own). */
  id: string
  companyId: string
  templateId: string
  customerId: string
  contactId: string | null
}

export const templateInactive = (name: string) => `The template ${name} is inactive; make it active, or pick another`
export const noAddress = (who: string, channel: MessageChannel) => `${who} has no ${channel === "email" ? "e-mail address" : "phone number"} to send this ${channel === "email" ? "e-mail" : "text message"} to`
export const CONTACT_NOT_THE_CUSTOMERS = "Pick a contact person of this customer"
export const contactInactive = (name: string) => `${name} is inactive: they no longer speak for this customer`

/** The message as written: its id and what it was queued as. */
export type QueuedMessage = { id: string; projectId: string; channel: MessageChannel; purpose: MessagePurpose; recipient: string }

/** Writes the message `queued` and sends its job, both in `tx`; throws `Refused` where it cannot be sent. */
export async function queueMessage(tx: Tx, send: Send, draft: MessageDraft): Promise<QueuedMessage> {
  const [template] = await tx
    .select({ projectId: messageTemplate.projectId, name: messageTemplate.name, purpose: messageTemplate.purpose, channel: messageTemplate.channel, subject: messageTemplate.subject, body: messageTemplate.body, status: messageTemplate.status })
    .from(messageTemplate)
    .where(and(eq(messageTemplate.companyId, draft.companyId), eq(messageTemplate.id, draft.templateId)))
    .limit(1)
  if (template === undefined) throw new RefusedField("templateId", "Pick a template the company has")
  if (template.status !== "active") throw new Refused(409, templateInactive(template.name))
  const channel = template.channel as MessageChannel

  const [holder] = await tx
    .select({ name: customer.name, email: customer.email, phone: customer.phone })
    .from(customer)
    .where(and(eq(customer.companyId, draft.companyId), eq(customer.id, draft.customerId)))
    .limit(1)
  if (holder === undefined) throw new RefusedField("customerId", "Pick a customer the company has")

  let to: { name: string; email: string | null; phone: string | null } = holder
  if (draft.contactId !== null) {
    const [contact] = await tx
      .select({ customerId: customerContact.customerId, name: customerContact.name, email: customerContact.email, phone: customerContact.phone, status: customerContact.status })
      .from(customerContact)
      .where(and(eq(customerContact.companyId, draft.companyId), eq(customerContact.id, draft.contactId)))
      .limit(1)
    if (contact === undefined || contact.customerId !== draft.customerId) throw new RefusedField("contactId", CONTACT_NOT_THE_CUSTOMERS)
    if (contact.status !== "active") throw new Refused(409, contactInactive(contact.name))
    to = contact
  }
  const recipient = channel === "email" ? to.email : to.phone
  if (recipient === null) throw new Refused(409, noAddress(to.name, channel))

  const [sender] = await tx.select({ name: company.name }).from(company).where(eq(company.id, draft.companyId)).limit(1)
  const values: MessageValues = { recipientName: to.name, customerName: holder.name, companyName: sender?.name ?? "" }
  await tx.insert(message).values({
    id: draft.id,
    companyId: draft.companyId,
    projectId: template.projectId,
    templateId: draft.templateId,
    customerId: draft.customerId,
    contactId: draft.contactId,
    channel,
    purpose: template.purpose,
    recipient,
    subject: template.subject === null ? null : renderTemplate(template.subject, values),
    body: renderTemplate(template.body, values),
    status: "queued",
  })
  const data: SendMessageData = { companyId: draft.companyId, messageId: draft.id }
  await sendInTransaction(send, tx, SEND_MESSAGE_QUEUE, data)
  return { id: draft.id, projectId: template.projectId, channel, purpose: template.purpose as MessagePurpose, recipient }
}

/** A staff notice: the text the domain rendered, to one of the company's user accounts, for the event that raised it. */
export type StaffMessageDraft = {
  id: string
  companyId: string
  projectId: string
  userAccountId: string
  sourceEventId: string
  subject: string
  body: string
}

/** Writes the staff notice `queued` and sends its job, both in `tx`; null where the event already told this user. */
export async function queueStaffMessage(tx: Tx, send: Send, draft: StaffMessageDraft): Promise<QueuedMessage | null> {
  const [user] = await tx
    .select({ email: userAccount.email })
    .from(userAccount)
    .where(and(eq(userAccount.companyId, draft.companyId), eq(userAccount.id, draft.userAccountId)))
    .limit(1)
  if (user === undefined) throw new RefusedField("userAccountId", "Pick a user account the company has")
  const written = await tx
    .insert(message)
    .values({
      id: draft.id,
      companyId: draft.companyId,
      projectId: draft.projectId,
      userAccountId: draft.userAccountId,
      sourceEventId: draft.sourceEventId,
      channel: "email",
      purpose: "staff",
      recipient: user.email,
      subject: draft.subject,
      body: draft.body,
      status: "queued",
    })
    .onConflictDoNothing({
      target: [message.companyId, message.sourceEventId, message.userAccountId],
      where: sql`${message.sourceEventId} is not null and ${message.userAccountId} is not null`,
    })
    .returning({ id: message.id })
  if (written.length === 0) return null
  const data: SendMessageData = { companyId: draft.companyId, messageId: draft.id }
  await sendInTransaction(send, tx, SEND_MESSAGE_QUEUE, data)
  return { id: draft.id, projectId: draft.projectId, channel: "email", purpose: "staff", recipient: user.email }
}

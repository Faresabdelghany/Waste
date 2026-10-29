// A customer's messages on the Pilot (#291 C15): the delivery log read in
// its details from `GET /messages?customerId=`, newest first, and Send
// message, a template sent to the customer or to one of its contact persons
// as the customer's action (`POST /messages`) — the answer is the message,
// not the customer, so an action and never a command, and the row stays as
// it is. The worker sends it through the log-only sender and judges the
// customer's consent at the send, so a message is answered `queued` and the
// log is read again to see it sent or withheld. The recipient picker offers
// the customer and the active contacts with an address on the template's
// channel (`recipientOptions`), the rule the API holds.
import type { CustomerContact } from "@waste/contracts/customers"
import type { Message, MessageChannel, MessageStatus, MessageTemplate } from "@waste/contracts/messaging"

import { CONTACTS_MODULE } from "@/lib/data/properties"

import { create, listAll, listPage } from "../client"
import type { CommandInput, LocalRefusal, RecordAction } from "./adapter"
import type { ActionOutcome, SendAction } from "./server-records"

/** The customer's action that sends it a message. */
export const SEND_MESSAGE = "send-message"

/** The recipient picker's value for the customer's own address. */
export const TO_CUSTOMER = "customer"

/** How many of the newest messages a customer's details read. */
export const MESSAGES_SHOWN = 20

export const MESSAGE_STATUS_LABELS: Readonly<Record<MessageStatus, string>> = { queued: "Queued", sent: "Sent", failed: "Failed", withheld: "Withheld" }

/** What the dialog holds: the template's server id and the recipient, the customer or a contact's server id. */
export type MessageDraft = { templateId: string; recipient: string }

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The dialog's draft, or the refusal of what it left out. */
export function messageDraftOf(input: CommandInput): MessageDraft | LocalRefusal {
  const draft = input.message as MessageDraft | undefined
  if (draft === undefined || draft.templateId === "") return refusal("templateId", "Pick a template")
  if (draft.recipient === "") return refusal("contactId", "Pick who it goes to")
  return draft
}

/** The draft as `POST /messages`'s body, the customer by the server id of the row it is sent from. */
export const messageBody = (draft: MessageDraft, customerId: string): { templateId: string; customerId: string; contactId?: string } =>
  draft.recipient === TO_CUSTOMER ? { templateId: draft.templateId, customerId } : { templateId: draft.templateId, customerId, contactId: draft.recipient }

/** `POST /messages`, the customer's action: the body is the draft, and `run` names the customer by the server id it is handed. */
export const SEND_MESSAGE_ACTION: RecordAction<Message> = {
  toBody: (input) => messageDraftOf(input),
  run: (client, serverId, draft) => create<Message>(client, "/messages", messageBody(draft as MessageDraft, serverId)).then((created) => created.body),
  refused: (record) => `The message to ${record.name} was not sent`,
}

/** Sends a message through the store's `sendAction`; the customer stays as it is. */
export function sendMessage(sendAction: SendAction, recordId: string, draft: MessageDraft): Promise<ActionOutcome<Message>> {
  return sendAction(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId, recordId, SEND_MESSAGE, { message: draft }) as Promise<ActionOutcome<Message>>
}

/** A customer's newest messages. */
export function customerMessages(client: Parameters<typeof listPage>[0], serverId: string): Promise<Message[]> {
  return listPage<Message>(client, "/messages", { customerId: serverId, limit: MESSAGES_SHOWN }).then((page) => page.items)
}

/** The active templates of every project the caller works in, for the dialog's picker. */
export function activeTemplates(client: Parameters<typeof listAll>[0]): Promise<MessageTemplate[]> {
  return listAll<MessageTemplate>(client, "/message-templates").then((templates) => templates.filter((template) => template.status === "active"))
}

/** Who a message on a channel may go to: the customer where it has an address on it, then each active contact that has one. */
export function recipientOptions(channel: MessageChannel, customer: { name: string; email: string | null; phone: string | null }, contacts: readonly CustomerContact[]): Array<{ value: string; label: string }> {
  const address = (who: { email: string | null; phone: string | null }) => (channel === "email" ? who.email : who.phone)
  const own = address(customer)
  return [
    ...(own === null ? [] : [{ value: TO_CUSTOMER, label: `${customer.name} · ${own}` }]),
    ...contacts.filter((contact) => contact.status === "active" && address(contact) !== null).map((contact) => ({ value: contact.id, label: `${contact.name} · ${address(contact)}` })),
  ]
}

/** A message's line: "Sent · E-mail to kontor@osterbro.example", with the reason where it was withheld or failed. */
export function messageLine(message: Pick<Message, "status" | "channel" | "recipient" | "reason">): string {
  const head = `${MESSAGE_STATUS_LABELS[message.status]} · ${message.channel === "email" ? "E-mail" : "Text message"} to ${message.recipient}`
  return message.reason !== null && (message.status === "withheld" || message.status === "failed") ? `${head} · ${message.reason}` : head
}

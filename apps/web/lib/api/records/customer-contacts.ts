// A Customer's Contact Persons on the Pilot (#291 C14): the people who speak
// for an organisation, each with a role and the channels they are reached
// on, read in its details from `GET /customers/:id/contacts` and written one
// at a time as the customer's two actions — `add-contact` (`POST
// /customers/:id/contacts`) and `edit-contact` (`PATCH
// /customer-contacts/:id`, its id riding in the draft). The answer is the
// contact, not the customer, so each is an action and never a command, and
// the customer's row stays as it is. A contact is retired by its status,
// never deleted. A draft with neither an e-mail nor a phone is refused here,
// before the API sees it, in the API's own sentence, which a test holds
// equal to the contracts'.
import type { ContactRole, ContactStatus, CustomerContact, CustomerContacts } from "@waste/contracts/customers"

import { CONTACTS_MODULE } from "@/lib/data/properties"

import { create, get, patch } from "../client"
import type { CommandInput, LocalRefusal, RecordAction } from "./adapter"
import type { ActionOutcome, SendAction } from "./server-records"

/** The customer's action that registers a contact person under it. */
export const ADD_CONTACT = "add-contact"
/** The customer's action that changes one of its contact persons. */
export const EDIT_CONTACT = "edit-contact"

/** What a contact with no channel is told (`@waste/contracts/customers`, `REACHABLE_ON_A_CHANNEL`); the test holds the two equal. */
export const REACHABLE_ON_A_CHANNEL = "Give an e-mail or a phone: a contact is reached on one at least"

/** The wire's roles, in the order the form offers them, each with the words a person reads. */
export const CONTACT_ROLE_LABELS: Readonly<Record<ContactRole, string>> = {
  primary: "Primary contact",
  billing: "Billing",
  operations: "Operations",
  "on-site": "On site",
  other: "Other",
}

/** A contact as the dialog holds it: every field as typed, the contact's server id where it is an edit. */
export type ContactDraft = {
  contactId?: string
  name: string
  role: ContactRole
  email: string
  phone: string
  status: ContactStatus
}

/** An empty draft: a new contact is the organisation's primary one until the person says otherwise. */
export const NEW_CONTACT: ContactDraft = { name: "", role: "primary", email: "", phone: "", status: "active" }

/** The draft of a stored contact, for its edit. */
export const draftOf = (contact: CustomerContact): ContactDraft => ({
  contactId: contact.id,
  name: contact.name,
  role: contact.role,
  email: contact.email ?? "",
  phone: contact.phone ?? "",
  status: contact.status,
})

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The draft as the wire's body, a blank channel a null; refused here where it has no name or no channel. */
export function contactBody(input: CommandInput): { contactId?: string; body: Record<string, unknown> } | LocalRefusal {
  const draft = input.contact as ContactDraft | undefined
  if (draft === undefined) return refusal("contact", "Fill in the contact")
  const name = draft.name.trim()
  const email = draft.email.trim()
  const phone = draft.phone.trim()
  if (name === "") return refusal("name", "A contact needs a name")
  if (email === "" && phone === "") return refusal("email", REACHABLE_ON_A_CHANNEL)
  const body = { name, role: draft.role, email: email === "" ? null : email, phone: phone === "" ? null : phone, status: draft.status }
  return draft.contactId === undefined ? { body } : { contactId: draft.contactId, body }
}

type Sent = { contactId?: string; body: Record<string, unknown> }

/** `POST /customers/:id/contacts`, the customer's action. */
export const ADD_CONTACT_ACTION: RecordAction<CustomerContact> = {
  toBody: (input) => contactBody(input),
  run: (client, serverId, sent) => create<CustomerContact>(client, `/customers/${serverId}/contacts`, (sent as Sent).body).then((created) => created.body),
  refused: (record) => `The contact person was not added to ${record.name}`,
}

/** `PATCH /customer-contacts/:id`, the customer's action naming its contact in the draft. */
export const EDIT_CONTACT_ACTION: RecordAction<CustomerContact> = {
  toBody: (input) => {
    const sent = contactBody(input)
    if ("message" in sent) return sent
    return sent.contactId === undefined ? refusal("contact", "Pick the contact to change") : sent
  },
  run: (client, _serverId, sent) => patch<CustomerContact>(client, `/customer-contacts/${(sent as Sent).contactId}`, (sent as Sent).body),
  refused: (record) => `The contact person of ${record.name} was not saved`,
}

/** Adds or changes a contact through the store's `sendAction`, as its draft says; the customer stays as it is. */
export function saveContact(sendAction: SendAction, recordId: string, draft: ContactDraft): Promise<ActionOutcome<CustomerContact>> {
  const name = draft.contactId === undefined ? ADD_CONTACT : EDIT_CONTACT
  return sendAction(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId, recordId, name, { contact: draft }) as Promise<ActionOutcome<CustomerContact>>
}

/** A customer's contact persons, every one, oldest first. */
export function customerContacts(client: Parameters<typeof get>[0], serverId: string): Promise<CustomerContact[]> {
  return get<CustomerContacts>(client, `/customers/${serverId}/contacts`).then((answer) => answer.items)
}

/** A contact's line: "Billing · hanne@example.dk · +45 20 30 40 50", with Inactive where they have left. */
export function contactLine(contact: Pick<CustomerContact, "role" | "email" | "phone" | "status">): string {
  return [CONTACT_ROLE_LABELS[contact.role], ...(contact.email === null ? [] : [contact.email]), ...(contact.phone === null ? [] : [contact.phone]), ...(contact.status === "inactive" ? ["Inactive"] : [])].join(" · ")
}

/** Whether a customer record takes contact persons: an organisation does, a person is their own contact. */
export const takesContacts = (kind: "person" | "organisation" | undefined): boolean => kind === "organisation"

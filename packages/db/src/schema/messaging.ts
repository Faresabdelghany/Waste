// Messaging (#291 C15): the templates the office writes and the delivery log
// of every message sent from them. The owner's decision on #291: the whole
// notification system is built on a log-only fake sender until a card-free
// provider is verified, so a message here is sent through the worker's
// provider door (apps/worker/src/messaging), which today writes a log line.
//
// `message_template` is a project's: a name, what the message is for (its
// `purpose`, which decides whether the customer's consent governs it), the
// channel it goes out on, a subject for an e-mail and none for a text
// message (`message_template_subject_shape`), and the body with its
// `{{placeholders}}` (@waste/domain/messaging/template). An inactive template
// is kept, since messages name it; there is no delete.
//
// `message` is the delivery log: one row per message, written `queued` with
// what was rendered and to whom — the recipient's address copied, so a
// changed e-mail never rewrites what was sent — and moved by the worker to
// `sent`, `failed` past its attempts, or `withheld` where the customer allows
// no service messages. It is current state with stamps rather than a ledger,
// since its status and attempts move; that movement is its history, so the
// audit trail leaves it out. A message names its customer always, the
// contact it went to where it went to one (the contact being the customer's
// is the writer's rule, `queueMessage` in commands/messaging.ts), and the
// template it was rendered from through the project, so a message is its
// template's project's.
import { MESSAGE_CHANNELS, MESSAGE_PURPOSES, MESSAGE_STATUSES, MESSAGE_TEMPLATE_STATUSES } from "@waste/domain/messaging/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf } from "./checks"
import { id, projectScoped, timestamps } from "./columns"
import { customer, customerContact } from "./customers"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const messageTemplate = wms.table(
  "message_template",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    purpose: text().notNull(),
    channel: text().notNull(),
    /** An e-mail's subject; a text message has none. */
    subject: text(),
    body: text().notNull(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectKey(t),
    tenantUnique(t, t.projectId, t.name),
    oneOf(t.purpose, MESSAGE_PURPOSES),
    oneOf(t.channel, MESSAGE_CHANNELS),
    oneOf(t.status, MESSAGE_TEMPLATE_STATUSES),
    check(tableObjectName(t.id.table, "subject_shape", "messageTemplate"), sql`(${t.channel} = 'email') = (${t.subject} is not null)`),
  ],
)

export const message = wms.table(
  "message",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    templateId: uuid(),
    customerId: uuid().notNull(),
    contactId: uuid(),
    channel: text().notNull(),
    purpose: text().notNull(),
    /** The address it went to, copied when it was queued: an e-mail address or a phone number. */
    recipient: text().notNull(),
    subject: text(),
    body: text().notNull(),
    status: text().notNull(),
    /** How many times the provider was asked to send it. */
    attempts: integer().notNull().default(0),
    /** The provider that sent it (`log` for the log-only fake), and the id it answered with. */
    provider: text(),
    providerMessageId: text(),
    /** Why it was withheld, or the last attempt's failure. */
    reason: text(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.templateId], messageTemplate),
    tenantReference(t, [t.customerId], customer),
    tenantReference(t, [t.contactId], customerContact),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.templateId),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.contactId),
    oneOf(t.channel, MESSAGE_CHANNELS),
    oneOf(t.purpose, MESSAGE_PURPOSES),
    oneOf(t.status, MESSAGE_STATUSES),
    check(tableObjectName(t.id.table, "attempts_range", "message"), sql`${t.attempts} >= 0`),
    // A sent message names when and by whom, and only a sent one does.
    check(tableObjectName(t.id.table, "sent_shape", "message"), sql`(${t.status} = 'sent') = (${t.sentAt} is not null and ${t.provider} is not null)`),
  ],
)

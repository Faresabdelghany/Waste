// `message`, the delivery log, as 0074 (#291 C15) left it: a customer's
// message alone, before the staff notifications (O16 of #290, migration
// 0083) gave it a user account, made its customer nullable behind
// `message_recipient_exactly_one`, keyed it on its source event and let its
// purpose be `staff`. messaging-rendering.test.ts diffs to this spelling and
// staff-notifications-rendering.test.ts from it, since an applied file is
// never edited and the schema module spells the table as it is today. And as
// 0083 left it: today's but for the key of a customer's notice by its source
// event (O16 of #290, part b, migration 0084), which
// staff-notifications-rendering.test.ts diffs to and
// booking-notices-rendering.test.ts from.
import { MESSAGE_CHANNELS, MESSAGE_PURPOSES, MESSAGE_STATUSES, MESSAGE_TEMPLATE_PURPOSES } from "@waste/domain/messaging/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { userAccount } from "../schema/access"
import { exactlyOne } from "../schema/checks"
import { customer, customerContact } from "../schema/customers"
import { messageTemplate } from "../schema/messaging"
import { company, project } from "../schema/organisation"
import { companyReference, projectReference, tenantIndex, tenantReference } from "../schema/references"
import { wms } from "../schema/wms"

/** The purposes as of 0074: a customer's two, the template's own. */
const PURPOSES_AS_OF_0074 = MESSAGE_TEMPLATE_PURPOSES

export const messageAsOf0074 = wms.table(
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
    recipient: text().notNull(),
    subject: text(),
    body: text().notNull(),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    provider: text(),
    providerMessageId: text(),
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
    oneOf(t.purpose, PURPOSES_AS_OF_0074),
    oneOf(t.status, MESSAGE_STATUSES),
    check(tableObjectName(t.id.table, "attempts_range", "message"), sql`${t.attempts} >= 0`),
    check(tableObjectName(t.id.table, "sent_shape", "message"), sql`(${t.status} = 'sent') = (${t.sentAt} is not null and ${t.provider} is not null)`),
  ],
)

export const messageAsOf0083 = wms.table(
  "message",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    templateId: uuid(),
    customerId: uuid(),
    contactId: uuid(),
    userAccountId: uuid(),
    sourceEventId: uuid(),
    channel: text().notNull(),
    purpose: text().notNull(),
    recipient: text().notNull(),
    subject: text(),
    body: text().notNull(),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    provider: text(),
    providerMessageId: text(),
    reason: text(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.templateId], messageTemplate),
    tenantReference(t, [t.customerId], customer),
    tenantReference(t, [t.contactId], customerContact),
    tenantReference(t, [t.userAccountId], userAccount),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.templateId),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.contactId),
    tenantIndex(t, t.userAccountId),
    exactlyOne(t, "recipient", [t.customerId, t.userAccountId]),
    uniqueIndex(tableObjectName(t.id.table, "source_event_id_user_account_id_idx", "message"))
      .on(t.companyId, t.sourceEventId, t.userAccountId)
      .where(sql`${t.sourceEventId} is not null and ${t.userAccountId} is not null`),
    oneOf(t.channel, MESSAGE_CHANNELS),
    oneOf(t.purpose, MESSAGE_PURPOSES),
    oneOf(t.status, MESSAGE_STATUSES),
    check(tableObjectName(t.id.table, "attempts_range", "message"), sql`${t.attempts} >= 0`),
    check(tableObjectName(t.id.table, "sent_shape", "message"), sql`(${t.status} = 'sent') = (${t.sentAt} is not null and ${t.provider} is not null)`),
  ],
)

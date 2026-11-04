// Staff notifications (O16 of #290, part a) as drizzle-kit writes them: one
// new table, a staff member's notification preferences, an alert's carrying
// the lowest severity it reaches them at; the outbox's two checks grown by
// `alert-raised` and `ticket-assigned` on an `alert`; and the delivery log
// addressing a user account beside a customer — the customer's NOT NULL
// relaxed behind `message_recipient_exactly_one`, keyed once per event and
// recipient, its purpose grown by `staff`. Then the migration, whose head is
// exactly those statements and whose tail is the new table's fence, trigger
// and audit trail (`NOTIFICATIONS_AUDITED`). The file is found by its name,
// not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { role, userAccount } from "../schema/access"
import { customer, customerContact } from "../schema/customers"
import { messageTemplate } from "../schema/messaging"
import { notificationPreference } from "../schema/notifications"
import { company, project, serviceProvider } from "../schema/organisation"
import { auditTrail, NOTIFICATIONS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { messageAsOf0074, messageAsOf0083 as message } from "./message-as-of"
import { outboxEventAsOf0054, outboxEventAsOf0083 as outboxEvent } from "./outbox-as-of"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const referenced = { company, project, serviceProvider, role, userAccount, customer, customerContact, messageTemplate }

/** What drizzle-kit writes for the migration: the outbox and the log from their earlier spelling to today's, and the new table. */
const generated = (): Promise<string[]> =>
  statementsBetween({ ...referenced, outboxEvent: outboxEventAsOf0054, message: messageAsOf0074 }, { ...referenced, outboxEvent, message, notificationPreference })

const handWritten = [...handWrittenStatements(notificationPreference), ...NOTIFICATIONS_AUDITED.flatMap(auditTrail)]

async function fileText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_staff_notifications\.sql$/.test(name))
  assert.ok(file !== undefined, "the staff notifications' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the staff notifications as drizzle-kit writes them", () => {
  test("a preference is one per person and event, an alert's with its lowest severity and a ticket's without", async () => {
    const statements = await generated()
    assert.ok(statements.some((statement) => statement.includes('CONSTRAINT "notification_preference_user_account_id_event_key" UNIQUE("company_id","user_account_id","event")')))
    assert.equal(checksOf(notificationPreference).get("notification_preference_min_severity_shape"), `(${ref("notification_preference", "event")} = 'alert-raised') = (${ref("notification_preference", "min_severity")} is not null)`)
  })

  test("the log addresses a customer or a user account, exactly one, and an event tells a person once", async () => {
    const statements = await generated()
    assert.ok(statements.includes('ALTER TABLE "wms"."message" ALTER COLUMN "customer_id" DROP NOT NULL;'))
    assert.equal(checksOf(message).get("message_recipient_exactly_one"), `(${ref("message", "customer_id")} is not null)::int + (${ref("message", "user_account_id")} is not null)::int = 1`)
    assert.ok(statements.some((statement) => statement.startsWith('CREATE UNIQUE INDEX "message_source_event_id_user_account_id_idx"') && statement.includes('WHERE "wms"."message"."source_event_id" is not null and "wms"."message"."user_account_id" is not null')))
  })

  test("the outbox takes the alert raised and the ticket assigned, last of each list", async () => {
    const statements = await generated()
    const kinds = statements.find((statement) => statement.includes('ADD CONSTRAINT "outbox_event_kind_one_of"'))
    assert.match(kinds ?? "", /'site-visit-voided', 'alert-raised', 'ticket-assigned'\)\);$/)
    const aggregates = statements.find((statement) => statement.includes('ADD CONSTRAINT "outbox_event_aggregate_kind_one_of"'))
    assert.match(aggregates ?? "", /'site-visit', 'alert'\)\);$/)
  })
})

describe("the staff notifications' migration", () => {
  test("begins with exactly what drizzle-kit generates for it, under its header", async () => {
    const text = await fileText()
    const head = (await generated()).map(normalised)
    // As a set: the CLI and drizzle-kit's API order a diff's statements differently.
    assert.deepEqual(statementsOf(text).slice(0, head.length).sort(), [...head].sort())
    assert.match(text, /^-- Staff notifications \(O16 of #290, part a\)/)
  })

  test("and carries below them the new table's fence, trigger and audit trail, in that order, and nothing else", async () => {
    const statements = statementsOf(await fileText())
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
  })
})

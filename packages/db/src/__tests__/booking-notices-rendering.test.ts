// Customer notices for bookings (O16 of #290, part b) as drizzle-kit writes
// them: one new table, a project's notification rules, each mapping a notice
// to one of the project's templates, once per project and event; the outbox's
// two checks grown by `bulky-booking-booked` and `bulky-booking-cancelled` on
// a `bulky-booking`; and the delivery log keyed once per event and customer.
// Then the migration, whose head is exactly those statements and whose tail
// is the new table's fence, trigger and audit trail
// (`NOTIFICATION_RULES_AUDITED`). The file is found by its name, not its
// number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { role, userAccount } from "../schema/access"
import { customer, customerContact } from "../schema/customers"
import { outboxEvent } from "../schema/execution"
import { message, messageTemplate } from "../schema/messaging"
import { notificationPreference, notificationRule } from "../schema/notifications"
import { company, project, serviceProvider } from "../schema/organisation"
import { auditTrail, NOTIFICATION_RULES_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { messageAsOf0092 } from "./message-as-of"
import { outboxEventAsOf0092 } from "./outbox-as-of"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const referenced = { company, project, serviceProvider, role, userAccount, customer, customerContact, messageTemplate, notificationPreference }

/** What drizzle-kit writes for the migration: the outbox and the log from their 0092 spelling to today's, and the new table. */
const generated = (): Promise<string[]> =>
  statementsBetween({ ...referenced, outboxEvent: outboxEventAsOf0092, message: messageAsOf0092 }, { ...referenced, outboxEvent, message, notificationRule })

const handWritten = [...handWrittenStatements(notificationRule), ...NOTIFICATION_RULES_AUDITED.flatMap(auditTrail)]

async function fileText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_booking_notices\.sql$/.test(name))
  assert.ok(file !== undefined, "the booking notices' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the booking notices as drizzle-kit writes them", () => {
  test("a rule is one per project and event, its template the project's own", async () => {
    const statements = await generated()
    assert.ok(statements.some((statement) => statement.includes('CONSTRAINT "notification_rule_project_id_event_key" UNIQUE("company_id","project_id","event")')))
    assert.ok(statements.includes('ALTER TABLE "wms"."notification_rule" ADD CONSTRAINT "notification_rule_template_id_fk" FOREIGN KEY ("company_id","project_id","template_id") REFERENCES "wms"."message_template"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;'))
    assert.equal(checksOf(notificationRule).get("notification_rule_event_one_of"), `${ref("notification_rule", "event")} in ('bulky-booking-booked', 'bulky-booking-cancelled', 'bulky-booking-collected', 'bulky-booking-not-collected')`)
  })

  test("an event tells a customer once", async () => {
    const statements = await generated()
    assert.ok(statements.some((statement) => statement.startsWith('CREATE UNIQUE INDEX "message_source_event_id_customer_id_idx"') && statement.includes('WHERE "wms"."message"."source_event_id" is not null and "wms"."message"."customer_id" is not null')))
  })

  test("the outbox takes the booking booked and cancelled, last of each list", async () => {
    const statements = await generated()
    const kinds = statements.find((statement) => statement.includes('ADD CONSTRAINT "outbox_event_kind_one_of"'))
    assert.match(kinds ?? "", /'ticket-assigned', 'bulky-booking-booked', 'bulky-booking-cancelled'\)\);$/)
    const aggregates = statements.find((statement) => statement.includes('ADD CONSTRAINT "outbox_event_aggregate_kind_one_of"'))
    assert.match(aggregates ?? "", /'alert', 'bulky-booking'\)\);$/)
  })
})

describe("the booking notices' migration", () => {
  test("begins with exactly what drizzle-kit generates for it, under its header", async () => {
    const text = await fileText()
    const head = (await generated()).map(normalised)
    // As a set: the CLI and drizzle-kit's API order a diff's statements differently.
    assert.deepEqual(statementsOf(text).slice(0, head.length).sort(), [...head].sort())
    assert.match(text, /^-- Customer notices for bookings \(O16 of #290, part b\)/)
  })

  test("and carries below them the new table's fence, trigger and audit trail, in that order, and nothing else", async () => {
    const statements = statementsOf(await fileText())
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
  })
})

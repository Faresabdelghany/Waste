// Service notifications (C18 of #291) as drizzle-kit writes them: one new
// table, the `notification` planning areas a broadcast's rule narrows its
// customers to, keyed into the rule and the area through their project; a
// project's notification rules grown by the service notices and given the
// project key the new table references them by; and the outbox's kind grown
// by `ticket-replied`. Then the migration, whose head is exactly those
// statements and whose tail is the new table's fence, trigger and audit trail
// (`SERVICE_NOTIFICATIONS_AUDITED`). The file is found by its name, not its
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
import { notificationPreference, notificationRule, notificationRuleArea } from "../schema/notifications"
import { company, project, serviceProvider } from "../schema/organisation"
import { planningArea } from "../schema/planning-areas"
import { auditTrail, SERVICE_NOTIFICATIONS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { notificationRuleAsOf0076 } from "./notification-rule-as-of"
import { outboxEventAsOf0076 } from "./outbox-as-of"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const referenced = { company, project, serviceProvider, role, userAccount, customer, customerContact, messageTemplate, message, notificationPreference, planningArea }

/** What drizzle-kit writes for the migration: the outbox and the rules from their 0076 spelling to today's, and the new table. */
const generated = (): Promise<string[]> =>
  statementsBetween({ ...referenced, outboxEvent: outboxEventAsOf0076, notificationRule: notificationRuleAsOf0076 }, { ...referenced, outboxEvent, notificationRule, notificationRuleArea })

const handWritten = [...handWrittenStatements(notificationRuleArea), ...SERVICE_NOTIFICATIONS_AUDITED.flatMap(auditTrail)]

async function fileText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_service_notifications\.sql$/.test(name))
  assert.ok(file !== undefined, "the service notifications' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the service notifications as drizzle-kit writes them", () => {
  test("a broadcast rule's area keys into the rule and the area through the project, once each", async () => {
    const statements = await generated()
    assert.ok(statements.includes('ALTER TABLE "wms"."notification_rule_area" ADD CONSTRAINT "notification_rule_area_rule_id_fk" FOREIGN KEY ("company_id","project_id","rule_id") REFERENCES "wms"."notification_rule"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;'))
    assert.ok(statements.includes('ALTER TABLE "wms"."notification_rule" ADD CONSTRAINT "notification_rule_project_key" UNIQUE("company_id","project_id","id");'), "the key the area references the rule by")
    assert.ok(statements.some((statement) => statement.includes('CONSTRAINT "notification_rule_area_rule_id_planning_area_id_key" UNIQUE("company_id","rule_id","planning_area_id")')))
  })

  test("the rules take the service notices, and the outbox the reply, last of each list", async () => {
    assert.equal(
      checksOf(notificationRule).get("notification_rule_event_one_of"),
      `${ref("notification_rule", "event")} in ('bulky-booking-booked', 'bulky-booking-cancelled', 'bulky-booking-collected', 'bulky-booking-not-collected', 'collection-reminder', 'ticket-replied', 'ticket-completed', 'route-cancelled', 'route-late')`,
    )
    const kinds = (await generated()).find((statement) => statement.includes('ADD CONSTRAINT "outbox_event_kind_one_of"'))
    assert.match(kinds ?? "", /'bulky-booking-cancelled', 'ticket-replied'\)\);$/)
  })
})

describe("the service notifications' migration", () => {
  test("begins with exactly what drizzle-kit generates for it, under its header", async () => {
    const text = await fileText()
    const head = (await generated()).map(normalised)
    assert.deepEqual(statementsOf(text).slice(0, head.length).sort(), [...head].sort())
    assert.match(text, /^-- Service notifications \(C18 of #291\)/)
  })

  test("and carries below them the new table's fence, trigger and audit trail, in that order, and nothing else", async () => {
    const statements = statementsOf(await fileText())
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
  })
})

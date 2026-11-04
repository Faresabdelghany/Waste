// Messaging (#291 C15) as drizzle-kit writes it: a project's message
// templates, an e-mail's with a subject and a text message's without, and
// the delivery log, a message under its template's project naming its
// customer and the contact it went to. Then the migration, which is exactly
// those statements under its header, then what the two tables owe the file
// by migrations/README.md: their fences and triggers, and the templates'
// audit trail (`MESSAGING_AUDITED`); the delivery log is exempt. The log is
// spelled as 0074 left it (message-as-of.ts), since 0083 grew it by the staff
// notifications. The file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { customer, customerContact } from "../schema/customers"
import { messageTemplate } from "../schema/messaging"
import { company, project } from "../schema/organisation"
import { auditTrail, MESSAGING_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { messageAsOf0074 as message } from "./message-as-of"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const referenced = { company, project, customer, customerContact }

/** What drizzle-kit writes for the migration: the two tables. */
const generated = (): Promise<string[]> => statementsBetween(referenced, { ...referenced, messageTemplate, message })

/** What the tables owe the file below drizzle-kit's statements: their fences and triggers, then the templates' audit trail. */
const handWritten = [...handWrittenStatements(messageTemplate), ...handWrittenStatements(message), ...MESSAGING_AUDITED.flatMap(auditTrail)]

async function fileText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_messaging\.sql$/.test(name))
  assert.ok(file !== undefined, "the messaging migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("messaging as drizzle-kit writes it", () => {
  test("a template is named once in its project, and has a subject exactly when it is an e-mail", async () => {
    const statements = await generated()
    const template = statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."message_template"'))
    assert.ok(template !== undefined)
    assert.match(template, /CONSTRAINT "message_template_project_id_name_key" UNIQUE\("company_id","project_id","name"\)/)
    assert.equal(checksOf(messageTemplate).get("message_template_subject_shape"), `(${ref("message_template", "channel")} = 'email') = (${ref("message_template", "subject")} is not null)`)
  })

  test("a message is its template's project's, names its customer and its contact through the tenant, and is sent exactly when it says by whom and when", async () => {
    const statements = await generated()
    assert.ok(statements.includes('ALTER TABLE "wms"."message" ADD CONSTRAINT "message_template_id_fk" FOREIGN KEY ("company_id","project_id","template_id") REFERENCES "wms"."message_template"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;'))
    assert.ok(statements.includes('ALTER TABLE "wms"."message" ADD CONSTRAINT "message_contact_id_fk" FOREIGN KEY ("company_id","contact_id") REFERENCES "wms"."customer_contact"("company_id","id") ON DELETE no action ON UPDATE no action;'))
    const checks = checksOf(message)
    assert.equal(checks.get("message_status_one_of"), `${ref("message", "status")} in ('queued', 'sent', 'failed', 'withheld')`)
    assert.equal(checks.get("message_sent_shape"), `(${ref("message", "status")} = 'sent') = (${ref("message", "sent_at")} is not null and ${ref("message", "provider")} is not null)`)
  })
})

describe("the messaging migration", () => {
  test("begins with exactly what drizzle-kit generates for it, under its header", async () => {
    const text = await fileText()
    const head = (await generated()).map(normalised)
    // As a set: the CLI and drizzle-kit's API order two new tables' keys differently.
    assert.deepEqual(statementsOf(text).slice(0, head.length).sort(), [...head].sort())
    assert.match(text, /^-- Messaging \(#291 C15\)/)
  })

  test("and carries below them the two tables' fences and triggers and the templates' audit trail, in that order", async () => {
    const statements = statementsOf(await fileText())
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
    assert.equal(MESSAGING_AUDITED.length, 1)
  })
})

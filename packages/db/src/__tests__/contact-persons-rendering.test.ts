// A Customer's Contact Persons (#291 C14) as drizzle-kit writes them: one new
// table, a named person under an organisation Customer with a role and the
// channels they are reached on, keyed into the customer through the tenant.
// Then the migration, which is exactly those statements under its header,
// then what the table owes the file by migrations/README.md: its fence and
// trigger, and its audit trail as its customer's child
// (`CONTACT_PERSONS_AUDITED`). The file is found by its name, not its
// number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { customer, customerContact } from "../schema/customers"
import { company } from "../schema/organisation"
import { auditTrail, CONTACT_PERSONS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const referenced = { company, customer }

/** What drizzle-kit writes for the migration: the one table. */
const generated = (): Promise<string[]> => statementsBetween(referenced, { ...referenced, customerContact })

/** What the table owes the file below drizzle-kit's statements: its fence and trigger, then its audit trail. */
const handWritten = [...handWrittenStatements(customerContact), ...CONTACT_PERSONS_AUDITED.flatMap(auditTrail)]

async function fileText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_contact_persons\.sql$/.test(name))
  assert.ok(file !== undefined, "the contact persons' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the contact persons as drizzle-kit writes them", () => {
  test("a contact keys into its customer through the tenant and is reachable on one channel at least", async () => {
    const statements = await generated()
    assert.ok(statements.includes('ALTER TABLE "wms"."customer_contact" ADD CONSTRAINT "customer_contact_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;'))
    assert.match(statements[0], /CONSTRAINT "customer_contact_tenant_key" UNIQUE\("company_id","id"\)/)
    const checks = checksOf(customerContact)
    assert.equal(checks.get("customer_contact_channel_shape"), `${ref("customer_contact", "email")} is not null or ${ref("customer_contact", "phone")} is not null`)
    assert.equal(checks.get("customer_contact_role_one_of"), `${ref("customer_contact", "role")} in ('primary', 'billing', 'operations', 'on-site', 'other')`)
    assert.equal(checks.get("customer_contact_status_one_of"), `${ref("customer_contact", "status")} in ('active', 'inactive')`)
  })
})

describe("the contact persons' migration", () => {
  test("begins with exactly what drizzle-kit generates for it, under its header", async () => {
    const text = await fileText()
    const head = (await generated()).map(normalised)
    assert.deepEqual(statementsOf(text).slice(0, head.length), head)
    assert.match(text, /^-- A Customer's Contact Persons \(#291 C14\)/)
  })

  test("and carries below them the table's fence, trigger and audit trail, in that order", async () => {
    const statements = statementsOf(await fileText())
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
    assert.equal(CONTACT_PERSONS_AUDITED.length, 1)
  })
})

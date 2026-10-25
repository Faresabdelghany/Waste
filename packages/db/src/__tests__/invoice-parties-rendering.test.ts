// The invoice's parties (#291 C5) as the migration writes them: the
// company's postal address, the seller's address a Danish invoice prints, and
// `invoice.parties`, the seller and the payer frozen at issue. drizzle-kit
// writes the column as one NOT NULL `ADD COLUMN`, which a database holding
// invoices refuses, so the file splits it in three: the column added
// nullable, every invoice issued before it backfilled with the parties as
// they stand (src/sql/invoice-parties.ts), and the column made NOT NULL;
// then the shape check. Its header says plainly that those earlier invoices
// take today's parties. The file is found by its name, not its number, which
// it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { invoice } from "../schema/finance"
import { company } from "../schema/organisation"
import { normalised, statementsOf } from "../sql/hand-written"
import { INVOICE_PARTIES_OBJECT, invoicePartiesBackfill, invoicePartiesRequired } from "../sql/invoice-parties"
import { checksOf, ref } from "./rendering"

const PARTIES_SHAPE = `jsonb_typeof(${ref("invoice", "parties")} -> 'seller') is not distinct from 'object' and jsonb_typeof(${ref("invoice", "parties")} -> 'buyer') is not distinct from 'object'`

/** The migration as it has to be: drizzle-kit's two columns and its check, the invoice's column split around the backfill. */
const GREW = [
  'ALTER TABLE "wms"."company" ADD COLUMN "postal_address" text;',
  'ALTER TABLE "wms"."invoice" ADD COLUMN "parties" jsonb;',
  invoicePartiesBackfill(),
  invoicePartiesRequired(),
  `ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_parties_shape" CHECK (${PARTIES_SHAPE});`,
]

/** The migration's file, by its name: it takes its number at its turn. */
async function migrationFile(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_invoice_parties\.sql$/.test(name))
  assert.ok(file !== undefined, "the invoice parties' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the invoice's parties as the migration writes them", () => {
  test("the postal address, then the parties added nullable, backfilled and required, then their shape — and nothing else", async () => {
    assert.deepEqual(statementsOf(await migrationFile()), GREW.map(normalised))
  })

  test("its header says plainly that the invoices issued before it take today's parties", async () => {
    assert.match(await migrationFile(), /^-- Invoices issued before this migration take today's parties/m)
  })

  test("the schema is what the statements make: a nullable text address, a NOT NULL jsonb, and the check the file adds", () => {
    assert.deepEqual({ type: company.postalAddress.getSQLType(), notNull: company.postalAddress.notNull }, { type: "text", notNull: false })
    assert.deepEqual({ type: invoice.parties.getSQLType(), notNull: invoice.parties.notNull }, { type: "jsonb", notNull: true })
    assert.equal(checksOf(invoice).get("invoice_parties_shape"), PARTIES_SHAPE)
  })

  test("the backfill reads every key InvoiceParties has, from the company and the payer of the same company", () => {
    for (const key of ["legalName", "registrationNumber", "vatNumber", "postalAddress", "bankIban", "bankBic", "fikCreditorNumber", "name", "billingAddress"]) {
      assert.ok(INVOICE_PARTIES_OBJECT.includes(`'${key}'`), key)
    }
    assert.match(invoicePartiesBackfill(), /cu\."company_id" = i\."company_id" AND cu\."id" = i\."customer_id"/)
  })
})

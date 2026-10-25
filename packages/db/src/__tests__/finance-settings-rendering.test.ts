// Finance settings on the wire (#291 slice 4, #292 C4) as drizzle-kit wrote
// them: the company's invoice identity — the VAT registration, the bank
// account and the FIK creditor number, each a nullable column under its
// shape — the project's payment terms and reference scheme, the customer's
// own terms, and the invoice's payment reference frozen at issue. The shapes
// and the range are the domain's (@waste/domain/finance/payment), the scheme
// its vocabulary's. The statements are spelled here and the file held to
// them; organisation-access-, registry- and finance-rendering.test.ts hold
// the tables as the schema writes them today, so the two cannot drift. The
// file is found by its name, not its number, which it takes at its turn. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { BIC_PATTERN, DEFAULT_PAYMENT_TERMS_DAYS, FIK_CREDITOR_PATTERN, IBAN_PATTERN, PAYMENT_REFERENCE_PATTERN, PAYMENT_TERMS_MAX, VAT_NUMBER_PATTERN } from "@waste/domain/finance/payment"
import { PAYMENT_REFERENCE_SCHEMES } from "@waste/domain/finance/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { customer } from "../schema/customers"
import { invoice } from "../schema/finance"
import { company, project } from "../schema/organisation"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

const IDENTITY: Array<[column: string, pattern: string]> = [
  ["vat_number", VAT_NUMBER_PATTERN],
  ["bank_iban", IBAN_PATTERN],
  ["bank_bic", BIC_PATTERN],
  ["fik_creditor_number", FIK_CREDITOR_PATTERN],
]

const termsRange = (table: string) => `${ref(table, "payment_terms_days")} between 0 and ${PAYMENT_TERMS_MAX}`
const REFERENCE_SHAPE = `${ref("invoice", "payment_reference")} is null or (${ref("invoice", "kind")} = 'invoice' and ${ref("invoice", "payment_reference")} ~ '${PAYMENT_REFERENCE_PATTERN}')`

/** 0037 as drizzle-kit wrote it: the columns first, then the checks, table by table in the schema's order. */
const GREW_IN_0037 = [
  ...IDENTITY.map(([column]) => `ALTER TABLE "wms"."company" ADD COLUMN "${column}" text;`),
  `ALTER TABLE "wms"."project" ADD COLUMN "payment_terms_days" integer DEFAULT ${DEFAULT_PAYMENT_TERMS_DAYS} NOT NULL;`,
  `ALTER TABLE "wms"."project" ADD COLUMN "payment_reference_scheme" text DEFAULT 'none' NOT NULL;`,
  'ALTER TABLE "wms"."customer" ADD COLUMN "payment_terms_days" integer;',
  'ALTER TABLE "wms"."invoice" ADD COLUMN "payment_reference" text;',
  ...IDENTITY.map(([column, pattern]) => `ALTER TABLE "wms"."company" ADD CONSTRAINT "company_${column}_shape" CHECK (${ref("company", column)} ~ '${pattern}');`),
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_payment_reference_scheme_one_of" CHECK (${ref("project", "payment_reference_scheme")} in (${list(...PAYMENT_REFERENCE_SCHEMES)}));`,
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_payment_terms_range" CHECK (${termsRange("project")});`,
  `ALTER TABLE "wms"."customer" ADD CONSTRAINT "customer_payment_terms_range" CHECK (${termsRange("customer")});`,
  `ALTER TABLE "wms"."invoice" ADD CONSTRAINT "invoice_payment_reference_shape" CHECK (${REFERENCE_SHAPE});`,
]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_finance_settings\.sql$/.test(name))
  assert.ok(file !== undefined, "the finance settings' migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

describe("finance settings as drizzle-kit writes them", () => {
  test("the migration is exactly the statements that grow four tables: the company's identity, the project's terms and scheme, the customer's terms and the invoice's reference, and nothing hand-written", async () => {
    assert.deepEqual(await migration(), GREW_IN_0037.map(normalised))
  })

  test("the checks the schema writes are the ones the migration adds, each rendering without parameters, over the domain's patterns, range and schemes", () => {
    for (const [column, pattern] of IDENTITY) assert.equal(checksOf(company).get(`company_${column}_shape`), `${ref("company", column)} ~ '${pattern}'`, column)
    assert.equal(checksOf(project).get("project_payment_terms_range"), termsRange("project"))
    assert.equal(checksOf(project).get("project_payment_reference_scheme_one_of"), `${ref("project", "payment_reference_scheme")} in (${list(...PAYMENT_REFERENCE_SCHEMES)})`)
    assert.equal(checksOf(customer).get("customer_payment_terms_range"), termsRange("customer"))
    assert.equal(checksOf(invoice).get("invoice_payment_reference_shape"), REFERENCE_SHAPE)
  })

  test("a project's terms default to the domain's thirty days and its scheme to none, so every project the migration finds keeps its invoices as they were", () => {
    assert.deepEqual({ notNull: project.paymentTermsDays.notNull, default: project.paymentTermsDays.default }, { notNull: true, default: DEFAULT_PAYMENT_TERMS_DAYS })
    assert.deepEqual({ notNull: project.paymentReferenceScheme.notNull, default: project.paymentReferenceScheme.default }, { notNull: true, default: "none" })
    assert.equal(customer.paymentTermsDays.notNull, false, "a customer keeps its project's terms until it has its own")
  })
})

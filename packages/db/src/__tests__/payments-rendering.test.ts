// Payments (#291 C6) as drizzle-kit writes them: `payment`, money as it
// arrived — registered by the office or a bank statement's line, its payer
// where known, a line's key once per company so a statement imported again
// adds nothing — and `payment_allocation`, a part of a payment applied to one
// invoice of its project, a wrong one undone by a negative row naming it,
// once. Both are ledgers: the migration is exactly drizzle-kit's statements,
// then each table's fence and revoke, and no trigger (EXEMPT in the audit
// trail). The file is found by its name, not its number, which it takes at
// its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PAYMENT_SOURCES } from "@waste/domain/finance/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { customer } from "../schema/customers"
import { billingRun, invoice, payment, paymentAllocation } from "../schema/finance"
import { company, project } from "../schema/organisation"
import { AUDITED_TABLE_NAMES } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, COMPANY, companyFk, ID, index, partialUniqueIndex, PROJECT, projectFk, projectFkTo, ref, tenantFk, uniqueKey, oneOfCheck, foreignKey } from "./rendering"
import { statementsBetween } from "./specimen"

const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'

/** A ledger's CREATE TABLE: id, tenant, project, the one stamp, then its own lines. */
const createLedger = (name: string, lines: string[]): string => [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, PROJECT, RECORDED, ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const referenced = { company, project, userAccount, customer, billingRun, invoice }

const BANK_LINE_SHAPE = `(${ref("payment", "source")} = 'bank-file') = (${ref("payment", "bank_line_key")} is not null)`
const ALLOCATION_SHAPE = `${ref("payment_allocation", "amount_minor")} <> 0 and (${ref("payment_allocation", "amount_minor")} < 0) = (${ref("payment_allocation", "reverses_allocation_id")} is not null) and ${ref("payment_allocation", "reverses_allocation_id")} <> ${ref("payment_allocation", "id")}`

const generated = () => statementsBetween(referenced, { ...referenced, payment, paymentAllocation })

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_payments\.sql$/.test(name))
  assert.ok(file !== undefined, "the payments' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("payments as drizzle-kit writes them", () => {
  test("the payment and its allocations, every column, key, check and index as the Domain model spells them", async () => {
    assert.deepEqual((await generated()).sort(), [
      createLedger("payment", [
        '"customer_id" uuid',
        '"amount_minor" bigint NOT NULL',
        '"currency" text NOT NULL',
        '"paid_on" date NOT NULL',
        '"reference" text',
        '"payer_text" text',
        '"source" text NOT NULL',
        '"bank_line_key" text',
        '"note" text',
        '"recorded_by" uuid',
        uniqueKey("payment_project_key", "company_id", "project_id", "id"),
        oneOfCheck("payment", "source", ...PAYMENT_SOURCES),
        `CONSTRAINT "payment_amount_positive" CHECK (${ref("payment", "amount_minor")} > 0)`,
        `CONSTRAINT "payment_bank_line_shape" CHECK (${BANK_LINE_SHAPE})`,
      ]),
      createLedger("payment_allocation", [
        '"payment_id" uuid NOT NULL',
        '"invoice_id" uuid NOT NULL',
        '"amount_minor" bigint NOT NULL',
        '"reverses_allocation_id" uuid',
        '"recorded_by" uuid',
        uniqueKey("payment_allocation_project_key", "company_id", "project_id", "id"),
        `CONSTRAINT "payment_allocation_amount_shape" CHECK (${ALLOCATION_SHAPE})`,
      ]),
      companyFk("payment"),
      projectFk("payment"),
      tenantFk("payment", "customer_id", "customer"),
      tenantFk("payment", "recorded_by", "user_account"),
      companyFk("payment_allocation"),
      projectFk("payment_allocation"),
      projectFkTo("payment_allocation", "payment_id", "payment"),
      projectFkTo("payment_allocation", "invoice_id", "invoice"),
      foreignKey("payment_allocation", "payment_allocation_reverses_allocation_id_fk", ["company_id", "project_id", "reverses_allocation_id"], "payment_allocation", ["company_id", "project_id", "id"]),
      tenantFk("payment_allocation", "recorded_by", "user_account"),
      partialUniqueIndex("payment", "payment_bank_line_key_idx", ["company_id", "bank_line_key"], `${ref("payment", "bank_line_key")} is not null`),
      index("payment", "payment_customer_id_idx", "company_id", "customer_id"),
      index("payment", "payment_project_id_paid_on_idx", "company_id", "project_id", "paid_on"),
      index("payment", "payment_recorded_by_idx", "company_id", "recorded_by"),
      partialUniqueIndex("payment_allocation", "payment_allocation_reverses_allocation_id_idx", ["company_id", "reverses_allocation_id"], `${ref("payment_allocation", "reverses_allocation_id")} is not null`),
      index("payment_allocation", "payment_allocation_payment_id_idx", "company_id", "payment_id"),
      index("payment_allocation", "payment_allocation_invoice_id_idx", "company_id", "invoice_id"),
      index("payment_allocation", "payment_allocation_recorded_by_idx", "company_id", "recorded_by"),
    ].sort())
  })

  test("the migration is exactly drizzle-kit's statements, then each ledger's fence and revoke, and no trigger", async () => {
    const text = await migration()
    assert.deepEqual(statementsOf(text), [...(await generated()), ...handWrittenStatements(payment), ...handWrittenStatements(paymentAllocation)].map(normalised))
    assert.doesNotMatch(text, /CREATE TRIGGER/)
    assert.ok(!AUDITED_TABLE_NAMES.has("payment") && !AUDITED_TABLE_NAMES.has("payment_allocation"), "ledgers: their rows are their own history")
  })

  test("the checks render without parameters", () => {
    assert.equal(checksOf(payment).get("payment_bank_line_shape"), BANK_LINE_SHAPE)
    assert.equal(checksOf(paymentAllocation).get("payment_allocation_amount_shape"), ALLOCATION_SHAPE)
  })
})

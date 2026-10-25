// The accounting export (#291 C7) as drizzle-kit writes it: the mapping — a
// project's accounts by number, each with its standard-chart number where it
// is mapped; its four defaults and its first day of exports, one row per
// project; a code per VAT rate; a product's own revenue account — each
// configuration with its fence, its `updated_at` trigger and its audit
// trigger, a set of its project; and the export's three ledgers — the run,
// one voucher per source row, a row once ever and a number once per project,
// and the voucher's frozen lines — each with its fence and revoke and no
// trigger. The file is found by its name, not its number, which it takes at
// its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ACCOUNT_NUMBER_PATTERN, VAT_CODE_PATTERN } from "@waste/domain/finance/accounting"
import { ACCOUNTING_SOURCE_KINDS } from "@waste/domain/finance/vocabulary"
import { getTableName } from "drizzle-orm"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { product } from "../schema/catalogue"
import { accountingAccount, accountingExport, accountingExportLine, accountingExportVoucher, accountingProductAccount, accountingSettings, accountingVatCode } from "../schema/finance"
import { company, project } from "../schema/organisation"
import { ACCOUNTING_AUDITED, auditTrail, AUDITED_TABLE_NAMES } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, COMPANY, companyFk, createTable, ID, index, oneOfCheck, PROJECT, positiveCheck, projectFk, projectFkTo, ref, tenantFk, uniqueKey } from "./rendering"
import { statementsBetween } from "./specimen"

const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'

/** A ledger's CREATE TABLE: id, tenant, project, the one stamp, then its own lines. */
const createLedger = (name: string, lines: string[]): string => [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, PROJECT, RECORDED, ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const referenced = { company, project, userAccount, product }
const tables = { accountingAccount, accountingSettings, accountingVatCode, accountingProductAccount, accountingExport, accountingExportVoucher, accountingExportLine }

const NUMBER_SHAPE = `${ref("accounting_account", "number")} ~ '${ACCOUNT_NUMBER_PATTERN}' and (${ref("accounting_account", "standard_account")} is null or ${ref("accounting_account", "standard_account")} ~ '${ACCOUNT_NUMBER_PATTERN}')`
const VAT_CODE_SHAPE = `${ref("accounting_vat_code", "vat_percent")} >= 0 and ${ref("accounting_vat_code", "vat_percent")} <= 100 and ${ref("accounting_vat_code", "code")} ~ '${VAT_CODE_PATTERN}'`
const EXPORT_SHAPE = `${ref("accounting_export", "period_to")} >= ${ref("accounting_export", "period_from")} and ${ref("accounting_export", "voucher_from")} > 0 and ${ref("accounting_export", "voucher_to")} >= ${ref("accounting_export", "voucher_from")} and ${ref("accounting_export", "line_count")} > 0`

const generated = () => statementsBetween(referenced, { ...referenced, ...tables })

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_accounting_export\.sql$/.test(name))
  assert.ok(file !== undefined, "the accounting export's migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the accounting export as drizzle-kit writes it", () => {
  test("the mapping's four tables and the export's three ledgers, every column, key, check and index as the Domain model spells them", async () => {
    assert.deepEqual((await generated()).sort(), [
      createTable("accounting_account", "project", [
        '"number" text NOT NULL',
        '"name" text NOT NULL',
        '"standard_account" text',
        uniqueKey("accounting_account_project_key", "company_id", "project_id", "id"),
        uniqueKey("accounting_account_project_id_number_key", "company_id", "project_id", "number"),
        `CONSTRAINT "accounting_account_number_shape" CHECK (${NUMBER_SHAPE})`,
      ]),
      createTable("accounting_settings", "project", [
        '"receivable_account_id" uuid',
        '"bank_account_id" uuid',
        '"suspense_account_id" uuid',
        '"revenue_account_id" uuid',
        '"exports_from" date',
        uniqueKey("accounting_settings_project_id_key", "company_id", "project_id"),
      ]),
      createTable("accounting_vat_code", "project", [
        '"vat_percent" integer NOT NULL',
        '"code" text NOT NULL',
        '"account_id" uuid NOT NULL',
        uniqueKey("accounting_vat_code_project_id_vat_percent_key", "company_id", "project_id", "vat_percent"),
        `CONSTRAINT "accounting_vat_code_shape" CHECK (${VAT_CODE_SHAPE})`,
      ]),
      createTable("accounting_product_account", "project", ['"product_id" uuid NOT NULL', '"account_id" uuid NOT NULL', uniqueKey("accounting_product_account_project_id_product_id_key", "company_id", "project_id", "product_id")]),
      createLedger("accounting_export", [
        '"period_from" date NOT NULL',
        '"period_to" date NOT NULL',
        '"voucher_from" integer NOT NULL',
        '"voucher_to" integer NOT NULL',
        '"line_count" integer NOT NULL',
        '"created_by" uuid',
        '"note" text',
        uniqueKey("accounting_export_project_key", "company_id", "project_id", "id"),
        `CONSTRAINT "accounting_export_shape" CHECK (${EXPORT_SHAPE})`,
      ]),
      createLedger("accounting_export_voucher", [
        '"export_id" uuid NOT NULL',
        '"voucher" integer NOT NULL',
        '"booked_on" date NOT NULL',
        '"source_kind" text NOT NULL',
        '"source_id" uuid NOT NULL',
        '"document" text',
        '"currency" text NOT NULL',
        '"customer_name" text',
        '"back_dated" boolean NOT NULL',
        uniqueKey("accounting_export_voucher_project_key", "company_id", "project_id", "id"),
        uniqueKey("accounting_export_voucher_source_kind_source_id_key", "company_id", "source_kind", "source_id"),
        uniqueKey("accounting_export_voucher_project_id_voucher_key", "company_id", "project_id", "voucher"),
        oneOfCheck("accounting_export_voucher", "source_kind", ...ACCOUNTING_SOURCE_KINDS),
        positiveCheck("accounting_export_voucher", "voucher"),
      ]),
      createLedger("accounting_export_line", [
        '"voucher_id" uuid NOT NULL',
        '"position" integer NOT NULL',
        '"account_number" text NOT NULL',
        '"account_name" text NOT NULL',
        '"vat_code" text',
        '"amount_minor" bigint NOT NULL',
        '"text" text NOT NULL',
        uniqueKey("accounting_export_line_voucher_id_position_key", "company_id", "voucher_id", "position"),
        positiveCheck("accounting_export_line", "position"),
      ]),
      ...Object.values(tables).flatMap((table) => [companyFk(getTableName(table)), projectFk(getTableName(table))]),
      projectFkTo("accounting_settings", "receivable_account_id", "accounting_account"),
      projectFkTo("accounting_settings", "bank_account_id", "accounting_account"),
      projectFkTo("accounting_settings", "suspense_account_id", "accounting_account"),
      projectFkTo("accounting_settings", "revenue_account_id", "accounting_account"),
      projectFkTo("accounting_vat_code", "account_id", "accounting_account"),
      projectFkTo("accounting_product_account", "product_id", "product"),
      projectFkTo("accounting_product_account", "account_id", "accounting_account"),
      tenantFk("accounting_export", "created_by", "user_account"),
      projectFkTo("accounting_export_voucher", "export_id", "accounting_export"),
      projectFkTo("accounting_export_line", "voucher_id", "accounting_export_voucher"),
      index("accounting_settings", "accounting_settings_receivable_account_id_idx", "company_id", "receivable_account_id"),
      index("accounting_settings", "accounting_settings_bank_account_id_idx", "company_id", "bank_account_id"),
      index("accounting_settings", "accounting_settings_suspense_account_id_idx", "company_id", "suspense_account_id"),
      index("accounting_settings", "accounting_settings_revenue_account_id_idx", "company_id", "revenue_account_id"),
      index("accounting_vat_code", "accounting_vat_code_account_id_idx", "company_id", "account_id"),
      index("accounting_product_account", "accounting_product_account_product_id_idx", "company_id", "product_id"),
      index("accounting_product_account", "accounting_product_account_account_id_idx", "company_id", "account_id"),
      index("accounting_export", "accounting_export_project_id_period_from_idx", "company_id", "project_id", "period_from"),
      index("accounting_export", "accounting_export_created_by_idx", "company_id", "created_by"),
      index("accounting_export_voucher", "accounting_export_voucher_export_id_idx", "company_id", "export_id"),
    ].sort())
  })

  test("the migration is exactly drizzle-kit's statements, then each table's fence with its touch or its revoke, then the mapping's audit triggers, each a set of its project", async () => {
    const text = await migration()
    const audit = ACCOUNTING_AUDITED.flatMap(auditTrail)
    const statements = statementsOf(text)
    const head = (await generated()).map(normalised)
    // drizzle-kit writes the tables in its own order, so the head is compared as a set; the tail is ours, in order.
    assert.deepEqual([...statements.slice(0, head.length)].sort(), [...head].sort())
    assert.deepEqual(statements.slice(head.length), [...Object.values(tables).flatMap(handWrittenStatements), ...audit].map(normalised))
    assert.deepEqual(
      audit,
      ["accounting_account", "accounting_settings", "accounting_vat_code", "accounting_product_account"].map((name) => `CREATE TRIGGER "${name}_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."${name}" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');`),
    )
    for (const ledger of ["accounting_export", "accounting_export_voucher", "accounting_export_line"]) assert.ok(!AUDITED_TABLE_NAMES.has(ledger), `${ledger}: a ledger, its rows its own history`)
    assert.equal(ACCOUNTING_AUDITED.every((entry) => entry.module === "configure.finance"), true, "audited under Settings › Finance & invoicing, where the mapping is set")
  })

  test("the checks render without parameters", () => {
    assert.equal(checksOf(accountingAccount).get("accounting_account_number_shape"), NUMBER_SHAPE)
    assert.equal(checksOf(accountingVatCode).get("accounting_vat_code_shape"), VAT_CODE_SHAPE)
    assert.equal(checksOf(accountingExport).get("accounting_export_shape"), EXPORT_SHAPE)
  })
})


// The accounting export's seven tables (#291 C7) as the SAF-T migration
// (C7b) left them, frozen: the mapping — a project's accounts, its four
// defaults, its VAT codes and its products' accounts — and the export's three
// ledgers. The accounting export was removed with its Settings pane, and the
// removal's migration drops the seven (drop-accounting-rendering.test.ts), so
// the schema module no longer spells them; accounting-rendering.test.ts holds
// the export's and SAF-T's applied files to these, since an applied file is
// never edited. The patterns and the vocabulary its checks read were the
// domain's, gone with it, and are spelled here as the files have them.
import { sql } from "drizzle-orm"
import { bigint, boolean, check, date, integer, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { product } from "../schema/catalogue"
import { oneOf, positive } from "../schema/checks"
import { id, projectScoped, recorded, timestamps } from "../schema/columns"
import { company, project } from "../schema/organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { wms } from "../schema/wms"
import type { Audited } from "../sql/audit-trail"

/** An account's number, in the office's chart or the standard chart, as the checks read it. */
export const ACCOUNT_NUMBER_PATTERN = "^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$"

/** A VAT code, the office's or a standard one, as the checks read it. */
export const VAT_CODE_PATTERN = "^[0-9A-Za-z][0-9A-Za-z_-]{0,8}$"

/** What an export booked: an issued invoice, a credit note, a payment, and an allocation of a payment that named no customer. */
export const ACCOUNTING_SOURCE_KINDS = ["invoice", "credit-note", "payment", "allocation"] as const

const total = () => bigint({ mode: "number" })

export const accountingAccountAsOfSafT = wms.table(
  "accounting_account",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    number: text().notNull(),
    name: text().notNull(),
    /** The account's number in Erhvervsstyrelsen's standard chart, which SAF-T requires (C7b); null until the office maps it. */
    standardAccount: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectKey(t),
    tenantUnique(t, t.projectId, t.number),
    check(tableObjectName(t.id.table, "number_shape", "accountingAccountAsOfSafT"), sql`${t.number} ~ ${sql.raw(`'${ACCOUNT_NUMBER_PATTERN}'`)} and (${t.standardAccount} is null or ${t.standardAccount} ~ ${sql.raw(`'${ACCOUNT_NUMBER_PATTERN}'`)})`),
  ],
)

export const accountingSettingsAsOfSafT = wms.table(
  "accounting_settings",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    receivableAccountId: uuid(),
    bankAccountId: uuid(),
    suspenseAccountId: uuid(),
    revenueAccountId: uuid(),
    /** The first day an export books: rows dated before it were booked by other means before the office exported from here; null books from the first. */
    exportsFrom: date(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    // One row per project.
    tenantUnique(t, t.projectId),
    projectReference(t, [t.receivableAccountId], accountingAccountAsOfSafT),
    projectReference(t, [t.bankAccountId], accountingAccountAsOfSafT),
    projectReference(t, [t.suspenseAccountId], accountingAccountAsOfSafT),
    projectReference(t, [t.revenueAccountId], accountingAccountAsOfSafT),
    tenantIndex(t, t.receivableAccountId),
    tenantIndex(t, t.bankAccountId),
    tenantIndex(t, t.suspenseAccountId),
    tenantIndex(t, t.revenueAccountId),
  ],
)

export const accountingVatCodeAsOfSafT = wms.table(
  "accounting_vat_code",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    vatPercent: integer().notNull(),
    code: text().notNull(),
    accountId: uuid().notNull(),
    /** The code in Erhvervsstyrelsen's standard tax codes (`S1`, `K1`, …) that a SAF-T file names beside the office's own (C7b); null where it is not mapped. */
    standardTaxCode: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.accountId], accountingAccountAsOfSafT),
    // A rate has one code in a project.
    tenantUnique(t, t.projectId, t.vatPercent),
    // No `between`: nested in an `and`, its expansion deparses one way as written and another once a dump is restored, and the Pilot rehearsal compares the two.
    check(tableObjectName(t.id.table, "shape", "accountingVatCodeAsOfSafT"), sql`${t.vatPercent} >= 0 and ${t.vatPercent} <= 100 and ${t.code} ~ ${sql.raw(`'${VAT_CODE_PATTERN}'`)}`),
    tenantIndex(t, t.accountId),
    // A standard code is of the shape a SAF-T TaxCode takes (C7b).
    check(tableObjectName(t.id.table, "standard_shape", "accountingVatCodeAsOfSafT"), sql`${t.standardTaxCode} is null or ${t.standardTaxCode} ~ ${sql.raw(`'${VAT_CODE_PATTERN}'`)}`),
  ],
)

export const accountingProductAccountAsOfSafT = wms.table(
  "accounting_product_account",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    productId: uuid().notNull(),
    accountId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.productId], product),
    projectReference(t, [t.accountId], accountingAccountAsOfSafT),
    // A product books to one account.
    tenantUnique(t, t.projectId, t.productId),
    tenantIndex(t, t.productId),
    tenantIndex(t, t.accountId),
  ],
)

export const accountingExportAsOfSafT = wms.table(
  "accounting_export",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    periodFrom: date().notNull(),
    periodTo: date().notNull(),
    /** The first and last voucher numbers it took, of the project's sequence. */
    voucherFrom: integer().notNull(),
    voucherTo: integer().notNull(),
    lineCount: integer().notNull(),
    createdBy: uuid(),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.createdBy], userAccount),
    projectKey(t),
    // An export books something: an empty one is refused, so it has its vouchers and their lines.
    check(tableObjectName(t.id.table, "shape", "accountingExportAsOfSafT"), sql`${t.periodTo} >= ${t.periodFrom} and ${t.voucherFrom} > 0 and ${t.voucherTo} >= ${t.voucherFrom} and ${t.lineCount} > 0`),
    tenantIndex(t, t.projectId, t.periodFrom),
    tenantIndex(t, t.createdBy),
  ],
)

export const accountingExportVoucherAsOfSafT = wms.table(
  "accounting_export_voucher",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    exportId: uuid().notNull(),
    voucher: integer().notNull(),
    bookedOn: date().notNull(),
    sourceKind: text().notNull(),
    /** The row booked: an invoice's, a payment's or an allocation's id; a soft uuid, as the kind says which. */
    sourceId: uuid().notNull(),
    /** The document's label, a payment's reference, or an allocation's invoice; null for a payment of no reference. */
    document: text(),
    currency: text().notNull(),
    customerName: text(),
    /** Dated before its export's period: it arrived after an earlier export took that period. */
    backDated: boolean().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.exportId], accountingExportAsOfSafT),
    projectKey(t),
    oneOf(t.sourceKind, ACCOUNTING_SOURCE_KINDS),
    positive(t.voucher),
    // A row is exported once, ever.
    tenantUnique(t, t.sourceKind, t.sourceId),
    // A voucher number is the project's once.
    tenantUnique(t, t.projectId, t.voucher),
    tenantIndex(t, t.exportId),
  ],
)

export const accountingExportLineAsOfSafT = wms.table(
  "accounting_export_line",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    voucherId: uuid().notNull(),
    position: integer().notNull(),
    accountNumber: text().notNull(),
    accountName: text().notNull(),
    vatCode: text(),
    /** Signed: a debit positive, a credit negative; a voucher's lines sum to zero. */
    amountMinor: total().notNull(),
    text: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.voucherId], accountingExportVoucherAsOfSafT),
    tenantUnique(t, t.voucherId, t.position),
    positive(t.position),
  ],
)

/** The mapping's four as the export's migration audited them, each a set of its project under Settings › Finance & invoicing; the exports were ledgers, exempt. */
export const ACCOUNTING_AUDITED_AS_OF_SAF_T: readonly Audited[] = [accountingAccountAsOfSafT, accountingSettingsAsOfSafT, accountingVatCodeAsOfSafT, accountingProductAccountAsOfSafT].map((table) => ({
  table,
  module: "configure.finance",
  parent: { table: project, column: table.projectId },
}))

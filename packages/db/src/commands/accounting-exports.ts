// The accounting export as statements (#291 slice 7, #292 C7): what a
// period's export books and the export itself
// (@waste/domain/finance/accounting says the vouchers).
//
// The rows an export books are a project's rows that no export took yet, on
// or before the period's last day, and on or after the project's first day
// of exports where it names one: its issued invoices and credit notes by
// `issued_on`, its payments by `paid_on`, and the allocations of its payments
// that named no customer by the day they were recorded on the project's clock.
// A row dated before the period's first day is back-dated: it arrived after
// an earlier export took its period, and goes into this one on its own day.
// A document books its customer as the invoice froze it (`parties.buyer`), a
// payment its payer as the register has it.
//
// `planExport` reads and books and writes nothing: what a preview answers,
// the vouchers in their order and every gap a voucher met. `runExport` takes
// the project's lock — a billing run's too, so a run and an export take
// turns — books the same, refuses on a gap (409, the first gap's sentence
// naming its document) or on nothing to book, numbers the vouchers on from
// the project's last, and writes the export, its vouchers and their lines in
// the caller's transaction. A voucher's unique (kind, source) is the
// backstop behind the lock: a row is exported once, ever.
import { invoiceLabel } from "@waste/contracts/finance"
import { gapSentence, voucherOf, type AccountingMapping, type ExportLine, type LedgerAccount, type SourceToBook, type Voucher } from "@waste/domain/finance/accounting"
import type { BillingPeriod } from "@waste/domain/finance/periods"
import type { AccountingSourceKind, InvoiceKind } from "@waste/domain/finance/vocabulary"
import { and, asc, eq, inArray, isNull, max, sql, type SQL } from "drizzle-orm"
import { alias, type PgColumn } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { customer } from "../schema/customers"
import { accountingAccount, accountingExport, accountingExportLine, accountingExportVoucher, accountingProductAccount, accountingSettings, accountingVatCode, invoice, invoiceLine, payment, paymentAllocation } from "../schema/finance"
import { project } from "../schema/organisation"
import type { Scope } from "./project-clock"
import { lockRow, refused } from "./shared"

/** The most vouchers one export writes: an export is one transaction. */
export const ACCOUNTING_EXPORT_MAX_VOUCHERS = 5000

/** What an export over too many rows is refused with. */
export const tooManyVouchers = (count: number): string => `${count} rows to book fall in the period; narrow it — an export is one transaction`

/** What an export with nothing to book is refused with. */
export const NOTHING_TO_EXPORT = "Nothing in the period is left to export: every invoice, credit note and payment of it is on an export already"

/** The project's mapping as the domain books with it, and the first day it exports from. */
export async function mappingOf(tx: Tx, scope: Scope): Promise<{ mapping: AccountingMapping; exportsFrom: string | null }> {
  const accounts = await tx
    .select({ id: accountingAccount.id, number: accountingAccount.number, name: accountingAccount.name })
    .from(accountingAccount)
    .where(and(eq(accountingAccount.companyId, scope.companyId), eq(accountingAccount.projectId, scope.projectId)))
  const byId = new Map(accounts.map((row) => [row.id, { number: row.number, name: row.name } satisfies LedgerAccount]))
  const of = (id: string | null): LedgerAccount | null => (id === null ? null : (byId.get(id) ?? null))
  const [settings] = await tx.select().from(accountingSettings).where(and(eq(accountingSettings.companyId, scope.companyId), eq(accountingSettings.projectId, scope.projectId))).limit(1)
  const vatCodes = await tx
    .select({ vatPercent: accountingVatCode.vatPercent, code: accountingVatCode.code, accountId: accountingVatCode.accountId })
    .from(accountingVatCode)
    .where(and(eq(accountingVatCode.companyId, scope.companyId), eq(accountingVatCode.projectId, scope.projectId)))
    .orderBy(asc(accountingVatCode.vatPercent))
  const products = await tx
    .select({ productId: accountingProductAccount.productId, accountId: accountingProductAccount.accountId })
    .from(accountingProductAccount)
    .where(and(eq(accountingProductAccount.companyId, scope.companyId), eq(accountingProductAccount.projectId, scope.projectId)))
  return {
    mapping: {
      receivable: of(settings?.receivableAccountId ?? null),
      bank: of(settings?.bankAccountId ?? null),
      suspense: of(settings?.suspenseAccountId ?? null),
      revenue: of(settings?.revenueAccountId ?? null),
      productRevenue: new Map(products.flatMap((row) => (byId.has(row.accountId) ? [[row.productId, byId.get(row.accountId)!] as const] : []))),
      vatCodes: vatCodes.flatMap((row) => (byId.has(row.accountId) ? [{ vatPercent: row.vatPercent, code: row.code, account: byId.get(row.accountId)! }] : [])),
    },
    exportsFrom: settings?.exportsFrom ?? null,
  }
}

/** The order vouchers take: by day, then an invoice, a credit note, a payment and an allocation, then by document and id. */
const KIND_ORDER: readonly AccountingSourceKind[] = ["invoice", "credit-note", "payment", "allocation"]

/** Every row of the project left to book on or before `periodTo`, from the project's first day of exports, in voucher order. */
export async function sourcesToBook(tx: Tx, scope: Scope, periodTo: string, exportsFrom: string | null): Promise<SourceToBook[]> {
  const exported = alias(accountingExportVoucher, "exported")
  const notExported = (kind: SQL | AccountingSourceKind, id: PgColumn) => and(eq(exported.companyId, scope.companyId), eq(exported.sourceKind, kind), eq(exported.sourceId, id))
  const within = (day: SQL): SQL | undefined => and(sql`${day} <= ${periodTo}`, exportsFrom === null ? undefined : sql`${day} >= ${exportsFrom}`)

  const documents = await tx
    .select({ id: invoice.id, kind: invoice.kind, number: invoice.number, issuedOn: invoice.issuedOn, currency: invoice.currency, netMinor: invoice.netMinor, vatMinor: invoice.vatMinor, grossMinor: invoice.grossMinor, parties: invoice.parties, creditsInvoiceId: invoice.creditsInvoiceId })
    .from(invoice)
    .leftJoin(exported, notExported(sql`${invoice.kind}`, invoice.id))
    .where(and(eq(invoice.companyId, scope.companyId), eq(invoice.projectId, scope.projectId), within(sql`${invoice.issuedOn}`), isNull(exported.id)))
  const ids = documents.map((row) => row.id)
  const lines =
    ids.length === 0
      ? []
      : await tx
          .select({ invoiceId: invoiceLine.invoiceId, productId: invoiceLine.productId, netMinor: invoiceLine.netMinor, vatPercent: invoiceLine.vatPercent, vatMinor: invoiceLine.vatMinor })
          .from(invoiceLine)
          .where(and(eq(invoiceLine.companyId, scope.companyId), inArray(invoiceLine.invoiceId, ids)))
          .orderBy(asc(invoiceLine.invoiceId), asc(invoiceLine.position))
  const credited = [...new Set(documents.flatMap((row) => (row.creditsInvoiceId === null ? [] : [row.creditsInvoiceId])))]
  const creditedLabels = new Map(
    credited.length === 0
      ? []
      : (await tx.select({ id: invoice.id, kind: invoice.kind, number: invoice.number }).from(invoice).where(and(eq(invoice.companyId, scope.companyId), inArray(invoice.id, credited)))).map((row) => [row.id, invoiceLabel(row.kind as InvoiceKind, row.number)]),
  )

  const payments = await tx
    .select({ id: payment.id, paidOn: payment.paidOn, currency: payment.currency, amountMinor: payment.amountMinor, reference: payment.reference, customerName: customer.name })
    .from(payment)
    .leftJoin(customer, and(eq(customer.companyId, payment.companyId), eq(customer.id, payment.customerId)))
    .leftJoin(exported, notExported("payment", payment.id))
    .where(and(eq(payment.companyId, scope.companyId), eq(payment.projectId, scope.projectId), within(sql`${payment.paidOn}`), isNull(exported.id)))

  const recordedOn = sql<string>`(${paymentAllocation.recordedAt} at time zone ${project.timezone})::date::text`
  const allocations = await tx
    .select({ id: paymentAllocation.id, recordedOn, amountMinor: paymentAllocation.amountMinor, currency: payment.currency, invoiceKind: invoice.kind, invoiceNumber: invoice.number, parties: invoice.parties })
    .from(paymentAllocation)
    .innerJoin(payment, and(eq(payment.companyId, paymentAllocation.companyId), eq(payment.id, paymentAllocation.paymentId)))
    .innerJoin(invoice, and(eq(invoice.companyId, paymentAllocation.companyId), eq(invoice.id, paymentAllocation.invoiceId)))
    .innerJoin(project, and(eq(project.companyId, paymentAllocation.companyId), eq(project.id, paymentAllocation.projectId)))
    .leftJoin(exported, notExported("allocation", paymentAllocation.id))
    // An allocation books only for a payment that named no customer: it moves the money from suspense to the receivable.
    .where(and(eq(paymentAllocation.companyId, scope.companyId), eq(paymentAllocation.projectId, scope.projectId), isNull(payment.customerId), within(sql`(${paymentAllocation.recordedAt} at time zone ${project.timezone})::date`), isNull(exported.id)))

  const linesOf = Map.groupBy(lines, (line) => line.invoiceId)
  const sources: SourceToBook[] = [
    ...documents.map((row): SourceToBook => ({
      kind: row.kind as "invoice" | "credit-note",
      id: row.id,
      label: invoiceLabel(row.kind as InvoiceKind, row.number),
      bookedOn: row.issuedOn,
      currency: row.currency,
      customerName: row.parties.buyer.name,
      netMinor: row.netMinor,
      vatMinor: row.vatMinor,
      grossMinor: row.grossMinor,
      creditsLabel: row.creditsInvoiceId === null ? null : (creditedLabels.get(row.creditsInvoiceId) ?? null),
      lines: (linesOf.get(row.id) ?? []).map(({ productId, netMinor, vatPercent, vatMinor }) => ({ productId, netMinor, vatPercent, vatMinor })),
    })),
    ...payments.map((row): SourceToBook => ({ kind: "payment", id: row.id, reference: row.reference, bookedOn: row.paidOn, currency: row.currency, amountMinor: row.amountMinor, customerName: row.customerName })),
    ...allocations.map((row): SourceToBook => ({ kind: "allocation", id: row.id, invoiceLabel: invoiceLabel(row.invoiceKind as InvoiceKind, row.invoiceNumber), bookedOn: row.recordedOn, currency: row.currency, amountMinor: row.amountMinor, customerName: row.parties.buyer.name })),
  ]
  const documentOf = (source: SourceToBook): string => (source.kind === "payment" ? (source.reference ?? "") : source.kind === "allocation" ? source.invoiceLabel : source.label)
  return sources.sort((a, b) => (a.bookedOn < b.bookedOn ? -1 : a.bookedOn > b.bookedOn ? 1 : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || documentOf(a).localeCompare(documentOf(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
}

/** A gap a row met: the row, as the office finds it, and the sentence. */
export type ExportGap = { source: { kind: AccountingSourceKind; id: string; document: string | null }; sentence: string }

/** What an export over the period would book: its vouchers in order, the gaps in the way, and how many of the vouchers are back-dated. */
export type ExportPlan = { vouchers: Voucher[]; gaps: ExportGap[]; backDated: number }

/** Plans the export of the period: reads and books, writes nothing. */
export async function planExport(tx: Tx, scope: Scope, period: BillingPeriod): Promise<ExportPlan> {
  const { mapping, exportsFrom } = await mappingOf(tx, scope)
  const sources = await sourcesToBook(tx, scope, period.periodTo, exportsFrom)
  const vouchers: Voucher[] = []
  const gaps: ExportGap[] = []
  for (const source of sources) {
    const booked = voucherOf(source, mapping)
    if ("voucher" in booked) vouchers.push(booked.voucher)
    else gaps.push({ source: { kind: source.kind, id: source.id, document: source.kind === "payment" ? source.reference : source.kind === "allocation" ? source.invoiceLabel : source.label }, sentence: gapSentence(booked.gap) })
  }
  return { vouchers, gaps, backDated: vouchers.filter((voucher) => voucher.bookedOn < period.periodFrom).length }
}

/** The sentence an export is refused with while a gap stands: the gap's own, and the document it met. */
export const gapRefusal = (gap: ExportGap): string => `${gap.sentence}${gap.source.document === null ? "" : ` (${gap.source.document})`}; set it up in Settings › Finance & invoicing › Accounting`

export type RunExportInput = BillingPeriod & { companyId: string; projectId: string; note: string | null; createdBy: string | null; newId: IdMinter }

/** The export a run wrote: its row, and what its summary reads. */
export type ExportWritten = { id: string; voucherFrom: number; voucherTo: number; lineCount: number; backDated: number }

/** The most lines one insert writes: a statement's parameters are bounded (65 535), and a line binds a dozen. */
const INSERT_CHUNK = 1000

/** Exports the period in the caller's transaction, under the project's lock. */
export async function runExport(tx: Tx, input: RunExportInput): Promise<ExportWritten> {
  const scope: Scope = { companyId: input.companyId, projectId: input.projectId }
  await lockRow(tx, project, { companyId: scope.companyId, id: scope.projectId })
  const plan = await planExport(tx, scope, input)
  const [gap] = plan.gaps
  if (gap !== undefined) throw refused(409, gapRefusal(gap))
  if (plan.vouchers.length === 0) throw refused(409, NOTHING_TO_EXPORT)
  if (plan.vouchers.length > ACCOUNTING_EXPORT_MAX_VOUCHERS) throw refused(409, tooManyVouchers(plan.vouchers.length))
  const [last] = await tx
    .select({ voucher: max(accountingExportVoucher.voucher) })
    .from(accountingExportVoucher)
    .where(and(eq(accountingExportVoucher.companyId, scope.companyId), eq(accountingExportVoucher.projectId, scope.projectId)))
  const first = (last?.voucher ?? 0) + 1
  const exportId = input.newId()
  await tx.insert(accountingExport).values({
    id: exportId,
    ...scope,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    voucherFrom: first,
    voucherTo: first + plan.vouchers.length - 1,
    lineCount: plan.vouchers.reduce((count, voucher) => count + voucher.lines.length, 0),
    createdBy: input.createdBy,
    note: input.note,
  })
  const voucherIds = plan.vouchers.map(() => input.newId())
  const voucherRows = plan.vouchers.map((voucher, index) => ({
    id: voucherIds[index],
    ...scope,
    exportId,
    voucher: first + index,
    bookedOn: voucher.bookedOn,
    sourceKind: voucher.source.kind,
    sourceId: voucher.source.id,
    document: voucher.document,
    currency: voucher.currency,
    customerName: voucher.customerName,
    backDated: voucher.bookedOn < input.periodFrom,
  }))
  for (let at = 0; at < voucherRows.length; at += INSERT_CHUNK) await tx.insert(accountingExportVoucher).values(voucherRows.slice(at, at + INSERT_CHUNK))
  const lineRows = plan.vouchers.flatMap((voucher, index) =>
    voucher.lines.map((line, position) => ({
      id: input.newId(),
      ...scope,
      voucherId: voucherIds[index],
      position: position + 1,
      accountNumber: line.account.number,
      accountName: line.account.name,
      vatCode: line.vatCode,
      amountMinor: line.amountMinor,
      text: line.text,
    })),
  )
  for (let at = 0; at < lineRows.length; at += INSERT_CHUNK) await tx.insert(accountingExportLine).values(lineRows.slice(at, at + INSERT_CHUNK))
  return { id: exportId, voucherFrom: first, voucherTo: first + plan.vouchers.length - 1, lineCount: lineRows.length, backDated: plan.backDated }
}

/** An export's lines as frozen, in voucher and line order: what its file is rendered from. */
export async function exportedLines(tx: Tx, scope: Scope, exportId: string): Promise<ExportLine[]> {
  const rows = await tx
    .select({
      voucher: accountingExportVoucher.voucher,
      bookedOn: accountingExportVoucher.bookedOn,
      accountNumber: accountingExportLine.accountNumber,
      accountName: accountingExportLine.accountName,
      text: accountingExportLine.text,
      amountMinor: accountingExportLine.amountMinor,
      vatCode: accountingExportLine.vatCode,
      currency: accountingExportVoucher.currency,
      customerName: accountingExportVoucher.customerName,
      document: accountingExportVoucher.document,
      sourceKind: accountingExportVoucher.sourceKind,
      sourceId: accountingExportVoucher.sourceId,
    })
    .from(accountingExportLine)
    .innerJoin(accountingExportVoucher, and(eq(accountingExportVoucher.companyId, accountingExportLine.companyId), eq(accountingExportVoucher.id, accountingExportLine.voucherId)))
    .where(and(eq(accountingExportVoucher.companyId, scope.companyId), eq(accountingExportVoucher.projectId, scope.projectId), eq(accountingExportVoucher.exportId, exportId)))
    .orderBy(asc(accountingExportVoucher.voucher), asc(accountingExportLine.position))
  return rows.map((row) => ({ ...row, sourceKind: row.sourceKind as AccountingSourceKind }))
}

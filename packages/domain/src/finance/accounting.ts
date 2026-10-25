// The accounting export (#291 slice 7, #292 C7): what the office imports into
// its own bookkeeping system, as a file — no live link (the owner's decision
// on #291). Each source row is one balanced voucher on its own day, on the
// project's chart of accounts:
//
//   an invoice       receivable +gross · revenue −net per account and rate · VAT −vat per rate
//   a credit note    the same rule; its totals are negative, so every sign turns
//   a payment        bank +amount · receivable −amount, or suspense −amount when it names no customer
//   an allocation    of a payment that named no customer: suspense +amount · receivable −amount,
//                    its reversal (a negative amount) moving it back
//
// A debit is positive and a credit negative, and a voucher's lines sum to
// zero, which `voucherOf` asserts: the invoice's VAT is its lines' VAT, so its
// gross is their net and VAT and the voucher balances by construction. An
// allocation of a known customer's payment is subledger matching inside one
// receivable account, so it books nothing. Every line goes to an account of
// the office's chart, never to a debtor number: the receivable is the one
// control account, and the customer is named on the line.
//
// A mapping that lacks an account a voucher needs is a gap, named, and no
// voucher: the export refuses while a gap stands rather than book to nothing.
//
// The CSV is our own, documented by `ACCOUNTING_CSV_COLUMNS`: UTF-8 with a
// byte-order mark, so a spreadsheet reads æ, ø and å; semicolon-separated, as
// e-conomic's journal import and a Danish spreadsheet expect; one row per
// line; ISO days; signed amounts with a decimal comma and the currency's own
// digits, no grouping. `amount` is always the line's own: a revenue line's
// net, a VAT line's VAT — a receiving system that derives VAT from `vat_code`
// on a gross amount imports it with `vat_code` unmapped. Danish SAF-T 2.1 is
// C7b's.
import { minorDigitsOf } from "./payments"
import type { AccountingSourceKind } from "./vocabulary"

/** An account's number in the office's chart, or in Erhvervsstyrelsen's standard chart: a letter or digit, then up to nineteen of letters, digits, points and hyphens. The database's check and the contracts read this one spelling. */
export const ACCOUNT_NUMBER_PATTERN = "^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$"

/** A VAT code in the office's system, `U25`, `I25`, `UEUV`: a letter or digit, then up to eight of letters, digits, underscores and hyphens — nine at most, the length Danish SAF-T's `TaxCode` carries (C7b). */
export const VAT_CODE_PATTERN = "^[0-9A-Za-z][0-9A-Za-z_-]{0,8}$"

/** An account of the office's chart, as a line names it. */
export type LedgerAccount = { number: string; name: string }

/** A VAT rate's code in the office's system, and the account its VAT is booked to. */
export type VatCode = { vatPercent: number; code: string; account: LedgerAccount }

/** A project's mapping onto its chart: the four accounts a voucher may need, a product's own revenue account where it has one, and a code per VAT rate. */
export type AccountingMapping = {
  receivable: LedgerAccount | null
  bank: LedgerAccount | null
  suspense: LedgerAccount | null
  /** Where a line's revenue goes when its product names no account of its own, or the line names no product. */
  revenue: LedgerAccount | null
  productRevenue: ReadonlyMap<string, LedgerAccount>
  vatCodes: readonly VatCode[]
}

/** An invoice line as booked: its product, net, rate and VAT. */
export type LineToBook = { productId: string | null; netMinor: number; vatPercent: number; vatMinor: number }

/** A row an export books, as read: an issued document, a payment, or an allocation of a payment that named no customer. */
export type SourceToBook =
  | { kind: "invoice" | "credit-note"; id: string; label: string; bookedOn: string; currency: string; customerName: string; netMinor: number; vatMinor: number; grossMinor: number; lines: readonly LineToBook[]; creditsLabel: string | null }
  | { kind: "payment"; id: string; reference: string | null; bookedOn: string; currency: string; amountMinor: number; customerName: string | null }
  | { kind: "allocation"; id: string; invoiceLabel: string; bookedOn: string; currency: string; amountMinor: number; customerName: string }

/** One line of a voucher: a debit positive, a credit negative. */
export type VoucherLine = { account: LedgerAccount; vatCode: string | null; amountMinor: number; text: string }

/** A balanced voucher of one source row on its own day. */
export type Voucher = { source: { kind: AccountingSourceKind; id: string }; bookedOn: string; currency: string; document: string | null; customerName: string | null; lines: readonly VoucherLine[] }

/** What a mapping lacks for a voucher: one of the four accounts, or a VAT rate's code. */
export type MappingGap = { account: "receivable" | "bank" | "suspense" | "revenue" } | { vatPercent: number }

/** A source row booked, or the gap that stands in its way. */
export type Booked = { voucher: Voucher } | { gap: MappingGap }

/** The sentence a gap is refused with: what to set up, in Settings' words. */
export function gapSentence(gap: MappingGap): string {
  if ("vatPercent" in gap) return `No VAT code is set up for ${gap.vatPercent} % VAT`
  const names = { receivable: "receivables", bank: "bank", suspense: "unmatched payments", revenue: "revenue" } as const
  return `No ${names[gap.account]} account is set up`
}

/** A voucher's lines summed: zero for every voucher this module writes. */
export const voucherSum = (lines: readonly Pick<VoucherLine, "amountMinor">[]): number => lines.reduce((sum, line) => sum + line.amountMinor, 0)

/** The voucher a source row books on the mapping, or the gap in its way; throws on a document whose header disagrees with its lines, which no issued document does. */
export function voucherOf(source: SourceToBook, mapping: AccountingMapping): Booked {
  const lines = linesOf(source, mapping)
  if ("gap" in lines) return lines
  const sum = voucherSum(lines.lines)
  if (sum !== 0) throw new Error(`voucherOf: ${source.kind} ${source.id} does not balance (${sum})`)
  const document = source.kind === "payment" ? source.reference : source.kind === "allocation" ? source.invoiceLabel : source.label
  return { voucher: { source: { kind: source.kind, id: source.id }, bookedOn: source.bookedOn, currency: source.currency, document, customerName: source.customerName, lines: lines.lines } }
}

function linesOf(source: SourceToBook, mapping: AccountingMapping): { lines: VoucherLine[] } | { gap: MappingGap } {
  switch (source.kind) {
    case "invoice":
    case "credit-note":
      return documentLines(source, mapping)
    case "payment": {
      if (mapping.bank === null) return { gap: { account: "bank" } }
      const against = source.customerName === null ? mapping.suspense : mapping.receivable
      if (against === null) return { gap: { account: source.customerName === null ? "suspense" : "receivable" } }
      const text = `Payment${source.reference === null ? "" : ` ${source.reference}`} ${source.customerName ?? "unmatched"}`
      return {
        lines: [
          { account: mapping.bank, vatCode: null, amountMinor: source.amountMinor, text },
          { account: against, vatCode: null, amountMinor: -source.amountMinor, text },
        ],
      }
    }
    case "allocation": {
      if (mapping.suspense === null) return { gap: { account: "suspense" } }
      if (mapping.receivable === null) return { gap: { account: "receivable" } }
      const text = `${source.amountMinor < 0 ? "Match undone" : "Payment matched"} ${source.invoiceLabel} ${source.customerName}`
      return {
        lines: [
          { account: mapping.suspense, vatCode: null, amountMinor: source.amountMinor, text },
          { account: mapping.receivable, vatCode: null, amountMinor: -source.amountMinor, text },
        ],
      }
    }
  }
}

function documentLines(source: Extract<SourceToBook, { kind: "invoice" | "credit-note" }>, mapping: AccountingMapping): { lines: VoucherLine[] } | { gap: MappingGap } {
  const net = source.lines.reduce((sum, line) => sum + line.netMinor, 0)
  const vat = source.lines.reduce((sum, line) => sum + line.vatMinor, 0)
  if (net !== source.netMinor || vat !== source.vatMinor || source.grossMinor !== source.netMinor + source.vatMinor) throw new Error(`voucherOf: ${source.label}'s totals are not its lines'`)
  if (mapping.receivable === null) return { gap: { account: "receivable" } }
  const text = `${source.label} ${source.customerName}${source.creditsLabel === null ? "" : ` (credits ${source.creditsLabel})`}`
  // Revenue per account and rate, VAT per rate, each in the order its first line met it.
  const revenue = new Map<string, { account: LedgerAccount; code: VatCode; netMinor: number }>()
  const vatByRate = new Map<number, { code: VatCode; vatMinor: number }>()
  for (const line of source.lines) {
    const account = (line.productId === null ? undefined : mapping.productRevenue.get(line.productId)) ?? mapping.revenue
    if (account === null) return { gap: { account: "revenue" } }
    const code = mapping.vatCodes.find((candidate) => candidate.vatPercent === line.vatPercent)
    if (code === undefined) return { gap: { vatPercent: line.vatPercent } }
    const key = `${account.number}/${line.vatPercent}`
    const held = revenue.get(key)
    revenue.set(key, { account, code, netMinor: (held?.netMinor ?? 0) + line.netMinor })
    const rate = vatByRate.get(line.vatPercent)
    vatByRate.set(line.vatPercent, { code, vatMinor: (rate?.vatMinor ?? 0) + line.vatMinor })
  }
  return {
    lines: [
      { account: mapping.receivable, vatCode: null, amountMinor: source.grossMinor, text },
      ...[...revenue.values()].map(({ account, code, netMinor }) => ({ account, vatCode: code.code, amountMinor: -netMinor, text })),
      ...[...vatByRate.values()].filter(({ vatMinor }) => vatMinor !== 0).map(({ code, vatMinor }) => ({ account: code.account, vatCode: code.code, amountMinor: -vatMinor, text: `${text} VAT ${code.vatPercent} %` })),
    ].filter((line) => line.amountMinor !== 0 || line.account === mapping.receivable),
  }
}

/** A line as an export freezes it: its voucher's number and day, the account as it was named, and its source — what the file is rendered from. */
export type ExportLine = {
  voucher: number
  bookedOn: string
  accountNumber: string
  accountName: string
  text: string
  amountMinor: number
  vatCode: string | null
  currency: string
  customerName: string | null
  document: string | null
  sourceKind: AccountingSourceKind
  sourceId: string
}

/** The vouchers numbered from `first` in their order, as the lines an export freezes. */
export const exportLinesOf = (vouchers: readonly Voucher[], first: number): ExportLine[] =>
  vouchers.flatMap((voucher, index) =>
    voucher.lines.map((line) => ({
      voucher: first + index,
      bookedOn: voucher.bookedOn,
      accountNumber: line.account.number,
      accountName: line.account.name,
      text: line.text,
      amountMinor: line.amountMinor,
      vatCode: line.vatCode,
      currency: voucher.currency,
      customerName: voucher.customerName,
      document: voucher.document,
      sourceKind: voucher.source.kind,
      sourceId: voucher.source.id,
    })),
  )

/** Our CSV's columns, in order. */
export const ACCOUNTING_CSV_COLUMNS = ["voucher", "date", "account", "account_name", "text", "amount", "vat_code", "currency", "customer", "document", "source", "source_id"] as const

/** An amount in its currency's digits with a decimal comma: `-1234,50`, `0,05`, `120` for a currency with none. */
export function amountText(minor: number, currency: string): string {
  const digits = minorDigitsOf(currency)
  const sign = minor < 0 ? "-" : ""
  const whole = Math.abs(minor)
  if (digits === 0) return `${sign}${whole}`
  const text = String(whole).padStart(digits + 1, "0")
  return `${sign}${text.slice(0, -digits)},${text.slice(-digits)}`
}

/** A field as the file spells it: quoted, its quotes doubled, where it holds a semicolon, a quote or a line break. */
const field = (value: string): string => (/[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

/** The export's file in our CSV: a byte-order mark, the header, one row per line in voucher order, CRLF line ends. */
export function accountingCsv(lines: readonly ExportLine[]): string {
  const rows = lines.map((line) =>
    [String(line.voucher), line.bookedOn, line.accountNumber, line.accountName, line.text, amountText(line.amountMinor, line.currency), line.vatCode ?? "", line.currency, line.customerName ?? "", line.document ?? "", line.sourceKind, line.sourceId].map(field).join(";"),
  )
  return `﻿${[ACCOUNTING_CSV_COLUMNS.join(";"), ...rows].join("\r\n")}\r\n`
}

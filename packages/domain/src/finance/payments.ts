// Payments and reconciliation (#291 slice 6, #292 C6). An invoice's standing
// is a reading of its payments, never a column: what it owes is its gross
// less its credit notes, and what its payments' allocations cover of that
// reads it open, partially paid, paid or — past its due day with anything
// owed — overdue; credited in full, or of no net to pay, it owes nothing.
// Money paid beyond what an invoice owes stays unallocated, a credit on the
// customer's balance (refunds are not here).
//
// A bank statement comes as our own CSV — `booked_on`, `amount`, `currency`,
// `reference`, `text` — a day, a decimal amount with a comma or a point
// before its decimals, the currency's code, the reference the payer gave and
// the bank's text. Its incoming lines become payments and its outgoing ones
// are skipped. Each line carries a key of what it says and how many identical
// lines came before it in the file, so a file imported twice adds nothing
// while two equal transfers on one day stay two. ISO 20022's CAMT.053 is the
// standard a bank's own export maps onto later.
//
// A line is matched to an invoice by the invoice's frozen FIK reference (#291
// C4) — as the bank gives it, or inside the FI card's printed line — or else
// by the one open invoice its text names by label; anything ambiguous stays
// unmatched for the office. A match allocates what the invoice owes at most.
import { csvRecords } from "../imports/csv"
import { PAYMENT_REFERENCE_PATTERN } from "./payment"

/** What an invoice reads as from its payments: a reading, never a column. */
export const INVOICE_PAYMENT_STATUSES = ["open", "partially-paid", "paid", "overdue", "credited"] as const
export type InvoicePaymentStatus = (typeof INVOICE_PAYMENT_STATUSES)[number]

export type InvoicePaymentReading = { status: InvoicePaymentStatus; paidMinor: number; outstandingMinor: number }

/**
 * An invoice's standing on `today` (the project's day): its gross, its credit
 * notes' gross (zero or less), what its payments' allocations total, and its
 * due day. Due on the day itself is still in time.
 */
export function invoicePayment(input: { grossMinor: number; creditedMinor: number; allocatedMinor: number; dueOn: string; today: string }): InvoicePaymentReading {
  const owed = input.grossMinor + input.creditedMinor
  const paidMinor = input.allocatedMinor
  const outstandingMinor = Math.max(0, owed - paidMinor)
  if (outstandingMinor === 0) return { status: paidMinor > 0 ? "paid" : "credited", paidMinor, outstandingMinor }
  if (input.today > input.dueOn) return { status: "overdue", paidMinor, outstandingMinor }
  return { status: paidMinor > 0 ? "partially-paid" : "open", paidMinor, outstandingMinor }
}

/**
 * How many digits a currency's minor unit has, as ISO 4217 lists them: a
 * fixed table rather than the runtime's, so a reading does not move with it.
 * Two for any code not listed.
 */
const MINOR_DIGITS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

/** The digits of a currency's minor unit: 2 for DKK, 0 for JPY, 3 for KWD. */
export const minorDigitsOf = (currency: string): number => MINOR_DIGITS[currency] ?? 2

/** A statement's amount in the currency's minor units — `1234,50` or `1234.5`, a sign allowed, no grouping — or null when it is not one. */
export function amountMinorOf(text: string, currency: string): number | null {
  const digits = minorDigitsOf(currency)
  const match = /^(-?)(\d+)(?:[.,](\d+))?$/.exec(text.trim())
  if (match === null) return null
  const [, sign, whole, fraction = ""] = match
  if (fraction.length > digits) return null
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0")
  if (!Number.isSafeInteger(minor)) return null
  return sign === "-" ? -minor : minor
}

/** The columns of our bank statement file, in order. */
export const BANK_FILE_COLUMNS = ["booked_on", "amount", "currency", "reference", "text"] as const

export type BankLine = {
  /** The file's row the line was read from, the header row 1. */
  row: number
  bookedOn: string
  amountMinor: number
  currency: string
  reference: string
  text: string
  /** How many identical lines the file held before this one: what tells two equal transfers apart. */
  occurrence: number
  /** What makes the line one payment, whichever file it is read from again. */
  key: string
}

export type BankFile = {
  lines: BankLine[]
  /** A line that is no incoming payment, by its row: an outgoing one. */
  skipped: { row: number; reason: "outgoing" }[]
  refusals: { row: number; message: string }[]
}

/** The longest text a line's key keeps: enough to tell lines apart, short enough to index. */
const KEY_TEXT_MAX = 200

/** A line's key: what it says, its text cut to KEY_TEXT_MAX, and how many identical lines the file held before it. */
export function bankLineKey(line: Pick<BankLine, "bookedOn" | "amountMinor" | "currency" | "reference" | "text">, occurrence: number): string {
  return JSON.stringify([line.bookedOn, line.amountMinor, line.currency, line.reference.slice(0, 40), line.text.slice(0, KEY_TEXT_MAX), occurrence])
}

const isDay = (text: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const [, year, month, day] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** A bank statement file read: its incoming lines, its outgoing ones skipped, and every line it cannot read refused by its row. */
export function bankFileOf(text: string): BankFile {
  const [header, ...records] = csvRecords(text)
  const file: BankFile = { lines: [], skipped: [], refusals: [] }
  const named = header?.fields.map((field) => field.trim().toLowerCase()) ?? []
  if (named.join(",") !== BANK_FILE_COLUMNS.join(",")) {
    file.refusals.push({ row: header?.row ?? 1, message: `The header is ${BANK_FILE_COLUMNS.join(", ")}` })
    return file
  }
  const seen = new Map<string, number>()
  for (const { row, fields } of records) {
    const [bookedOn = "", amountText = "", currency = "", reference = "", lineText = ""] = fields.map((field) => field.trim())
    if (!isDay(bookedOn)) {
      file.refusals.push({ row, message: "booked_on is a day, as 2026-10-12" })
      continue
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      file.refusals.push({ row, message: "currency is three capital letters, as DKK" })
      continue
    }
    const amountMinor = amountMinorOf(amountText, currency)
    if (amountMinor === null) {
      file.refusals.push({ row, message: "amount is a number with a comma or a point before the decimals, as 1234,50" })
      continue
    }
    if (amountMinor <= 0) {
      file.skipped.push({ row, reason: "outgoing" })
      continue
    }
    const said = { bookedOn, amountMinor, currency, reference, text: lineText }
    const identity = bankLineKey(said, 0)
    const occurrence = seen.get(identity) ?? 0
    seen.set(identity, occurrence + 1)
    file.lines.push({ row, ...said, occurrence, key: bankLineKey(said, occurrence) })
  }
  return file
}

/** An invoice a line may pay: its frozen reference, its label, its currency and what it owes. */
export type OpenInvoice = { id: string; label: string; paymentReference: string | null; currency: string; outstandingMinor: number }

export type BankMatch = { invoiceId: string; amountMinor: number; by: "reference" | "label" }

/** The payment reference a bank's reference holds: itself, or the one inside a FI card's printed line (`+71<…+creditor<`); null for anything else. */
export function bankLineReference(reference: string): string | null {
  const plain = reference.replace(/\s+/g, "")
  if (new RegExp(PAYMENT_REFERENCE_PATTERN).test(plain)) return plain
  const card = /^\+7[15]<(\d{15,16})\+\d{8}<$/.exec(plain)
  return card?.[1] ?? null
}

/** The document labels a bank's text names, each once: `INV-26007188`, `CN-26007189`. */
export const bankLineLabels = (text: string): string[] => [...new Set(text.match(/\b(?:INV|CN)-\d+\b/g) ?? [])]

/** The invoice a line pays and how much of it, or null where none is certain: by reference first, then by the one label its text names. */
export function matchBankLine(line: Pick<BankLine, "amountMinor" | "currency" | "reference" | "text">, invoices: readonly OpenInvoice[]): BankMatch | null {
  const payable = invoices.filter((invoice) => invoice.currency === line.currency)
  const allocate = (invoice: OpenInvoice, by: BankMatch["by"]): BankMatch | null =>
    invoice.outstandingMinor > 0 ? { invoiceId: invoice.id, amountMinor: Math.min(line.amountMinor, invoice.outstandingMinor), by } : null

  const reference = bankLineReference(line.reference)
  if (reference !== null) {
    const byReference = payable.find((invoice) => invoice.paymentReference === reference)
    return byReference === undefined ? null : allocate(byReference, "reference")
  }
  const labels = bankLineLabels(line.text)
  const named = payable.filter((invoice) => labels.includes(invoice.label))
  if (labels.length !== 1 || named.length !== 1) return null
  return allocate(named[0], "label")
}

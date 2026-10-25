// What an invoice document says (#291 slice 5, #292 C5): the model a renderer
// lays out, a pure function of the ledger's rows — the invoice, its frozen
// lines and the parties frozen at its issue — in its project's language,
// Danish for a Danish project and English for any other. Every string is
// spelled here rather than through the runtime's Intl, whose tables move with
// Node's ICU, so the same rows give the same document on any runtime; and
// every string is WinAnsi, the encoding the PDF standard fonts print, a
// character outside it marked `?` rather than dropped.
import { fikLine, fikSchemeOf } from "./payment"
import type { CreditReason } from "./vocabulary"

export type DocumentLanguage = "da" | "en"

/** The parties as they stood when the document was issued, frozen on it. */
export type InvoiceParties = {
  seller: {
    legalName: string
    registrationNumber: string
    vatNumber: string | null
    /** Lines separated by newlines. */
    postalAddress: string | null
    bankIban: string | null
    bankBic: string | null
    fikCreditorNumber: string | null
  }
  buyer: {
    name: string
    registrationNumber: string | null
    /** Lines separated by newlines. */
    billingAddress: string | null
  }
}

export type InvoiceDocumentLine = {
  description: string
  serviceDate: string | null
  quantity: number
  unitPriceMinor: number
  netMinor: number
  vatPercent: number
  vatMinor: number
}

/** The rows a document is made of: the invoice's own columns, its lines in position order, and its parties. */
export type InvoiceDocumentInput = {
  kind: "invoice" | "credit-note"
  /** `INV-26007188`, `CN-26007189`: the contracts' `invoiceLabel`. */
  label: string
  language: DocumentLanguage
  currency: string
  issuedOn: string
  dueOn: string
  periodFrom: string | null
  periodTo: string | null
  paymentReference: string | null
  /** On a credit note: the invoice it corrects, by its label, the reason the office chose and the note it wrote. */
  credits: { label: string; reason: CreditReason | null; note: string | null } | null
  netMinor: number
  vatMinor: number
  grossMinor: number
  lines: readonly InvoiceDocumentLine[]
  parties: InvoiceParties
}

/** The document, every string spelled and WinAnsi: a renderer places it and adds nothing. */
export type InvoiceDocument = {
  title: string
  label: string
  /** The day it was issued, ISO: the date its file carries. */
  issuedOn: string
  seller: string[]
  buyer: string[]
  /** Label and value, in the order printed. */
  facts: [string, string][]
  columns: string[]
  /** One row per line, in the columns' order. */
  lines: string[][]
  /** Per VAT rate, ascending: what it is of, and the VAT. */
  vat: [string, string][]
  totals: [string, string][]
  payment: string[]
  /** The FIK card's code line, printed in a fixed-width font; null where the document carries none. */
  fikLine: string | null
}

const LABELS = {
  da: {
    invoice: "Faktura",
    creditNote: "Kreditnota",
    invoiceNumber: "Fakturanr.",
    creditNoteNumber: "Kreditnotanr.",
    invoiceDate: "Fakturadato",
    creditNoteDate: "Dato",
    period: "Periode",
    due: "Forfaldsdato",
    reference: "Betalingsreference",
    credits: "Krediterer",
    reason: "Årsag",
    note: "Bemærkning",
    reasons: { "service-not-delivered": "Ydelse ikke leveret", "quantity-correction": "Rettelse af antal", "price-correction": "Rettelse af pris", duplicate: "Dobbeltfakturering", other: "Andet" },
    registration: "CVR",
    vatNumber: "Momsnr.",
    columns: ["Beskrivelse", "Dato", "Antal", "Stykpris", "Moms", "Beløb"],
    vatOf: (percent: string, base: string) => `Moms ${percent} af ${base}`,
    subtotal: "Subtotal",
    vat: "Moms",
    total: (currency: string) => `I alt ${currency}`,
    payBy: (date: string) => `Betales senest ${date}`,
  },
  en: {
    invoice: "Invoice",
    creditNote: "Credit note",
    invoiceNumber: "Invoice no.",
    creditNoteNumber: "Credit note no.",
    invoiceDate: "Invoice date",
    creditNoteDate: "Date",
    period: "Period",
    due: "Due date",
    reference: "Payment reference",
    credits: "Credits",
    reason: "Reason",
    note: "Note",
    reasons: { "service-not-delivered": "Service not delivered", "quantity-correction": "Quantity correction", "price-correction": "Price correction", duplicate: "Duplicate", other: "Other" },
    registration: "Reg. no.",
    vatNumber: "VAT no.",
    columns: ["Description", "Date", "Qty", "Unit price", "VAT", "Amount"],
    vatOf: (percent: string, base: string) => `VAT ${percent} of ${base}`,
    subtotal: "Subtotal",
    vat: "VAT",
    total: (currency: string) => `Total ${currency}`,
    payBy: (date: string) => `Due by ${date}`,
  },
} as const

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** The document's language for a project's BCP 47 tag: Danish for `da` and its regions, English otherwise. */
export const documentLanguageOf = (tag: string): DocumentLanguage => (tag.split("-")[0]?.toLowerCase() === "da" ? "da" : "en")

/**
 * How many digits a currency's minor unit has, as ISO 4217 lists them: a
 * fixed table rather than the runtime's, so a document does not move with it.
 * Two for any code not listed.
 */
const MINOR_DIGITS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

/** An amount in minor units as the language writes it: `1.234,50` in Danish, `1,234.50` in English, the currency's own number of decimals. */
export function documentAmount(minor: number, currency: string, language: DocumentLanguage): string {
  if (!Number.isSafeInteger(minor)) throw new Error(`documentAmount: ${minor} is not a whole number of minor units`)
  const digits = MINOR_DIGITS[currency] ?? 2
  const [group, decimal] = language === "da" ? [".", ","] : [",", "."]
  const sign = minor < 0 ? "-" : ""
  const units = String(Math.abs(minor)).padStart(digits + 1, "0")
  const whole = units.slice(0, units.length - digits).replace(/\B(?=(\d{3})+(?!\d))/g, group)
  return digits === 0 ? `${sign}${whole}` : `${sign}${whole}${decimal}${units.slice(-digits)}`
}

/** A calendar day (`2026-10-13`) as the language writes it: `13.10.2026`, `13 October 2026`. */
export function documentDate(day: string, language: DocumentLanguage): string {
  const [year, month, date] = day.split("-")
  if (language === "da") return `${date}.${month}.${year}`
  return `${Number(date)} ${MONTHS[Number(month) - 1]} ${year}`
}

/** The characters WinAnsiEncoding gives beyond Latin-1's printable ones, at 0x80–0x9F. */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ")

/** Text the standard fonts can print: composed, every control character a space, and anything WinAnsi lacks `?`. */
export function winAnsi(text: string): string {
  let printable = ""
  for (const character of text.normalize("NFC").replace(/\r\n/g, "\n")) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) printable += " "
    else if (code < 0x7f || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(character)) printable += character
    else printable += "?"
  }
  return printable
}

/** A newline-separated address as its lines, blanks dropped. */
const linesOf = (address: string | null): string[] =>
  (address ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")

/** The model of an invoice's or a credit note's document; throws where its lines do not add up to its totals. */
export function invoiceDocumentOf(input: InvoiceDocumentInput): InvoiceDocument {
  const label = LABELS[input.language]
  const amount = (minor: number) => documentAmount(minor, input.currency, input.language)
  const date = (day: string) => documentDate(day, input.language)
  const { seller, buyer } = input.parties

  const net = input.lines.reduce((sum, line) => sum + line.netMinor, 0)
  const vat = input.lines.reduce((sum, line) => sum + line.vatMinor, 0)
  if (net !== input.netMinor) throw new Error(`invoiceDocumentOf: ${input.label}'s lines' net ${net} is not the invoice's ${input.netMinor}`)
  if (vat !== input.vatMinor) throw new Error(`invoiceDocumentOf: ${input.label}'s lines' VAT ${vat} is not the invoice's ${input.vatMinor}`)

  const isInvoice = input.kind === "invoice"
  const facts: [string, string][] = isInvoice
    ? [
        [label.invoiceNumber, input.label],
        [label.invoiceDate, date(input.issuedOn)],
        ...(input.periodFrom !== null && input.periodTo !== null ? [[label.period, `${date(input.periodFrom)} – ${date(input.periodTo)}`] as [string, string]] : []),
        [label.due, date(input.dueOn)],
        ...(input.paymentReference !== null ? [[label.reference, input.paymentReference] as [string, string]] : []),
      ]
    : [
        [label.creditNoteNumber, input.label],
        [label.creditNoteDate, date(input.issuedOn)],
        ...(input.credits !== null ? [[label.credits, input.credits.label] as [string, string]] : []),
        ...(input.credits?.reason ? [[label.reason, label.reasons[input.credits.reason]] as [string, string]] : []),
        ...(input.credits?.note ? [[label.note, input.credits.note] as [string, string]] : []),
      ]

  const rates = [...new Set(input.lines.map((line) => line.vatPercent))].sort((a, b) => a - b)
  const vatByRate: [string, string][] = rates.map((rate) => {
    const lines = input.lines.filter((line) => line.vatPercent === rate)
    const base = lines.reduce((sum, line) => sum + line.netMinor, 0)
    const due = lines.reduce((sum, line) => sum + line.vatMinor, 0)
    return [label.vatOf(`${rate} %`, amount(base)), amount(due)]
  })

  const scheme = input.paymentReference === null ? null : fikSchemeOf(input.paymentReference)
  const card = isInvoice && scheme !== null && seller.fikCreditorNumber !== null ? fikLine(scheme, input.paymentReference, seller.fikCreditorNumber) : null
  const bank = [seller.bankIban === null ? null : `IBAN ${seller.bankIban}`, seller.bankBic === null ? null : `BIC ${seller.bankBic}`].filter((part) => part !== null).join(" · ")

  const document: InvoiceDocument = {
    title: isInvoice ? label.invoice : label.creditNote,
    label: input.label,
    issuedOn: input.issuedOn,
    seller: [seller.legalName, ...linesOf(seller.postalAddress), `${label.registration} ${seller.registrationNumber}`, ...(seller.vatNumber === null ? [] : [`${label.vatNumber} ${seller.vatNumber}`])],
    buyer: [buyer.name, ...linesOf(buyer.billingAddress), ...(buyer.registrationNumber === null ? [] : [`${label.registration} ${buyer.registrationNumber}`])],
    facts,
    columns: [...label.columns],
    lines: input.lines.map((line) => [line.description, line.serviceDate === null ? "" : date(line.serviceDate), String(line.quantity), amount(line.unitPriceMinor), `${line.vatPercent} %`, amount(line.netMinor)]),
    vat: vatByRate,
    totals: [
      [label.subtotal, amount(input.netMinor)],
      [label.vat, amount(input.vatMinor)],
      [label.total(input.currency), amount(input.grossMinor)],
    ],
    payment: isInvoice ? [label.payBy(date(input.dueOn)), ...(bank === "" ? [] : [bank])] : [],
    fikLine: card,
  }
  return encoded(document)
}

/** The document with every string WinAnsi. */
function encoded(document: InvoiceDocument): InvoiceDocument {
  const pair = ([a, b]: [string, string]): [string, string] => [winAnsi(a), winAnsi(b)]
  return {
    title: winAnsi(document.title),
    label: winAnsi(document.label),
    issuedOn: document.issuedOn,
    seller: document.seller.map(winAnsi),
    buyer: document.buyer.map(winAnsi),
    facts: document.facts.map(pair),
    columns: document.columns.map(winAnsi),
    lines: document.lines.map((row) => row.map(winAnsi)),
    vat: document.vat.map(pair),
    totals: document.totals.map(pair),
    payment: document.payment.map(winAnsi),
    fikLine: document.fikLine === null ? null : winAnsi(document.fikLine),
  }
}

// How an invoice is paid (#291 slice 4, #292 C4): when it is due and the
// reference the payer quotes. Pure, so the billing run (packages/db) and the
// invoice document (#292 C5) read one spelling.
//
// The terms are the customer's own where it has them, else its project's —
// thirty days on a project nobody has set, `DEFAULT_PAYMENT_TERMS_DAYS`, which
// the column defaults to — and the due day is that many calendar days after
// the issue day. A credit note is due on issue, and carries no reference.
//
// A payment reference is the document's number under the project's scheme
// (`PAYMENT_REFERENCE_SCHEMES`), frozen on the invoice at issue: for a Danish
// FI card, FIK 71 fifteen digits and FIK 75 sixteen, the number zero-padded and
// the modulus-10 check digit last — the digits weighted 2 and 1 from the
// right, each product's digits summed, the check digit what makes the sum a
// multiple of ten. The number is the company's one series (`invoice_number_key`),
// so two projects' invoices never share a reference under one creditor. The
// FIK line the document prints, `+71<reference+creditor<`, is built from the
// frozen reference and the company's creditor number at print time.
import { addDays } from "../route-schemes/recurrence"
import type { PaymentReferenceScheme } from "./vocabulary"

/** A new project's terms: due thirty days after issue, the column's default. */
export const DEFAULT_PAYMENT_TERMS_DAYS = 30

/** The longest terms a project or a customer may set. */
export const PAYMENT_TERMS_MAX = 365

/** The terms an invoice is issued under: the customer's own where it has them, else its project's. */
export const termsOf = (customerTerms: number | null, projectTerms: number): number => customerTerms ?? projectTerms

/** The day an invoice issued on a day is due under its terms. */
export const dueOn = (issuedOn: string, termsDays: number): string => addDays(issuedOn, termsDays)

// The invoice identity's shapes, spelled once for the company table's CHECKs
// and the contracts' refinements (the public slug's precedent,
// access/public-slug.ts): anchored patterns that Postgres's `~` and
// JavaScript read alike, the code upper case and without the spaces a person
// types for reading.

/** A VAT registration: its country's two letters, then its number. */
export const VAT_NUMBER_PATTERN = "^[A-Z]{2}[0-9A-Z]{2,13}$"

/** An IBAN: the country, the two check digits, then the account, 15 to 34 characters in all. */
export const IBAN_PATTERN = "^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$"

/** A BIC: the bank, the country, the location, and an optional branch. */
export const BIC_PATTERN = "^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$"

/** A FIK creditor number: eight digits. */
export const FIK_CREDITOR_PATTERN = "^[0-9]{8}$"

/** A frozen payment reference: FIK 71's fifteen digits or FIK 75's sixteen. */
export const PAYMENT_REFERENCE_PATTERN = "^[0-9]{15,16}$"

/** The digits a scheme's reference holds, its check digit included. */
const REFERENCE_LENGTH: Readonly<Record<Exclude<PaymentReferenceScheme, "none">, number>> = { "fik-71": 15, "fik-75": 16 }

/** The card type a FIK scheme prints. */
const CARD_TYPE: Readonly<Record<Exclude<PaymentReferenceScheme, "none">, string>> = { "fik-71": "71", "fik-75": "75" }

/** The modulus-10 check digit of a run of digits: weighted 2 and 1 from the right, each product's digits summed. */
export function modulus10(digits: string): number {
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index])
    const weighted = index % 2 === 0 ? digit * 2 : digit
    sum += weighted > 9 ? weighted - 9 : weighted
  }
  return (10 - (sum % 10)) % 10
}

/** A document's payment reference under its project's scheme, or null under none. */
export function paymentReference(scheme: PaymentReferenceScheme, documentNumber: number): string | null {
  if (scheme === "none") return null
  if (!Number.isSafeInteger(documentNumber) || documentNumber < 0) throw new Error(`paymentReference: ${documentNumber} is not a whole number of a document`)
  const body = REFERENCE_LENGTH[scheme] - 1
  const digits = String(documentNumber)
  if (digits.length > body) throw new Error(`paymentReference: ${documentNumber} has more digits than ${scheme}'s ${body}`)
  const padded = digits.padStart(body, "0")
  return `${padded}${modulus10(padded)}`
}

/** The FIK line a document prints: the card's type, the reference and the creditor's number; null under none. */
export function fikLine(scheme: PaymentReferenceScheme, reference: string | null, creditorNumber: string): string | null {
  if (scheme === "none" || reference === null) return null
  return `+${CARD_TYPE[scheme]}<${reference}+${creditorNumber}<`
}

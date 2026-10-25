// Settings › Finance & invoicing on the Pilot (#291 C4): the company's invoice
// identity — the VAT number, the bank account and the FIK creditor number an
// invoice document prints — and the payment terms a project or a customer
// gives its invoices. Each field is judged by the domain's own pattern
// (`@waste/domain/finance/payment`), the one the database's checks and the
// contracts read, so a value refused here is one the API would refuse.
import { BIC_PATTERN, FIK_CREDITOR_PATTERN, IBAN_PATTERN, PAYMENT_TERMS_MAX, VAT_NUMBER_PATTERN } from "@waste/domain/finance/payment"
import type { PaymentReferenceScheme } from "@waste/domain/finance/vocabulary"

export type CompanyIdentityKey = "vatNumber" | "bankIban" | "bankBic" | "fikCreditorNumber"

/** The company's identity fields, in the order the pane shows them: the wire's key, the fact a record shows it under, and the domain's pattern. */
export const COMPANY_IDENTITY_FIELDS: readonly { key: CompanyIdentityKey; label: string; fact: string; pattern: string; example: string; shape: string }[] = [
  { key: "vatNumber", label: "VAT number", fact: "VAT number", pattern: VAT_NUMBER_PATTERN, example: "DK12345678", shape: "A VAT number starts with its country's two letters" },
  { key: "bankIban", label: "IBAN", fact: "IBAN", pattern: IBAN_PATTERN, example: "DK5000400440116243", shape: "An IBAN is its country's two letters, two check digits and the account" },
  { key: "bankBic", label: "BIC", fact: "BIC", pattern: BIC_PATTERN, example: "DABADKKK", shape: "A BIC is 8 or 11 letters and digits" },
  { key: "fikCreditorNumber", label: "FIK creditor number", fact: "FIK creditor", pattern: FIK_CREDITOR_PATTERN, example: "85123456", shape: "A FIK creditor number is 8 digits" },
]

/** A code as the wire spells it: the spaces a person groups it by gone, upper case; a blank one is none. */
export function identityValueOf(text: string): string | null {
  const value = text.replace(/\s+/g, "").toUpperCase()
  return value === "" ? null : value
}

/** The sentence refusing what was typed into an identity field, or null when the API would take it. */
export function identityRefusalOf(key: CompanyIdentityKey, text: string): string | null {
  const value = identityValueOf(text)
  const field = COMPANY_IDENTITY_FIELDS.find((candidate) => candidate.key === key)
  if (value === null || field === undefined || new RegExp(field.pattern).test(value)) return null
  return `${field.shape}, as ${field.example}`
}

export const PAYMENT_TERMS_REFUSAL = `Payment terms are a whole number of days from 0 to ${PAYMENT_TERMS_MAX}`

/** The sentence refusing terms typed as days, or null for a whole number from 0 to `PAYMENT_TERMS_MAX`. */
export function paymentTermsRefusalOf(text: string): string | null {
  const trimmed = text.trim()
  return /^\d+$/.test(trimmed) && Number(trimmed) <= PAYMENT_TERMS_MAX ? null : PAYMENT_TERMS_REFUSAL
}

/** Terms as a person reads them; a customer with none of its own pays by its project's. */
export function paymentTermsLabel(days: number | null): string {
  if (days === null) return "The project's"
  if (days === 0) return "Due on issue"
  return days === 1 ? "1 day" : `${days} days`
}

const SCHEME_LABELS: Readonly<Record<PaymentReferenceScheme, string>> = { none: "None", "fik-71": "FIK 71", "fik-75": "FIK 75" }

/** A payment reference scheme as the pane and a project's facts name it. */
export const paymentReferenceSchemeLabel = (scheme: PaymentReferenceScheme): string => SCHEME_LABELS[scheme]

/** Whether a project's hires and work-order jobs wait for a person before a run invoices them (M14 of #293), as its facts and the pane name it. */
export const holdForReviewLabel = (held: boolean): string => (held ? "Held for review" : "Billed as charged")

// A numbered document as a person reads it: the number the database keeps in
// its company's unbroken series, under the series' prefix — a route `RC-1042`,
// a ticket `T-8831`, an invoice `INV-26007188` and a credit note
// `CN-26007189` (one series, the prefix telling the kinds apart), a scale
// ticket `ST-12`. The prefix is presentation, never stored, so a series is
// renamed here alone; a label read back — a bank line naming an invoice — is
// parsed by the same table.
import { WHOLE_NUMBER_PATTERN } from "./requests"

/** Each numbered document's prefix. */
export const NUMBER_PREFIXES = {
  route: "RC-",
  ticket: "T-",
  invoice: "INV-",
  "credit-note": "CN-",
  "scale-ticket": "ST-",
} as const

export type NumberedDocument = keyof typeof NUMBER_PREFIXES

/** The label a document is named by, from the number its series gave it. */
export const numberLabel = (document: NumberedDocument, number: number): string => `${NUMBER_PREFIXES[document]}${number}`

/** The number a label names under a document's prefix, or null where it is another document's or no number at all. */
export function numberOf(document: NumberedDocument, label: string): number | null {
  const prefix = NUMBER_PREFIXES[document]
  if (!label.startsWith(prefix)) return null
  const digits = label.slice(prefix.length)
  return new RegExp(WHOLE_NUMBER_PATTERN).test(digits) ? Number(digits) : null
}

/** A route's label: `RC-1042`. */
export const routeLabel = (number: number): string => numberLabel("route", number)

/** A ticket's label: `T-8831`. */
export const ticketLabel = (number: number): string => numberLabel("ticket", number)

/** An invoice's or a credit note's label, by the kind the row carries: `INV-26007188`, `CN-26007189`. */
export const invoiceLabel = (kind: "invoice" | "credit-note", number: number): string => numberLabel(kind, number)

/** A scale ticket's label: `ST-12`. */
export const scaleTicketLabel = (number: number): string => numberLabel("scale-ticket", number)

// What an issued document reads as on the wire (#112): its label is its
// number under its kind's prefix (../numbering), its gross is its net and its
// VAT, and each of its lines charges for one event or credits one line; and
// a partial credit names each line once, by one quantity.
import { eachOnceSentence } from "../requests"

/** What a document whose label is not its number under its kind's prefix is told. */
export const LABEL_IS_THE_NUMBER = "label is the number under the prefix of its kind"

/** What a document whose gross is not its net and its VAT is told. */
export const GROSS_IS_NET_PLUS_VAT = "grossMinor is netMinor and vatMinor together"

export const totalsAgree = (value: { netMinor: number; vatMinor: number; grossMinor: number }): boolean => value.grossMinor === value.netMinor + value.vatMinor

/** What a line charging for an event and crediting a line, or doing neither, is told. */
export const ONE_SOURCE = "A line charges for one billable event or credits one line"

export const oneSource = (line: { billableEventId: string | null; creditsLineId: string | null }): boolean => (line.billableEventId !== null) !== (line.creditsLineId !== null)

/** The most lines a partial credit may name: an invoice's lines, not an import. */
export const CREDIT_LINES_MAX = 500

/** What a partial credit naming a line twice is told. */
export const EACH_LINE_ONCE = eachOnceSentence("line", "a line is credited by one quantity in one credit note")

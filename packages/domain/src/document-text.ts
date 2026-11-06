// The text a printed document carries — an invoice's, a credit note's, a
// waste transfer note's — in its project's language, Danish for a Danish
// project and English for any other. A day is spelled from tables rather than
// through the runtime's Intl, whose tables move with Node's ICU, so the same
// rows give the same document on any runtime; and every string is WinAnsi,
// the encoding the PDF standard fonts print, a character outside it marked
// `?` rather than dropped.
import { MONTH_LABELS } from "./days"

export type DocumentLanguage = "da" | "en"

/** The document's language for a project's BCP 47 tag: Danish for `da` and its regions, English otherwise. */
export const documentLanguageOf = (tag: string): DocumentLanguage => (tag.split("-")[0]?.toLowerCase() === "da" ? "da" : "en")

/** A calendar day (`2026-10-13`) as the language writes it: `13.10.2026`, `13 October 2026`. */
export function documentDate(day: string, language: DocumentLanguage): string {
  const [year, month, date] = day.split("-")
  if (language === "da") return `${date}.${month}.${year}`
  return `${Number(date)} ${MONTH_LABELS[Number(month) - 1]} ${year}`
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

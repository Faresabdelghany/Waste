// A CSV file as the web writes one (#292, #291 slice 28 and #290 O12): the
// workspace's Export, the Dashboard's tonnage report and its scheme table.
// RFC 4180: fields separated by commas, records by CRLF, a field quoted when
// it holds a comma, a quote, a line break or leading or trailing space, a
// quote inside doubled. A field that starts with `=`, `+`, `-`, `@`, a tab or
// a carriage return is prefixed with an apostrophe, so a spreadsheet opening
// the file reads it as text and never as a formula — a record's name is
// typed by people, and a cell that runs on opening is the file attacking its
// reader (OWASP's CSV injection). A number is written as it is, so a
// negative amount stays a number. The file starts with a byte-order mark,
// which is how Excel knows the bytes are UTF-8 and shows "Østerbro" rather
// than mojibake.
//
// Building the text is pure and tested; `downloadBlob` is the one browser
// call, a Blob behind a temporary link, which `downloadCsv` hands a text and
// a file the API wrote (the waste-data report's) hands its bytes.

/** A cell: text as it is shown, a number as it is counted, nothing as an empty field. */
export type CsvCell = string | number | null | undefined

/** The characters a spreadsheet starts a formula with. */
const FORMULA_START = /^[=+\-@\t\r]/

/** What makes a field need quotes. */
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/

/** One field, escaped. */
export function csvField(cell: CsvCell): string {
  if (cell === null || cell === undefined) return ""
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : ""
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The byte-order mark that tells a spreadsheet the file is UTF-8. */
export const CSV_BOM = "﻿"

/** A header and its rows as one CSV text, CRLF between records and after the last, the byte-order mark first. */
export function csvOf(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return CSV_BOM + [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n"
}

/** A file name a download can carry: lowercase words joined by hyphens, `.csv` on the end. */
export function csvFileName(...parts: readonly string[]): string {
  const stem = parts
    .join(" ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return `${stem || "export"}.csv`
}

/** How long the file's object URL outlives the click: a browser may start the download after the click returns, and a URL revoked first downloads nothing. */
const REVOKE_AFTER_MS = 30_000

/** Hands the browser a CSV text to save under `fileName`. */
export function downloadCsv(fileName: string, text: string): void {
  downloadBlob(fileName, new Blob([text], { type: "text/csv;charset=utf-8" }))
}

/** Hands the browser a file to save under `fileName`, its bytes as they are. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}

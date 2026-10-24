// A CSV file read into an import's rows (#291 slice 12), the browser's side
// of the upload: RFC 4180 — fields separated by commas or, as a Danish
// spreadsheet saves them, semicolons (whichever the header row holds more
// of), records by CRLF, LF or CR, a field in double quotes holding commas,
// line breaks and doubled quotes — and the UTF-8 byte-order mark a
// spreadsheet writes first, dropped. A record's number is a spreadsheet's
// row number: the header is row 1 and the first record row 2, so a sentence
// about row 14 is about the row a person sees as 14. A record that holds
// nothing but empty fields is skipped, as the empty line at a file's end is.
// A quoted field that never closes runs to the end of the file, and the row
// it opened on is said, since every row after it has been swallowed into it.
//
// `importRows` turns the records into the rows an import sends: each keyed by
// its kind's column (`columnOf`, so the header's spelling does not matter),
// each cell trimmed, an empty one left out — and a cell an export wrote
// behind an apostrophe, so a spreadsheet would not run it as a formula, read
// without it — with what the header row says about the columns beside them. `importTemplate` is the other way: a kind's
// header row as a file a spreadsheet opens, which the reader reads back.

import { columnOf, headerIssues, IMPORT_COLUMNS } from "./columns"
import type { ImportKind } from "./vocabulary"

/** One record of a file, by its spreadsheet row number. */
export type CsvRecord = { row: number; fields: string[] }

/** The separator a file uses: a comma unless its first line holds more semicolons outside its quoted fields, as a spreadsheet saved under a Danish locale writes. */
export function separatorOf(text: string): "," | ";" {
  const firstLine = (text.replace(/^﻿/, "").split(/\r\n|\n|\r/, 1)[0] ?? "").replace(/"[^"]*"/g, "")
  const count = (char: string) => firstLine.split(char).length - 1
  return count(";") > count(",") ? ";" : ","
}

/** The records of a CSV text, the header first, each with its spreadsheet row number. */
export function csvRecords(text: string): CsvRecord[] {
  return readCsv(text).records
}

/** The records, and the row a quoted field opened on that never closed; null when every quote closed. */
function readCsv(text: string): { records: CsvRecord[]; unclosedQuote: number | null } {
  const body = text.replace(/^﻿/, "")
  const separator = separatorOf(body)
  const records: CsvRecord[] = []
  let fields: string[] = []
  let field = ""
  let quoted = false
  let row = 1
  let quotedOn = 1
  const endRecord = () => {
    fields.push(field)
    if (fields.some((value) => value.trim() !== "")) records.push({ row, fields })
    fields = []
    field = ""
    row += 1
  }
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field.trim() === "") {
      quoted = true
      quotedOn = row
      field = ""
    } else if (char === separator) {
      fields.push(field)
      field = ""
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && body[index + 1] === "\n") index += 1
      endRecord()
    } else field += char
  }
  if (field !== "" || fields.length > 0) endRecord()
  return { records, unclosedQuote: quoted ? quotedOn : null }
}

/** One row as an import sends it: its spreadsheet row number and its non-empty cells by column header. */
export type ImportRow = { row: number; values: Record<string, string> }

/** A file read for one kind of import: its rows, and what its header row and its quotes say about it. */
export type ImportFile = {
  rows: ImportRow[]
  /** Headers the kind does not know, required columns the file lacks, columns it names twice, and the row a quoted field opened on that never closed. */
  issues: { unknown: string[]; missing: string[]; repeated: string[]; unclosedQuote: number | null }
}

/** The apostrophe an export writes before a cell a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, a tab or a carriage return). */
const FORMULA_GUARD = /^'(?=[=+\-@\t\r])/

/** The rows of a CSV text for one kind of import, every cell trimmed and an empty one left out, keyed by the kind's own column headers. */
export function importRows(kind: ImportKind, text: string): ImportFile {
  const { records: [header, ...records], unclosedQuote } = readCsv(text)
  if (header === undefined) return { rows: [], issues: { ...headerIssues(kind, []), unclosedQuote } }
  const columns = header.fields.map((name) => columnOf(kind, name)?.header)
  const rows = records.map((record) => {
    const values: Record<string, string> = {}
    record.fields.forEach((value, index) => {
      const column = columns[index]
      const trimmed = value.trim().replace(FORMULA_GUARD, "")
      if (column !== undefined && trimmed !== "") values[column] = trimmed
    })
    return { row: record.row, values }
  })
  return { rows, issues: { ...headerIssues(kind, header.fields), unclosedQuote } }
}

/** A field as a CSV writes it: in double quotes, its quotes doubled, when it holds the separator, a quote or a line break. */
export function csvField(value: string, separator: "," | ";"): string {
  return value.includes(separator) || /["\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * A kind's template: its header row and nothing else, behind the byte-order
 * mark that tells a spreadsheet the file is UTF-8, and a CRLF as RFC 4180
 * ends a record. The separator is the caller's: a spreadsheet under a Danish
 * locale opens a file of semicolons into columns, and one of commas into one.
 */
export function importTemplate(kind: ImportKind, separator: "," | ";" = ","): string {
  return `\uFEFF${IMPORT_COLUMNS[kind].map((column) => csvField(column.header, separator)).join(separator)}\r\n`
}

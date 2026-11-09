// The CSV import's closed lists (#291 slice 12, row 20.1): what a file can
// import and what became of each of its rows. The database reads each tuple
// into its CHECK and the contracts into a `z.enum`, so a value is added in
// one place, as every context's vocabulary is.
//
// A kind names the records a file holds, one import of one kind at a time:
// the company's Customers, a project's Properties with their parties, a
// project's containers, a project's Agreements with their Subscriptions, and
// the company's catalogue — its waste fractions, container types and vehicle
// types with the container types each services (O30 of #290, row 1.18) — and
// a project's fleet, its vehicles with their compartments and its drivers.
// `COMPANY_IMPORT_KINDS` are the company's and name no project; every other
// kind is a project's.
// A row's outcome is what the import did with it: made a record, changed one
// it matched, found one it matched with nothing to change, or refused it with
// the API's own sentence.
//
// The limits are here too, since the browser reads a file against them
// before it sends a row and the contracts hold a request to them. A file is
// at most `IMPORT_ROWS_MAX` rows, and it travels `IMPORT_BATCH_MAX` rows to
// a request — previewed and committed alike — because each row is written in
// a savepoint of the request's one transaction, and Postgres keeps the
// subtransactions of one transaction in a cache of 64 before every other
// session's snapshot has to look them up on disk; a request of 50 rows also
// gives its connection back to the pool's next request within a second or
// two.
import { INT4_MAX } from "../requests"
import { PARAGRAPH_MAX } from "../text"

export const IMPORT_KINDS = ["customers", "properties", "containers", "agreements", "waste-fractions", "container-types", "vehicle-types", "vehicles", "drivers", "collection-calendars", "planning-areas"] as const

export const IMPORT_ROW_OUTCOMES = ["created", "updated", "unchanged", "refused"] as const

/** Where a run stands: still recording its rows, or every row recorded. A reading of its counts, never a column. */
export const IMPORT_RUN_STATUSES = ["running", "completed"] as const

/** The separators a file is written with, by name: a comma, or a semicolon for a spreadsheet under a Danish locale, which opens a file of commas into one column. */
export const CSV_SEPARATORS = ["comma", "semicolon"] as const

/** The most rows one request previews or commits: below the 64 subtransactions Postgres caches per transaction, one savepoint per row. */
export const IMPORT_BATCH_MAX = 50

/** The most rows one file holds: what a run may be said to hold. */
export const IMPORT_ROWS_MAX = 10_000

/** The longest boundary a planning-area row may carry, as the GeoJSON of its polygon: some thousands of vertices, where every other cell is a paragraph's length. */
export const IMPORT_BOUNDARY_MAX = 100_000

/** The first row a file's records start on: the header is row 1. */
export const IMPORT_FIRST_ROW = 2

/** The largest spreadsheet row number a row may carry: the database's integer. */
export const IMPORT_ROW_NUMBER_MAX = INT4_MAX

/** The longest cell a row may hold: a paragraph's length. */
export const IMPORT_CELL_MAX = PARAGRAPH_MAX

export type ImportKind = (typeof IMPORT_KINDS)[number]

/** The kinds whose records are the company's, so whose import names no project. A value of `IMPORT_KINDS`, not a vocabulary. */
export const COMPANY_IMPORT_KINDS = ["customers", "waste-fractions", "container-types", "vehicle-types"] as const satisfies readonly ImportKind[]

/** Whether a kind's records are the company's and its import names no project. */
export const isCompanyImportKind = (kind: ImportKind): boolean => (COMPANY_IMPORT_KINDS as readonly ImportKind[]).includes(kind)
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number]
export type ImportRunStatus = (typeof IMPORT_RUN_STATUSES)[number]
export type CsvSeparator = (typeof CSV_SEPARATORS)[number]

/** Every list of this module by its name, for a test that walks them. */
export const IMPORT_VOCABULARIES = {
  IMPORT_KINDS,
  IMPORT_ROW_OUTCOMES,
  IMPORT_RUN_STATUSES,
  CSV_SEPARATORS,
} as const satisfies Record<string, readonly [string, ...string[]]>

// The CSV import's closed lists (#291 slice 12, row 20.1): what a file can
// import and what became of each of its rows. The database reads each tuple
// into its CHECK and the contracts into a `z.enum`, so a value is added in
// one place, as every context's vocabulary is.
//
// A kind names the records a file holds, one import of one kind at a time:
// the company's Customers, a project's Properties with their parties, a
// project's containers, a project's Agreements with their Subscriptions, and
// the company's catalogue — its waste fractions, container types and vehicle
// types with the container types each services (O30 of #290, row 1.18).
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

/** What a file imports. */
export const IMPORT_KINDS = ["customers", "properties", "containers", "agreements", "waste-fractions", "container-types", "vehicle-types"] as const

/** What became of one row. */
export const IMPORT_ROW_OUTCOMES = ["created", "updated", "unchanged", "refused"] as const

/** The most rows one request previews or commits: below the 64 subtransactions Postgres caches per transaction, one savepoint per row. */
export const IMPORT_BATCH_MAX = 50

/** The most rows one file holds: what a run may be said to hold. */
export const IMPORT_ROWS_MAX = 10_000

/** The largest spreadsheet row number a row may carry: the database's integer. */
export const IMPORT_ROW_NUMBER_MAX = 2_147_483_647

export type ImportKind = (typeof IMPORT_KINDS)[number]

/** The kinds whose records are the company's, so whose import names no project. A value of `IMPORT_KINDS`, not a vocabulary. */
export const COMPANY_IMPORT_KINDS = ["customers", "waste-fractions", "container-types", "vehicle-types"] as const satisfies readonly ImportKind[]

/** Whether a kind's records are the company's and its import names no project. */
export const isCompanyImportKind = (kind: ImportKind): boolean => (COMPANY_IMPORT_KINDS as readonly ImportKind[]).includes(kind)
export type ImportRowOutcome = (typeof IMPORT_ROW_OUTCOMES)[number]

/** Every list of this module by its name, for a test that walks them. */
export const IMPORT_VOCABULARIES = {
  IMPORT_KINDS,
  IMPORT_ROW_OUTCOMES,
} as const satisfies Record<string, readonly [string, ...string[]]>

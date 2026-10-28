// The CSV import on the wire (#291 slice 12, row 20.1): the company's
// Customers, a project's Properties with their parties, a project's
// containers, a project's Agreements with their Subscriptions, and the
// company's catalogue — waste fractions, container types and vehicle types
// (O30 of #290, row 1.18) — from a file the browser has read into rows
// (@waste/domain/imports/csv).
//
// An import is a preview first and a commit after:
//
//   POST /imports/preview  — a dry run of one batch: every row read, matched
//                            on its key and written exactly as the commit
//                            would write it, each in its own savepoint, and
//                            the whole rolled back. It answers each row's
//                            outcome — created, updated, unchanged or
//                            refused, the refusal in the API's own sentence
//                            — and stores nothing. A file is previewed a
//                            batch at a time, as it is committed.
//   POST /imports          — the run: the kind, the project, the file's name
//                            and how many rows it holds, a record of its own.
//   POST /imports/:id/rows — one batch of the run's rows, written in one
//                            transaction, each row in its own savepoint, its
//                            outcome appended to the run's ledger; a row the
//                            run has already recorded is answered as it was
//                            and not written again, so a batch sent twice
//                            writes nothing twice.
//
// A row is its spreadsheet row number and its non-empty cells by column
// header (@waste/domain/imports/columns); what it is written as is the
// family's own create or patch body, checked by the family's own schema, so
// a refusal says what a form's would. Rows name other records by the keys a
// person knows them by, never by id. The limits are the domain's
// (@waste/domain/imports/vocabulary), which the browser reads a file
// against before it sends a row.
import { IMPORT_BATCH_MAX, IMPORT_KINDS, IMPORT_ROW_NUMBER_MAX, IMPORT_ROW_OUTCOMES, IMPORT_ROWS_MAX, isCompanyImportKind } from "@waste/domain/imports/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { NonNegativeInt, PositiveInt, stamped } from "./resource"
import { Label } from "./text"

export const ImportKind = z.enum(IMPORT_KINDS)
export type ImportKind = z.infer<typeof ImportKind>

export const ImportRowOutcome = z.enum(IMPORT_ROW_OUTCOMES)
export type ImportRowOutcome = z.infer<typeof ImportRowOutcome>

/** The longest cell a row may hold: a paragraph's length. */
export const IMPORT_CELL_MAX = 2000

/** The kinds whose records are a project's, and so whose import names a project: every kind but the company's (@waste/domain/imports/vocabulary). */
export const PROJECT_IMPORT_KINDS: readonly ImportKind[] = IMPORT_KINDS.filter((kind) => !isCompanyImportKind(kind))

export const PROJECT_REQUIRED = "This kind of record is a project's: name the project the file is imported into"
export const PROJECT_REFUSED = "These records are the company's, not a project's: an import of them names no project"

/** A kind's import names a project exactly when its records are a project's: the sentence at `projectId` where it does not. */
export function projectIssue(body: { kind: ImportKind; projectId?: string }): string | undefined {
  const fits = PROJECT_IMPORT_KINDS.includes(body.kind) === (body.projectId !== undefined)
  return fits ? undefined : body.projectId === undefined ? PROJECT_REQUIRED : PROJECT_REFUSED
}
const projectFits = (body: { kind: ImportKind; projectId?: string }, context: z.RefinementCtx) => {
  const message = projectIssue(body)
  if (message !== undefined) context.addIssue({ code: "custom", message, path: ["projectId"] })
}

/** One row of a file: its spreadsheet row number (the header is row 1) and its non-empty cells by column header. */
export const ImportRowValues = z.strictObject({
  row: z.int().min(2).max(IMPORT_ROW_NUMBER_MAX),
  values: z.record(z.string().min(1).max(200), z.string().max(IMPORT_CELL_MAX)),
})
export type ImportRowValues = z.infer<typeof ImportRowValues>

/** Each row number once in one request. */
const rowsOnce = (rows: readonly { row: number }[]) => new Set(rows.map((row) => row.row)).size === rows.length
const rowsOnceIssue = { message: "Give each row once: a row number names one row of the file", path: ["rows"] }

/** `POST /imports/preview`: what would become of one batch of rows. */
export const ImportPreviewRequest = z
  .strictObject({
    kind: ImportKind,
    projectId: Id.optional(),
    fileName: Label,
    rows: z.array(ImportRowValues).min(1).max(IMPORT_BATCH_MAX),
  })
  .superRefine(projectFits)
  .refine((body) => rowsOnce(body.rows), rowsOnceIssue)
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>

/** What became, or would become, of one row. */
export const ImportRowResult = z.object({
  row: z.int().min(2),
  outcome: ImportRowOutcome,
  /** What the row was matched on, as a person reads it: `registration number 12345678`, `address Parkvej 18`. */
  key: z.string().nullable(),
  /** The record the row made or matched; null on a refusal. */
  resourceId: Id.nullable(),
  /** The refusal's sentence, the column it names first; null otherwise. */
  detail: z.string().nullable(),
})
export type ImportRowResult = z.infer<typeof ImportRowResult>

/** How many rows came out each way. */
export const ImportCounts = z.object({ created: NonNegativeInt, updated: NonNegativeInt, unchanged: NonNegativeInt, refused: NonNegativeInt })
export type ImportCounts = z.infer<typeof ImportCounts>

/** `POST /imports/preview`'s answer: each row's outcome as the commit would have it, and the counts. Nothing was stored. */
export const ImportPreview = z.object({
  kind: ImportKind,
  rows: z.array(ImportRowResult),
  counts: ImportCounts,
})
export type ImportPreview = z.infer<typeof ImportPreview>

/** `POST /imports`: the run a commit's batches belong to. */
export const ImportRunCreate = z
  .strictObject({
    kind: ImportKind,
    projectId: Id.optional(),
    fileName: Label,
    /** How many rows the file holds; the run is complete when it has recorded that many. */
    rowCount: PositiveInt.max(IMPORT_ROWS_MAX),
  })
  .superRefine(projectFits)
export type ImportRunCreate = z.infer<typeof ImportRunCreate>

/** Where a run stands: still recording its rows, or every row recorded. A reading of its counts, never a column. */
export const ImportRunStatus = z.enum(["running", "completed"])
export type ImportRunStatus = z.infer<typeof ImportRunStatus>

/** One import run. */
export const ImportRun = z.object({
  ...stamped,
  kind: ImportKind,
  /** Null for the company's Customers. */
  projectId: Id.nullable(),
  fileName: Label,
  rowCount: PositiveInt,
  counts: ImportCounts,
  status: ImportRunStatus,
  /** Who ran it. */
  requestedBy: Id,
})
export type ImportRun = z.infer<typeof ImportRun>

/** `POST /imports/:id/rows`: one batch of the run's rows. */
export const ImportBatch = z
  .strictObject({
    rows: z.array(ImportRowValues).min(1).max(IMPORT_BATCH_MAX),
  })
  .refine((body) => rowsOnce(body.rows), rowsOnceIssue)
export type ImportBatch = z.infer<typeof ImportBatch>

/** What one batch did: each row's outcome, a row the run had already recorded answered as recorded, and the run as it now stands. */
export const ImportBatchResult = z.object({
  rows: z.array(ImportRowResult),
  run: ImportRun,
})
export type ImportBatchResult = z.infer<typeof ImportBatchResult>

/** One row a run recorded: its outcome and when. */
export const ImportRunRow = ImportRowResult.extend({ id: Id, recordedAt: IsoDateTime })
export type ImportRunRow = z.infer<typeof ImportRunRow>

/** A page of runs: one kind's, or one project's. */
export const ImportRunListQuery = PageRequest.extend({
  kind: ImportKind.optional(),
  projectId: Id.optional(),
})
export type ImportRunListQuery = z.infer<typeof ImportRunListQuery>

/** A page of one run's rows: every outcome, or one. */
export const ImportRunRowListQuery = PageRequest.extend({
  outcome: ImportRowOutcome.optional(),
})
export type ImportRunRowListQuery = z.infer<typeof ImportRunRowListQuery>

/** `GET /imports/templates/:kind`'s path. */
export const ImportKindParam = z.object({ kind: ImportKind })

/** The separators a template is written with: a comma, or a semicolon for a spreadsheet under a Danish locale, which opens a file of commas into one column. */
export const IMPORT_TEMPLATE_SEPARATORS = ["comma", "semicolon"] as const

/** `GET /imports/templates/:kind`'s query. */
export const ImportTemplateQuery = z.object({
  separator: z.enum(IMPORT_TEMPLATE_SEPARATORS).default("comma"),
})
export type ImportTemplateQuery = z.infer<typeof ImportTemplateQuery>

// The CSV import (#291 slice 12, row 20.1): the company's Customers, a
// project's Properties with their parties, its containers and its
// Agreements with their Subscriptions, from a file the browser has read into
// rows (@waste/domain/imports/csv). The wire is @waste/contracts/imports.
//
// `GET /imports/templates/:kind` is a kind's header row as a CSV file.
// `POST /imports/preview` is the dry run of one batch: every row written as
// the commit would write it, each in its own savepoint and all of them
// inside one more that is rolled back, so the batch's rows see each other —
// a second row naming the agreement the first made matches it — and nothing
// is stored. `POST /imports` makes the run a commit's batches belong to, and
// `POST /imports/:id/rows` writes one batch in the request's one
// transaction, each row in its own savepoint, appending each row's outcome
// to the run's ledger and moving its counts in that same transaction. The
// client sends a file's batches one after another, to the preview and to the
// run alike; the run is complete when its counts reach the rows it was said
// to hold. A batch is at most `IMPORT_BATCH_MAX` rows
// (@waste/domain/imports/vocabulary), fewer than the 64 subtransactions
// Postgres caches for one transaction, and short enough to give its
// connection back to the pool within a second or two.
//
// A batch is safe to send again: the run is locked first, and a row the run
// has already recorded is answered as recorded and not written twice, so a
// batch whose answer was lost is sent again whole. A batch that would record
// more rows than the run holds is a 409 naming the count. A run's ledger is
// what it did and is never rewritten, so a refused row is fixed in the file
// and the file imported again as a new run: the rows the first run wrote are
// matched and come back unchanged.
//
// What a row becomes is routes/import-rows.ts: the families' own writes,
// their own schemas and their own sentences. The grants are two: the
// import's own, `improve.imports` (`create` to preview or commit, `view` to
// read the runs), and the target module's — `view` for the request, since
// matching reads its records, then `create` or `edit` per row as the row
// makes or changes one.
//
// A run is read by a role that views both the import and the module its kind
// writes, since its ledger names the records it matched — a customer's CVR
// number, an e-mail — and a role that cannot read those cannot read them
// here; a run of another kind is a run that does not exist. A run of the
// company's Customers names no project; a project's run is fenced by its
// project like every project-scoped row.
//
// Every row a batch writes is in the audit log (#291 slice 9a) under the
// batch's request: its account, and its reason — the `Waste-Change-Reason`
// header where the request gives one, which the guard has set already, else
// the import's own, "CSV import <file>", set here through the same helper
// before any row is written. A preview's writes are rolled back, and their
// history with them.
import {
  ImportBatch,
  ImportBatchResult,
  ImportKindParam,
  ImportPreview,
  ImportPreviewRequest,
  ImportRun,
  ImportRunCreate,
  ImportRunListQuery,
  ImportRunRow,
  ImportRunRowListQuery,
  ImportTemplateQuery,
  type ImportCounts,
  type ImportKind,
  type ImportRowOutcome,
  type ImportRowResult,
  type ImportRowValues,
} from "@waste/contracts/imports"
import { Page } from "@waste/contracts/pagination"
import { CHANGE_REASON_HEADER } from "@waste/contracts/audit"
import { PARAGRAPH_MAX } from "@waste/contracts/text"
import type { Tx } from "@waste/db/client"
import { importRun, importRunRow } from "@waste/db/schema/imports"
import { actAs } from "@waste/db/tenant"
import { IMPORT_COLUMNS } from "@waste/domain/imports/columns"
import { importTemplate } from "@waste/domain/imports/csv"
import { IMPORT_KINDS } from "@waste/domain/imports/vocabulary"
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, TransactionRollbackError, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { changeReasonOf } from "../auth/audit"
import { allows, requireAllowed, requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { IMPORT_MODULES, importRow, type ImportContext } from "./import-rows"
import { created, describeCreated, describeJson, IdParam, lockRow, stampsOf } from "./shared"

const MODULE = "improve.imports"
const ImportRunPage = Page(ImportRun)
const ImportRunRowPage = Page(ImportRunRow)

const runColumns = {
  id: importRun.id,
  projectId: importRun.projectId,
  kind: importRun.kind,
  fileName: importRun.fileName,
  rowCount: importRun.rowCount,
  createdCount: importRun.createdCount,
  updatedCount: importRun.updatedCount,
  unchangedCount: importRun.unchangedCount,
  refusedCount: importRun.refusedCount,
  requestedBy: importRun.requestedBy,
  createdAt: importRun.createdAt,
  updatedAt: importRun.updatedAt,
}

type RunRow = Pick<typeof importRun.$inferSelect, keyof typeof runColumns>

/** The run on the wire: its counts as one object, and whether it is complete, which they say. `kind` is text with a CHECK in the database and an enum here. */
function runOf(row: RunRow): ImportRun {
  const counts: ImportCounts = { created: row.createdCount, updated: row.updatedCount, unchanged: row.unchangedCount, refused: row.refusedCount }
  const recorded = counts.created + counts.updated + counts.unchanged + counts.refused
  return {
    id: row.id,
    kind: row.kind as ImportKind,
    projectId: row.projectId,
    fileName: row.fileName,
    rowCount: row.rowCount,
    counts,
    status: recorded >= row.rowCount ? "completed" : "running",
    requestedBy: row.requestedBy,
    ...stampsOf(row),
  }
}

const rowColumns = {
  id: importRunRow.id,
  rowNumber: importRunRow.rowNumber,
  outcome: importRunRow.outcome,
  key: importRunRow.key,
  resourceId: importRunRow.resourceId,
  detail: importRunRow.detail,
  recordedAt: importRunRow.recordedAt,
}

type RowRow = Pick<typeof importRunRow.$inferSelect, keyof typeof rowColumns>

const resultOf = (row: RowRow): ImportRowResult => ({
  row: row.rowNumber,
  outcome: row.outcome as ImportRowOutcome,
  key: row.key,
  resourceId: row.resourceId,
  detail: row.detail,
})

const runRowOf = (row: RowRow): ImportRunRow => ({ id: row.id, ...resultOf(row), recordedAt: row.recordedAt.toISOString() })

/** The runs this caller reads: the company's Customers runs, and the runs of the projects they work in. */
const runScope = (principal: Principal): SQL | undefined =>
  and(
    eq(importRun.companyId, principal.companyId),
    or(isNull(importRun.projectId), inProjects(importRun.projectId, principal)),
    kindsIn(readableKinds(principal)),
  )

/** The kinds whose runs a caller reads: those whose module the caller views. */
const readableKinds = (principal: Principal): ImportKind[] => IMPORT_KINDS.filter((kind) => allows(principal.grants, IMPORT_MODULES[kind], "view"))

/** A run of one of these kinds; `false` when there are none, never an `in ()`. */
const kindsIn = (kinds: readonly ImportKind[]): SQL => (kinds.length === 0 ? sql`false` : inArray(importRun.kind, [...kinds]))

const noSuchRun = (id: string) => problem(404, { detail: `No import run ${id} in this company's imports this account reads` })

async function findRun(tx: Tx, principal: Principal, id: string): Promise<RunRow | undefined> {
  const [row] = await tx
    .select(runColumns)
    .from(importRun)
    .where(and(runScope(principal), eq(importRun.id, id)))
    .limit(1)
  return row
}

/** How many rows each way. */
function countsOf(results: readonly ImportRowResult[]): ImportCounts {
  const counts: ImportCounts = { created: 0, updated: 0, unchanged: 0, refused: 0 }
  for (const result of results) counts[result.outcome] += 1
  return counts
}

/** A row's cells name the kind's columns only: a cell under a header the kind does not know is the request's 400, at the cell. */
function requireColumns(kind: ImportKind, rows: readonly ImportRowValues[], path: string): void {
  const known = new Set(IMPORT_COLUMNS[kind].map((column) => column.header))
  const errors = rows.flatMap((row, index) =>
    Object.keys(row.values)
      .filter((header) => !known.has(header))
      .map((header) => ({ path: `${path}.${index}.values.${header}`, message: `Not a column of a ${kind} import; the columns are ${[...known].join(", ")}` })),
  )
  if (errors.length > 0) throw invalidRequest("body", errors)
}

/** The context the rows of one request are written in, once the project and the target module's `view` are the caller's. */
function contextFor(tx: Tx, principal: Principal, kind: ImportKind, projectId: string | null): ImportContext {
  requireAllowed(principal.grants, IMPORT_MODULES[kind], "view")
  return { tx, principal, projectId, memo: {} }
}

const TEMPLATE_SEPARATORS = { comma: ",", semicolon: ";" } as const

/** The reason an import's writes are recorded under when its request gives none, bounded as a reason is. */
export const importReason = (fileName: string): string => `CSV import ${fileName}`.slice(0, PARAGRAPH_MAX)

export function importRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/imports/templates/:kind",
      describeRoute({
        operationId: "getImportTemplate",
        summary: "A kind's CSV template",
        description:
          "The header row of one kind of import as a CSV file, UTF-8 with a byte-order mark so a spreadsheet opens it as such: the columns the import reads, in order, the required ones among them. `separator=semicolon` writes it for a spreadsheet under a Danish locale, which opens a file of commas into one column; the import reads either.",
        security: BEARER_SECURITY,
        responses: {
          200: { description: "The template, as an attachment.", content: { "text/csv": { schema: { type: "string" as const } } } },
          400: describeProblem("The path does not name a kind of import, or `separator` is neither `comma` nor `semicolon`."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `improve.imports`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", ImportKindParam),
      validate("query", ImportTemplateQuery),
      (c) => {
        const { kind } = c.req.valid("param")
        const { separator } = c.req.valid("query")
        return c.body(importTemplate(kind, TEMPLATE_SEPARATORS[separator]), 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${kind}-import-template.csv"`,
        })
      },
    )
    .post(
      "/imports/preview",
      describeRoute({
        operationId: "previewImport",
        summary: "What an import would do",
        description:
          "A dry run of one batch of rows of one kind, at most 50: each row matched on its key and written exactly as the commit would write it — the family's own schema, references and rules — each in its own savepoint, and the whole rolled back, so nothing is stored. A row sees the batch's rows before it, as it would in the commit; a file is previewed a batch at a time, as it is committed. Each row answers `created`, `updated`, `unchanged` or `refused`, a refusal with the sentence the commit would record, the column it names first. Customers are the company's and name no project; every other kind names the project the file is imported into. The grants are `create` on `improve.imports` and `view` on the module the kind writes; a row the commit would refuse for the caller's `create` or `edit` there is refused here too.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("Each row's outcome and the counts. Nothing was stored.", ImportPreview),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, gives a row number twice or holds more than 50 rows; a cell sits under a header the kind does not know; or the project is missing for a project's kind, given for Customers, or not one this account works in.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `improve.imports` or `view` on the module the kind writes."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ImportPreviewRequest),
      async (c) => {
        const { kind, projectId, rows } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId)
        const context = contextFor(tx, principal, kind, projectId ?? null)
        requireColumns(kind, rows, "rows")
        const results: ImportRowResult[] = []
        try {
          // The dry run: one savepoint around every row's own, rolled back once the last row has answered.
          await tx.transaction(async (dry) => {
            for (const row of rows) results.push(await importRow({ ...context, tx: dry }, kind, row))
            dry.rollback()
          })
        } catch (error) {
          if (!(error instanceof TransactionRollbackError)) throw error
        }
        return c.json({ kind, rows: results, counts: countsOf(results) } satisfies ImportPreview)
      },
    )
    .post(
      "/imports",
      describeRoute({
        operationId: "createImportRun",
        summary: "Start an import",
        description:
          "Makes the run a commit's batches belong to: the kind, the project for a project's kind (none for Customers), the file's name and how many rows it holds. It writes no row; `POST /imports/{id}/rows` does, a batch at a time. The run is complete when it has recorded as many rows as it was said to hold. The grants are `create` on `improve.imports` and `view` on the module the kind writes.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The run, with nothing recorded yet.", ImportRun),
          400: describeProblem("The body is missing a field or names a member the server owns, or the project is missing for a project's kind, given for Customers, or not one this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `improve.imports` or `view` on the module the kind writes."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ImportRunCreate),
      async (c) => {
        const { kind, projectId, fileName, rowCount } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId)
        requireAllowed(principal.grants, IMPORT_MODULES[kind], "view")
        const [row] = await tx
          .insert(importRun)
          .values({ id: newId(), companyId: principal.companyId, projectId: projectId ?? null, kind, fileName, rowCount, requestedBy: principal.user.id })
          .returning(runColumns)
        return created(c, "/imports", runOf(row))
      },
    )
    .get(
      "/imports",
      describeRoute({
        operationId: "listImportRuns",
        summary: "The imports run here",
        description:
          "One page of import runs, newest first: the company's Customers runs and the runs of the projects the caller works in, of the kinds whose module the caller views. `kind` narrows it to one kind, `projectId` to one of those projects; naming another is refused. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of runs, newest first.", ImportRunPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `kind` is not a kind of import, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `improve.imports`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ImportRunListQuery),
      async (c) => {
        const { limit, cursor, kind, projectId } = c.req.valid("query")
        // Newest first, so the next page is the runs below the cursor.
        const below = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(runColumns)
          .from(importRun)
          .where(
            and(
              runScope(principal),
              kind === undefined ? undefined : eq(importRun.kind, kind),
              projectId === undefined ? undefined : eq(importRun.projectId, projectId),
              below === undefined ? undefined : lt(importRun.id, below),
            ),
          )
          .orderBy(desc(importRun.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(runOf), nextCursor })
      },
    )
    .get(
      "/imports/:id",
      describeRoute({
        operationId: "getImportRun",
        summary: "One import run",
        description: "One import run, with its counts so far and whether it has recorded every row it was said to hold. A run of a project this account does not work in, or of a kind whose module its role does not view, is a run that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The run.", ImportRun),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `improve.imports`."),
          404: describeProblem("No import run with that id that this account reads."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findRun(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchRun(id)
        return c.json(runOf(row))
      },
    )
    .post(
      "/imports/:id/rows",
      describeRoute({
        operationId: "importRows",
        summary: "Write one batch of an import",
        description:
          "Writes up to 50 rows of the run in one transaction, each in its own savepoint, as the preview did: each matched on its key and made, changed, left as it stands or refused, and its outcome appended to the run's ledger, `GET /imports/{id}/rows`, with the run's counts moved in the same transaction. A row the run has already recorded is answered as recorded and not written again, so a batch whose answer was lost is sent again whole. The grants are `create` on `improve.imports`, `view` on the module the run's kind writes, and there `create` for a row that makes a record and `edit` for one that changes it, asked per row: a row the caller may not write is refused and the rest are written. Each row is recorded in the audit log under the request's `Waste-Change-Reason`, or, without one, `CSV import <file name>`. The answer is 201 without a Location: the rows are appended to the run's ledger and read there.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("Each row's outcome, in the batch's order, and the run as it now stands.", ImportBatchResult),
          400: describeProblem("The path does not hold an id, or the body is missing its rows, holds more than 50, gives a row number twice, or has a cell under a header the run's kind does not know."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `improve.imports` or `view` on the module the run's kind writes."),
          404: describeProblem("No import run with that id that this account reads."),
          409: describeProblem("The batch would record more rows than the run was said to hold."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", ImportBatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const { rows } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The run first, locked: a batch sent twice at once is two requests, and the second reads what the first recorded.
        await lockRow(tx, importRun, { companyId: principal.companyId, id })
        const run = await findRun(tx, principal, id)
        if (run === undefined) throw noSuchRun(id)
        const kind = run.kind as ImportKind
        const context = contextFor(tx, principal, kind, run.projectId)
        requireColumns(kind, rows, "rows")
        if (changeReasonOf(c.req.header(CHANGE_REASON_HEADER)) === null) await actAs(tx, { userAccountId: principal.user.id, reason: importReason(run.fileName) })

        const earlier = await tx
          .select(rowColumns)
          .from(importRunRow)
          .where(and(eq(importRunRow.companyId, principal.companyId), eq(importRunRow.importRunId, run.id), inArray(importRunRow.rowNumber, rows.map((row) => row.row))))
        const recorded = new Map(earlier.map((row) => [row.rowNumber, resultOf(row)]))
        const fresh = rows.filter((row) => !recorded.has(row.row))
        const before = runOf(run)
        const held = before.counts.created + before.counts.updated + before.counts.unchanged + before.counts.refused
        if (held + fresh.length > run.rowCount) {
          throw problem(409, { detail: `The run holds ${run.rowCount} rows and has recorded ${held}; this batch would record ${fresh.length} more` })
        }

        const written = new Map<number, ImportRowResult>()
        for (const row of fresh) written.set(row.row, await importRow(context, kind, row))
        const results = [...written.values()]
        if (results.length > 0) {
          await tx.insert(importRunRow).values(
            results.map((result) => ({
              id: newId(),
              companyId: principal.companyId,
              importRunId: run.id,
              rowNumber: result.row,
              outcome: result.outcome,
              key: result.key,
              resourceId: result.resourceId,
              detail: result.detail,
            })),
          )
        }
        const counts = countsOf(results)
        const [after] = await tx
          .update(importRun)
          .set({
            createdCount: sql`${importRun.createdCount} + ${counts.created}`,
            updatedCount: sql`${importRun.updatedCount} + ${counts.updated}`,
            unchangedCount: sql`${importRun.unchangedCount} + ${counts.unchanged}`,
            refusedCount: sql`${importRun.refusedCount} + ${counts.refused}`,
          })
          .where(and(eq(importRun.companyId, principal.companyId), eq(importRun.id, run.id)))
          .returning(runColumns)
        const answer: ImportBatchResult = { rows: rows.map((row) => recorded.get(row.row) ?? written.get(row.row)!), run: runOf(after) }
        return c.json(answer, 201)
      },
    )
    .get(
      "/imports/:id/rows",
      describeRoute({
        operationId: "listImportRunRows",
        summary: "What an import did, row by row",
        description:
          "One page of the rows a run recorded, in the order they were written: each row's outcome, what it was matched on, the record it made or matched — for an agreements run, the agreement — and a refusal's sentence. `outcome` narrows it to one outcome, such as the refusals: a refused row is fixed in the file and the file imported again as a new run, the rows this one wrote coming back unchanged. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the run's rows.", ImportRunRowPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, or `outcome` is not an outcome."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `improve.imports`."),
          404: describeProblem("No import run with that id that this account reads."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", ImportRunRowListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, outcome } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findRun(tx, principal, id)) === undefined) throw noSuchRun(id)
        const rows = await tx
          .select(rowColumns)
          .from(importRunRow)
          .where(
            and(
              eq(importRunRow.companyId, principal.companyId),
              eq(importRunRow.importRunId, id),
              outcome === undefined ? undefined : eq(importRunRow.outcome, outcome),
              after === undefined ? undefined : gt(importRunRow.id, after),
            ),
          )
          .orderBy(asc(importRunRow.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(runRowOf), nextCursor })
      },
    )
}

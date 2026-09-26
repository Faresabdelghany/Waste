// What every shared write statement repeats, once (Issue #109 part B, Issue
// #112 part B; #109 §7.24's question — where do the shared write statements
// live once `apps/worker` exists — answered: here). The statements under this
// directory are the ones both processes run — the API inside a request's
// transaction, the worker inside a job's — and a statement is a function over
// `tx` that takes no Principal and no Context, so either process may run it.
// What it needs of the request layer is exactly this file, and the three
// things the API's routes/shared.ts spelled for its routes alone:
//
//   a row lock   — a rule the caller holds rather than the database is only
//                  held per transaction, and two transactions that read the
//                  same parent and then write can each pass it. Where a
//                  statement holds such a rule it takes the parent's row lock
//                  first (`lockRow`) and reads afterwards, so the two
//                  serialise on that row; where it locks two rows it takes
//                  them from the top down, so two callers can never hold half
//                  of each other's pair. A row that is not there locks
//                  nothing, and the read that follows answers for it.
//   a number     — a document numbered from one of the company's series (a
//                  ticket, an invoice, a credit note) takes it one way
//                  (`nextNumber`): `update … returning` under the company's
//                  row lock, so two documents numbered at once take turns and
//                  a transaction that fails rolls its number back with its
//                  rows, the series unbroken. The route's counter is
//                  generation's to take (#97 part B), in blocks, not here.
//   a refusal    — a rule a statement holds and the caller answers for: the
//                  API as a 409 with a sentence, the worker as a failed job
//                  or a line in its log. A statement throws `Refused` with
//                  the sentence and the status the API would answer, and
//                  never a `ProblemError`, which is Hono's and the API's
//                  (the worker has no response to put it in); the API's
//                  error handler maps a `Refused` to the problem of its
//                  status (`refusedProblem`), so a route that calls a shared
//                  statement answers what it always answered. A refusal the
//                  database gives — a unique or exclusion violation the
//                  statement foresaw and gave a sentence to — goes through
//                  `refuseDuplicate` and `refuseOverlap`, the commands' two
//                  doors, which read the constraint's name off the SQLSTATE
//                  (`../sqlstate`) and throw the sentence as a 409 `Refused`;
//                  a constraint the statement did not name is left to the
//                  caller, which for the API is still a 409 with the
//                  constraint's name — the signal that a sentence is missing.
//
// The API's routes/shared.ts re-exports `lockRow`, `lockRows` and
// `nextNumber` from here, so a route reads them where it always did; its own
// `refuseDuplicate` and `refuseOverlap` stay the routes' doors, answering a
// `ProblemError` directly, since a route has the request in hand. Nothing
// here knows a table or a resource but the company's row, which every series
// lives on.
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import { company } from "../schema/organisation"
import { exclusionConstraintOf, uniqueConstraintOf } from "../sqlstate"

// The SQLSTATE readers live in ../sqlstate, where the API's problem.ts and
// the worker's consumers read them too; they are re-exported here as well,
// since a duplicate met inside a command is read the same way as one met by
// a route, and a consumer that imports the commands has them in one place.
export { checkConstraintOf, constraintOf, EXCLUSION_VIOLATION, exclusionConstraintOf, sqlstate, UNIQUE_VIOLATION, uniqueConstraintOf } from "../sqlstate"

/** A table a row can be looked up in the way every table of this system can be: by its own id, inside a company. */
export type TenantTable = PgTable & { id: PgColumn; companyId: PgColumn }

/**
 * A rule a shared statement refused the write on: the sentence a person
 * reads, and the status the API answers it with — a 409 for a row that says
 * otherwise, a 400 for a value the body carried that will not do, which then
 * names the field it came in (`path`), the shape the API's field errors take.
 * Thrown by the statements here and by nothing else; the API's error handler
 * turns it into its problem and the worker's handler into a failed job, since
 * a refusal the domain's rules give is not a fact a consumer may swallow.
 */
export class Refused extends Error {
  readonly status: 400 | 409
  /** The field of the body the refused value came in; a 400's, and never a 409's. */
  readonly path: string | undefined

  constructor(status: 400 | 409, detail: string, path?: string) {
    super(detail)
    this.name = "Refused"
    this.status = status
    this.path = path
  }
}

/** `throw refused(409, "…")`: how a shared statement says a row already says otherwise. */
export const refused = (status: 409, detail: string): Refused => new Refused(status, detail)

/** A value the body carried that will not do, at the field it came in: the 400 the API answers `{ path, message }` with. */
export class RefusedField extends Refused {
  constructor(path: string, message: string) {
    super(400, message, path)
    this.name = "RefusedField"
  }
}

/** What the two doors below share: run the write, and raise the sentence the statement wrote for the constraint it hit as a 409 `Refused`. */
async function refusing<T>(constraintNamed: (error: unknown) => string | undefined, sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const constraint = constraintNamed(error)
    const detail = constraint === undefined ? undefined : sentences[constraint]
    if (detail === undefined) throw error
    throw refused(409, detail)
  }
}

/**
 * Runs a write, and turns a unique violation the statement named into a
 * `Refused` 409 with that sentence. A constraint the statement did not name
 * is left to the caller, which for the API is still a 409 with the
 * constraint's name — the signal that a sentence is missing here.
 */
export async function refuseDuplicate<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refusing(uniqueConstraintOf, sentences, write)
}

/** The same for an exclusion constraint: a row whose period overlaps one already there. */
export async function refuseOverlap<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refusing(exclusionConstraintOf, sentences, write)
}

/**
 * Takes the row lock of the record a rule hangs off, inside the caller's one
 * transaction, and reads nothing back: `select … for update`. A rule the
 * database holds — a key, a period that overlaps — needs none of this; a
 * rule the caller holds does, since it is read first and written after, and
 * without the lock two transactions both read the state the other has not
 * written yet and both pass.
 */
export async function lockRow(tx: Tx, table: TenantTable, row: { companyId: string; id: string }): Promise<void> {
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, row.companyId), eq(table.id, row.id)))
    .limit(1)
    .for("update")
}

/**
 * The same for several rows of one table, taken in id order in one statement
 * (`order by id for update`: Postgres sorts first and locks as it returns the
 * rows, so two transactions naming overlapping sets take them in the same
 * order and neither waits on the other's second row). An id that is not
 * there locks nothing; the check that follows answers for it. Nothing to lock
 * is nothing to do.
 */
export async function lockRows(tx: Tx, table: TenantTable, companyId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(table.id, [...ids])))
    .orderBy(asc(table.id))
    .for("update")
}

/** The counters a company's row carries, one per document series. */
export type Series = "nextInvoiceNumber" | "nextTicketNumber" | "nextRouteNumber"

/** The next number of a company's series, never renumbered: the one the counter had, the counter stepped past it in the database as an expression over its own column. */
export async function nextNumber(tx: Tx, companyId: string, series: Series): Promise<number> {
  const column = company[series]
  const [row] = await tx
    .update(company)
    .set({ [series]: sql`${column} + 1` } as Partial<Record<Series, SQL>>)
    .where(eq(company.id, companyId))
    .returning({ next: column })
  if (row === undefined) throw new Error(`no company ${companyId} to number a document in`)
  return row.next - 1
}

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
//                  generation's to take (#97 part B), in blocks, and the
//                  office's one at a time for an ad-hoc route (#111).
//   a refusal    — a rule a statement holds and the caller answers for: the
//                  API as its 409 or 400, the worker as a failed job or a
//                  line in its log. A statement says no by throwing the
//                  domain's `Refused` (`@waste/domain/refusal`): the sentence
//                  and why — a conflict, or an invalid value at the input it
//                  came in — and nothing of a response, since the worker has
//                  none to put it in; the API's error handler maps it. A
//                  statement whose refusal its callers count rather than
//                  fail on answers it as a value instead (`queueMessage`). A
//                  refusal the database gives — a constraint the caller
//                  foresaw and gave a sentence to — goes through the doors
//                  below, which read the constraint's name off the SQLSTATE
//                  (`../sqlstate`): `refuseDuplicate` (23505) and
//                  `refuseOverlap` (23P01) a conflict, `refuseCheck` (23514)
//                  an invalid value, and `replayed` an idempotent retry
//                  meeting its key, answered as the first application. A
//                  constraint the caller did not name is left to it, which
//                  for the API is a 409 with the constraint's name (or a 500
//                  for a check) — the signal that a sentence is missing. The
//                  API's routes and the statements here go through the same
//                  doors.
//
// The API's routes/shared.ts re-exports `lockRow`, `lockRows` and
// `nextNumber` from here, so a route reads them where it always did. Nothing
// here knows a table or a resource but the company's row, which every series
// lives on.
import { Refused } from "@waste/domain/refusal"
import { and, asc, eq, getTableColumns, inArray, is, SQL, sql } from "drizzle-orm"
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import { company, COMPANY_COUNTERS } from "../schema/organisation"
import { checkConstraintOf, exclusionConstraintOf, uniqueConstraintOf } from "../sqlstate"

// The SQLSTATE readers live in ../sqlstate, where the API's problem.ts and
// the worker's consumers read them too; they are re-exported here as well,
// since a duplicate met inside a command is read the same way as one met by
// a route, and a consumer that imports the commands has them in one place.
export { checkConstraintOf, constraintOf, EXCLUSION_VIOLATION, exclusionConstraintOf, sqlstate, UNIQUE_VIOLATION, uniqueConstraintOf } from "../sqlstate"

/** A table a row can be looked up in the way every table of this system can be: by its own id, inside a company. */
export type TenantTable = PgTable & { id: PgColumn; companyId: PgColumn }

/** Runs a write, and refuses with the caller's own refusal for a constraint it named; anything else is thrown as it came. */
async function refusing<T, Said>(constraintNamed: (error: unknown) => string | undefined, sentences: Readonly<Record<string, Said>>, refusal: (said: Said) => Refused, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const constraint = constraintNamed(error)
    const said = constraint === undefined ? undefined : sentences[constraint]
    if (said === undefined) throw error
    throw refusal(said)
  }
}

/**
 * Runs a write, and turns a unique violation the caller named into a
 * conflict with that sentence. Two doors and not one taking a SQLSTATE,
 * because a caller foresees the two separately — the same table's name key
 * and its `no_overlap` constraint say different things to a person — and a
 * sentence written for one must not answer the other.
 */
export async function refuseDuplicate<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refusing(uniqueConstraintOf, sentences, Refused.conflict, write)
}

/** The same for an exclusion constraint: a row whose period overlaps one already there. */
export async function refuseOverlap<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refusing(exclusionConstraintOf, sentences, Refused.conflict, write)
}

/** What a check the caller named refuses: the input whose value will not do, and why. */
export type CheckRefusal = { input: string; sentence: string }

/**
 * The door one SQLSTATE further along: a check violation (23514) the caller
 * named, refused as an invalid value at its input, since nothing else in the
 * table says otherwise — the row is alone and its own value will not do. For
 * the check only the database can run, such as `st_isvalid` on a polygon
 * whose ring crosses itself in a way the shape rule cannot see; a check the
 * caller did not name is left to it, which for the API is a 500 logging the
 * constraint.
 */
export async function refuseCheck<T>(sentences: Readonly<Record<string, CheckRefusal>>, write: () => Promise<T>): Promise<T> {
  return await refusing(checkConstraintOf, sentences, ({ input, sentence }) => Refused.invalid(input, sentence), write)
}

/**
 * The door that answers a key already taken with the first application
 * rather than a refusal: a client-minted id, or an outside system's own id
 * of a read, already present is the command already done. Runs the write in
 * the caller's savepoint; when it fails with 23505 on one of the constraints
 * named, `first` reads what was recorded under the key — a fresh statement,
 * which sees the winner's committed row — and its answer stands in the
 * write's place. A 23505 on any other constraint rethrows the write's own
 * error, since it is not a replay; so does a named key that `first` finds
 * nothing recorded under — unless the caller gives `taken`, whose answer
 * stands in then: the key is held by a row the caller cannot see, which for
 * the driver door is a command id another driver's device minted.
 */
export async function replayed<T>(keys: readonly string[], write: () => Promise<T>, first: () => Promise<T | undefined>, taken?: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const constraint = uniqueConstraintOf(error)
    if (constraint === undefined || !keys.includes(constraint)) throw error
    const recorded = await first()
    if (recorded !== undefined) return recorded
    if (taken === undefined) throw error
    return await taken()
  }
}

/**
 * How strongly `lockRow` takes its row. `no key update` serialises every
 * caller of the row — it conflicts with itself — but not the `for key share`
 * Postgres takes on a referenced row for each foreign-key insert, so a
 * child's insert naming the row goes on while a rule over the row's set is
 * judged (#335). `update` blocks those inserts too, and is for the caller
 * that goes on to change a key column of the row it locked (`strengthFor`).
 * It takes the stronger lock at once rather than upgrading at the update,
 * since a transaction that holds a key share on the row and then waits for
 * its lock would deadlock with the upgrade.
 */
export type LockStrength = "no key update" | "update"

/**
 * The columns Postgres counts as the table's key when it decides whether an
 * update changes one: every column of its primary key, of a unique
 * constraint, and of a unique index that is neither partial nor over an
 * expression.
 */
function keyColumnsOf(table: PgTable): ReadonlySet<string> {
  const config = getTableConfig(table)
  const columns = [
    ...config.primaryKeys.flatMap((key) => key.columns),
    ...config.uniqueConstraints.flatMap((constraint) => constraint.columns),
    ...config.columns.filter((column) => column.isUnique || column.primary),
  ].map((column) => column.name)
  for (const index of config.indexes) {
    if (!index.config.unique || index.config.where !== undefined) continue
    for (const column of index.config.columns) {
      if (!is(column, SQL) && "name" in column && column.name !== undefined) columns.push(column.name)
    }
  }
  return new Set(columns)
}

/**
 * The strength a patch of the table's row is locked at: `update` where it
 * sets a key column (`keyColumnsOf`), such as a name or a code unique in its
 * scope, and `no key update` otherwise. A member left undefined sets nothing.
 */
export function strengthFor(table: TenantTable, patch: object): LockStrength {
  const keys = keyColumnsOf(table)
  const columns = getTableColumns(table)
  const setsKey = Object.entries(patch).some(([member, value]) => value !== undefined && columns[member] !== undefined && keys.has(columns[member].name))
  return setsKey ? "update" : "no key update"
}

/**
 * Takes the row lock of the record a rule hangs off, inside the caller's one
 * transaction, and reads nothing back: `select … for no key update`, or
 * `for update` where the caller changes a key column of the row
 * (`LockStrength`). A rule the database holds — a key, a period that
 * overlaps — needs none of this; a rule the caller holds does, since it is
 * read first and written after, and without the lock two transactions both
 * read the state the other has not written yet and both pass.
 */
export async function lockRow(tx: Tx, table: TenantTable, row: { companyId: string; id: string }, strength: LockStrength = "no key update"): Promise<void> {
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, row.companyId), eq(table.id, row.id)))
    .limit(1)
    .for(strength)
}

/**
 * The same for several rows of one table, taken in id order in one statement
 * (`order by id for no key update`: Postgres sorts first and locks as it
 * returns the rows, so two transactions naming overlapping sets take them in
 * the same order and neither waits on the other's second row). An id that is
 * not there locks nothing; the check that follows answers for it. Nothing to
 * lock is nothing to do. No caller changes a key column of a row it locks
 * this way.
 */
export async function lockRows(tx: Tx, table: TenantTable, companyId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(table.id, [...ids])))
    .orderBy(asc(table.id))
    .for("no key update")
}

/**
 * Takes the transaction-scoped advisory lock on a key, for a rule over a set
 * no one row stands for — a project's SLA targets, a crew member's day, a
 * property's count: two transactions naming the same key take turns until
 * the first ends. The key is the caller's, `<family>:<company>:<id>` by
 * convention, so two families never share a lock.
 */
export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

/** A company's document series: one of the counters its row declares (`COMPANY_COUNTERS`), which its audit trail ignores and the reset to the seed puts back. */
export type Series = keyof typeof COMPANY_COUNTERS

/** The next number of a company's series, never renumbered: the one the counter had, the counter stepped past it in the database as an expression over its own column. */
export async function nextNumber(tx: Tx, companyId: string, series: Series): Promise<number> {
  const column = COMPANY_COUNTERS[series]
  const [row] = await tx
    .update(company)
    .set({ [series]: sql`${column} + 1` } as Partial<Record<Series, SQL>>)
    .where(eq(company.id, companyId))
    .returning({ next: column })
  if (row === undefined) throw new Error(`no company ${companyId} to number a document in`)
  return row.next - 1
}

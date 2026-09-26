// What every command under this directory shares, and what the API's
// routes/shared.ts and problem.ts spelled for the routes before the worker
// needed the same words (Issue #112 part B; #109 §7.24's question, "where do
// the shared write statements live once `apps/worker` exists", answered:
// here). A command is a function over `tx` that takes no Principal and no
// Context, so either process may run it, and what it needs of the request
// layer is exactly this file: the SQLSTATE a failed statement carries, the
// constraint Postgres named, a row lock, and a refusal that is not an HTTP
// problem.
//
// `CommandRefused` is the command's word for "a row already there says
// otherwise": a unique or exclusion violation the command foresaw and gave a
// sentence to. It is a plain Error with the status the API would answer and
// the sentence as its message, and never a Hono exception — the API's
// `refuseDuplicate` turns the same violation into its 409 problem inside a
// request, and a route that calls a command catches this and rethrows it as
// one (`apps/api/src/routes/shared.ts`, `refusedByCommand`); a job that meets
// it fails the job with the sentence, which is what pg-boss's failed count and
// the worker's `/readyz` are for.
import { and, eq, sql, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import { company } from "../schema/organisation"

// The SQLSTATEs with a meaning to a command. A unique violation is two rows
// with the same key (23505); an exclusion violation is two rows whose periods
// overlap (23P01, the effective-dated tables, Issue #78).
export const UNIQUE_VIOLATION = "23505"
export const EXCLUSION_VIOLATION = "23P01"

/** The SQLSTATE of a failed statement, through Drizzle's wrapper (`cause`) or straight from postgres.js. */
export function sqlstate(error: unknown): { code: string; constraint?: string } | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate !== "object" || candidate === null) continue
    const { code, constraint_name: constraint } = candidate as { code?: unknown; constraint_name?: unknown }
    if (typeof code === "string") return { code, ...(typeof constraint === "string" ? { constraint } : {}) }
  }
  return undefined
}

/** The constraint a failed statement names, when it failed this way and Postgres named one. */
export function constraintOf(error: unknown, code: string): string | undefined {
  const failed = sqlstate(error)
  return failed?.code === code ? failed.constraint : undefined
}

/** The constraint a unique violation names, when that is what the error is and Postgres named it. */
export const uniqueConstraintOf = (error: unknown): string | undefined => constraintOf(error, UNIQUE_VIOLATION)

/** The same for an exclusion violation: which `EXCLUDE USING gist` refused the period. */
export const exclusionConstraintOf = (error: unknown): string | undefined => constraintOf(error, EXCLUSION_VIOLATION)

/** The status a refusal carries: the one the API answers for it, so a route can pass it through. */
export type RefusalStatus = 409

/**
 * A command's refusal: the database said a row already there says otherwise,
 * the command foresaw it and this is its sentence. Not an HTTP exception —
 * the command has no request — but carrying the status the API answers, so
 * the route that called it rethrows it as its problem with nothing lost.
 */
export class CommandRefused extends Error {
  readonly status: RefusalStatus

  constructor(detail: string, status: RefusalStatus = 409) {
    super(detail)
    this.name = "CommandRefused"
    this.status = status
  }
}

/** What the two doors below share: run the write, and raise the sentence the command wrote for the constraint it hit. */
async function refused<T>(constraintOf: (error: unknown) => string | undefined, sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const constraint = constraintOf(error)
    const detail = constraint === undefined ? undefined : sentences[constraint]
    if (detail === undefined) throw error
    throw new CommandRefused(detail)
  }
}

/**
 * Runs a write, and turns a unique violation the command named into a
 * `CommandRefused` with that sentence. A constraint the command did not name
 * is left to the caller, which for the API is still a 409 with the
 * constraint's name — the signal that a sentence is missing here.
 */
export async function refuseDuplicate<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refused(uniqueConstraintOf, sentences, write)
}

/** The same for an exclusion constraint: a row whose period overlaps one already there. */
export async function refuseOverlap<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refused(exclusionConstraintOf, sentences, write)
}

/** A table a row can be looked up in the way every table of this system can be: by its own id, inside a company. */
export type TenantTable = PgTable & { id: PgColumn; companyId: PgColumn }

/**
 * Takes the row lock of the record a rule hangs off, inside the caller's one
 * transaction, and reads nothing back: `select … for update`. A rule the
 * database holds — a key, a period that overlaps — needs none of this; a rule
 * the command holds does, since it is read first and written after, and
 * without the lock two transactions both read the state the other has not
 * written yet and both pass. A row that is not there locks nothing, and the
 * read that follows answers for it. Where two rows are locked they are taken
 * from the top down — the project before the event — so two callers can never
 * hold half of each other's pair.
 */
export async function lockRow(tx: Tx, table: TenantTable, row: { companyId: string; id: string }): Promise<void> {
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, row.companyId), eq(table.id, row.id)))
    .limit(1)
    .for("update")
}

// The company's document series, once (Issue #112, its review). A route's, a
// ticket's and an invoice's number each come off a counter on the company's
// row (`next_route_number`, `next_ticket_number`, `next_invoice_number`;
// schema/organisation.ts): `update … returning` under the company's row lock,
// so two documents numbered at once take turns, and a transaction that fails
// rolls its number back with its rows, the series unbroken. The route's
// counter is the generation worker's to take (#97 part B), in blocks.

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

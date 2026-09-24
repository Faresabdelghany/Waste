// What every resource route repeats, once. Three route modules answer the
// Organisation & Access resources (company.ts, projects.ts,
// service-providers.ts) and they agree on four things:
//
//   the path id      — `/projects/:id` takes an `Id` and nothing else, so a
//                      path that is not one is a 400 naming `id` before the
//                      handler runs and before Postgres is asked to read a
//                      malformed uuid;
//   the 200 body     — one JSON body described by its contracts schema;
//   the timestamps   — `timestamptz` arrives as a Date and goes out as the
//                      contracts' IsoDateTime, which is its ISO string;
//   a duplicate      — the unique constraints a route can foresee become a
//                      sentence a client can show, instead of the constraint
//                      name the generic 23505 mapping would print
//                      (problem.ts). A collision nobody foresaw still lands
//                      there, as a 409 either way.
//   a reference      — an id a body names must be a row of this company
//                      (`requireRow`), checked before the write, or the
//                      foreign key answers 23503 and the client gets a 500
//                      naming nothing.
//
// The Registry added the same thing one SQLSTATE along (Issue #78): an
// effective-dated table refuses a row whose period overlaps one already there
// with 23P01, which is the same kind of news and gets the same treatment,
// `refuseOverlap` beside `refuseDuplicate`. Two doors and not one taking a
// SQLSTATE, because a route foresees the two separately — the same table's
// name key and its `no_overlap` constraint say different things to a person —
// and a sentence written for one must not answer the other.
//
//   a row lock     — a rule the API holds rather than the database is only
//                    held per transaction, and two transactions that read
//                    the same parent and then write can each pass it. Where
//                    a route holds such a rule, it takes the parent's row
//                    lock first (`lockRow`) and reads afterwards, so the
//                    two serialise on that row (routes/periods.ts says which
//                    rule and which parent).
//   a status       — where the row a body names carries one, the lookup that
//                    proves it is there answers it too (`requireStatus`), so
//                    the gate a new reference passes (routes/statuses.ts,
//                    Issue #79) costs no second statement.
//
// Nothing here knows a table or a resource: what is not shared by every route
// module stays in the one that owns it.
import { Id } from "@waste/contracts/ids"
import type { Tx } from "@waste/db/client"
import { and, eq, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import { resolver } from "hono-openapi"
import * as z from "zod"

import { exclusionConstraintOf, invalidRequest, problem, uniqueConstraintOf } from "../problem"

/** The path parameter of every `/<resource>/:id` route. */
export const IdParam = z.object({ id: Id })

type Schema = Parameters<typeof resolver>[0]

/** What a route says about a JSON body in its OpenAPI description. */
export function describeJson(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema: resolver(schema) } } }
}

/** The instants of a row, as the wire spells them. */
export function stampsOf(row: { createdAt: Date; updatedAt: Date }): { createdAt: string; updatedAt: string } {
  return { createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/**
 * Runs a write, and turns a unique violation the route named into a 409 with
 * that sentence. A constraint the route did not name is left to the error
 * handler, which is still a 409 — with the constraint's name, which is the
 * signal that a sentence is missing here.
 */
export async function refuseDuplicate<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refused(uniqueConstraintOf, sentences, write)
}

/**
 * The same for an exclusion constraint: a row whose period overlaps one
 * already there (23P01, the Registry's effective-dated tables). A constraint
 * the route did not name is left to the error handler, a 409 either way.
 */
export async function refuseOverlap<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refused(exclusionConstraintOf, sentences, write)
}

/** A table a row can be looked up in the way every table of this system can be: by its own id, inside a company. */
export type TenantTable = PgTable & { id: PgColumn; companyId: PgColumn }

/** A table whose rows carry a status beside the key: every Registry record that is not effective-dated. */
export type StatusTable = TenantTable & { status: PgColumn }

/** The row a body named: this company's, and under whatever else its key demands. */
type NamedRow = { companyId: string; id: string; also?: SQL }

/** What a row that is not there is told: a 400 at the field that named it. */
type Refusal = { path: string; message: string }

/**
 * Holds an id a body named to a row that is really there — in this company,
 * and under whatever else its key demands, which `also` carries: the project
 * a project-scoped row belongs to, the agreement a subscription hangs on, the
 * property a party is a party to.
 *
 * A row that is not there is a 400 naming the field. The foreign key is the
 * backstop and would answer 23503, a 500 saying nothing, where this says
 * which id to fix; and since the fence hides another company's row, "it is
 * not yours" and "it does not exist" are the same answer on the wire.
 *
 * The sentence stays with the route, which knows what the field is called and
 * what the thing is ("Not a container type of this company"). This runs the
 * lookup, always with `company_id`, and shapes the refusal — so the check a
 * product makes of its container type is the check a subscription will make
 * of its product and an agreement of its customer.
 */
export async function requireRow(tx: Tx, table: TenantTable, row: NamedRow, refusal: Refusal): Promise<void> {
  await answering(tx, table, table.id, row, refusal)
}

/**
 * The same lookup for a table whose rows carry a status, answering it: one
 * statement proves the row is there and says what state it is in, so a route
 * that gates a new reference on that state (routes/statuses.ts) asks once,
 * and a row that is not there is still the 400 above, before any 409.
 */
export async function requireStatus(tx: Tx, table: StatusTable, row: NamedRow, refusal: Refusal): Promise<string> {
  return (await answering(tx, table, table.status, row, refusal)) as string
}

/** One column of the row a body named, or the refusal when there is no such row. */
async function answering(tx: Tx, table: TenantTable, column: PgColumn, row: NamedRow, refusal: Refusal): Promise<unknown> {
  const [found] = await tx
    .select({ answer: column })
    .from(table)
    .where(and(eq(table.companyId, row.companyId), eq(table.id, row.id), row.also))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [refusal])
  return found.answer
}

/**
 * Takes the row lock of the record a rule hangs off, inside the request's
 * one transaction, and reads nothing back: `select … for update`.
 *
 * A rule the database holds — a key, a period that overlaps — needs none of
 * this. A rule the API holds does: containment (routes/periods.ts) is read
 * first and written after, so without a lock a transaction shortening a
 * parent and a transaction adding a child both read the state the other has
 * not written yet and both pass. Taking the parent's lock before the read
 * makes the second transaction wait and then see what the first wrote.
 *
 * A route locks the parent before it reads it, and where it locks two rows
 * it takes them from the top down — the agreement before the subscription —
 * so two requests can never hold half of each other's pair. A row that is
 * not there locks nothing, and the read that follows answers the 404.
 */
export async function lockRow(tx: Tx, table: TenantTable, row: { companyId: string; id: string }): Promise<void> {
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, row.companyId), eq(table.id, row.id)))
    .limit(1)
    .for("update")
}

/** What the two above share: run the write, and answer the sentence the route wrote for the constraint it hit. */
async function refused<T>(
  constraintOf: (error: unknown) => string | undefined,
  sentences: Readonly<Record<string, string>>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const constraint = constraintOf(error)
    const detail = constraint === undefined ? undefined : sentences[constraint]
    if (detail === undefined) throw error
    throw problem(409, { detail })
  }
}

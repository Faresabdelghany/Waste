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
//                      naming nothing;
//   a create         — answers 201 with the body and `Location`, the row's
//                      own single-row GET (`created`), and every 201 in the
//                      document declares the header (`describeCreated`),
//                      Issue #74.
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
import { providerShape } from "@waste/contracts/places"
import type { ProblemFieldError } from "@waste/contracts/problem"
import type { Tx } from "@waste/db/client"
import { and, eq, sql, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import type { Context } from "hono"
import { resolver } from "hono-openapi"
import * as z from "zod"

import { checkConstraintOf, exclusionConstraintOf, invalidRequest, problem, uniqueConstraintOf } from "../problem"

/** The path parameter of every `/<resource>/:id` route. */
export const IdParam = z.object({ id: Id })

type Schema = Parameters<typeof resolver>[0]

/** What a route says about a JSON body in its OpenAPI description. */
export function describeJson(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema: resolver(schema) } } }
}

/** The one header a create answers beside its body, as the document declares it on every 201. */
const LOCATION_HEADER = {
  Location: {
    description: "Where the resource is now read: the path of its own single-row GET, relative to the API's origin.",
    schema: { type: "string" as const },
  },
}

/** What a route says about the 201 a create answers: the body, and `Location` naming where the row is now read. */
export function describeCreated(description: string, schema: Schema) {
  return { ...describeJson(description, schema), headers: LOCATION_HEADER }
}

/**
 * The 201 a create answers (Issue #74): the body, and `Location` naming the
 * row's own single-row GET — `collection` under the id the server minted,
 * relative to the API's origin and never with a host, since the API does not
 * know the name it is reached by. The path is root-relative because the API
 * is served at its origin's root and mounts under no prefix — its own host,
 * as docs/architecture/backend-architecture.md deploys it — so `/projects/<id>`
 * resolves against any origin it is reached by; a base path would be a
 * change here, not in every route. `collection` is where the row is read, not
 * where it was posted: a subscription made under `/agreements/:id/subscriptions`
 * is at `/subscriptions/<id>`. A command (`deactivate`, `reactivate`,
 * `make-primary-administrator`) and a set replacement answer 200 and carry
 * no header, since nothing new is anywhere.
 */
export function created<Body extends { id: string }>(c: Context, collection: `/${string}`, body: Body) {
  return c.json(body, 201, { location: `${collection}/${body.id}` })
}

/** The instants of a row, as the wire spells them. */
export function stampsOf(row: { createdAt: Date; updatedAt: Date }): { createdAt: string; updatedAt: string } {
  return { createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/**
 * What a record's own row is set to when a set that travels with it is
 * replaced (a Property's parties, a Collection Group's rule): nothing but the
 * stamp, since the set is what changed. The trigger would move `updated_at`
 * whatever the update said; naming it is naming what changed, and the update
 * is also what answers "there is no such record here" under the caller's
 * scope. One spelling for a Registry set and a Planning set alike.
 */
export const stamp = (): { updatedAt: SQL } => ({ updatedAt: sql`now()` })

/** A `time` column as postgres.js hands it over: `HH:MM:SS`, with fractional seconds where the value carried them. */
const TIME_OF_DAY = /^(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/

/**
 * A `time` column as the wire spells it (Issue #97): Postgres answers
 * `HH:MM:SS`, the contracts' `IsoTime` is `HH:MM`, so the seconds go. A value
 * that is not a time of day is a bug in a statement, not a client's, and is
 * thrown to become the server's 500 rather than sliced into a wrong time.
 */
export function timeOf(value: string): string {
  const match = TIME_OF_DAY.exec(value)
  if (match === null) throw new Error(`timeOf: ${JSON.stringify(value)} is not a time of day as Postgres spells one (HH:MM:SS)`)
  return match[1]
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
export type NamedRow = { companyId: string; id: string; also?: SQL }

/** What a body is told about a value it carried — a row that is not there, a check the database refused: a 400 at the field that named it. */
export type Refusal = { path: string; message: string }

/** Where a refused id is answered: on the body it came in, or on the query string a list filter named it in. */
export type Target = "body" | "query"

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
 * of its product and an agreement of its customer. A `query` target refuses
 * on the query string, for a list filter that names a row; a body on the body.
 */
export async function requireRow(tx: Tx, table: TenantTable, row: NamedRow, refusal: Refusal, target: Target = "body"): Promise<void> {
  const issue = await rowIssue(tx, table, row, refusal)
  if (issue !== undefined) throw invalidRequest(target, [issue])
}

/**
 * The same lookup as an answer rather than a throw: the refusal where there
 * is no such row, undefined where there is. For a route that holds a body to
 * several rules at once and lists every refusal in one 400 — a place patch's
 * provider beside its two shape rules (routes/place-rules.ts) — so a client
 * mending one is not told about the other on its next try.
 */
export async function rowIssue(tx: Tx, table: TenantTable, row: NamedRow, refusal: Refusal): Promise<Refusal | undefined> {
  return (await answering(tx, table, table.id, row)) === undefined ? refusal : undefined
}

/**
 * The same lookup for a table whose rows carry a status, answering it: one
 * statement proves the row is there and says what state it is in, so a route
 * that gates a new reference on that state (routes/statuses.ts) asks once,
 * and a row that is not there is still the 400 above, before any 409. The
 * caller names the vocabulary the column's check holds the value to.
 */
export async function requireStatus<Status extends string>(tx: Tx, table: StatusTable, row: NamedRow, refusal: Refusal): Promise<Status> {
  const found = await answering(tx, table, table.status, row)
  if (found === undefined) throw invalidRequest("body", [refusal])
  return found.answer as Status
}

/** One column of the row a body named, or undefined when there is no such row: the statement behind the three doors above. */
async function answering(tx: Tx, table: TenantTable, column: PgColumn, row: NamedRow): Promise<{ answer: unknown } | undefined> {
  const [found] = await tx
    .select({ answer: column })
    .from(table)
    .where(and(eq(table.companyId, row.companyId), eq(table.id, row.id), row.also))
    .limit(1)
  return found
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

/**
 * The third door, one SQLSTATE further along (Issue #97): a check violation
 * (23514) the route named becomes a 400 on the field, in the shape the
 * validator's own refusals take. A 400 and not a 409, because nothing else in
 * the table says otherwise — the row is alone and its own value will not do,
 * which is what a schema says of a value it refuses; the only difference is
 * who noticed. The API runs every check it can before the write, so this door
 * is for the check only the database can run: `st_isvalid` on a polygon,
 * whose ring may cross itself in a way the shape rule cannot see. A check the
 * route did not name is left to the error handler, which answers a 500 and
 * logs the constraint — the signal that a sentence is missing here.
 */
export async function refuseCheck<T>(sentences: Readonly<Record<string, Refusal>>, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const constraint = checkConstraintOf(error)
    const refusal = constraint === undefined ? undefined : sentences[constraint]
    if (refusal === undefined) throw error
    throw invalidRequest("body", [refusal])
  }
}

// Resources, round A (Issue #101 review): the owning provider's shape, once.
// A depot, an unloading station, a vehicle and a driver each name a service
// provider exactly when their ownership (or a driver's employment) says so,
// and each route held that against its stored row in its own lines. The
// refusal has one shape here: the rule is the contracts' (`providerShape`,
// @waste/contracts/places, which judges a half-seen pair as fine and leaves
// it to the route to merge the stored row in), the path is always
// `serviceProviderId`, and the sentence is the family's, since a depot's and
// a driver's differ. It comes in two doors: `providerShapeIssue` answers the
// field error or nothing, for a caller that holds a row to more than one
// rule and lists every refusal in one 400 (routes/place-rules.ts, the two
// places), and `requireProviderShape` throws it, for a caller with one rule
// to hold (routes/vehicles.ts and routes/drivers.ts, since the closing
// round). Both take the row as the write leaves it — the provider merged onto
// the stored row, `string | null` and never absent — so a raw patch, whose
// provider may be undefined, does not compile.

/** The provider rule's answer for a row as a write leaves it — `owner` its ownership or employment, `body` its provider — at `serviceProviderId` with the family's sentence; undefined where the row holds. */
export function providerShapeIssue(owner: string, body: { serviceProviderId: string | null }, sentence: string): ProblemFieldError | undefined {
  return providerShape(owner, body) ? undefined : { path: "serviceProviderId", message: sentence }
}

/** Holds a row as a write leaves it to the contracts' provider rule, refusing at `serviceProviderId` with the family's sentence: `providerShapeIssue`, thrown. */
export function requireProviderShape(owner: string, body: { serviceProviderId: string | null }, sentence: string): void {
  const issue = providerShapeIssue(owner, body, sentence)
  if (issue !== undefined) throw invalidRequest("body", [issue])
}

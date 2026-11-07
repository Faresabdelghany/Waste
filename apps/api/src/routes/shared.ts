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
//                      (problem.ts), through `refuseDuplicate` — one of the
//                      doors in `@waste/db/commands/shared` the routes and the
//                      shared statements both go through, beside
//                      `refuseOverlap` (23P01), `refuseCheck` (23514) and
//                      `replayed`. A collision nobody foresaw still lands in
//                      the error handler, as a 409 either way.
//   a reference      — an id a body names must be a row of this company
//                      (`requireRow`), checked before the write, or the
//                      foreign key answers 23503 and the client gets a 500
//                      naming nothing;
//   a create         — answers 201 with the body and `Location`, the row's
//                      own single-row GET (`created`), and every 201 in the
//                      document declares the header (`describeCreated`),
//                      Issue #74.
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
//                    the gate a new reference passes (@waste/domain/status-gates,
//                    Issue #79) costs no second statement.
//   a command      — a write the worker runs as well as a route (Issue #109
//                    part B's `openTicket`, Issue #112 part B's
//                    `recordBillableEvent`, `issueInvoice` and `runBilling`,
//                    under `@waste/db/commands/`) has no request and refuses
//                    with the domain's `Refused`, a conflict or an invalid
//                    value at its input, which the API's error handler
//                    (problem.ts, `refusalProblem`) answers as the 409 or the
//                    400 at the body's field of that name; a route calls the
//                    command and catches nothing.
//
// The row lock and the company's numbering (`lockRow`, `lockRows`,
// `nextNumber`, `@waste/db/commands/shared`) and how the wire spells a row's
// time (`stampsOf`, `instantOf`, `timeOf`, `@waste/db/shapes/times`) are the
// database package's, which the commands both processes run read too; a route
// imports them from there.
//
// Nothing here knows a table or a resource: what is not shared by every route
// module stays in the one that owns it.
import { Id } from "@waste/contracts/ids"
import type { ProblemFieldError } from "@waste/contracts/problem"
import type { Tx } from "@waste/db/client"
import type { TenantTable } from "@waste/db/commands/shared"
import { aheadOfClock, RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import { providerShape } from "@waste/domain/resources/places"
import { and, eq, getTableName, gte, lt, sql, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import type { Context } from "hono"
import { resolver } from "hono-openapi"
import * as z from "zod"

import { invalidRequest } from "../problem"

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

/** The first instant of a `YYYY-MM-DD` day on the UTC calendar. */
const startOfUtcDay = (day: string): Date => new Date(`${day}T00:00:00Z`)

/** The first instant after a `YYYY-MM-DD` day on the UTC calendar: the exclusive end of a window that takes the whole of that day. */
export const endOfDayExclusive = (day: string): Date => new Date(startOfUtcDay(day).getTime() + 86_400_000)

/**
 * The `where` fragment a list filter's `from`/`to` pair of `IsoDate` days
 * makes over an instant column (Issue #109, at integration): both ends
 * inclusive, on the UTC calendar day — `from` at its first instant, `to` up
 * to but not including the midnight after it, so a row at 23:59 on the `to`
 * day is inside the window and one at 00:00 the day after is not. Spelled
 * once, because `lte(column, new Date(to))` reads a day as its first midnight
 * and lists nothing of the day itself. A filter whose bounds are
 * `IsoDateTime` instants (`GET /unloads`, `GET /stock-movements`) compares
 * them as instants and does not come here, and one over a `date` column (a
 * route's operating day) compares days and needs no window. Undefined when
 * neither end was given, as `and` of nothing is.
 */
export function dayWindow(column: PgColumn, from: string | undefined, to: string | undefined): SQL | undefined {
  return and(from === undefined ? undefined : gte(column, startOfUtcDay(from)), to === undefined ? undefined : lt(column, endOfDayExclusive(to)))
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

/** A table whose rows carry a status beside the key: every Registry record that is not effective-dated. */
export type StatusTable = TenantTable & { status: PgColumn }

/** The row a body named: this company's, and under whatever else its key demands. */
export type NamedRow = { companyId: string; id: string; also?: SQL }

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
export async function requireRow(tx: Tx, table: TenantTable, row: NamedRow, refusal: ProblemFieldError, target: Target = "body"): Promise<void> {
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
export async function rowIssue(tx: Tx, table: TenantTable, row: NamedRow, refusal: ProblemFieldError): Promise<ProblemFieldError | undefined> {
  return (await answering(tx, table, table.id, row)) === undefined ? refusal : undefined
}

/**
 * The same lookup for a table whose rows carry a status, answering it: one
 * statement proves the row is there and says what state it is in, so a route
 * that gates a new reference on that state (@waste/domain/status-gates) asks once,
 * and a row that is not there is still the 400 above, before any 409. The
 * caller names the vocabulary the column's check holds the value to. A
 * `query` target refuses on the query string, for a list filter that names a
 * row (`GET /tickets?customerId=`, Issue #109); a body on the body.
 */
export async function requireStatus<Status extends string>(tx: Tx, table: StatusTable, row: NamedRow, refusal: ProblemFieldError, target: Target = "body"): Promise<Status> {
  const found = await answering(tx, table, table.status, row)
  if (found === undefined) throw invalidRequest(target, [refusal])
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

// Execution (Issue #104, ADR-0004): the clock bounds every recorded instant
// is held within. The skew, `OCCURRED_AT_SKEW_MS`, is the domain's
// (`@waste/domain/execution/commands`), where the Stock Movement ledger
// (`@waste/db/commands/stock-ledger`) reads it too, and `requireNotAhead` is
// the route's check over it, spelled once since Resolution's review (Issue
// #109) found it spelled four times; `COMMAND_BACKDATE_MS` is the lower bound
// only a device's queue needs, since an office command's instant defaults to
// the request's clock and a device's may be two days old.

/**
 * Holds a recorded instant to the skew: the body's instant — a ticket's or a
 * movement's `occurredAt`, an unload's, an alert's `detectedAt` — may run
 * ahead of the request's clock `at` by `OCCURRED_AT_SKEW_MS` and no further,
 * refused as a 400 at `path` in the domain's words (`RECORDED_AFTER_IT_HAPPENED`),
 * and has no lower bound here, since the office records a complaint made
 * yesterday and the ledger a movement found in last week's paperwork; the
 * forty-eight-hour floor is the driver door's alone (`COMMAND_BACKDATE_MS`,
 * judged in the domain beside the skew). The ticket create, the alert raise
 * and the unload capture read this one check; a batch ingest that answers
 * each reading on its own reads the domain's `aheadOfClock`.
 */
export function requireNotAhead(instant: Date, at: Date, path = "occurredAt"): void {
  if (aheadOfClock(instant, at)) throw invalidRequest("body", [{ path, message: RECORDED_AFTER_IT_HAPPENED }])
}

/**
 * How far behind the request's clock a driver command's `occurredAt` may lie:
 * forty-eight hours. A device that was offline for two days is a device whose
 * day is over, and its queue is answered as rejections Resolution reads rather
 * than as facts (#104 §7.8). The receipts are still written, so nothing the
 * device said is dropped.
 */
export const COMMAND_BACKDATE_MS = 48 * 3_600_000

/** The primary key constraint Postgres names when a row with the table's id is already there: `<table>_pkey`, its own default, which a driver command's `replayed` names. */
export const primaryKeyOf = (table: PgTable): string => `${getTableName(table)}_pkey`


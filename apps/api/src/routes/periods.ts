// A period inside a period (Issue #78, ADR-0005). The Registry's three
// effective-dated families nest: a Subscription runs inside its Agreement,
// and a Container Service Placement inside its Subscription. Postgres cannot
// say that across rows without a trigger, so the API says it, and it says it
// here once rather than twice in two route modules.
//
// The rule has two sides, because a period can be broken from either end:
//
//   the child moves — a create or a patch that puts a bound outside the
//                     parent's is a 400 naming the bound, since the caller
//                     chose it and can choose another;
//   the parent moves — a patch that shortens an Agreement so a Subscription
//                     of it would fall outside is a 409, since the rows in
//                     the way are not in the body and the caller has to end
//                     them first. `refuseStranded` is that count and that
//                     409, once, for every parent that asks it; `notWithin`
//                     is the `where` for a child with a period of its own,
//                     and a child that is a day (a calendar's holiday, Issue
//                     #97) brings a `where` over its day instead.
//
// A patch carries one bound and the stored row the other, so what has to be
// judged is the period the write leaves behind, not the body: `periodAfter`
// composes it. That is also why the ordering rule is repeated here. The
// contracts refuse `validTo <= validFrom` on a body that holds both
// (@waste/contracts/validity), but a patch naming only `validTo` gives them
// one bound and they let it through; unchecked it would reach the table's
// `validPeriod` check and come back as a 500 saying nothing. `requireWithin`
// holds the merged period to itself before it holds it to the parent's, with
// the contracts' own sentence, so a client reads one answer whichever noticed.
//
// Days are `YYYY-MM-DD`, so `<` and `>` on the strings are `<` and `>` on the
// days: the fields are zero-padded and most significant first. The period is
// half-open — `validFrom` is the first day in force and `validTo` the first
// day out of it — which is why a child ending exactly when its parent does is
// inside it, and a child with no end is outside a parent that has one.
//
// The rule is held per transaction, under the parent's row lock. Both sides
// read the parent and then write, so without a lock a request shortening an
// Agreement and a request adding a Subscription to it each read a state the
// other has not committed yet and both pass. Every route that holds this
// rule therefore takes the parent's lock before it reads it (`lockRow`,
// routes/shared.ts) — the Agreement for a subscription's create or patch and
// for the agreement's own patch, the Subscription for a placement's create
// or patch and for the subscription's own — and where a route locks two, it
// takes them from the top down, the Agreement before the Subscription, so no
// two requests hold half of each other's pair.
import { ENDS_AFTER_IT_STARTS, validityOrdered } from "@waste/contracts/validity"
import type { Tx } from "@waste/db/client"
import type { ValidityColumns } from "@waste/db/schema/columns"
import { count } from "@waste/domain/text"
import { count as countRows, sql, type SQL } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { invalidRequest, problem } from "../problem"

/** The period a row is in force over: the first day in, and the first day out or null while it runs. */
export type Period = { validFrom: string; validTo: string | null }

/** Which bound of the period a patch or a create names; the path an error sits at. */
type Bound = "validFrom" | "validTo"

/** The period a create body asks for: an absent end is the open one the column stores as null. */
export function periodOf(values: { validFrom: string; validTo?: string | null }): Period {
  return { validFrom: values.validFrom, validTo: values.validTo ?? null }
}

/** The period a patch leaves behind: the bounds the body gave, and the stored row's where it gave none. */
export function periodAfter(current: Period, patch: { validFrom?: string; validTo?: string | null }): Period {
  return {
    validFrom: patch.validFrom ?? current.validFrom,
    validTo: patch.validTo === undefined ? current.validTo : patch.validTo,
  }
}

/** The bounds of `child` that lie outside `parent`, in the order a body spells them. */
function boundsOutside(parent: Period, child: Period): Bound[] {
  const outside: Bound[] = []
  if (child.validFrom < parent.validFrom) outside.push("validFrom")
  if (parent.validTo !== null && (child.validTo === null || child.validTo > parent.validTo)) outside.push("validTo")
  return outside
}

/** Refuses a period that runs backwards, the rule the contracts hold a whole body to and a patch escapes. `at` is where the body carried the period when not at its root: `assignment.` for the first assignment riding on a service area's create (Issue #112). */
export function requireOrdered(period: Period, at = ""): void {
  if (validityOrdered(period)) return
  throw invalidRequest("body", [{ path: `${at}validTo`, message: ENDS_AFTER_IT_STARTS }])
}

/**
 * Holds the period a write leaves behind to itself and to its parent's: a
 * 400 naming each bound that is outside, with the sentence the route wrote
 * ("Outside the agreement's period"), since only the route knows what the
 * parent is called. `at` prefixes the bound's path where the body carried the
 * period inside a member (`assignment.validTo`).
 */
export function requireWithin(parent: Period, child: Period, message: string, at = ""): void {
  requireOrdered(child, at)
  const errors = boundsOutside(parent, child).map((path) => ({ path: `${at}${path}`, message }))
  if (errors.length > 0) throw invalidRequest("body", errors)
}

/**
 * The `where` fragment matching the rows whose period leaves this one: the
 * other side of the rule, for the query behind the 409 a parent's patch
 * earns. A row with no end leaves a parent that has one, which is why the
 * null is named rather than left to a comparison that would answer null.
 */
export function notWithin(columns: ValidityColumns, parent: Period): SQL {
  const leaves = [sql`${columns.validFrom} < ${parent.validFrom}`]
  if (parent.validTo !== null) {
    leaves.push(sql`${columns.validTo} is null`, sql`${columns.validTo} > ${parent.validTo}`)
  }
  return sql`(${sql.join(leaves, sql` or `)})`
}

/**
 * The other side of the rule, for a parent whose period is moving: the
 * children the new period would leave outside are counted and the write is
 * refused with the count (409), because those rows are not in the body and
 * the caller has to end them first. `where` is the caller's — which table,
 * which parent, and what "outside" means for its rows: `notWithin` for a
 * child with a period of its own (a subscription, a placement), the day
 * against the two bounds for a child that is a day (a calendar's holiday) —
 * and it carries `company_id` and the parent's id and never `inProjects`,
 * since the parent was read under the caller's scope and a child's project is
 * the parent's by the composite key: a count that refuses a write must not be
 * the one statement that could miss a row. The sentence is the route's, since
 * only it knows what the children are called.
 */
export async function refuseStranded(tx: Tx, table: PgTable, where: SQL | undefined, sentence: (rows: number) => string): Promise<void> {
  const [row] = await tx.select({ rows: countRows() }).from(table).where(where)
  const strays = row?.rows ?? 0
  if (strays > 0) throw problem(409, { detail: sentence(strays) })
}

/**
 * The sentence most parents refuse with, spelled once: "1 price row falls
 * outside the new period; end it first", "2 holidays fall outside the new
 * period; remove them first" — the count through the domain's `count`, the
 * verb and the pronoun following it, `remedy` what the caller does with the
 * rows in the way (`end` a dated child, `remove` a day). A parent whose
 * children are ended another way — a placement through the ledger's commands
 * (routes/agreements.ts) — spells its own.
 */
export const strandedSentence =
  (noun: string, remedy: "end" | "remove", plural?: string) =>
  (rows: number): string =>
    `${count(rows, noun, plural)} ${rows === 1 ? "falls" : "fall"} outside the new period; ${remedy} ${rows === 1 ? "it" : "them"} first`

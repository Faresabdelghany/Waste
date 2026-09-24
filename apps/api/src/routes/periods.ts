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
//                     them first. `notWithin` is the `where` that counts
//                     them.
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
import { ENDS_AFTER_IT_STARTS, validityOrdered } from "@waste/contracts/validity"
import type { ValidityColumns } from "@waste/db/schema/columns"
import { sql, type SQL } from "drizzle-orm"

import { invalidRequest } from "../problem"

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

/** Refuses a period that runs backwards, the rule the contracts hold a whole body to and a patch escapes. */
export function requireOrdered(period: Period): void {
  if (validityOrdered(period)) return
  throw invalidRequest("body", [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])
}

/**
 * Holds the period a write leaves behind to itself and to its parent's: a
 * 400 naming each bound that is outside, with the sentence the route wrote
 * ("Outside the agreement's period"), since only the route knows what the
 * parent is called.
 */
export function requireWithin(parent: Period, child: Period, message: string): void {
  requireOrdered(child)
  const errors = boundsOutside(parent, child).map((path) => ({ path, message }))
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

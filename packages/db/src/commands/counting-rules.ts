// What a Counting Rule counts (#547 of #544), spelled once for the two that
// count: the worker, as each emptying completes, and the API's simulation
// over past emptyings — so a rule simulated counts what it will count once it
// is switched on. A counted stop is a pickup joined to its route
// (`stopOnItsRoute`), whose service date places it in a period: a completed
// emptying at a property, of the rule's fraction and in a container of its
// type where the rule names them (`countedStops`). An address-only stop names
// no container, so a rule naming a type never counts one.
import type { CountingWindow } from "@waste/domain/resolution/counting-rules"
import { and, count, eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { container } from "../schema/containers"
import { pickup, route } from "../schema/execution"

/** A rule's terms that say which stops count: one fraction, one container type, null counting every one. */
export type CountingTerms = { wasteFractionId: string | null; containerTypeId: string | null }

/** A pickup's route, whose service date is the day a stop is counted on. */
export const stopOnItsRoute: SQL = and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)) as SQL

/** The stops a rule counts, over `pickup` joined to its route: completed emptyings at a property, of its fraction and in its container type where it names them. */
export function countedStops(companyId: string, terms: CountingTerms): SQL {
  return and(
    eq(pickup.companyId, companyId),
    eq(pickup.status, "completed"),
    eq(pickup.service, "empty"),
    isNotNull(pickup.propertyId),
    terms.wasteFractionId === null ? undefined : eq(pickup.wasteFractionId, terms.wasteFractionId),
    terms.containerTypeId === null
      ? undefined
      : sql`exists (select 1 from ${container} where ${container.companyId} = ${pickup.companyId} and ${container.id} = ${pickup.containerId} and ${container.containerTypeId} = ${terms.containerTypeId})`,
  ) as SQL
}

/** How many stops a rule counts at one property over one period. */
export async function countedAt(tx: Tx, companyId: string, terms: CountingTerms, propertyId: string, period: CountingWindow): Promise<number> {
  const [row] = await tx
    .select({ counted: count() })
    .from(pickup)
    .innerJoin(route, stopOnItsRoute)
    .where(and(countedStops(companyId, terms), eq(pickup.propertyId, propertyId), gte(route.serviceDate, period.from), lt(route.serviceDate, period.to)))
  return row.counted
}

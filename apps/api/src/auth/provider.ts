// Who a Service Provider is, and what its account reaches (Issue #112 §3,
// ADR-0001). An office account works in projects and reaches a project's
// rows through `inProjects` (projects.ts). A provider's account works in no
// project — Lars, the Service Provider Manager at NordRen, has one Service
// Provider Access and no Project Access — and until Finance it reached
// nothing of the company's operation at all. Finance is where a provider's
// own records live: the Service Area Assignment says who holds an area when,
// and everything a provider reads follows from it.
//
// Two predicates, both `where` fragments a statement carries beside the
// tenant, and both a SQL `false` for an account they do not apply to, the way
// `inProjects` is for an account with no project — so neither ever widens a
// statement, and a condition that does not apply is a condition that refuses
// rather than one left out.
//
// `servesRoute` is the one sentence ADR-0001 states, as SQL over a `route`
// row: the route's scheme's planning area is in a service area assigned to
// the account's provider on the route's operating date. It is built here,
// described and proved against seeded rows (provider-reach.test.ts) and wired
// into nothing (§7.21): one follow-up issue per family adds it to that
// family's list and single read as a second fence for a provider account,
// `inProjects` for the office and this for the provider, the way `assignedTo`
// is the driver's. The day is the route's `operating_date`, the day the work
// happens, which is the day a provider is on the road for it (#104 §5 and
// #109 §5 both said "operating date"; ADR-0001's "service date" is read as
// the day the work is done, §7.24). A route whose scheme has no planning area
// is reached by no provider through it, and a Service Area with no planning
// areas reaches no route.
//
// `reachesAssignments` is what a provider's account reaches directly and
// today (§7.22): its own assignments — the rows naming its provider — and,
// through them, the areas they name, the prices under them and the
// settlements over them. For an account with a provider the fragment is
// `service_provider_id = <the provider>`; for one with projects it is
// `inProjects` over the assignment's project; never both widened — an account
// with a provider is bounded to it whatever else it holds, since the
// provider's rows are what the account is for. A provider account never
// reaches a price list, a billable event, a billing run or an invoice: those
// families carry `inProjects` alone, and a provider works in no project.
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { route } from "@waste/db/schema/execution"
import { serviceArea, serviceAreaAssignment, serviceAreaPlanningArea } from "@waste/db/schema/finance"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { and, eq, exists, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import type { Principal } from "./principal"
import { inProjects } from "./projects"

/** The Service Provider Access's provider, or null for an office account. */
export function providerIdOf(principal: Principal): string | null {
  return principal.serviceProvider?.id ?? null
}

/** The columns of a route row the predicate reads: the `route` table's own, or an alias's. */
export type RouteColumns = { companyId: PgColumn; routeSchemeId: PgColumn; operatingDate: PgColumn }

/**
 * The `where` fragment that keeps a statement over `route` to the routes the
 * caller's provider serves on the day: `exists` one assignment of the
 * provider, valid on the route's operating date, whose area is valid on it
 * too and names the planning area the route's scheme names. `false` for an
 * account without a provider, so an office account never widens through it.
 * `on` is the route row the statement is over — the `route` table itself, or
 * an alias of it in a join — and `tx` is what the subquery is built on, so
 * it is one statement with the caller's.
 */
export function servesRoute(tx: Tx, principal: Principal, on: RouteColumns = route): SQL {
  const providerId = providerIdOf(principal)
  if (providerId === null) return sql`false`
  return exists(
    tx
      .select({ one: sql`1` })
      .from(serviceAreaAssignment)
      .innerJoin(serviceArea, and(eq(serviceArea.companyId, serviceAreaAssignment.companyId), eq(serviceArea.id, serviceAreaAssignment.serviceAreaId)))
      .innerJoin(serviceAreaPlanningArea, and(eq(serviceAreaPlanningArea.companyId, serviceArea.companyId), eq(serviceAreaPlanningArea.serviceAreaId, serviceArea.id)))
      .innerJoin(routeScheme, and(eq(routeScheme.companyId, on.companyId), eq(routeScheme.id, on.routeSchemeId)))
      .where(
        and(
          eq(serviceAreaAssignment.companyId, on.companyId),
          eq(serviceAreaAssignment.serviceProviderId, providerId),
          eq(serviceAreaPlanningArea.planningAreaId, routeScheme.planningAreaId),
          validOn(serviceAreaAssignment, on.operatingDate),
          validOn(serviceArea, on.operatingDate),
        ),
      ),
  )
}

/** The columns of an assignment row the reach reads: the `service_area_assignment` table's own, or an alias's. */
export type AssignmentColumns = { projectId: PgColumn; serviceProviderId: PgColumn }

/**
 * The `where` fragment that keeps a statement over `service_area_assignment`
 * to the assignments the caller reaches: the rows naming its provider for an
 * account with one, the rows of its projects for one with projects, and
 * `false` for an account with neither. A family whose rows hang off an
 * assignment — an area through the assignments naming it, a provider price
 * and a settlement through the assignment they are made under — carries this
 * inside an `exists` over the assignment for a provider account, and
 * `inProjects` over its own project column for an office account
 * (`providerIdOf` says which), so an area nobody has assigned yet is still
 * the office's to see.
 */
export function reachesAssignments(principal: Principal, on: AssignmentColumns = serviceAreaAssignment): SQL {
  const providerId = providerIdOf(principal)
  if (providerId !== null) return eq(on.serviceProviderId, providerId)
  return inProjects(on.projectId, principal)
}

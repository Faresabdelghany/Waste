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
// the account's provider on the route's operating date. The day is the
// route's `operating_date`, the day the work happens, which is the day a
// provider is on the road for it (#104 §5 and #109 §5 both said "operating
// date"; ADR-0001's "service date" is read as the day the work is done,
// §7.24). A route whose scheme has no planning area — the office's ad-hoc
// route among them, which has no scheme — is reached by no provider through
// it, and a Service Area with no planning areas reaches no route. The
// scheme's planning area is read as it stands, so a scheme moved to another
// area moves the routes it already wrote with it.
//
// It fences the reads of two families (#291 slice 23, the first of §7.21's
// follow-ups): the routes — the list, a route's read, its device log and its
// Plans — and the pickups — the list, a stop's read and its proof objects.
// `reachesRoute` is the choice between the two fences for a statement over
// `route`, `inProjects` for the office and `servesRoute` for the provider,
// the way `assignedTo` is the driver's; `reachesThroughRoute` is the same
// choice for a row that hangs off a route — a pickup, a Plan, a Plan's stop —
// spelled once for them. Every command of those families stays the office's
// (`inProjects` alone, routes/execution-shapes.ts's `routeScope`), so a
// provider's account whose role is granted `edit` finds no row to command —
// the family's 404, as a settlement's commands answer it.
//
// `reachesAssignments` is what a provider's account reaches directly and
// today (§7.22): its own assignments — the rows naming its provider — and,
// through them, the areas they name, the prices under them and the
// settlements over them. For an account with a provider the fragment is
// `service_provider_id = <the provider>`; for one with projects it is
// `inProjects` over the assignment's project; never both widened — an account
// with a provider is bounded to it whatever else it holds, since the
// provider's rows are what the account is for. `reachesThroughAssignments` is
// the same reach for the three families whose rows hang off an assignment,
// spelled once for them: the office's `inProjects` over the row's own
// project, a provider's `exists` over the assignment that names the row. A
// provider account never reaches a price list, a billable event, a billing
// run or an invoice: those families carry `inProjects` alone, and a provider
// works in no project.
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { route } from "@waste/db/schema/execution"
import { serviceArea, serviceAreaAssignment, serviceAreaPlanningArea } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import { routeScheme } from "@waste/db/schema/route-schemes"
import type { ModuleKey } from "@waste/domain/access/modules"
import { and, eq, exists, sql, type SQL } from "drizzle-orm"
import { alias, type PgColumn } from "drizzle-orm/pg-core"

import { invalidRequest } from "../problem"
import type { Principal } from "./principal"
import { inProjects, requireProject } from "./projects"

/** The Service Provider Access's provider, or null for an office account. */
export function providerIdOf(principal: Principal): string | null {
  return principal.serviceProvider?.id ?? null
}

/**
 * Whether the provider serves the scheme on the day (#474): `servesRoute`'s
 * sentence asked of a scheme rather than a route — an assignment of the
 * provider, valid on the day, whose area is valid on it too and names the
 * planning area the scheme names. What a proposal is held to: a provider
 * proposes a change only for a scheme it serves on the day the change would
 * apply from, whichever side opens it. A scheme with no planning area is
 * served by nobody.
 */
export async function servesScheme(tx: Tx, scope: { companyId: string; serviceProviderId: string; routeSchemeId: string }, day: string): Promise<boolean> {
  const [served] = await tx
    .select({ one: sql`1` })
    .from(serviceAreaAssignment)
    .innerJoin(serviceArea, and(eq(serviceArea.companyId, serviceAreaAssignment.companyId), eq(serviceArea.id, serviceAreaAssignment.serviceAreaId)))
    .innerJoin(serviceAreaPlanningArea, and(eq(serviceAreaPlanningArea.companyId, serviceArea.companyId), eq(serviceAreaPlanningArea.serviceAreaId, serviceArea.id)))
    .innerJoin(routeScheme, and(eq(routeScheme.companyId, serviceAreaAssignment.companyId), eq(routeScheme.id, scope.routeSchemeId)))
    .where(
      and(
        eq(serviceAreaAssignment.companyId, scope.companyId),
        eq(serviceAreaAssignment.serviceProviderId, scope.serviceProviderId),
        eq(serviceAreaPlanningArea.planningAreaId, routeScheme.planningAreaId),
        validOn(serviceAreaAssignment, day),
        validOn(serviceArea, day),
      ),
    )
    .limit(1)
  return served !== undefined
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

/** The columns of a route row the reach reads: the predicate's, and the project the office's fence reads. */
export type ReachedRouteColumns = RouteColumns & { projectId: PgColumn }

/**
 * The `where` fragment that keeps a statement over `route` to the routes the
 * caller reads: `inProjects` over the route's project for an office account,
 * and for an account with a provider `servesRoute` alone — never both
 * widened, since an account with a provider is bounded to it whatever else
 * it holds (`reachesAssignments`' rule). The reads of the routes family carry
 * it beside the tenant; their commands carry `inProjects` alone.
 */
export function reachesRoute(tx: Tx, principal: Principal, on: ReachedRouteColumns = route): SQL {
  if (providerIdOf(principal) === null) return inProjects(on.projectId, principal)
  return servesRoute(tx, principal, on)
}

/** The columns of a row that hangs off a route — a pickup, a Plan, a Plan's stop — as the reach reads them. */
export type RouteChildColumns = { companyId: PgColumn; projectId: PgColumn; routeId: PgColumn }

/** The route a child row's reach is judged on, apart from any `route` the caller's statement already joins. */
const reachedRoute = alias(route, "reached_route")

/**
 * The `where` fragment that keeps a statement over a row that hangs off a
 * route to the rows the caller reads, spelled once for the pickups, the Plans
 * and their stops: `inProjects` over the row's own project for an office
 * account — the fence those statements always carried — and for an account
 * with a provider `exists` the route the row names, served by the provider
 * on its operating date (`servesRoute`). The route is an alias of its own, so
 * a statement that joins `route` itself keeps its join apart from this one;
 * such a statement may hand its joined route as `joined` instead, and the
 * provider's fence is then `servesRoute` over it, with no second read.
 */
export function reachesThroughRoute(tx: Tx, principal: Principal, on: RouteChildColumns, joined?: RouteColumns): SQL {
  if (providerIdOf(principal) === null) return inProjects(on.projectId, principal)
  if (joined !== undefined) return servesRoute(tx, principal, joined)
  return exists(
    tx
      .select({ one: sql`1` })
      .from(reachedRoute)
      .where(and(eq(reachedRoute.companyId, on.companyId), eq(reachedRoute.id, on.routeId), servesRoute(tx, principal, reachedRoute))),
  )
}

/** The columns of an assignment row the reach reads: the `service_area_assignment` table's own, or an alias's. */
export type AssignmentColumns = { projectId: PgColumn; serviceProviderId: PgColumn }

/**
 * The `where` fragment that keeps a statement over `service_area_assignment`
 * to the assignments the caller reaches: the rows naming its provider for an
 * account with one, the rows of its projects for one with projects, and
 * `false` for an account with neither. A family whose rows hang off an
 * assignment reads through `reachesThroughAssignments` below, which carries
 * this inside its `exists`.
 */
export function reachesAssignments(principal: Principal, on: AssignmentColumns = serviceAreaAssignment): SQL {
  const providerId = providerIdOf(principal)
  if (providerId !== null) return eq(on.serviceProviderId, providerId)
  return inProjects(on.projectId, principal)
}

/** The columns of a row that hangs off an assignment, as the reach reads them: its own project, for the office. */
export type AssignmentChildColumns = { projectId: PgColumn }

/**
 * The `where` fragment that keeps a statement over a family whose rows hang
 * off an assignment — an area through the assignments naming it, a provider
 * price and a settlement through the assignment they are made under — to the
 * rows the caller reaches (§7.22), spelled once for the three: `inProjects`
 * over the row's own project for an office account, so an area nobody has
 * assigned yet is still the office's to see, and for a provider's account
 * `exists` one assignment the caller reaches (`reachesAssignments`) that
 * `named` ties to the row — `eq(serviceAreaAssignment.serviceAreaId,
 * serviceArea.id)` for an area, `eq(serviceAreaAssignment.id,
 * serviceProviderPrice.serviceAreaAssignmentId)` for a price, the same for
 * a settlement. `providerIdOf` says which; `tx` is what the subquery is
 * built on, so it is one statement with the caller's.
 */
export function reachesThroughAssignments(tx: Tx, principal: Principal, on: AssignmentChildColumns, named: SQL): SQL {
  if (providerIdOf(principal) === null) return inProjects(on.projectId, principal)
  return exists(
    tx
      .select({ one: sql`1` })
      .from(serviceAreaAssignment)
      .where(and(eq(serviceAreaAssignment.companyId, principal.companyId), named, reachesAssignments(principal))),
  )
}

/** The columns of a fleet row the reach reads: a vehicle's or a driver's project, and the provider that owns or employs it. */
export type FleetColumns = { projectId: PgColumn; serviceProviderId: PgColumn }

/**
 * The `where` fragment that keeps a statement over the fleet — a vehicle, a
 * driver — to the rows the caller reaches (#291 slice 23b): `inProjects` for
 * an office account, and for an account with a provider the rows naming its
 * provider as their owner or employer, in whichever project they are based —
 * its own fleet, which a provider's manager reads and keeps whole (its
 * charter grants every action on both). Never both widened. Unlike the
 * routes, the fleet's writes carry it too: a provider changes its own trucks
 * and drivers, and no other.
 */
export function reachesFleet(principal: Principal, on: FleetColumns): SQL {
  const providerId = providerIdOf(principal)
  if (providerId !== null) return eq(on.serviceProviderId, providerId)
  return inProjects(on.projectId, principal)
}

/** What a provider's account naming a project it holds no award in is told, its provider named. */
export const notAHeldProject = (provider: string): string => `Not a project ${provider} holds a Service Area in`

/**
 * Holds a project a request names to the ones the caller may name there:
 * for an office account the projects it works in (`requireProject`); for a
 * provider's account, which works in none, a project in which its provider
 * holds a Service Area Assignment in force on the project's today, its
 * Service Area in force too, as `servesRoute` judges an award — the
 * request's instant rendered on the project's clock — where its fleet is
 * based and its work is. A 400 at `path` otherwise, in the provider's name.
 */
export async function requireReachedProject(tx: Tx, principal: Principal, projectId: string, now: () => Date, path = "projectId", target: "body" | "query" = "body"): Promise<void> {
  const providerId = providerIdOf(principal)
  if (providerId === null) return requireProject(principal, projectId, path, target)
  const today = sql`(${now().toISOString()}::timestamptz at time zone ${project.timezone})::date`
  const [held] = await tx
    .select({ one: sql`1` })
    .from(serviceAreaAssignment)
    .innerJoin(project, and(eq(project.companyId, serviceAreaAssignment.companyId), eq(project.id, serviceAreaAssignment.projectId)))
    .innerJoin(serviceArea, and(eq(serviceArea.companyId, serviceAreaAssignment.companyId), eq(serviceArea.id, serviceAreaAssignment.serviceAreaId)))
    .where(
      and(
        eq(serviceAreaAssignment.companyId, principal.companyId),
        eq(serviceAreaAssignment.projectId, projectId),
        eq(serviceAreaAssignment.serviceProviderId, providerId),
        // In force as `servesRoute` judges an award: the assignment and the area both.
        validOn(serviceAreaAssignment, today),
        validOn(serviceArea, today),
      ),
    )
    .limit(1)
  if (held === undefined) throw invalidRequest(target, [{ path, message: notAHeldProject(providerNameOf(principal)) }])
}

/** What a provider's account naming a fleet row of anyone else's is told: its own fleet, named. */
export const notOwnFleet = (what: "vehicle" | "trailer" | "driver", provider: string): string => `Not a ${what} of ${provider}`

/** The name a provider's account's sentences call its provider by. */
export const providerNameOf = (principal: Principal): string => principal.serviceProvider?.legalName ?? "This account's service provider"

/** What a provider's vehicle or driver is told when a body would make it anyone else's. */
export const ownFleetKind = (provider: string, what: "vehicle" | "driver"): string =>
  what === "vehicle" ? `${provider}'s vehicles are its own: their ownership is service-provider` : `${provider}'s drivers are its own: their employment is service-provider`
export const ownFleetProvider = (provider: string, what: "vehicle" | "driver"): string => `${provider}'s ${what}s name ${provider} as their provider`

/** The two halves of a fleet row's owner a body carries: the kind — a vehicle's ownership, a driver's employment — and the provider. */
export type FleetOwner = { kind: string | undefined; serviceProviderId: string | null | undefined }

/**
 * A provider's account writes its own fleet and nobody else's (#291 slice
 * 23b): a create's ownership (a vehicle) or employment (a driver) is
 * `service-provider` and its provider the caller's, and a patch that names
 * either names those. Each a 400 at its field in the provider's name, the two
 * listed together; nothing for an office account, whose rule is the
 * contracts' pair rule alone. A create carries both halves (the contracts
 * default the kind); a patch only the ones it moves.
 */
export function requireOwnFleet(principal: Principal, owner: FleetOwner, what: "vehicle" | "driver", mode: "create" | "patch"): void {
  const providerId = providerIdOf(principal)
  if (providerId === null) return
  const provider = providerNameOf(principal)
  const kindPath = what === "vehicle" ? "ownership" : "employment"
  const issues: { path: string; message: string }[] = []
  if ((mode === "create" || owner.kind !== undefined) && owner.kind !== "service-provider") issues.push({ path: kindPath, message: ownFleetKind(provider, what) })
  if ((mode === "create" || owner.serviceProviderId !== undefined) && owner.serviceProviderId !== providerId) issues.push({ path: "serviceProviderId", message: ownFleetProvider(provider, what) })
  if (issues.length > 0) throw invalidRequest("body", issues)
}

/** A Service Provider's own team: the module its manager administers the team's accounts, and reads the roles it may give, under (#291 slice 23b). */
export const TEAM_MODULE: ModuleKey = "service-providers.service-provider-workspace"

/** The module a caller reaches the company's accounts and roles through: the office's access settings, or for a provider's account its own team. */
export const accessModuleOf = (principal: Principal): ModuleKey => (providerIdOf(principal) === null ? "configure.access" : TEAM_MODULE)


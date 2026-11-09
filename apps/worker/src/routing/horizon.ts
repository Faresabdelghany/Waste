// The horizon (#172, decided on #132 §2–4 and #124 §2 and §4): which Routes
// get a Plan without anyone asking. Eager inside a fixed week —
// tomorrow through today + 7 on the project's clock, `HORIZON_DAYS` — and
// on demand beyond it: an Optimise click, a reorder's measurement, a
// dispatch. Two ways in, one door out:
//
//   generation — `planReshaped`, which ../planning/generate-routes.ts calls
//                once its run's transaction has committed, with the routes
//                the run created or reshaped: stops inserted, moved, brought
//                back or skipped, the depot or the station changed. A route
//                the run left alone is the sweep's;
//   the sweep  — `routing.sweep-horizon` (sweep-horizon.ts) at 03:30 UTC,
//                half an hour after Plan Ahead, once however many nights
//                were missed: a
//                cross-tenant read on the worker role of every planned or
//                ready route of an active project operating inside the
//                window with an open stop, Plan Ahead on or not, nearest date
//                first, of which it asks for each whose active Plan is
//                missing or no longer answers it: failed (a manual or
//                baseline Plan is active from its creation, so one whose
//                measurement was refused stays the route's, #231), stale
//                (`planIsStale`), not naming the stops the request would — a
//                manual or baseline Plan in their order (`answersRequest`,
//                #212) — or keyed on ends or places that have moved since
//                (`planKey`), so a generation whose ask failed is asked
//                again; then every calculating Plan more than a day old
//                whose job pg-boss no longer holds — its retries spent, or
//                lost across an outage — has its job re-sent under its key.
//
// Each route is its own transaction as `wms_api` under `withCompany`, under
// the route's row lock (the office's order: a route before its Plans), so the
// route read is the route asked for, and one route's trouble is a line in the
// log, never another route's and never the run's failure: the sweep is the
// net under a generation whose ask failed, and a Route without a Plan is
// complete (#132 §2). Only an active project's routes are the horizon's,
// generation's as much as the sweep's. What is asked is `horizonRequest`
// (@waste/domain/routing/plans): the Optimise request's size rule — the
// optimiser for fifty open stops or fewer from a depot, a baseline above or
// without one — unless the active Plan is a dispatcher's manual order, which
// the horizon extends and never replaces, and leaves alone while an Optimise
// the dispatcher asked after it still waits. The door is the office's own,
// `ensurePlan` (@waste/db/commands/plans), asked `batch`: its cache
// re-activates a ready match and holds a calculating one, so a second run
// over unchanged inputs or a second sweep in a night enqueues nothing, and
// its job is sent in the route's transaction under the Plan's id, at the
// priority the batch class and the operating date give it. No provider is
// called here: the jobs call it, outside any transaction (#124 §4).
import type { Tx } from "@waste/db/client"
import { ensurePlan, planKey, planStopIds } from "@waste/db/commands/plans"
import { projectToday } from "@waste/db/query/project-clock"
import { pickup, route } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import { plan } from "@waste/db/schema/routing"
import { loggable } from "@waste/db/sqlstate"
import { withCompany } from "@waste/db/tenant"
import { orderIsOpen } from "@waste/domain/execution/transitions"
import { planAheadRunWindow } from "@waste/domain/planning/lifecycle"
import { answersRequest, horizonRequest, planIsStale } from "@waste/domain/routing/plans"
import type { PlanSolver, PlanStatus } from "@waste/domain/routing/vocabulary"
import { DEFAULT_PROFILE } from "@waste/routing/provider"
import { and, asc, eq, gt } from "drizzle-orm"

import type { RoutingContext } from "./engine"

/** How far the horizon reaches from tomorrow: a fixed week, whatever a scheme's own Plan Ahead window, since every Plan it asks spends the routing quota. */
export const HORIZON_DAYS = 7

/** The horizon on one project's clock: tomorrow through today + `HORIZON_DAYS`. */
export const horizonFrom = (today: string) => planAheadRunWindow(today, HORIZON_DAYS)
export type Horizon = ReturnType<typeof horizonFrom>

/**
 * What one route's turn came to: a Plan asked for (written, or found in the
 * cache), an active Plan that still answers the route, a dispatcher's own
 * Optimise left to answer, or not a route of the horizon at all.
 */
export type Turn = "asked" | "fresh" | "waiting" | "outside"

/** When a route is asked for: generation's reshaped route whatever its Plan reads; the sweep's only when its active Plan is missing or no longer answers it. */
export type Occasion = "reshaped" | "unanswered"

async function activePlanOf(tx: Tx, companyId: string, planId: string): Promise<{ id: string; solver: PlanSolver; status: PlanStatus; fingerprint: string; named: string[] } | null> {
  const [row] = await tx
    .select({ solver: plan.solver, status: plan.status, fingerprint: plan.fingerprint })
    .from(plan)
    .where(and(eq(plan.companyId, companyId), eq(plan.id, planId)))
  if (row === undefined) return null
  return { id: planId, solver: row.solver, status: row.status, fingerprint: row.fingerprint, named: await planStopIds(tx, { companyId, planId }) }
}

/** Whether an optimiser Plan asked after `planId` is still calculating on the route — Plan ids are UUIDv7, so asked later is a greater id: a dispatcher's Optimise after their reorder. */
async function optimisationAskedAfter(tx: Tx, companyId: string, routeId: string, planId: string): Promise<boolean> {
  const [waiting] = await tx
    .select({ id: plan.id })
    .from(plan)
    .where(and(eq(plan.companyId, companyId), eq(plan.routeId, routeId), eq(plan.solver, "optimiser"), eq(plan.status, "calculating"), gt(plan.id, planId)))
    .limit(1)
  return waiting !== undefined
}

/**
 * One route's turn, in a fenced transaction under its row lock: a planned or
 * ready route of an active project, operating inside the horizon with an
 * open stop, is asked a Plan through the office's door, `batch`. The sweep
 * leaves one whose active Plan still answers it — has not failed, names its
 * stops as they stand, a manual or baseline Plan in their order, and keys the
 * request it would make now, its ends and places too — and either leaves a
 * route whose dispatcher asked to optimise after reordering.
 */
export async function planRoute(context: RoutingContext, companyId: string, routeId: string, horizon: Horizon, occasion: Occasion): Promise<Turn> {
  return withCompany(context.api.db, companyId, async (tx: Tx): Promise<Turn> => {
    const [row] = await tx
      .select({
        id: route.id,
        projectId: route.projectId,
        status: route.status,
        operatingDate: route.operatingDate,
        plannedStartTime: route.plannedStartTime,
        plannedDriverId: route.plannedDriverId,
        plannedVehicleId: route.plannedVehicleId,
        depotId: route.depotId,
        unloadingStationId: route.unloadingStationId,
        activePlanId: route.activePlanId,
      })
      .from(route)
      .where(and(eq(route.companyId, companyId), eq(route.id, routeId)))
      .for("update")
    if (row === undefined || !orderIsOpen(row.status) || row.operatingDate < horizon.from || row.operatingDate > horizon.to) return "outside"
    // A project still onboarding spends no routing quota: the horizon is an active project's (#132 §2).
    const [owner] = await tx
      .select({ status: project.status })
      .from(project)
      .where(and(eq(project.companyId, companyId), eq(project.id, row.projectId)))
    if (owner?.status !== "active") return "outside"
    const stops = await tx
      .select({ id: pickup.id, status: pickup.status, reason: pickup.reason })
      .from(pickup)
      .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId)))
      .orderBy(asc(pickup.position), asc(pickup.id))
    const open = stops.filter((stop) => stop.status === "planned").map((stop) => stop.id)
    // Nothing open is no order to measure: a route whose rule matched nothing, or whose stops are all decided.
    if (open.length === 0) return "outside"
    const active = row.activePlanId === null ? null : await activePlanOf(tx, companyId, row.activePlanId)
    const optimisationWaiting = active?.solver === "manual" && (await optimisationAskedAfter(tx, companyId, routeId, active.id))
    const request = horizonRequest({ open, hasDepot: row.depotId !== null, hasStation: row.unloadingStationId !== null, active, optimisationWaiting })
    if (request === null) return "waiting"
    const routing = { name: context.routing.name, profile: DEFAULT_PROFILE }
    // A failed active Plan answers nothing (#231): `ensurePlan` reuses only a ready or calculating match, so the route is asked a new Plan.
    if (occasion === "unanswered" && active !== null && active.status !== "failed") {
      const removed = stops.filter((stop) => stop.status === "skipped" && stop.reason === "regeneration").map((stop) => stop.id)
      const keysRequest = !planIsStale({ named: active.named, open, removed }) && (await planKey(tx, companyId, row, request, routing)).fingerprint === active.fingerprint
      // The fingerprint keys places, so two stops at one address that trade places key alike (#212): a Plan that keys the request, of its solver, must name its very stops too.
      if (keysRequest && answersRequest({ solver: request.solver, status: active.status, named: active.named, asked: request.orderedPickupIds })) return "fresh"
    }
    await ensurePlan(tx, companyId, row, { ...request, class: "batch" }, { routing, send: context.send })
    return "asked"
  })
}

export type ReshapedRoute = { id: string; operatingDate: string }

/** What the horizon did for a run's routes: those it asked a Plan for, nearest date first, and those whose turn failed. */
export type HorizonAsks = { asked: string[]; failed: string[] }

/**
 * Generation's routing jobs (#124 §4: outside the generation transaction):
 * after a run has committed, a Plan asked for each route it created or
 * reshaped that operates inside the horizon on the project's clock, nearest
 * date first. Never throws: a failure is a line in the log, and the route
 * waits for the night's sweep.
 */
export async function planReshaped(context: RoutingContext, scope: { companyId: string; projectId: string }, routes: readonly ReshapedRoute[]): Promise<HorizonAsks> {
  const asks: HorizonAsks = { asked: [], failed: [] }
  if (routes.length === 0) return asks
  let horizon: Horizon
  try {
    horizon = horizonFrom(await withCompany(context.api.db, scope.companyId, (tx: Tx) => projectToday(tx, scope, context.now)()))
  } catch (error) {
    context.log(`routing: project ${scope.projectId}'s horizon could not be read (${JSON.stringify(loggable(error))}); its routes wait for the night's sweep`)
    return { asked: [], failed: routes.map((row) => row.id) }
  }
  const inside = routes
    .filter((row) => row.operatingDate >= horizon.from && row.operatingDate <= horizon.to)
    .sort((left, right) => left.operatingDate.localeCompare(right.operatingDate) || left.id.localeCompare(right.id))
  for (const row of inside) {
    try {
      if ((await planRoute(context, scope.companyId, row.id, horizon, "reshaped")) === "asked") asks.asked.push(row.id)
    } catch (error) {
      context.log(`routing: route ${row.id} was asked no Plan (${JSON.stringify(loggable(error))}); the night's sweep asks again`)
      asks.failed.push(row.id)
    }
  }
  return asks
}

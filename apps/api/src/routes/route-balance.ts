// Balancing a day across vehicles (O15 of #290, the third part of #350):
// `POST /routes/balance-preview` weighs one project's routes of an operating
// day that have not started — each route's load against its planned vehicle's
// payload and its work against its planned driver's shift, as the route read
// weighs them (`workloadsByRoute`, `shiftsByRoute`, the active Plan's drive,
// waiting and unload visits) — and answers the moves the domain's balance
// proposes (`balanceDay`, @waste/domain/routing/balance), every route before
// and after them, and a token over the day as it read it. Nothing moves.
//
// `POST /routes/balance` applies the moves the office accepted of a preview,
// all or some, never one it did not propose: under every route of the day's
// row lock, in id order, it reads the day again, refuses a token that no
// longer matches (409: preview it again), and moves each stop through O23's
// own move (`moveStops`, routes/stop-moves.ts) — taken off where it stood and
// the office's stop of the same work added on the other route, naming the one
// it came from — so no route is created or cancelled and the next generation
// run keeps the moves. Each route the moves touched is then asked a new Plan
// through the office's door (`ensurePlan`, `interactive`): one optimisation a
// route of up to fifty stops, its parts above that, a baseline above ten
// parts or without a depot.
import { createHash } from "node:crypto"

import { RouteBalanceApply, RouteBalanceDay, RouteBalancePreview, RouteBalanceResult } from "@waste/contracts/routes"
import type { Tx } from "@waste/db/client"
import { routeTiming } from "@waste/db/commands/stop-timing"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { plan, planStop } from "@waste/db/schema/routing"
import type { JobSender } from "@waste/db/jobs"
import { stopLoadKg } from "@waste/domain/execution/workload"
import type { PickupService, PickupStatus } from "@waste/domain/execution/vocabulary"
import { balanceDay, type BalanceRoute, type BalanceStop } from "@waste/domain/routing/balance"
import { optimiseSolver } from "@waste/domain/routing/plans"
import type { RoutingIdentity } from "@waste/routing/provider"
import { and, asc, count, eq, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { findRoute, pickupsOfRoute, routeColumns, routeScope, type PickupRow, type RouteRow } from "./execution-shapes"
import { fitsOf } from "./fleet-fit"
import { ensurePlan } from "./plan-shapes"
import type { ClockOptions } from "./scheme-groups"
import { describeJson, lockRows } from "./shared"
import { moveStops } from "./stop-moves"
import { shiftsByRoute, workloadsByRoute } from "./workload"

const PICKUPS = "route-studio.pickups"

/** What the apply answers a token that no longer says the day: something moved since the preview. */
export const DAY_CHANGED = "The day's routes changed since the balance was previewed; preview it again"

/** What the apply answers a move the balance did not propose, at `moves`. */
export const NOT_PROPOSED = "Not a move the balance proposes for this day; preview it again"

/** A position off a stored point. */
const positionOf = (point: { coordinates: readonly [number, number, number?] } | null): [number, number] | null => (point === null ? null : [point.coordinates[0], point.coordinates[1]])

/** The routes of a project's day the balance weighs: planned or ready, in id order. */
async function routesOfDay(tx: Tx, principal: Principal, day: RouteBalanceDay): Promise<RouteRow[]> {
  return await tx
    .select(routeColumns)
    .from(route)
    .where(and(routeScope(principal), eq(route.projectId, day.projectId), eq(route.operatingDate, day.operatingDate), inArray(route.status, ["planned", "ready"])))
    .orderBy(asc(route.id))
}

/** The token a preview answers: the day's routes and their stops as they were read, so an apply can tell nothing moved since. */
function tokenOf(routes: readonly RouteRow[], stops: readonly { id: string; routeId: string; status: string }[]): string {
  const lines = [
    ...routes.map((row) => `route ${row.id} ${row.updatedAt.toISOString()} ${row.activePlanId ?? "none"}`),
    ...stops.map((stop) => `stop ${stop.id} ${stop.routeId} ${stop.status}`),
  ].sort()
  return createHash("sha256").update(lines.join("\n")).digest("hex")
}

/** The day as the balance weighs it, with the token over what it read. */
async function weighDay(tx: Tx, principal: Principal, routes: readonly RouteRow[]): Promise<{ balanced: BalanceRoute[]; token: string }> {
  const { companyId } = principal
  const routeIds = routes.map((row) => row.id)
  const planIds = routes.flatMap((row) => (row.activePlanId === null ? [] : [row.activePlanId]))
  const vehicleIds = [...new Set(routes.flatMap((row) => (row.plannedVehicleId === null ? [] : [row.plannedVehicleId])))]
  const workloads = await workloadsByRoute(tx, companyId, routes)
  const [shifts, stops, plans, unloads, fits] = await Promise.all([
    shiftsByRoute(tx, companyId, routes, workloads),
    routeIds.length === 0
      ? []
      : tx
          .select({
            id: pickup.id,
            routeId: pickup.routeId,
            position: pickup.position,
            status: pickup.status,
            containerId: pickup.containerId,
            service: pickup.service,
            wasteFractionId: pickup.wasteFractionId,
            containerTypeId: container.containerTypeId,
            property: property.location,
            point: sharedCollectionPoint.location,
            volumeLitres: containerType.volumeLitres,
            densityKgPerCubicMetre: wasteFraction.densityKgPerCubicMetre,
          })
          .from(pickup)
          .leftJoin(property, and(eq(property.companyId, pickup.companyId), eq(property.id, pickup.propertyId)))
          .leftJoin(sharedCollectionPoint, and(eq(sharedCollectionPoint.companyId, pickup.companyId), eq(sharedCollectionPoint.id, pickup.sharedCollectionPointId)))
          .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
          .leftJoin(containerType, and(eq(containerType.companyId, container.companyId), eq(containerType.id, container.containerTypeId)))
          .leftJoin(wasteFraction, and(eq(wasteFraction.companyId, pickup.companyId), eq(wasteFraction.id, pickup.wasteFractionId)))
          .where(and(eq(pickup.companyId, companyId), inArray(pickup.routeId, routeIds)))
          .orderBy(asc(pickup.position), asc(pickup.id)),
    planIds.length === 0
      ? []
      : tx
          .select({ id: plan.id, durationSeconds: plan.durationSeconds, waitingSeconds: plan.waitingSeconds })
          .from(plan)
          .where(and(eq(plan.companyId, companyId), inArray(plan.id, planIds))),
    planIds.length === 0
      ? []
      : tx
          .select({ planId: planStop.planId, visits: count() })
          .from(planStop)
          .where(and(eq(planStop.companyId, companyId), inArray(planStop.planId, planIds), eq(planStop.kind, "unload")))
          .groupBy(planStop.planId),
    fitsOf(tx, companyId, vehicleIds),
  ])
  const measured = new Map(plans.map((row) => [row.id, row] as const))
  const visits = new Map(unloads.map((row) => [row.planId, row.visits] as const))
  const stopsByRoute = Map.groupBy(stops, (stop) => stop.routeId)
  const balanced: BalanceRoute[] = []
  for (const row of routes) {
    const own = stopsByRoute.get(row.id) ?? []
    // Each open stop's window and its seconds at the kerb, on the clock the optimiser is sent (O14 of #290).
    const timing = await routeTiming(
      tx,
      companyId,
      row,
      own.filter((stop) => stop.status === "planned").map((stop) => stop.id),
    )
    const workload = workloads.get(row.id)
    const active = row.activePlanId === null ? undefined : measured.get(row.activePlanId)
    balanced.push({
      id: row.id,
      serviceProviderId: row.plannedServiceProviderId,
      // The planned vehicle as a move judges it (O7 of #290): its compartments' fractions, the containers its type lifts, one trip's weight.
      vehicle: row.plannedVehicleId === null ? null : (fits.get(row.plannedVehicleId) ?? null),
      capacityKg: workload?.capacityKg ?? null,
      shift: shifts.get(row.id)?.shift ?? null,
      plannedStartTime: row.plannedStartTime,
      driveSeconds: active?.durationSeconds ?? null,
      waitingSeconds: active?.waitingSeconds ?? null,
      unloads: active === undefined ? 0 : (visits.get(active.id) ?? 0),
      kg: workload?.expectedKg ?? 0,
      stopSeconds: workload?.stopSeconds ?? 0,
      stops: own.map((stop): BalanceStop => {
        const timed = timing.stops.get(stop.id)
        const window = timed?.window ?? null
        return {
          id: stop.id,
          position: stop.position,
          status: stop.status as PickupStatus,
          containerId: stop.containerId,
          service: stop.service as PickupService,
          at: positionOf(stop.property) ?? positionOf(stop.point),
          kg: stopLoadKg({ service: stop.service as PickupService, volumeLitres: stop.volumeLitres, densityKgPerCubicMetre: stop.densityKgPerCubicMetre }) ?? 0,
          serviceSeconds: timed?.serviceSeconds ?? 0,
          wasteFractionId: stop.wasteFractionId,
          containerTypeId: stop.containerTypeId,
          // A stop whose two windows never meet is served at no time of the day: it is not moved.
          window: window === "disjoint" ? [0, 0] : window,
        }
      }),
    })
  }
  return { balanced, token: tokenOf(routes, stops) }
}

/** The preview a day answers: the moves, every route before and after, the token. */
async function previewOf(tx: Tx, principal: Principal, routes: readonly RouteRow[]): Promise<RouteBalancePreview> {
  const { balanced, token } = await weighDay(tx, principal, routes)
  const { moves, routes: weighed } = balanceDay(balanced)
  return { token, moves, routes: weighed }
}

export type RouteBalanceOptions = ClockOptions & { routing: RoutingIdentity; jobs: JobSender }

export function routeBalanceRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date(), routing, jobs }: RouteBalanceOptions) {
  return new Hono<AuthEnv>()
    .post(
      "/routes/balance-preview",
      describeRoute({
        operationId: "previewRouteBalance",
        summary: "Propose balancing a day's routes",
        description:
          "Weighs the project's routes of `operatingDate` that are `planned` or `ready` (O15 of #290) — each one's expected kilograms against its planned vehicle's payload, and its work against its planned driver's shift as the route read weighs it: its active Plan's drive and waiting, its stops' time at the kerb, its unload visits on the way and the break — and proposes moving open stops off the routes that run over either onto routes of the day that can take them and stay within both: of the same service provider (or the company's own), whose vehicle carries the stop's fraction, lifts its container and takes its weight on one trip (O7 of #290, as a move judges it), that do not empty its container already, and whose working day reaches the stop's window. Each round moves, off the route furthest over, the stop that costs a receiving route least, at most fifty moves. Distances are straight lines read as roads, so `after` is an estimate until the routes are measured again. Nothing moves: `POST /routes/balance` applies what the office accepts, with the `token` this answers.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The moves, every route of the day before and after them, and the day's token.", RouteBalancePreview),
          400: describeProblem("The body names a project the caller does not work in, or is not a day of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `route-studio.pickups`."),
        },
      }),
      guard,
      requireGrant(PICKUPS, "edit"),
      validate("json", RouteBalanceDay),
      async (c) => {
        const day = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, day.projectId)
        return c.json(await previewOf(tx, principal, await routesOfDay(tx, principal, day)))
      },
    )
    .post(
      "/routes/balance",
      describeRoute({
        operationId: "applyRouteBalance",
        summary: "Apply a day's balance",
        description:
          "Moves the stops of a balance preview the office accepted — all of its moves or some, each once, never one it did not propose (400 at `moves`) — under every route of the day's row lock, taken in id order. The day is read again and its token compared with the preview's: anything that moved since is a 409, and the balance is previewed again. Each stop is moved as `POST /routes/{id}/move-stops` moves one (O23 of #290): taken off where it stood, `removed-by-dispatcher`, and the office's stop of the same work added on the other route, naming the stop it came from, so the move outlives the next generation run; a refusal there rolls back every move. Each route the moves touched that still has open stops is then asked a new Plan, `interactive`: one optimisation call a route of up to fifty stops, one a part above that, a baseline measurement above ten parts or without a depot.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("How many stops moved, and the Plan each touched route was asked.", RouteBalanceResult),
          400: describeProblem("The body names a project the caller does not work in, no move, one stop twice, or a move the balance does not propose."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `route-studio.pickups`."),
          409: describeProblem("The day changed since the preview, or a stop is refused where it would go; the detail says which."),
          503: describeProblem("The worker has not made its routing queues yet."),
        },
      }),
      guard,
      requireGrant(PICKUPS, "edit"),
      validate("json", RouteBalanceApply),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const unlocked = await routesOfDay(tx, principal, body)
        await lockRows(
          tx,
          route,
          principal.companyId,
          unlocked.map((row) => row.id),
        )
        const routes = await routesOfDay(tx, principal, body)
        const preview = await previewOf(tx, principal, routes)
        if (preview.token !== body.token) throw problem(409, { detail: DAY_CHANGED })
        const proposed = new Map(preview.moves.map((move) => [move.pickupId, move] as const))
        const errors = body.moves.flatMap((move, index) => (proposed.get(move.pickupId)?.toRouteId === move.toRouteId ? [] : [{ path: `moves.${index}`, message: NOT_PROPOSED }]))
        if (errors.length > 0) throw invalidRequest("body", errors)
        // The accepted moves, in the order the balance proposed them, grouped by the routes they leave and join.
        const accepted = new Set(body.moves.map((move) => move.pickupId))
        const groups = new Map<string, { from: string; to: string; pickupIds: string[] }>()
        for (const move of preview.moves) {
          if (!accepted.has(move.pickupId)) continue
          const key = `${move.fromRouteId} ${move.toRouteId}`
          const group = groups.get(key) ?? { from: move.fromRouteId, to: move.toRouteId, pickupIds: [] }
          group.pickupIds.push(move.pickupId)
          groups.set(key, group)
        }
        const byId = new Map(routes.map((row) => [row.id, row] as const))
        const at = now()
        for (const group of groups.values()) {
          const stops = await pickupsOfRoute(tx, principal.companyId, group.from)
          const moving = group.pickupIds.map((id) => stops.find((row) => row.id === id) as PickupRow)
          await moveStops(tx, principal, byId.get(group.from) as RouteRow, byId.get(group.to) as RouteRow, moving, at)
        }
        // Each route touched is asked a new Plan over its open stops as they now stand.
        const touched = [...new Set([...groups.values()].flatMap((group) => [group.from, group.to]))].sort()
        const asked: RouteBalanceResult["routes"] = []
        for (const routeId of touched) {
          const current = await findRoute(tx, principal, routeId)
          if (current === undefined) continue
          const open = (await pickupsOfRoute(tx, principal.companyId, routeId)).filter((stop) => stop.status === "planned")
          if (open.length === 0) {
            asked.push({ routeId, planId: null })
            continue
          }
          const { solver } = optimiseSolver({ openStops: open.length, hasDepot: current.depotId !== null, hasStation: current.unloadingStationId !== null })
          const { planId } = await ensurePlan(tx, principal, current, { solver, orderedPickupIds: open.map((stop) => stop.id) }, { routing, jobs })
          asked.push({ routeId, planId })
        }
        return c.json({ moved: accepted.size, routes: asked } satisfies RouteBalanceResult)
      },
    )
}

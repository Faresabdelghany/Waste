// A route's track and its estimates (O8 of #290, decided on #344):
// `GET /routes/:id/positions`, one session's positions in the order they
// were taken, and `GET /routes/:id/eta`, each stop of the active Plan with
// the instant the vehicle is expected there. Both read under the Live
// board's grant, `route-studio.live` `view`, and the routes' reach
// (`findReachedRoute`): an office account reads the routes of its projects,
// a Service Provider's account the routes it serves, and any other route is
// the family's 404. There is no read of a driver's positions across routes,
// and the driver door reads none.
//
// The track is the route's open session's, else its latest's, unless
// `sessionId` names another of the route's own (400 at the query otherwise).
// A track longer than `TRACK_POINTS_MAX` is thinned evenly in the statement
// that reads it, every n-th point and the last, and says so, so a long day
// costs one bounded answer.
//
// The estimates are @waste/domain/routing/eta over what this module reads:
// the active Plan's stops and its legs' seconds, the route's stops as they
// stand, and the optimiser's clock of the route (`routeTiming`, the read the
// Plan was asked with: each stop's window and kerb time, the departure). The
// times of the operating day become instants on the project's clock
// (`instantOnDay`). The Live board reads the same estimates for each of its
// routes (`liveEtaOf`).
import { RouteEta, RouteTrack, RouteTrackQuery, type LiveEta, type Position } from "@waste/contracts/positions"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { instantOnDay } from "@waste/domain/clock"
import { routeTiming } from "@waste/db/commands/stop-timing"
import { pickup, session, sessionPosition } from "@waste/db/schema/execution"
import { projectTimezone } from "@waste/db/query/project-clock"
import { plan, planLeg } from "@waste/db/schema/routing"
import { routeEta, type EtaStop } from "@waste/domain/routing/eta"
import { POSITION_RETENTION_DAYS, TRACK_POINTS_MAX } from "@waste/domain/execution/positions"
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import type { RouteRow } from "@waste/db/shapes/routes"
import type { RouteDeps } from "../deps"
import { describeJson, IdParam, routes } from "../operation"
import { describeProblem, invalidRequest } from "../problem"
import { getReachedRoute } from "./execution-shapes"
import { planStopsByPlan } from "./plan-shapes"

const MODULE = "route-studio.live"

/** What a sessionId that is not one of the route's own is told. */
export const NOT_A_SESSION_OF_THE_ROUTE = "Not a session of this route"

/** A position row on the wire. */
const positionOf = (row: { fixedAt: Date | string; location: unknown; accuracyM: number; speedKmh: number | null; headingDeg: number | null }): Position => ({
  at: new Date(row.fixedAt).toISOString(),
  // The column is `geometry(Point, 4326)`, flat: what it holds is the contracts' `FlatPoint`.
  location: row.location as FlatPoint,
  accuracyM: row.accuracyM,
  speedKmh: row.speedKmh,
  headingDeg: row.headingDeg,
})

/** One session's track in order, thinned to `TRACK_POINTS_MAX` evenly with its last point kept, in one statement. */
async function trackOf(tx: Tx, companyId: string, sessionId: string): Promise<{ points: Position[]; thinned: boolean }> {
  const [{ total }] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(sessionPosition)
    .where(and(eq(sessionPosition.companyId, companyId), eq(sessionPosition.sessionId, sessionId)))
  const step = Math.max(1, Math.ceil(total / TRACK_POINTS_MAX))
  const rows = await tx.execute<{ fixed_at: string; location: string; accuracy_m: number; speed_kmh: number | null; heading_deg: number | null }>(sql`
    select fixed_at, extensions.st_asgeojson(location) as location, accuracy_m, speed_kmh, heading_deg
      from (
        select sp.*, row_number() over (order by sp.fixed_at, sp.id) as n
          from wms.session_position sp
         where sp.company_id = ${companyId} and sp.session_id = ${sessionId}
      ) numbered
     where (n - 1) % ${step} = 0 or n = ${total}
     order by fixed_at, id
  `)
  const points = rows.map((row) => positionOf({ fixedAt: row.fixed_at, location: JSON.parse(row.location), accuracyM: row.accuracy_m, speedKmh: row.speed_kmh, headingDeg: row.heading_deg }))
  // Thinned to the step, and the last kept, the count can pass the bound by one: drop the point before the last.
  if (points.length > TRACK_POINTS_MAX) points.splice(points.length - 2, 1)
  return { points, thinned: step > 1 }
}

/** The newest position of each open session named, by session, in one statement. */
export async function newestPositionsBySession(tx: Tx, companyId: string, sessionIds: readonly string[]): Promise<Map<string, Position>> {
  if (sessionIds.length === 0) return new Map()
  const rows = await tx
    .selectDistinctOn([sessionPosition.sessionId], { sessionId: sessionPosition.sessionId, fixedAt: sessionPosition.fixedAt, location: sessionPosition.location, accuracyM: sessionPosition.accuracyM, speedKmh: sessionPosition.speedKmh, headingDeg: sessionPosition.headingDeg })
    .from(sessionPosition)
    .where(and(eq(sessionPosition.companyId, companyId), inArray(sessionPosition.sessionId, [...sessionIds])))
    .orderBy(asc(sessionPosition.sessionId), desc(sessionPosition.fixedAt))
  return new Map(rows.map((row) => [row.sessionId, positionOf(row)] as const))
}

/** A route's estimates as instants: the active Plan's stops with each one's, and the trip's end. */
export type RouteEtaReading = { planId: string | null; stops: { kind: "pickup" | "unload"; pickupId: string | null; position: number; eta: Date | null }[]; finishAt: Date | null }

/** The route's estimates at `now`, over its active Plan, its stops and its clock. */
export async function routeEtaOf(tx: Tx, companyId: string, routeRow: RouteRow, now: Date): Promise<RouteEtaReading> {
  if (routeRow.activePlanId === null) return { planId: null, stops: [], finishAt: null }
  const [planRow] = await tx
    .select({ id: plan.id, status: plan.status, trip: plan.trip })
    .from(plan)
    .where(and(eq(plan.companyId, companyId), eq(plan.id, routeRow.activePlanId)))
    .limit(1)
  if (planRow === undefined) return { planId: null, stops: [], finishAt: null }
  const [planStops, legRows, stopRows, timeZone] = await Promise.all([
    planStopsByPlan(tx, companyId, [planRow.id]).then((byPlan) => byPlan.get(planRow.id) ?? []),
    tx
      .select({ seconds: planLeg.seconds })
      .from(planLeg)
      .where(and(eq(planLeg.companyId, companyId), eq(planLeg.planId, planRow.id)))
      .orderBy(asc(planLeg.position)),
    tx
      .select({ id: pickup.id, status: pickup.status, reason: pickup.reason, outcomeAt: pickup.outcomeAt, arrivedAt: pickup.arrivedAt })
      .from(pickup)
      .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeRow.id))),
    projectTimezone(tx, companyId, routeRow.projectId),
  ])
  const named = planStops.flatMap((row) => (row.kind === "pickup" && row.pickupId !== null ? [row.pickupId] : []))
  const timing = await routeTiming(tx, companyId, routeRow, named)
  const onDay = (seconds: number) => instantOnDay(routeRow.operatingDate, seconds, timeZone).getTime()
  const stops = new Map(stopRows.map((row) => [row.id, row] as const))
  // A Plan stop names a pickup of its own route by its key; one somehow gone is left out of the trip, not invented.
  const visited = planStops.filter((row) => row.kind === "unload" || (row.pickupId !== null && stops.has(row.pickupId)))
  const etaStops: EtaStop[] = visited.map((row) => {
    if (row.kind === "unload") return { kind: "unload" }
    const stop = stops.get(row.pickupId as string)!
    const clock = timing.stops.get(stop.id)
    const window = clock?.window ?? null
    return {
      kind: "pickup",
      pickupId: stop.id,
      status: stop.status,
      reason: stop.reason,
      outcomeAt: stop.outcomeAt?.getTime() ?? null,
      arrivedAt: stop.arrivedAt?.getTime() ?? null,
      serviceSeconds: clock?.serviceSeconds ?? 0,
      window: window === null || window === "disjoint" ? window : [onDay(window[0]), onDay(window[1])],
    }
  })
  const reading = routeEta({
    routeStatus: routeRow.status,
    startedAt: routeRow.startedAt?.getTime() ?? null,
    plannedDeparture: timing.departure === null ? null : onDay(timing.departure),
    trip: planRow.trip,
    stops: etaStops,
    // A Plan's legs are written with its `ready` and never before; a stop dropped from the trip leaves legs that are no longer its, which the domain refuses to read.
    legs: planRow.status === "ready" && visited.length === planStops.length ? legRows.map((row) => row.seconds) : null,
    now: now.getTime(),
  })
  return {
    planId: planRow.id,
    stops: visited.map((row, index) => ({ kind: row.kind === "unload" ? "unload" : "pickup", pickupId: row.pickupId, position: row.position, eta: reading.stops[index].eta === null ? null : new Date(reading.stops[index].eta as number) })),
    finishAt: reading.finishAt === null ? null : new Date(reading.finishAt),
  }
}

/** What the Live board shows of a route's estimates: the first pickup still to come with an estimate, and the trip's end; null without an active Plan. */
export async function liveEtaOf(tx: Tx, companyId: string, routeRow: RouteRow, now: Date): Promise<LiveEta | null> {
  const reading = await routeEtaOf(tx, companyId, routeRow, now)
  if (reading.planId === null) return null
  const next = reading.stops.find((stop) => stop.kind === "pickup" && stop.eta !== null)
  return { nextPickupId: next?.pickupId ?? null, nextAt: next?.eta?.toISOString() ?? null, finishAt: reading.finishAt?.toISOString() ?? null }
}

export function positionRoutes(deps: RouteDeps) {
  const { now } = deps
  return routes(deps)
    .get(
      "/routes/:id/positions",
      {
        operationId: "getRouteTrack",
        summary: "One session's track of a route",
        description: `Where the route's vehicle was while a session ran (O8 of #290): the positions the Driver App recorded, in the order they were taken — the route's open session's, else its latest's, unless \`sessionId\` names another session of this route. A track longer than ${TRACK_POINTS_MAX} points is thinned evenly, its last point kept, and \`thinned\` says so; a route never started answers no session and no points. Positions are kept ${POSITION_RETENTION_DAYS} days at most, so an older session's track is empty. Read per route only: an office account reads the routes of its projects, a Service Provider's account the routes it serves.`,
        module: MODULE,
        action: "view",
        params: IdParam,
        query: RouteTrackQuery,
        invalid: ["`sessionId` is not a session of this route"],
        responses: {
          200: describeJson("The track.", RouteTrack),
          404: describeProblem("No route with that id that this account reads."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { sessionId } = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const routeRow = await getReachedRoute(tx, principal, id)
        const sessions = await tx
          .select({ id: session.id, endedAt: session.endedAt })
          .from(session)
          .where(and(eq(session.companyId, principal.companyId), eq(session.routeId, routeRow.id), sessionId === undefined ? undefined : eq(session.id, sessionId)))
          .orderBy(asc(isNull(session.endedAt)), asc(session.id))
        if (sessionId !== undefined && sessions.length === 0) throw invalidRequest("query", [{ path: "sessionId", message: NOT_A_SESSION_OF_THE_ROUTE }])
        // The open session sorts last, then the latest by id: the one the board means.
        const chosen = sessions.at(-1)
        const body: RouteTrack = chosen === undefined ? { routeId: routeRow.id, sessionId: null, points: [], thinned: false } : { routeId: routeRow.id, sessionId: chosen.id, ...(await trackOf(tx, principal.companyId, chosen.id)) }
        return c.json(body)
      },
    )
    .get(
      "/routes/:id/eta",
      {
        operationId: "getRouteEta",
        summary: "When the route's vehicle is expected at each stop",
        description:
          "Each stop of the route's active Plan, in its order, with `eta`, the instant the vehicle is expected there (O8 of #290): the Plan's legs from the route's start — or, before it starts, its planned departure and never earlier than now — each stop's time at the kerb, the wait for a stop's window that has not opened, as the optimiser waits, fifteen minutes at each unload visit on the way, and the progress so far: a stop the driver decided is passed and the estimates go on from its outcome, a stop the vehicle is at is arrived, and on a running route no stop still to come is expected before now. `eta` is null for a stop passed and for every stop of a route that has ended, or whose Plan is not measured, or that has no departure; a stop the active Plan does not name has no row, and a route without one answers no stops. The driver's break is not placed, so a stop after it may be expected early by its minutes. `finishAt` is when the trip is expected to end.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The estimates.", RouteEta),
          404: describeProblem("No route with that id that this account reads."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const routeRow = await getReachedRoute(tx, principal, id)
        const at = now()
        const reading = await routeEtaOf(tx, principal.companyId, routeRow, at)
        const body: RouteEta = {
          routeId: routeRow.id,
          planId: reading.planId,
          computedAt: at.toISOString(),
          stops: reading.stops.map((stop) => ({ ...stop, eta: stop.eta?.toISOString() ?? null })),
          finishAt: reading.finishAt?.toISOString() ?? null,
        }
        return c.json(body)
      },
    )
}

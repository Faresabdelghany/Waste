"use client"

// The route map's legs (#173, decided on #124 §5 and #132 §5): what the
// planning map draws of each dated route it shows, and what the route's card
// says of its routing, read off the route's active Plan alone. A route
// without one is the generated order, not measured, drawn dashed; a `ready`
// Plan's stored legs are fetched once (`GET /plans/:id`, only for a route
// the map draws) and drawn as the road; a `failed` one's sentence is fetched
// the same way; one still calculating is asked again every ten seconds while
// drawn, and not before its `deferredUntil` while the quota puts it off —
// MAX_PLANS_IN_FLIGHT at a time, the map's day first, then the days ahead,
// the past window last (`planFetchOrder`), each road built once as its Plan
// lands and the landed ones drawn together every REDRAW_MS, so a window of
// hundreds of routes draws tomorrow's roads in moments rather than one
// render per Plan. A
// route's Retry is Optimise (`POST /routes/:id/optimise`): the Plan it
// answers is the route's reading while the map holds it — an optimiser Plan
// becomes the active one only once ready (#124 §2), and the route's record
// is the list's reading until the store reads the list again. Without the
// API nothing is fetched: every route reads Not measured. The map's drawing
// code is planning-map.tsx's, fed the same road states the guided setup's
// preview feeds its map.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type { Plan, PlanDetail } from "@waste/contracts/plans"
import type { AreaRoute } from "@waste/domain/map-planning/routes"
import { useApiClient } from "@/components/waste/api-session-store"
import { useServerModuleState } from "@/components/waste/business-record-store"
import { useMinuteClock } from "@/components/waste/routing/use-routing-quota"
import { isApiProblem, problemSentence } from "@/lib/api/problem"
import { optimiseRoute, planDetail } from "@/lib/api/routing"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { activePlanOf, nextPlanFetch, PLAN_POLL_MS, planFetchOrder, planReading, routePlanOf, type PlanReading, type RoutePlan } from "@/lib/map-planning/plan-readings"
import { roadGeometryOfLegs, type RoadGeometry, type RoadSource } from "@/lib/map-planning/road-geometry"
import type { RoadGeometryState } from "@/lib/map-planning/road-geometry-cache"

import { forgetStoredRoads } from "./use-road-geometries"

export type PlanLegs = {
  /** What the overlay draws per route: the active Plan's legs where it has them, else the stops joined straight. */
  roads: ReadonlyMap<string, RoadGeometryState>
  /** What each route's card says of its routing. */
  readings: ReadonlyMap<string, PlanReading>
  /** Whose roads are drawn, for the attribution. */
  sources: readonly RoadSource[]
  /** Retry (= Optimise) for a route, or null where it cannot be asked: no API, or no row of the route on it. */
  retryFor: (routeId: string) => (() => void) | null
}

/** A Plan as the map last fetched it, its road built once as it landed: renders read it, never the legs again. */
type Fetched = { detail: PlanDetail; at: number; road: RoadGeometry | null }

const roadOf = (detail: PlanDetail): RoadGeometry | null =>
  detail.status === "ready" ? roadGeometryOfLegs(detail.legs, { provider: detail.provider, optimised: detail.solver === "optimiser" }) : null

/** Plans asked for at once, so a window of hundreds of routes does not land on the API's small pool in one go. */
export const MAX_PLANS_IN_FLIGHT = 4

/** How long landed Plans wait to be drawn together, so a window of hundreds redraws the map a few times, not once per Plan. */
export const REDRAW_MS = 100

/** `today` is the map's day, its routes' Plans asked for first (`planFetchOrder`). */
export function usePlanLegs(routes: readonly AreaRoute[], records: readonly BusinessRecord[], today: string): PlanLegs {
  const client = useApiClient()
  const routesModule = useServerModuleState("route-studio", "routes")
  const now = useMinuteClock()
  const [fetched, setFetched] = useState<ReadonlyMap<string, Fetched>>(() => new Map())
  const [missed, setMissed] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [retried, setRetried] = useState<ReadonlyMap<string, Plan>>(() => new Map())
  const [wake, setWake] = useState(0)
  const inFlight = useRef(new Map<string, AbortController>())
  /** The Plans the map draws now: what a landing fetch keeps beside itself, so the details held stay the drawn routes'. */
  const drawn = useRef(new Set<string>())
  /** The Plans due to be asked for, nearest first, as the last pass found them; a landing takes the next. */
  const due = useRef<RoutePlan[]>([])
  /** The Plans landed and the requests failed since the last redraw, and the redraw that will draw them. */
  const landed = useRef(new Map<string, Fetched>())
  const failed = useRef(new Map<string, number>())
  const redraw = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Asks for the next due Plans while fewer than MAX_PLANS_IN_FLIGHT are on their way: the latest pass's. */
  const ask = useRef<() => void>(() => {})
  /** Abandons every request and everything settled but not drawn, so the next pass asks for it all again. */
  const stopAsking = useCallback(() => {
    for (const controller of inFlight.current.values()) controller.abort()
    inFlight.current.clear()
    if (redraw.current !== null) clearTimeout(redraw.current)
    redraw.current = null
    landed.current = new Map()
    failed.current = new Map()
    due.current = []
    ask.current = () => {}
  }, [])

  const recordById = useMemo(() => new Map(records.map((record) => [record.id, record])), [records])

  const ordered = useMemo(() => planFetchOrder(routes, today), [routes, today])
  // The Plan each drawn route reads, at its freshest, in the order they are asked for.
  const plans = useMemo(() => {
    const byRoute = new Map<string, RoutePlan>()
    if (client === null) return byRoute
    for (const route of ordered) {
      const active = activePlanOf(recordById.get(route.id))
      const retry = retried.get(route.id) ?? null
      const baseId = (retry ?? active)?.id
      const plan = routePlanOf(active, retry, baseId === undefined ? undefined : fetched.get(baseId)?.detail)
      if (plan !== null) byRoute.set(route.id, plan)
    }
    return byRoute
  }, [client, fetched, ordered, recordById, retried])

  // Ask for what is due, and wake when the next thing will be. A request that
  // lands starts the next due one at once, outside React, and the landed
  // Plans are drawn together at most every REDRAW_MS: a render of the whole
  // map per Plan, not the API, was what a window of hundreds waited on.
  useEffect(() => {
    forgetStoredRoads()
    if (client === null) {
      // Signed out: nothing more is asked with the client that was.
      stopAsking()
      return
    }
    const at = Date.now()
    const wanted = new Map([...plans.values()].map((plan) => [plan.id, plan]))
    drawn.current = new Set(wanted.keys())
    for (const [id, controller] of inFlight.current) {
      if (wanted.has(id)) continue
      controller.abort()
      inFlight.current.delete(id)
    }
    let next = Number.POSITIVE_INFINITY
    const dueNow: RoutePlan[] = []
    for (const plan of wanted.values()) {
      if (inFlight.current.has(plan.id) || landed.current.has(plan.id) || failed.current.has(plan.id)) continue
      const failedAt = missed.get(plan.id)
      if (failedAt !== undefined && at - failedAt < PLAN_POLL_MS) {
        next = Math.min(next, failedAt + PLAN_POLL_MS)
        continue
      }
      const known = fetched.get(plan.id)
      const fetch = nextPlanFetch(plan, known?.detail, known?.at, at)
      if (fetch.kind === "at") next = Math.min(next, fetch.at)
      if (fetch.kind === "now") dueNow.push(plan)
    }
    due.current = dueNow
    const redrawSettled = () => {
      redraw.current = null
      const batch = landed.current
      const failures = failed.current
      landed.current = new Map()
      failed.current = new Map()
      // Only the drawn routes' details are kept: a Plan's legs are the heavy part of the map.
      if (batch.size > 0) setFetched((current) => new Map([...current, ...batch].filter(([id]) => drawn.current.has(id))))
      // Asked again a poll's length on, not at once.
      if (failures.size > 0) setMissed((current) => new Map([...current, ...failures]))
    }
    const settled = () => {
      redraw.current ??= setTimeout(redrawSettled, REDRAW_MS)
      ask.current()
    }
    const askNext = () => {
      while (inFlight.current.size < MAX_PLANS_IN_FLIGHT) {
        const plan = due.current.shift()
        if (plan === undefined) return
        if (inFlight.current.has(plan.id) || landed.current.has(plan.id) || failed.current.has(plan.id) || !drawn.current.has(plan.id)) continue
        const controller = new AbortController()
        inFlight.current.set(plan.id, controller)
        planDetail(client, plan.id, controller.signal).then(
          (detail) => {
            if (controller.signal.aborted) return
            inFlight.current.delete(plan.id)
            // The road is all the map draws of the legs, so they are not kept beside it.
            landed.current.set(plan.id, { detail: { ...detail, legs: [] }, at: Date.now(), road: roadOf(detail) })
            settled()
          },
          () => {
            if (controller.signal.aborted) return
            inFlight.current.delete(plan.id)
            failed.current.set(plan.id, Date.now())
            settled()
          },
        )
      }
    }
    // A request of an earlier pass asks on with this pass's client and list.
    ask.current = askNext
    askNext()
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setWake((count) => count + 1), Math.max(0, next - at))
    return () => clearTimeout(timer)
  }, [client, fetched, missed, plans, stopAsking, wake])

  // Nothing left in flight once the map goes, and nothing settled left undrawn: shown again, it asks again.
  useEffect(() => stopAsking, [stopAsking])

  const { roads, readings, sources } = useMemo(() => {
    const roadStates = new Map<string, RoadGeometryState>()
    const routeReadings = new Map<string, PlanReading>()
    const drawn: RoadSource[] = []
    for (const route of routes) {
      const plan = plans.get(route.id) ?? null
      const reading = planReading(plan, now)
      routeReadings.set(route.id, reading)
      const known = plan === null ? undefined : fetched.get(plan.id)
      const road = plan?.status === "ready" ? (known?.road ?? null) : null
      if (road !== null) {
        // The pickups stay the markers: the legs run from the depot and back to it.
        roadStates.set(route.id, { status: "ready", geometry: { ...road, snappedStops: route.stops.map((stop) => stop.lngLat) } })
        drawn.push(road.source)
      } else if (plan?.status === "ready") {
        roadStates.set(route.id, { status: "pending" })
      } else {
        // No road to draw: the Plan's own reading says why; it stands until the Plan moves, which the fetches above follow.
        roadStates.set(route.id, { status: "estimate", resumesAt: plan?.deferredUntil ?? null, reason: reading.sentence, standsUntil: Number.POSITIVE_INFINITY })
      }
    }
    return { roads: roadStates, readings: routeReadings, sources: drawn }
  }, [fetched, now, plans, routes])

  const retryFor = useCallback(
    (routeId: string) => {
      const serverId = routesModule?.serverIds.get(routeId)
      if (client === null || serverId === undefined) return null
      return () => {
        optimiseRoute(client, serverId).then(
          (answer) => setRetried((current) => new Map(current).set(routeId, answer)),
          (error: unknown) => toast.error("Routing was not asked again", { description: isApiProblem(error) ? problemSentence(error.problem) : undefined }),
        )
      }
    },
    [client, routesModule],
  )

  return { roads, readings, sources, retryFor }
}

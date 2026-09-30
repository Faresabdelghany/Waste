"use client"

// The route map's legs (#173, decided on #124 §5 and #132 §5): what the
// planning map draws of each dated route it shows, and what the route's card
// says of its routing, read off the route's active Plan alone. A route
// without one is the generated order, not measured, drawn dashed; a `ready`
// Plan's stored legs are fetched once (`GET /plans/:id`, only for a route
// the map draws) and drawn as the road; a `failed` one's sentence is fetched
// the same way; one still calculating is asked again every ten seconds while
// drawn, and not before its `deferredUntil` while the quota puts it off. A
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
import { activePlanOf, nextPlanFetch, PLAN_POLL_MS, planReading, routePlanOf, type PlanReading, type RoutePlan } from "@/lib/map-planning/plan-readings"
import { roadGeometryOfLegs, type RoadSource } from "@/lib/map-planning/road-geometry"
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

type Fetched = { detail: PlanDetail; at: number }

export function usePlanLegs(routes: readonly AreaRoute[], records: readonly BusinessRecord[]): PlanLegs {
  const client = useApiClient()
  const routesModule = useServerModuleState("route-studio", "routes")
  const now = useMinuteClock()
  const [fetched, setFetched] = useState<ReadonlyMap<string, Fetched>>(() => new Map())
  const [missed, setMissed] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [retried, setRetried] = useState<ReadonlyMap<string, Plan>>(() => new Map())
  const [wake, setWake] = useState(0)
  const inFlight = useRef(new Map<string, AbortController>())

  const recordById = useMemo(() => new Map(records.map((record) => [record.id, record])), [records])

  // The Plan each drawn route reads, at its freshest.
  const plans = useMemo(() => {
    const byRoute = new Map<string, RoutePlan>()
    if (client === null) return byRoute
    for (const route of routes) {
      const active = activePlanOf(recordById.get(route.id))
      const retry = retried.get(route.id) ?? null
      const baseId = (retry ?? active)?.id
      const plan = routePlanOf(active, retry, baseId === undefined ? undefined : fetched.get(baseId)?.detail)
      if (plan !== null) byRoute.set(route.id, plan)
    }
    return byRoute
  }, [client, fetched, recordById, retried, routes])

  // Ask for what is due, and wake when the next thing will be.
  useEffect(() => {
    forgetStoredRoads()
    if (client === null) return
    const at = Date.now()
    const wanted = new Map([...plans.values()].map((plan) => [plan.id, plan]))
    for (const [id, controller] of inFlight.current) {
      if (wanted.has(id)) continue
      controller.abort()
      inFlight.current.delete(id)
    }
    let next = Number.POSITIVE_INFINITY
    for (const plan of wanted.values()) {
      if (inFlight.current.has(plan.id)) continue
      const failedAt = missed.get(plan.id)
      if (failedAt !== undefined && at - failedAt < PLAN_POLL_MS) {
        next = Math.min(next, failedAt + PLAN_POLL_MS)
        continue
      }
      const known = fetched.get(plan.id)
      const fetch = nextPlanFetch(plan, known?.detail, known?.at, at)
      if (fetch.kind === "at") next = Math.min(next, fetch.at)
      if (fetch.kind !== "now") continue
      const controller = new AbortController()
      inFlight.current.set(plan.id, controller)
      planDetail(client, plan.id, controller.signal).then(
        (detail) => {
          inFlight.current.delete(plan.id)
          setFetched((current) => new Map(current).set(plan.id, { detail, at: Date.now() }))
        },
        () => {
          if (controller.signal.aborted) return
          inFlight.current.delete(plan.id)
          // Asked again a poll's length on, not at once.
          setMissed((current) => new Map(current).set(plan.id, Date.now()))
        },
      )
    }
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setWake((count) => count + 1), Math.max(0, next - at))
    return () => clearTimeout(timer)
  }, [client, fetched, missed, plans, wake])

  // Nothing left in flight once the map goes.
  useEffect(() => {
    const requests = inFlight.current
    return () => {
      for (const controller of requests.values()) controller.abort()
      requests.clear()
    }
  }, [])

  const { roads, readings, sources } = useMemo(() => {
    const roadStates = new Map<string, RoadGeometryState>()
    const routeReadings = new Map<string, PlanReading>()
    const drawn: RoadSource[] = []
    for (const route of routes) {
      const plan = plans.get(route.id) ?? null
      const reading = planReading(plan, now)
      routeReadings.set(route.id, reading)
      const detail = plan === null ? undefined : fetched.get(plan.id)?.detail
      const road = plan?.status === "ready" && detail?.status === "ready" ? roadGeometryOfLegs(detail.legs, { provider: detail.provider, optimised: detail.solver === "optimiser" }) : null
      if (road !== null) {
        // The pickups stay the markers: the legs run from the depot and back to it.
        roadStates.set(route.id, { status: "ready", geometry: { ...road, snappedStops: route.stops.map((stop) => stop.lngLat) } })
        drawn.push(road.source)
      } else if (plan?.status === "ready") {
        roadStates.set(route.id, { status: "pending" })
      } else {
        roadStates.set(route.id, { status: "estimate", resumesAt: plan?.deferredUntil ?? null, reason: reading.sentence })
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

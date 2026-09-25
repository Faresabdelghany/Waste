// Route estimates for the guided setup (2026-09-16 redesign): stops,
// distance, duration, load, and the capacity / shift verdicts the group
// table and the route map show. Pure data logic — no UI or store
// dependencies.
//
// Every number says what it is. Generation produces stop lists only — no
// distance, duration, or weight. Distance and duration are the road's once a
// routing engine has answered for the road through the stops (Issue #39,
// 2026-09-25: the web asks the OSRM demo server through
// lib/map-planning/road-geometry, the target system self-hosted Valhalla,
// ADR-0002): the distance as routed, and the drive time plus the time at the
// stops — each container type's emptying time from the asset catalogue (the
// caller passes that resolver), the prototype's allowance where the catalogue
// has none. Until the road is known they are heuristics (the prototype's
// coefficients). `basis` on the estimate says which, and the adapter's
// `labels` spell it for the route map. Container weights come from the asset
// catalogue where it weighs the type for the fraction — every fixture
// container type since Issue #39 — and from the fallback table below
// otherwise; each weight says which it was, so a group whose containers use
// any fallback weight is flagged per row ("Fallback weight") instead of
// qualifying the whole column. The stop order is generation's — the matched
// containers as generation writes them — never an optimised sequence:
// optimisation is a separate job over a generated Route (ADR-0002) and plugs
// in through routeEstimateAdapter the way the road did. The UI reads all of
// it through that adapter — the single place a real optimiser response plugs
// in (see the adapter's doc). The verdicts never gate Next or Create.

import type { ContainerMatchProfile } from "./matching"

export const SHIFT_HOURS = 8

/** kg per emptied container by display container type (fallback when the catalogue has no entry). */
export const FALLBACK_CONTAINER_KG: Readonly<Record<string, number>> = {
  "Two-wheel bin · 140 L": 6,
  "Two-wheel bin · 240 L": 10,
  "Four-wheel bin · 660 L": 30,
  "Four-wheel bin · 1,100 L": 55,
  "Igloo · 2,500 L": 400,
  "Underground · 5,000 L": 650,
  "Wastewater tank · 3,000 L": 3000,
}

/** Density factor per fraction relative to residual waste. */
export const FALLBACK_FRACTION_FACTOR: Readonly<Record<string, number>> = {
  residual: 1,
  organic: 1.2,
  paper: 0.6,
  cardboard: 0.5,
  glass: 1.5,
  plastic: 0.3,
  metal: 0.8,
  mixed: 1,
  wastewater: 1,
}

const DEFAULT_CONTAINER_KG = 20

/** kg for one emptied container of the type carrying the fraction, from the fallback tables. */
export function fallbackContainerWeightKg(
  containerType: string | undefined,
  fraction: string | undefined,
): number {
  const base = (containerType && FALLBACK_CONTAINER_KG[containerType]) || DEFAULT_CONTAINER_KG
  const factor = (fraction && FALLBACK_FRACTION_FACTOR[fraction.toLowerCase()]) || 1
  return base * factor
}

/** A resolved container weight and where it came from. */
export type ContainerWeight = {
  kg: number
  /** True when the fallback table supplied the weight, not the asset catalogue. */
  fallback: boolean
}

/** The fallback tables' weight, flagged as such. */
export function fallbackContainerWeight(
  containerType: string | undefined,
  fraction: string | undefined,
): ContainerWeight {
  return { kg: fallbackContainerWeightKg(containerType, fraction), fallback: true }
}

/** Resolves the weight for (container type, fraction); the UI layer wraps the catalogue around the fallback. */
export type ContainerWeightResolver = (
  containerType: string | undefined,
  fraction: string | undefined,
) => ContainerWeight

export type LoadEstimate = {
  /** Total load in tonnes (one decimal) for emptying every container once. */
  loadT: number
  /** True when any container's weight came from the fallback table. */
  fallbackWeight: boolean
}

/** The load for emptying every container once, and whether any weight was a fallback. */
export function estimateLoad(
  containers: readonly Pick<ContainerMatchProfile, "containerType" | "fractions">[],
  weight: ContainerWeightResolver = fallbackContainerWeight,
): LoadEstimate {
  let kg = 0
  let fallbackWeight = false
  for (const container of containers) {
    const resolved = weight(container.containerType, container.fractions[0])
    kg += resolved.kg
    fallbackWeight ||= resolved.fallback
  }
  return { loadT: Math.round(kg / 100) / 10, fallbackWeight }
}

/** Minutes at one stop when the catalogue has no emptying time for its container type — the prototype's allowance. */
export const STOP_MINUTES = 0.85

/** Resolves a container type's emptying time in minutes; null when the catalogue has no entry for it. */
export type StopMinutesResolver = (containerType: string | undefined) => number | null

/**
 * Minutes spent at the stops: each container type's catalogue emptying time,
 * the allowance for a type the catalogue does not time. Feeds the road basis
 * of estimateRoute, whose drive time says nothing about the stops.
 */
export function estimateServiceMinutes(
  containers: readonly Pick<ContainerMatchProfile, "containerType">[],
  minutesFor: StopMinutesResolver = () => null,
): number {
  let minutes = 0
  for (const container of containers) {
    minutes += minutesFor(container.containerType) ?? STOP_MINUTES
  }
  return minutes
}

export type RouteEstimateStatus = "within" | "tight" | "over-capacity" | "over-shift"

/** Where an estimate's distance and duration come from. */
export type RouteEstimateBasis = "estimate" | "road"

/** What a routing engine answered for the road through a route's stops. */
export type RouteMeasure = {
  distanceMetres: number
  durationSeconds: number
}

export type RouteEstimate = {
  stops: number
  loadT: number
  /** Kilometres — whole on the estimate basis, to one decimal on the road's. */
  km: number
  mins: number
  capacityT: number
  /** Load as a percentage of capacity; 0 when the capacity is unknown. */
  pct: number
  overCapacity: boolean
  overShift: boolean
  status: RouteEstimateStatus
  /** The heuristic, or the road a routing engine answered with. */
  basis: RouteEstimateBasis
}

export const ROUTE_ESTIMATE_STATUS_LABELS: Record<RouteEstimateStatus, string> = {
  within: "Within limits",
  tight: "Tight",
  "over-capacity": "Over capacity",
  "over-shift": `Over ${SHIFT_HOURS} h shift`,
}

export type RouteEstimateInput = {
  stops: number
  loadT: number
  capacityT: number | null | undefined
  /** The road through the stops as a routing engine answered it; absent or null until it has. */
  road?: RouteMeasure | null
  /**
   * Minutes at the stops (estimateServiceMinutes), read on the road basis
   * only — the heuristic carries its own per-stop allowance. Absent, every
   * stop takes the allowance.
   */
  serviceMinutes?: number
}

/**
 * Distance, duration, and verdicts for one route. With the road: its
 * distance as routed and its drive time plus the time at the stops. Without:
 * the prototype's coefficients over the stop count. The capacity and shift
 * verdicts read the same whichever the basis.
 */
export function estimateRoute(input: RouteEstimateInput): RouteEstimate {
  const stops = Math.max(0, input.stops)
  const road = input.road ?? null
  const km = road ? Math.round(road.distanceMetres / 100) / 10 : Math.round(11 + stops * 0.085)
  const mins = road
    ? Math.round(road.durationSeconds / 60 + (input.serviceMinutes ?? stops * STOP_MINUTES))
    : Math.round(stops * STOP_MINUTES + (km / 24) * 60 + 30)
  const capacityT = input.capacityT ?? 0
  const pct = capacityT > 0 ? Math.round((input.loadT / capacityT) * 100) : 0
  const overCapacity = pct > 100
  const overShift = mins > SHIFT_HOURS * 60
  const status: RouteEstimateStatus = overCapacity
    ? "over-capacity"
    : overShift
      ? "over-shift"
      : pct >= 90
        ? "tight"
        : "within"
  return {
    stops,
    loadT: input.loadT,
    km,
    mins,
    capacityT,
    pct,
    overCapacity,
    overShift,
    status,
    basis: road ? "road" : "estimate",
  }
}

/**
 * The ONE seam between the wizard and the route numbers it shows. The wizard
 * model, group editor, route map, and review call these members and nothing
 * else in this module for their numbers. The road plugged in here (Issue
 * #39): `route` takes what the routing engine answered and labels the result
 * through `basis`. A real optimiser — the Plan of ADR-0002, with its own
 * sequence, distance, duration and load — plugs in the same way: return its
 * numbers from `route` and `load`, and set the `labels` to what they then are.
 */
export type RouteEstimateAdapter = {
  /** The qualifier the route map shows beside the numbers, per basis: what they are. */
  labels: Readonly<Record<RouteEstimateBasis, string>>
  /** Per group: its load and whether any of its container weights is a fallback. */
  load: (
    containers: readonly Pick<ContainerMatchProfile, "containerType" | "fractions">[],
    weight: ContainerWeightResolver,
  ) => LoadEstimate
  /** Per route: the minutes at its stops, from the catalogue's emptying times. */
  serviceMinutes: (
    containers: readonly Pick<ContainerMatchProfile, "containerType">[],
    minutesFor: StopMinutesResolver,
  ) => number
  route: (input: RouteEstimateInput) => RouteEstimate
}

export const routeEstimateAdapter: RouteEstimateAdapter = {
  labels: { estimate: "Estimate", road: "Road" },
  load: estimateLoad,
  serviceMinutes: estimateServiceMinutes,
  route: estimateRoute,
}

/** "7 h 41 min" / "45 min". */
export function formatMinutes(mins: number): string {
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return hours ? `${hours} h ${String(rest).padStart(2, "0")} min` : `${rest} min`
}

/** "43 km" / "0.5 km" / "1,234.5 km" — a sum of road kilometres is rounded back to one decimal. */
export function formatKilometres(km: number): string {
  return `${(Math.round(km * 10) / 10).toLocaleString("en-GB")} km`
}

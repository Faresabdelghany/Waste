// Route estimates for the guided setup (2026-09-16 redesign): stops,
// distance, duration, load, and the capacity / shift verdicts the group
// table and the route map show. Pure data logic — no UI or store
// dependencies.
//
// Every number is an ESTIMATE. Generation produces stop lists only — no
// distance, duration, or weight — so distance, duration, and the 8 h check
// are heuristics (the prototype's coefficients), and container weights come
// from the asset-management catalogue where it has the type (4 of the 7
// display types today; the caller passes that resolver) and from the
// fallback table below otherwise. Each weight says which it was, so a group
// whose containers use any fallback weight is flagged per row ("Fallback
// weight") instead of qualifying the whole column. The UI reads all of it
// through routeEstimateAdapter — the single place a real optimiser response
// plugs in (see the adapter's doc). The verdicts never gate Next or Create.

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

export type RouteEstimateStatus = "within" | "tight" | "over-capacity" | "over-shift"

export type RouteEstimate = {
  stops: number
  loadT: number
  km: number
  mins: number
  capacityT: number
  /** Load as a percentage of capacity; 0 when the capacity is unknown. */
  pct: number
  overCapacity: boolean
  overShift: boolean
  status: RouteEstimateStatus
}

export const ROUTE_ESTIMATE_STATUS_LABELS: Record<RouteEstimateStatus, string> = {
  within: "Within limits",
  tight: "Tight",
  "over-capacity": "Over capacity",
  "over-shift": `Over ${SHIFT_HOURS} h shift`,
}

/** Distance, duration, and verdicts for one route from its stop count, load, and vehicle capacity. */
export function estimateRoute(input: {
  stops: number
  loadT: number
  capacityT: number | null | undefined
}): RouteEstimate {
  const stops = Math.max(0, input.stops)
  const km = Math.round(11 + stops * 0.085)
  const mins = Math.round(stops * 0.85 + (km / 24) * 60 + 30)
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
  return { stops, loadT: input.loadT, km, mins, capacityT, pct, overCapacity, overShift, status }
}

/**
 * The ONE seam between the wizard and the route numbers it shows. The wizard
 * model, group editor, route map, and review call these three members and
 * nothing else in this module, so swapping in a real optimiser means one
 * change here: return its distance / duration / load from `route` and
 * `load`, and set `label` to what the numbers then are.
 */
export type RouteEstimateAdapter = {
  /** The qualifier the route map shows beside the numbers this adapter produces. */
  label: string
  /** Per group: its load and whether any of its container weights is a fallback. */
  load: (
    containers: readonly Pick<ContainerMatchProfile, "containerType" | "fractions">[],
    weight: ContainerWeightResolver,
  ) => LoadEstimate
  route: (input: { stops: number; loadT: number; capacityT: number | null | undefined }) => RouteEstimate
}

export const routeEstimateAdapter: RouteEstimateAdapter = {
  label: "Estimate",
  load: estimateLoad,
  route: estimateRoute,
}

/** "7 h 41 min" / "45 min". */
export function formatMinutes(mins: number): string {
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return hours ? `${hours} h ${String(rest).padStart(2, "0")} min` : `${rest} min`
}

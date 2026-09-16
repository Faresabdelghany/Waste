// Route estimate adapter for the guided setup (2026-09-16 redesign): stops,
// distance, duration, load, and the capacity / shift verdicts the group
// table and the route map show. Pure data logic — no UI or store
// dependencies.
//
// Gap adapter: generation produces stop lists only — no distance, duration,
// or weight — so every number here is a heuristic (the prototype's
// coefficients). Container weights come from the asset-management catalogue
// where it covers the type (the caller passes that resolver) and from the
// fallback table below otherwise.

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

/** Resolves kg for (container type, fraction); the UI layer wraps the catalogue around the fallback. */
export type ContainerWeightResolver = (
  containerType: string | undefined,
  fraction: string | undefined,
) => number

/** Total load in tonnes (one decimal) for emptying every container once. */
export function estimateLoadTonnes(
  containers: readonly Pick<ContainerMatchProfile, "containerType" | "fractions">[],
  weightKg: ContainerWeightResolver = fallbackContainerWeightKg,
): number {
  const kg = containers.reduce(
    (sum, container) => sum + weightKg(container.containerType, container.fractions[0]),
    0,
  )
  return Math.round(kg / 100) / 10
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

/** "7 h 41 min" / "45 min". */
export function formatMinutes(mins: number): string {
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return hours ? `${hours} h ${String(rest).padStart(2, "0")} min` : `${rest} min`
}

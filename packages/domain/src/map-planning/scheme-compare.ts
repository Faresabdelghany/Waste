// Scheme comparison (2026-09-16): two Route Schemes side by side on the map.
// Every non-deleted scheme with a readable recurrence is comparable, drafts
// included — asking how a draft overlaps the effective scheme is a planning
// question. Each scheme's stops resolve through the collection-group seam
// (@waste/domain/route-schemes/groups) against the registry as it is now; the
// comparison splits them into A only, B only, and both, and names the
// orphans: containers needing service that sit inside the hull of both
// schemes' located stops yet belong to neither. Pure data logic.

import type { BusinessRecord } from "../prototype-record"
import { effectiveStopPlans } from "../route-schemes/groups"
import {
  effectiveSchemeStatus,
  schemesInPlanning,
  type SchemeLifecycleStatus,
} from "../route-schemes/lifecycle"
import { recurrenceFromValues } from "../route-schemes/recurrence"
import { convexHull, pointInPolygon, type LngLat } from "./geo"
import { containerLocation } from "./positions"

export type SchemeStopSet = {
  id: string
  name: string
  /** The derived lifecycle status (never the stored string). */
  status: SchemeLifecycleStatus
  containerIds: ReadonlySet<string>
}

export type CompareMembership = "a" | "b" | "both"

/** Violet for A, cyan for B, rose where both meet. */
export const COMPARE_COLORS: Readonly<Record<CompareMembership, string>> = {
  a: "#7c3aed",
  b: "#0891b2",
  both: "#db2777",
}

export type SchemeComparison = {
  a: SchemeStopSet
  b: SchemeStopSet
  aOnly: ReadonlySet<string>
  bOnly: ReadonlySet<string>
  both: ReadonlySet<string>
  /** Needing service, inside the hull of both schemes' located stops, listed by neither. */
  orphaned: ReadonlySet<string>
  /** The convex hull of both schemes' located stops; empty below three points. */
  hull: LngLat[]
  membership: ReadonlyMap<string, CompareMembership>
}

/** Every comparable scheme with its resolved stops, by name. */
export function schemeStopSets(
  schemes: readonly BusinessRecord[],
  containers: readonly BusinessRecord[],
  today: string,
): SchemeStopSet[] {
  const sets: SchemeStopSet[] = []
  for (const scheme of schemesInPlanning(schemes)) {
    const recurrence = recurrenceFromValues(scheme.submittedValues ?? {})
    if (!recurrence) continue
    const containerIds = new Set<string>()
    for (const plan of effectiveStopPlans(scheme, recurrence.serviceDays, containers)) {
      for (const containerId of plan.containerIds) containerIds.add(containerId)
    }
    sets.push({ id: scheme.id, name: scheme.name, status: effectiveSchemeStatus(scheme, today), containerIds })
  }
  return sets.sort((left, right) => left.name.localeCompare(right.name))
}

export function compareSchemes(
  a: SchemeStopSet,
  b: SchemeStopSet,
  containers: readonly BusinessRecord[],
  needing: ReadonlySet<string>,
): SchemeComparison {
  const membership = new Map<string, CompareMembership>()
  for (const id of a.containerIds) membership.set(id, b.containerIds.has(id) ? "both" : "a")
  for (const id of b.containerIds) if (!membership.has(id)) membership.set(id, "b")

  const aOnly = new Set<string>()
  const bOnly = new Set<string>()
  const both = new Set<string>()
  for (const [id, side] of membership) (side === "a" ? aOnly : side === "b" ? bOnly : both).add(id)

  const byId = new Map(containers.map((container) => [container.id, container]))
  const stopLocations = [...membership.keys()]
    .map((id) => byId.get(id))
    .map((container) => (container ? containerLocation(container) : null))
    .filter((point): point is LngLat => point !== null)
  const hull = stopLocations.length >= 3 ? convexHull(stopLocations) : []

  const orphaned = new Set<string>()
  if (hull.length >= 3) {
    for (const container of containers) {
      if (!needing.has(container.id) || membership.has(container.id)) continue
      const location = containerLocation(container)
      if (location && pointInPolygon(location, hull)) orphaned.add(container.id)
    }
  }

  return { a, b, aOnly, bOnly, both, orphaned, hull, membership }
}

/** A cluster's side: mixed or shared containers count as both; nothing listed is null. */
export function clusterMembership(
  containerIds: readonly string[],
  membership: ReadonlyMap<string, CompareMembership>,
): CompareMembership | null {
  let sawA = false
  let sawB = false
  for (const id of containerIds) {
    const side = membership.get(id)
    if (side === "both") return "both"
    if (side === "a") sawA = true
    if (side === "b") sawB = true
  }
  if (sawA && sawB) return "both"
  return sawA ? "a" : sawB ? "b" : null
}

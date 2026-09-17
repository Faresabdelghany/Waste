// The toolbar search (2026-09-16): finds a place on the planning map by
// address or property, container id, or planning-area name. Properties come
// first (one hit per address, however many containers stand there), then
// containers, then areas; within a kind, prefix matches lead. Pure data
// logic over the points and area layers the map already holds.

import type { PlanningAreaLayer } from "@waste/domain/map-planning/areas"
import type { LngLat, LngLatBounds } from "@waste/domain/map-planning/geo"
import type { MapPoint } from "@waste/domain/map-planning/points"

export type SearchHitKind = "property" | "container" | "area"

export type SearchHit = {
  id: string
  kind: SearchHitKind
  label: string
  sublabel: string
  /** Where a property or container is. */
  lngLat?: LngLat
  /** What an area spans. */
  bounds?: LngLatBounds
  /** The containers a property or container hit stands for. */
  containerIds: string[]
}

const DEFAULT_LIMIT = 8

const normalise = (value: string) => value.trim().toLowerCase()

/** 0 = no match, 2 = prefix match, 1 = substring match. */
function score(haystack: string, needle: string): number {
  const text = normalise(haystack)
  if (!text.includes(needle)) return 0
  return text.startsWith(needle) || text.split(/[\s,·]+/).some((word) => word.startsWith(needle)) ? 2 : 1
}

export function searchMap(
  query: string,
  points: readonly MapPoint[],
  areas: readonly PlanningAreaLayer[],
  limit = DEFAULT_LIMIT,
): SearchHit[] {
  const needle = normalise(query)
  if (!needle) return []

  const properties = new Map<string, { point: MapPoint; members: MapPoint[]; score: number }>()
  const containers: Array<{ hit: SearchHit; score: number }> = []
  for (const point of points) {
    const propertyScore = Math.max(score(point.propertyKey, needle), score(point.sublabel, needle))
    if (propertyScore > 0) {
      const entry = properties.get(point.propertyKey)
      if (entry) {
        entry.members.push(point)
        entry.score = Math.max(entry.score, propertyScore)
      } else {
        properties.set(point.propertyKey, { point, members: [point], score: propertyScore })
      }
    }
    const containerScore = score(point.label, needle)
    if (containerScore > 0) {
      containers.push({
        score: containerScore,
        hit: {
          id: point.id,
          kind: "container",
          label: point.label,
          sublabel: [point.fractions.join(" · "), point.sublabel].filter(Boolean).join(" · "),
          lngLat: point.lngLat,
          containerIds: point.containerIds,
        },
      })
    }
  }

  const propertyHits = Array.from(properties.values())
    .sort((a, b) => b.score - a.score || a.point.propertyKey.localeCompare(b.point.propertyKey))
    .map(({ point, members }) => ({
      id: `property:${point.propertyKey}`,
      kind: "property" as const,
      label: point.propertyKey,
      sublabel: `${members.length} container${members.length === 1 ? "" : "s"} · ${point.sublabel}`,
      lngLat: point.lngLat,
      containerIds: members.flatMap((member) => member.containerIds),
    }))
  // A property hit already covers every container standing at it.
  const containerHits = containers
    .sort((a, b) => b.score - a.score || a.hit.label.localeCompare(b.hit.label))
    .map(({ hit }) => hit)
  const areaHits = areas
    .map((area) => ({ area, score: score(area.name, needle) }))
    .filter(({ score: value }) => value > 0)
    .sort((a, b) => b.score - a.score || a.area.name.localeCompare(b.area.name))
    .map(({ area }) => ({
      id: `area:${area.id}`,
      kind: "area" as const,
      label: area.name,
      sublabel: area.bounds
        ? `Planning area · ${area.containerCount} container${area.containerCount === 1 ? "" : "s"}`
        : "Planning area · no located containers",
      bounds: area.bounds ?? undefined,
      containerIds: [],
    }))

  return [...propertyHits, ...containerHits, ...areaHits].slice(0, limit)
}

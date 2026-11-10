// Planning-area outlines for the Layers control (2026-09-16). A fixture's
// planning areas carry no geometry, so its outline is DERIVED: the convex
// hull of the area's located containers, pushed out a little so the markers
// sit inside the line. Every visible area gets a row — one without located
// containers has no geometry and cannot be shown or zoomed to. Pure data
// logic; the map draws the polygons, the panel lists the rows.
//
// The outline itself is `planningAreaOutline` (@waste/domain/map-planning/geo),
// which the database seed stores as each demo area's boundary.

import type { BusinessRecord } from "../prototype-record"
import { isSoftDeleted } from "../record-visibility"
import { containerAreaRefs } from "../route-schemes/matching"
import { boundsFromPolygon, planningAreaOutline, type LngLat, type LngLatBounds } from "@waste/domain/map-planning/geo"
import type { Gazetteer } from "@waste/fixtures/positions"
import { containerLocation } from "./positions"

export type PlanningAreaLayer = {
  id: string
  name: string
  color: string
  /** Empty when the area has no located container. */
  polygon: LngLat[]
  bounds: LngLatBounds | null
  containerCount: number
}

/** Outline colours, cycled in list order — apart from the amber selection ring. */
export const AREA_LAYER_PALETTE = [
  "#2563eb",
  "#16a34a",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#ca8a04",
] as const

function belongsTo(refs: { ids: readonly string[]; names: readonly string[] }, area: BusinessRecord): boolean {
  if (refs.ids.length > 0) return refs.ids.includes(area.id)
  const name = area.name.trim().toLowerCase()
  return refs.names.some((candidate) => candidate.toLowerCase() === name)
}

/**
 * The typed value an area record carries its boundary on: a GeoJSON Polygon
 * as the web's adapter writes the version in force
 * (apps/web/lib/api/records/planning.ts). The adapter and this reader share
 * the key so neither misspells the other.
 */
export const PLANNING_AREA_GEOMETRY_KEY = "geometry"

/** A GeoJSON Polygon's rings as the record carries them: `[lng, lat]` positions, the first ring the outer, any other a hole. */
export type PlanningAreaGeometry = { type: "Polygon"; coordinates: [number, number][][] }

const positionOf = (value: unknown): [number, number] | null =>
  Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number" && Number.isFinite(value[0]) && Number.isFinite(value[1])
    ? [value[0], value[1]]
    : null

/**
 * The polygon an area record carries under `PLANNING_AREA_GEOMETRY_KEY`, as
 * it stands — every ring, since a hole travels with its outer ring — or null
 * where the record carries none, text that is no polygon, or a polygon with
 * one position missing or malformed: a polygon with a vertex dropped is a
 * different shape, not this one with a flaw.
 */
export function planningAreaGeometry(area: BusinessRecord): PlanningAreaGeometry | null {
  const raw = area.submittedValues?.[PLANNING_AREA_GEOMETRY_KEY]
  if (typeof raw !== "string" || raw.trim() === "") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const polygon = parsed as { type?: unknown; coordinates?: unknown }
  if (polygon.type !== "Polygon" || !Array.isArray(polygon.coordinates) || polygon.coordinates.length === 0) return null
  const rings: [number, number][][] = []
  for (const ring of polygon.coordinates as unknown[]) {
    if (!Array.isArray(ring)) return null
    const positions = ring.map(positionOf)
    if (positions.some((position) => position === null)) return null
    rings.push(positions as [number, number][])
  }
  return { type: "Polygon", coordinates: rings }
}

/**
 * The outline an area record carries from the server: the outer ring of
 * `planningAreaGeometry`, open, since every outline the map draws is. Null
 * where the record carries no polygon, or one whose outer ring encloses
 * nothing: the area is then outlined around its located containers, as
 * every fixture area is.
 */
export function storedOutline(area: BusinessRecord): LngLat[] | null {
  const polygon = planningAreaGeometry(area)
  if (polygon === null) return null
  const ring = polygon.coordinates[0].map(([lng, lat]) => ({ lng, lat }))
  const last = ring[ring.length - 1]
  const open = ring.length >= 4 && last.lng === ring[0].lng && last.lat === ring[0].lat ? ring.slice(0, -1) : ring
  return open.length >= 3 ? open : null
}

export function planningAreaLayers(
  areas: readonly BusinessRecord[],
  containers: readonly BusinessRecord[],
  gazetteer: Gazetteer,
): PlanningAreaLayer[] {
  const located = containers
    .filter((container) => !isSoftDeleted(container))
    .map((container) => ({ refs: containerAreaRefs(container), spot: containerLocation(container, gazetteer) }))
    .filter((entry): entry is { refs: ReturnType<typeof containerAreaRefs>; spot: LngLat } => entry.spot !== null)

  return areas
    .filter((area) => !isSoftDeleted(area))
    .map((area, index) => {
      const spots = located.filter(({ refs }) => belongsTo(refs, area)).map(({ spot }) => spot)
      const polygon = storedOutline(area) ?? planningAreaOutline(spots)
      return {
        id: area.id,
        name: area.name,
        color: AREA_LAYER_PALETTE[index % AREA_LAYER_PALETTE.length],
        polygon,
        bounds: polygon.length ? boundsFromPolygon(polygon) : null,
        containerCount: spots.length,
      }
    })
}

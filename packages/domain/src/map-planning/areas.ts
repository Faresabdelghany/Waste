// Planning-area outlines for the Layers control (2026-09-16). Planning areas
// carry no geometry in the prototype, so an outline is DERIVED: the convex
// hull of the area's located containers, pushed out a little so the markers
// sit inside the line. Every visible area gets a row — one without located
// containers has no geometry and cannot be shown or zoomed to. Pure data
// logic; the map draws the polygons, the panel lists the rows.
//
// The outline itself is `planningAreaOutline`, exported (Issue #156) because
// the database seed stores the boundary it draws: `packages/db`'s planning
// seed hands it the containers at the spots the map places them and closes
// the ring, so the stored boundary and the map's picture are one derivation.
// The helper is shared; its inputs are the seed's copies of the web's
// fixtures, which hold only as long as those copies do (registry.ts says
// what keeps them together).

import type { BusinessRecord } from "../prototype-record"
import { cleanFact, typedString } from "../record-values"
import { isSoftDeleted } from "../record-visibility"
import {
  boundsFromPolygon,
  boundsPolygon,
  convexHull,
  expandPolygon,
  offsetMetres,
  type LngLat,
  type LngLatBounds,
} from "./geo"
import { containerLocation, type Gazetteer } from "./positions"

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

/** Metres the hull grows so the outermost markers sit inside the line. */
const HULL_MARGIN_METRES = 80
/** Half-width of the box drawn around one or two containers. */
const POINT_BOX_METRES = 120

function belongsTo(container: BusinessRecord, area: BusinessRecord): boolean {
  const typed = typedString(container.submittedValues, "planningAreaId")
  if (typed) return typed === area.id
  const fact = cleanFact(container.facts["Planning area"])
  return Boolean(fact && fact.toLowerCase() === area.name.trim().toLowerCase())
}

/**
 * The outline of an area around its located containers' spots, an open ring:
 * three or more distinct spots are their convex hull pushed 80 m out, one or
 * two a box 120 m past them, none no outline at all.
 */
export function planningAreaOutline(spots: readonly LngLat[]): LngLat[] {
  const hull = convexHull(spots)
  if (hull.length >= 3) return expandPolygon(hull, HULL_MARGIN_METRES)
  if (hull.length === 0) return []
  const corners = hull.flatMap((spot) => [
    offsetMetres(spot, -POINT_BOX_METRES, -POINT_BOX_METRES),
    offsetMetres(spot, POINT_BOX_METRES, POINT_BOX_METRES),
  ])
  return boundsPolygon(boundsFromPolygon(corners))
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

/** One layer per visible area, in the order the areas come: the outline the server holds where the record carries one, else the outline around its containers. */
export function planningAreaLayers(
  areas: readonly BusinessRecord[],
  containers: readonly BusinessRecord[],
  gazetteer: Gazetteer,
): PlanningAreaLayer[] {
  const located = containers
    .filter((container) => !isSoftDeleted(container))
    .map((container) => ({ container, spot: containerLocation(container, gazetteer) }))
    .filter((entry): entry is { container: BusinessRecord; spot: LngLat } => entry.spot !== null)

  return areas
    .filter((area) => !isSoftDeleted(area))
    .map((area, index) => {
      const spots = located.filter(({ container }) => belongsTo(container, area)).map(({ spot }) => spot)
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

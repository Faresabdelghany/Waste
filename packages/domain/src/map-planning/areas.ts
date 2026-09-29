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

/** One layer per visible area, in the order the areas come. */
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
      const polygon = planningAreaOutline(spots)
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

// Planning-area outlines for the Layers control (2026-09-16). Planning areas
// carry no geometry in the prototype, so an outline is DERIVED: the convex
// hull of the area's located containers, pushed out a little so the markers
// sit inside the line. Every visible area gets a row — one without located
// containers has no geometry and cannot be shown or zoomed to. Pure data
// logic; the map draws the polygons, the panel lists the rows.

import type { BusinessRecord } from "../data/business-modules"
import { isSoftDeleted } from "../data/record-visibility"
import {
  boundsFromPolygon,
  boundsPolygon,
  convexHull,
  expandPolygon,
  offsetMetres,
  type LngLat,
  type LngLatBounds,
} from "./geo"
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

/** Metres the hull grows so the outermost markers sit inside the line. */
const HULL_MARGIN_METRES = 80
/** Half-width of the box drawn around one or two containers. */
const POINT_BOX_METRES = 120

const EMPTY_FACT = "—"

function belongsTo(container: BusinessRecord, area: BusinessRecord): boolean {
  const typed = container.submittedValues?.planningAreaId
  if (typeof typed === "string" && typed.trim()) return typed.trim() === area.id
  const fact = container.facts["Planning area"]?.trim()
  return Boolean(fact && fact !== EMPTY_FACT && fact.toLowerCase() === area.name.trim().toLowerCase())
}

function outline(spots: readonly LngLat[]): LngLat[] {
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
): PlanningAreaLayer[] {
  const located = containers
    .filter((container) => !isSoftDeleted(container))
    .map((container) => ({ container, spot: containerLocation(container) }))
    .filter((entry): entry is { container: BusinessRecord; spot: LngLat } => entry.spot !== null)

  return areas
    .filter((area) => !isSoftDeleted(area))
    .map((area, index) => {
      const spots = located.filter(({ container }) => belongsTo(container, area)).map(({ spot }) => spot)
      const polygon = outline(spots)
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

// The outline drawn around a planning area that carries no boundary of its
// own (2026-09-16): the convex hull of its located containers' spots, pushed
// out a little so the markers sit inside the line. The web's map draws it for
// such an area, and `pnpm db:seed` stores it as each demo area's boundary
// (Issue #156): the seed hands it the containers at the spots the map places
// them (./positions) and closes the ring, so the stored boundary and the
// map's picture are one derivation.

import { boundsFromPolygon, boundsPolygon, convexHull, expandPolygon, offsetMetres, type LngLat } from "@waste/domain/map-planning/geo"

/** Metres the hull grows so the outermost markers sit inside the line. */
const HULL_MARGIN_METRES = 80
/** Half-width of the box drawn around one or two containers. */
const POINT_BOX_METRES = 120

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

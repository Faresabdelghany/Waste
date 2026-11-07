// Positions on the earth, `[longitude, latitude]` in WGS 84 (RFC 7946's
// order), and the one way the system measures between two of them without a
// road: a great circle on the mean earth radius. The routing fake measures a
// straight leg by it and the splitter walks a polyline with it, the balance
// estimates a detour by it, and the Driver App keeps a position fix by it.
//
// The radius is the IUGG's mean radius R1, 6 371 008.8 m. The routing fake
// and the balance once used 6 371 000 m, its rounding: their metres grew by
// 1.4 ppm when they joined this one, 1.4 mm in a kilometre.

/** `[longitude, latitude]`, two ordinates and no altitude. */
export type Position2D = [number, number]

/** A line through two or more positions: a routed leg's geometry. */
export type LineString = { type: "LineString"; coordinates: Position2D[] }

/** The ordinates' ranges, in degrees. */
export const LONGITUDE = { min: -180, max: 180 } as const
export const LATITUDE = { min: -90, max: 90 } as const

// A polygon's ring (RFC 7946 §3.1.6): four or more positions, the last equal
// to the first, at least three of them distinct so it encloses an area at
// all. Geometric validity beyond that — no self-intersection, the winding —
// is the database's to judge.

/** A position as a body gives it: two ordinates, an altitude possibly after them. */
type Ordinates = readonly (number | undefined)[]

/** The fewest positions a ring has: three corners and the first again. */
export const RING_POSITIONS_MIN = 4

/** The fewest distinct positions a ring has, besides the closing one. */
export const RING_CORNERS_MIN = 3

/** Whether a ring ends where it starts. */
export const ringCloses = (ring: readonly Ordinates[]): boolean => {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first.length === last.length && first.every((value, index) => value === last[index])
}

/** Whether a ring holds enough distinct positions, besides the closing one, to enclose an area. */
export const ringEnclosesArea = (ring: readonly Ordinates[]): boolean => new Set(ring.slice(0, -1).map((position) => position.join(","))).size >= RING_CORNERS_MIN

export const RING_TOO_SHORT = "a linear ring has at least four positions"
export const RING_OPEN = "a linear ring ends where it starts"
export const RING_WITHOUT_AREA = "a linear ring has at least three distinct positions"
export const POLYGON_WITHOUT_RING = "a polygon has an outer ring"

/** The fewest positions a line has. */
export const LINE_POSITIONS_MIN = 2
export const LINE_TOO_SHORT = "a line string has at least two positions"

export const EARTH_RADIUS_METRES = 6_371_008.8

const radians = (degrees: number): number => (degrees * Math.PI) / 180

/** The great-circle distance between two positions, in metres, unrounded: a caller that stores a measure rounds it. */
export function haversineMetres([lonA, latA]: readonly [number, number], [lonB, latB]: readonly [number, number]): number {
  const dLat = radians(latB - latA)
  const dLon = radians(lonB - lonA)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLon / 2) ** 2
  // Rounding may carry `h` a hair past 1 between antipodes, where asin has no answer.
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Whether two positions are the same point: two bins at one address, two waypoints snapped to one. */
export const samePosition = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] === b[0] && a[1] === b[1]

/**
 * Consecutive identical points are one point of a trip, spanning no leg — two
 * bins at one address — and PostGIS keeps no zero-length LINESTRING, so they
 * collapse. The one spelling of the rule: a provider answers legs over the
 * collapsed trip, and a job that maps them back collapses the same way.
 */
export const distinctConsecutive = (points: readonly Position2D[]): Position2D[] => points.filter((point, index) => index === 0 || !samePosition(point, points[index - 1]))

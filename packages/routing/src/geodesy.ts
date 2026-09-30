// Great-circle distance on the mean Earth radius: what the fake measures a
// straight leg by, and what the splitter walks an optimised route's polyline
// with. Metres, unrounded; a caller that stores a measure rounds it.
import type { Position2D } from "@waste/contracts/geojson"

const EARTH_RADIUS_METRES = 6_371_000
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

export function haversine([lonA, latA]: Position2D, [lonB, latB]: Position2D): number {
  const dLat = toRadians(latB - latA)
  const dLon = toRadians(lonB - lonA)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a))
}

/** Whether two positions are the same point: two bins at one address, two waypoints snapped to one. */
export const samePosition = (a: Position2D, b: Position2D): boolean => a[0] === b[0] && a[1] === b[1]

/**
 * Consecutive identical points are one point of a trip, spanning no leg — two
 * bins at one address — and PostGIS keeps no zero-length LINESTRING, so they
 * collapse. The one spelling of the rule: a provider answers legs over the
 * collapsed trip, and a job that maps them back collapses the same way.
 */
export const distinctConsecutive = (points: readonly Position2D[]): Position2D[] => points.filter((point, index) => index === 0 || !samePosition(point, points[index - 1]))

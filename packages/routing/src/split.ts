// A routed line cut into legs (#124 §1: one `plan_leg` per consecutive pair
// of the trip's points). A directions response says where each waypoint
// falls on its line (`way_points`); an optimisation's does not — VROOM
// returns the whole route as one polyline and, per step, the location it
// was asked about and the road distance travelled on arrival — so
// `waypointIndices` finds each stop on the line: among the vertices at about
// the distance the route itself reports, the nearest to the stop, never
// behind the stop before it. Distance alone would drift with the difference
// between the line's length and the road's; nearness alone would put a stop
// on a later pass that runs closer to its address than the road it was
// visited from. Both, and the line's ends pinned to the trip's ends.
import type { LineString, Position2D } from "@waste/contracts/geojson"

import { haversine, samePosition } from "./geodesy"
import type { RoutedLeg } from "./provider"

/** How far along the line from where the route's distance puts it a stop may be found: a quarter of a kilometre, or 3 % of a long route. */
const WINDOW_METRES = 250
const WINDOW_SHARE = 0.03

/** A stop of an optimised route as its step reports it: where it was asked for, and the road metres travelled on arrival. */
export type Waypoint = { at: Position2D; metres: number }

export function waypointIndices(line: readonly Position2D[], waypoints: readonly Waypoint[]): number[] {
  if (waypoints.length < 2) throw new Error("waypointIndices: a route has at least a start and an end")
  if (line.length < 2) throw new Error("waypointIndices: the line has fewer than two vertices")
  const along = [0]
  for (let index = 1; index < line.length; index += 1) along.push(along[index - 1] + haversine(line[index - 1], line[index]))
  const lineMetres = along[along.length - 1]
  const roadMetres = waypoints[waypoints.length - 1].metres
  // The line's length and the road's differ by the router's own geometry; a stop's distance is read at the line's scale.
  const scale = lineMetres > 0 && roadMetres > 0 ? lineMetres / roadMetres : 1
  const window = Math.max(WINDOW_METRES, WINDOW_SHARE * lineMetres)
  const last = line.length - 1
  const indices = [0]
  for (const waypoint of waypoints.slice(1, -1)) {
    const from = indices[indices.length - 1]
    const target = waypoint.metres * scale
    let best = -1
    let bestNearness = Number.POSITIVE_INFINITY
    for (let index = from; index <= last; index += 1) {
      if (Math.abs(along[index] - target) > window) continue
      const nearness = haversine(line[index], waypoint.at)
      if (nearness < bestNearness) {
        best = index
        bestNearness = nearness
      }
    }
    if (best < 0) {
      // Nothing inside the window (a degenerate line): the vertex at the nearest distance, still never behind.
      best = from
      for (let index = from; index <= last; index += 1) if (Math.abs(along[index] - target) < Math.abs(along[best] - target)) best = index
    }
    indices.push(best)
  }
  indices.push(last)
  return indices
}

/** A leg's measure, from the provider's own numbers. */
export type LegMeasure = { metres: number; seconds: number }

/**
 * The legs between consecutive waypoints: the line from each waypoint's
 * index to the next's, both ends included. A slice spanning no distance —
 * two waypoints snapped to one road point — is the straight line between the
 * two waypoints instead, since a LineString of one point is no geometry
 * PostGIS keeps; the waypoints themselves must differ, which callers ensure
 * by collapsing consecutive duplicates first.
 */
export function legsBetween(line: readonly Position2D[], indices: readonly number[], points: readonly Position2D[], measures: readonly LegMeasure[]): RoutedLeg[] {
  if (indices.length !== points.length) throw new Error(`legsBetween: ${indices.length} indices for ${points.length} waypoints`)
  if (measures.length !== points.length - 1) throw new Error(`legsBetween: ${measures.length} measures for ${points.length - 1} legs`)
  return measures.map((measure, index) => {
    const slice = line.slice(indices[index], indices[index + 1] + 1)
    const spans = slice.some((position) => !samePosition(position, slice[0]))
    if (!spans && samePosition(points[index], points[index + 1])) throw new Error(`legsBetween: waypoints ${index + 1} and ${index + 2} are one point; collapse consecutive duplicates first`)
    const geometry: LineString = { type: "LineString", coordinates: spans ? slice : [points[index], points[index + 1]] }
    return { geometry, metres: measure.metres, seconds: measure.seconds }
  })
}

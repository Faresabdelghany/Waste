// Road geometry for the maps' routes. A route is known by its stops, and the
// road between them is the routing provider's, asked for through the API
// alone (#173; ADR-0001 — the provider's key is one person's and never
// reaches the browser): the guided setup's drafted routes through the
// preview (`POST /routing/preview`), a dated Route through its active Plan's
// stored legs (`GET /plans/:id`). Both answer legs of the same shape — a
// LineString with its metres and seconds, one per consecutive pair of
// points — which `roadGeometryOfLegs` turns into what the maps draw: each
// leg simplified to a metre or two, the stops where the legs meet, and the
// totals. A road carries its source, the provider and whether an optimiser
// ordered the trip, since the attribution a map owes reads it (#124 §6).
// Everything here is pure; lib/api/routing.ts makes the calls.

import { simplifyPath, worldPoint, type LngLat } from "@waste/domain/map-planning/geo"
import { COPENHAGEN_CENTER } from "@waste/domain/map-planning/positions"
import { avalancheHash } from "@waste/domain/route-schemes/hash"
import type { LineString, Position } from "@waste/contracts/geojson"

/** Vertices closer than this to the line between their neighbours are dropped. */
const SIMPLIFY_TOLERANCE_METRES = 1.5

/** Whose road it is, and whether an optimiser ordered the trip: what the attribution under a map reads. */
export type RoadSource = { provider: string; optimised: boolean }

export type RoadGeometry = {
  /** The road from stop i to stop i + 1, both snapped endpoints included; one fewer than the stops. */
  legs: LngLat[][]
  /** Every stop moved onto the road network. */
  snappedStops: LngLat[]
  distanceMetres: number
  durationSeconds: number
  source: RoadSource
}

/** One leg as the API answers it, a preview's or a Plan's. */
export type WireLeg = { path: LineString; metres: number; seconds: number }

const roundCoordinate = (value: number) => value.toFixed(5)

/** The cache key of a stop sequence: order matters, sub-metre jitter does not. */
export function roadGeometryKey(stops: readonly LngLat[]): string {
  const text = stops.map((stop) => `${roundCoordinate(stop.lng)},${roundCoordinate(stop.lat)}`).join(";")
  return `${stops.length}:${avalancheHash(text).toString(16)}`
}

const toLngLat = ([lng, lat]: Position): LngLat => ({ lng, lat })

/**
 * The road the legs make, in order: each leg's path simplified, the stops
 * where one leg ends and the next begins, and the totals the legs sum to.
 * No legs is no road to draw: null.
 */
export function roadGeometryOfLegs(legs: readonly WireLeg[], source: RoadSource): RoadGeometry | null {
  if (legs.length === 0) return null
  const paths = legs.map((leg) => simplifyPath(leg.path.coordinates.map(toLngLat), SIMPLIFY_TOLERANCE_METRES))
  return {
    legs: paths,
    snappedStops: [paths[0][0], ...paths.map((path) => path[path.length - 1])],
    distanceMetres: legs.reduce((sum, leg) => sum + leg.metres, 0),
    durationSeconds: legs.reduce((sum, leg) => sum + leg.seconds, 0),
    source,
  }
}

/** The whole road, leg after leg, each joint vertex once. */
export function roadPath(geometry: RoadGeometry): LngLat[] {
  const path: LngLat[] = []
  for (const leg of geometry.legs) {
    for (const [index, point] of leg.entries()) {
      if (index === 0 && path.length > 0) continue
      path.push(point)
    }
  }
  return path
}

/* ------------------------------- rendering ------------------------------- */

/** Road paths are built once in world pixels at this zoom and moved by one group transform. */
export const ROAD_REF_ZOOM = 16
/** The origin every road path is local to — the city centre the maps open on. */
export const ROAD_ORIGIN: LngLat = COPENHAGEN_CENTER
/** A second fixed point: its screen distance from the origin gives the live scale. */
const ROAD_PROBE: LngLat = { lng: ROAD_ORIGIN.lng + 0.01, lat: ROAD_ORIGIN.lat }
const ROAD_PROBE_WORLD_DX = worldPoint(ROAD_PROBE, ROAD_REF_ZOOM).x - worldPoint(ROAD_ORIGIN, ROAD_REF_ZOOM).x

export type ScreenPoint = { x: number; y: number }

export type RoadOverlay = {
  /** The SVG group transform that puts every road path on screen for the current camera. */
  transform: string
  /** Screen pixels per world pixel at ROAD_REF_ZOOM — 1 at that zoom, doubling per level. */
  scale: number
}

/**
 * The one transform the road overlay needs per frame: translate to the
 * origin's screen position, scale by the ratio of the live zoom to the
 * reference zoom, read off the probe's screen distance. Null until the map
 * projects. Right only on a north-up, flat map — a rotated or pitched camera
 * would need a full re-projection — which is why both maps keep rotation and
 * pitch disabled.
 */
export function roadOverlay(project: (lngLat: LngLat) => ScreenPoint | null): RoadOverlay | null {
  const origin = project(ROAD_ORIGIN)
  const probe = project(ROAD_PROBE)
  if (!origin || !probe) return null
  const scale = (probe.x - origin.x) / ROAD_PROBE_WORLD_DX
  return { transform: `translate(${origin.x} ${origin.y}) scale(${scale})`, scale }
}

/** The SVG path of a road in the overlay's own space — localPathData at ROAD_REF_ZOOM, relative to ROAD_ORIGIN. */
export function roadOverlayPath(points: readonly LngLat[]): string {
  return localPathData(points, ROAD_REF_ZOOM, ROAD_ORIGIN)
}

/**
 * An SVG path through `points` in web-mercator world pixels at `refZoom`,
 * relative to `origin` — the map draws it inside one group whose transform
 * (translate to the origin's screen position, scale by the zoom ratio) moves
 * with the camera, so the path itself never has to be re-projected. Hundreds
 * of route vertices stay float-precise because they are local to the origin.
 */
export function localPathData(points: readonly LngLat[], refZoom: number, origin: LngLat): string {
  if (points.length === 0) return ""
  const base = worldPoint(origin, refZoom)
  return points
    .map((point, index) => {
      const world = worldPoint(point, refZoom)
      return `${index === 0 ? "M" : "L"}${(world.x - base.x).toFixed(2)} ${(world.y - base.y).toFixed(2)}`
    })
    .join("")
}

export type Chevron = { x: number; y: number; angle: number }

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * Direction markers along a screen-space path: one every `spacing` pixels,
 * the first half a step in, each turned to its segment's heading (degrees,
 * clockwise from screen east). A path shorter than half a step gets none.
 */
export function chevronsAlong(points: readonly ScreenPoint[], spacing: number): Chevron[] {
  const chevrons: Chevron[] = []
  if (points.length < 2 || spacing <= 0) return chevrons
  let next = spacing / 2
  let travelled = 0
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]
    const b = points[index]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length === 0) continue
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI
    while (next <= travelled + length) {
      const t = (next - travelled) / length
      chevrons.push({ x: round2(a.x + dx * t), y: round2(a.y + dy * t), angle: round2(angle) })
      next += spacing
    }
    travelled += length
  }
  return chevrons
}

// Road geometry for the planning map's routes (2026-09-16). A dated route is
// known by its stops; the road between them comes from the public OSRM demo
// server (keyless, car profile, no SLA) — one GET per chunk of stops, the
// chunks overlapping by a stop so their legs join. The answer is split into
// one leg per pair of stops at the snapped waypoints, simplified to a metre
// or two, and cached: in memory for the session and in the browser under one
// key (spelled in lib/storage-keys.ts), oldest first, capped. Everything here is pure except fetchRoadGeometry,
// which takes its fetch — the tests hand it a fake, the hook the real one.

import { avalancheHash } from "@waste/domain/route-schemes/hash"
import { simplifyPath, worldPoint, type LngLat } from "@waste/domain/map-planning/geo"
import { COPENHAGEN_CENTER } from "@waste/domain/map-planning/positions"
import type { Position } from "@waste/contracts/geojson"

export const OSRM_BASE_URL = "https://router.project-osrm.org"
/** Stops per request — the demo server declines very long coordinate lists. */
export const ROAD_GEOMETRY_CHUNK_SIZE = 50
/** Routes remembered in the browser before the oldest is forgotten. */
export const ROAD_GEOMETRY_CACHE_MAX = 150
/** Vertices closer than this to the line between their neighbours are dropped. */
const SIMPLIFY_TOLERANCE_METRES = 1.5

export type RoadGeometry = {
  /** The road from stop i to stop i + 1, both snapped endpoints included; one fewer than the stops. */
  legs: LngLat[][]
  /** Every stop moved onto the road network. */
  snappedStops: LngLat[]
  distanceMetres: number
  durationSeconds: number
}

const roundCoordinate = (value: number) => value.toFixed(5)

/** The cache key of a stop sequence: order matters, sub-metre jitter does not. */
export function roadGeometryKey(stops: readonly LngLat[]): string {
  const text = stops.map((stop) => `${roundCoordinate(stop.lng)},${roundCoordinate(stop.lat)}`).join(";")
  return `${stops.length}:${avalancheHash(text).toString(16)}`
}

/** Chunks of at most `size` items whose neighbours share their boundary item. */
export function chunkStops<T>(stops: readonly T[], size: number): T[][] {
  if (stops.length <= size) return [[...stops]]
  const chunks: T[][] = []
  for (let start = 0; start < stops.length - 1; start += size - 1) {
    chunks.push(stops.slice(start, start + size))
  }
  return chunks
}

export function osrmRouteUrl(stops: readonly LngLat[], baseUrl = OSRM_BASE_URL): string {
  const coordinates = stops.map((stop) => `${stop.lng.toFixed(6)},${stop.lat.toFixed(6)}`).join(";")
  return `${baseUrl}/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`
}

type OsrmAnswer = {
  code?: unknown
  message?: unknown
  routes?: Array<{
    geometry?: { coordinates?: unknown }
    legs?: Array<{ distance?: unknown; duration?: unknown }>
  }>
  waypoints?: Array<{ location?: unknown }>
}

/**
 * A GeoJSON position as OSRM sends them, checked structurally; anything else
 * in the geometry is dropped. The contracts type, not its schema: a runtime
 * zod import here would land in the client bundle of every workspace route.
 */
const isPosition = (value: unknown): value is Position =>
  Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every((n) => typeof n === "number")

const toLngLat = ([lng, lat]: Position): LngLat => ({ lng, lat })

const squaredDistance = (a: LngLat, b: LngLat) => (a.lng - b.lng) ** 2 + (a.lat - b.lat) ** 2

/**
 * One leg per pair of stops: the overview geometry is cut at the vertex
 * nearest each snapped waypoint, walking forward so a road that passes the
 * same corner twice is cut in stop order.
 */
export function parseOsrmRoute(payload: unknown, stopCount: number): RoadGeometry {
  const answer = (payload ?? {}) as OsrmAnswer
  if (answer.code !== "Ok") {
    throw new Error(`OSRM answered ${String(answer.code ?? "nothing")}${answer.message ? `: ${String(answer.message)}` : ""}`)
  }
  const route = answer.routes?.[0]
  const coordinates = route?.geometry?.coordinates
  const waypoints = answer.waypoints
  if (!route || !Array.isArray(coordinates) || !Array.isArray(waypoints)) {
    throw new Error("OSRM answered without a route geometry")
  }
  if (waypoints.length !== stopCount) {
    throw new Error(`OSRM answered with ${waypoints.length} waypoints for ${stopCount} stops`)
  }
  const path = coordinates.filter(isPosition).map(toLngLat)
  const snappedStops = waypoints.map((waypoint) => {
    if (!isPosition(waypoint.location)) throw new Error("OSRM answered with an unlocated waypoint")
    return toLngLat(waypoint.location)
  })
  if (path.length === 0) throw new Error("OSRM answered with an empty geometry")

  const cuts: number[] = [0]
  for (let index = 1; index < snappedStops.length - 1; index += 1) {
    let nearest = cuts[index - 1]
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let vertex = cuts[index - 1]; vertex < path.length; vertex += 1) {
      const distance = squaredDistance(path[vertex], snappedStops[index])
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = vertex
      }
    }
    cuts.push(nearest)
  }
  cuts.push(path.length - 1)

  const legs: LngLat[][] = []
  for (let index = 0; index < snappedStops.length - 1; index += 1) {
    const leg = path.slice(cuts[index], cuts[index + 1] + 1)
    legs.push(simplifyPath(leg.length > 0 ? leg : [snappedStops[index], snappedStops[index + 1]], SIMPLIFY_TOLERANCE_METRES))
  }

  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
  const routeLegs = route.legs ?? []
  return {
    legs,
    snappedStops,
    distanceMetres: routeLegs.reduce((sum, leg) => sum + number(leg.distance), 0),
    durationSeconds: routeLegs.reduce((sum, leg) => sum + number(leg.duration), 0),
  }
}

/** Chunk answers, in order, joined into one geometry — the shared stop is kept once. */
export function mergeRoadGeometries(parts: readonly RoadGeometry[]): RoadGeometry {
  return parts.reduce<RoadGeometry>(
    (merged, part, index) => ({
      legs: [...merged.legs, ...part.legs],
      snappedStops: [...merged.snappedStops, ...(index === 0 ? part.snappedStops : part.snappedStops.slice(1))],
      distanceMetres: merged.distanceMetres + part.distanceMetres,
      durationSeconds: merged.durationSeconds + part.durationSeconds,
    }),
    { legs: [], snappedStops: [], distanceMetres: 0, durationSeconds: 0 },
  )
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

export type RoadFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type FetchRoadGeometryOptions = {
  fetch?: RoadFetch
  signal?: AbortSignal
  baseUrl?: string
  chunkSize?: number
}

/** The road through `stops`, in order; rejects when any chunk cannot be routed. */
export async function fetchRoadGeometry(
  stops: readonly LngLat[],
  options: FetchRoadGeometryOptions = {},
): Promise<RoadGeometry> {
  if (stops.length < 2) {
    return { legs: [], snappedStops: [...stops], distanceMetres: 0, durationSeconds: 0 }
  }
  const request: RoadFetch = options.fetch ?? ((url, init) => fetch(url, init))
  const parts: RoadGeometry[] = []
  for (const chunk of chunkStops(stops, options.chunkSize ?? ROAD_GEOMETRY_CHUNK_SIZE)) {
    const response = await request(osrmRouteUrl(chunk, options.baseUrl), { signal: options.signal })
    if (!response.ok) throw new Error(`OSRM request failed with status ${response.status}`)
    parts.push(parseOsrmRoute(await response.json(), chunk.length))
  }
  return mergeRoadGeometries(parts)
}

/* --------------------------------- cache --------------------------------- */

const isLngLat = (value: unknown): value is LngLat =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as LngLat).lng === "number" &&
  typeof (value as LngLat).lat === "number"

function parseGeometry(value: unknown): RoadGeometry | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<RoadGeometry>
  if (!Array.isArray(candidate.legs) || !Array.isArray(candidate.snappedStops)) return null
  if (!candidate.legs.every((leg) => Array.isArray(leg) && leg.every(isLngLat))) return null
  if (!candidate.snappedStops.every(isLngLat)) return null
  if (typeof candidate.distanceMetres !== "number" || typeof candidate.durationSeconds !== "number") return null
  return {
    legs: candidate.legs,
    snappedStops: candidate.snappedStops,
    distanceMetres: candidate.distanceMetres,
    durationSeconds: candidate.durationSeconds,
  }
}

/** The stored cache, oldest first; garbage and malformed entries are dropped. */
export function parseRoadGeometryCache(raw: string | null): Map<string, RoadGeometry> {
  const cache = new Map<string, RoadGeometry>()
  if (!raw) return cache
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown }
    if (!Array.isArray(parsed?.entries)) return cache
    for (const entry of parsed.entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue
      const geometry = parseGeometry(entry[1])
      if (geometry) cache.set(entry[0], geometry)
    }
  } catch {
    // A corrupt store is an empty cache; the roads are fetched again.
  }
  return cache
}

export function serializeRoadGeometryCache(cache: ReadonlyMap<string, RoadGeometry>): string {
  return JSON.stringify({ entries: [...cache.entries()] })
}

/** Records `geometry` under `key` as the newest entry, forgetting the oldest past `max`. */
export function rememberRoadGeometry(
  cache: Map<string, RoadGeometry>,
  key: string,
  geometry: RoadGeometry,
  max = ROAD_GEOMETRY_CACHE_MAX,
): Map<string, RoadGeometry> {
  cache.delete(key)
  cache.set(key, geometry)
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return cache
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

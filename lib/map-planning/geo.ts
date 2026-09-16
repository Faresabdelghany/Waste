// Map Planning geometry (2026-09-16). Pure data logic — no map library, no
// DOM — shared by clustering (lib/map-planning/clusters.ts), the draw tools'
// selection resolution, and the tests. Coordinates are WGS84 lng/lat; the
// pixel space is the web-mercator "world" MapLibre uses: 512 px at zoom 0,
// doubling per level.

export type LngLat = { lng: number; lat: number }

export type WorldPoint = { x: number; y: number }

export type LngLatBounds = { west: number; south: number; east: number; north: number }

/** World size in pixels at a zoom level (MapLibre's 512 px tile convention). */
export function worldSize(zoom: number): number {
  return 512 * 2 ** zoom
}

/** Web-mercator world pixel of a coordinate at a zoom level. */
export function worldPoint(point: LngLat, zoom: number): WorldPoint {
  const size = worldSize(zoom)
  const latRad = (point.lat * Math.PI) / 180
  const mercN = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad))
  return {
    x: ((point.lng + 180) / 360) * size,
    y: (1 - mercN / Math.PI) * (size / 2),
  }
}

/** Inverse of worldPoint. */
export function worldToLngLat(point: WorldPoint, zoom: number): LngLat {
  const size = worldSize(zoom)
  const lng = (point.x / size) * 360 - 180
  const n = Math.PI - (2 * Math.PI * point.y) / size
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lng, lat }
}

/**
 * Ray casting in lng/lat space — accurate enough for planning-area-sized
 * shapes. A polygon needs at least three vertices; a point exactly on an
 * edge counts as inside.
 */
export function pointInPolygon(point: LngLat, polygon: readonly LngLat[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    if (crosses) inside = !inside
  }
  return inside
}

export function boundsFromPolygon(polygon: readonly LngLat[]): LngLatBounds {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const point of polygon) {
    west = Math.min(west, point.lng)
    east = Math.max(east, point.lng)
    south = Math.min(south, point.lat)
    north = Math.max(north, point.lat)
  }
  return { west, south, east, north }
}

export function inBounds(point: LngLat, bounds: LngLatBounds): boolean {
  return (
    point.lng >= bounds.west &&
    point.lng <= bounds.east &&
    point.lat >= bounds.south &&
    point.lat <= bounds.north
  )
}

/** The four corners of a bounds, as a polygon. */
export function boundsPolygon(bounds: LngLatBounds): LngLat[] {
  return [
    { lng: bounds.west, lat: bounds.south },
    { lng: bounds.east, lat: bounds.south },
    { lng: bounds.east, lat: bounds.north },
    { lng: bounds.west, lat: bounds.north },
  ]
}

/** Moves a coordinate by metres east and north (flat-earth, fine within a city). */
export function offsetMetres(point: LngLat, eastMetres: number, northMetres: number): LngLat {
  const metresPerDegreeLat = 111_320
  const metresPerDegreeLng = metresPerDegreeLat * Math.cos((point.lat * Math.PI) / 180)
  return {
    lng: point.lng + eastMetres / metresPerDegreeLng,
    lat: point.lat + northMetres / metresPerDegreeLat,
  }
}

/** Metres per degree of latitude; longitude scales by cos(lat). */
const METRES_PER_DEGREE_LAT = 111_320

/** Local flat-earth metres of a coordinate relative to a reference latitude. */
function localMetres(point: LngLat, refLat: number): { x: number; y: number } {
  const metresPerDegreeLng = METRES_PER_DEGREE_LAT * Math.cos((refLat * Math.PI) / 180)
  return { x: point.lng * metresPerDegreeLng, y: point.lat * METRES_PER_DEGREE_LAT }
}

/** Shoelace area in square metres (equirectangular at the polygon's mean latitude). */
export function polygonAreaSquareMetres(polygon: readonly LngLat[]): number {
  if (polygon.length < 3) return 0
  const refLat = polygon.reduce((sum, point) => sum + point.lat, 0) / polygon.length
  let twice = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = localMetres(polygon[j], refLat)
    const b = localMetres(polygon[i], refLat)
    twice += a.x * b.y - b.x * a.y
  }
  return Math.abs(twice) / 2
}

/** The vertex mean — the label anchor for hull-shaped polygons. */
export function polygonCentroid(polygon: readonly LngLat[]): LngLat {
  if (polygon.length === 0) return { lng: 0, lat: 0 }
  return {
    lng: polygon.reduce((sum, point) => sum + point.lng, 0) / polygon.length,
    lat: polygon.reduce((sum, point) => sum + point.lat, 0) / polygon.length,
  }
}

const cross = (o: LngLat, a: LngLat, b: LngLat) =>
  (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng)

/**
 * Andrew's monotone chain: the counter-clockwise convex hull of a point set,
 * duplicates removed. Fewer than three distinct points come back as they are
 * (the caller pads those into a box).
 */
export function convexHull(points: readonly LngLat[]): LngLat[] {
  const distinct = Array.from(
    new Map(points.map((point) => [`${point.lng},${point.lat}`, point] as const)).values(),
  ).sort((a, b) => a.lng - b.lng || a.lat - b.lat)
  if (distinct.length < 3) return distinct
  const lower: LngLat[] = []
  for (const point of distinct) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop()
    }
    lower.push(point)
  }
  const upper: LngLat[] = []
  for (const point of [...distinct].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop()
    }
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

/** Pushes every vertex `metres` further from the centroid — a cheap buffer for convex shapes. */
export function expandPolygon(polygon: readonly LngLat[], metres: number): LngLat[] {
  if (polygon.length === 0) return []
  const centre = polygonCentroid(polygon)
  return polygon.map((point) => {
    const c = localMetres(centre, centre.lat)
    const p = localMetres(point, centre.lat)
    const dx = p.x - c.x
    const dy = p.y - c.y
    const length = Math.hypot(dx, dy)
    if (length === 0) return point
    return offsetMetres(point, (dx / length) * metres, (dy / length) * metres)
  })
}

/** Perpendicular distance in metres from `point` to the segment `a`–`b`. */
function distanceToSegmentMetres(point: LngLat, a: LngLat, b: LngLat): number {
  const origin = localMetres(a, a.lat)
  const p = { x: localMetres(point, a.lat).x - origin.x, y: localMetres(point, a.lat).y - origin.y }
  const q = { x: localMetres(b, a.lat).x - origin.x, y: localMetres(b, a.lat).y - origin.y }
  const lengthSquared = q.x * q.x + q.y * q.y
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (p.x * q.x + p.y * q.y) / lengthSquared))
  const dx = p.x - t * q.x
  const dy = p.y - t * q.y
  return Math.hypot(dx, dy)
}

/**
 * Douglas–Peucker: the path with every vertex that strays less than
 * `toleranceMetres` from the line between its kept neighbours removed. The
 * endpoints always stay; a path of two points or fewer is returned as is.
 */
export function simplifyPath(path: readonly LngLat[], toleranceMetres: number): LngLat[] {
  if (path.length <= 2) return [...path]
  const keep = new Array<boolean>(path.length).fill(false)
  keep[0] = true
  keep[path.length - 1] = true
  const stack: Array<[number, number]> = [[0, path.length - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    let farthest = -1
    let farthestDistance = toleranceMetres
    for (let index = start + 1; index < end; index += 1) {
      const distance = distanceToSegmentMetres(path[index], path[start], path[end])
      if (distance > farthestDistance) {
        farthestDistance = distance
        farthest = index
      }
    }
    if (farthest === -1) continue
    keep[farthest] = true
    stack.push([start, farthest], [farthest, end])
  }
  return path.filter((_, index) => keep[index])
}

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

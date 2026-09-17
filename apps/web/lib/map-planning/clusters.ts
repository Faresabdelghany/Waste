// Marker clustering for the planning map (2026-09-16). Grid clustering in
// web-mercator pixel space at the current zoom, then a merge pass so
// neighbours that straddle a grid line still fold together. Deterministic:
// points are sorted by id first, so the same registry always draws the same
// picture. Pure data logic — the map component only renders the result.

import { avalancheHash } from "@waste/domain/route-schemes/hash"
import { worldPoint, type LngLat, type WorldPoint } from "@waste/domain/map-planning/geo"
import { rankFractions, type MapPoint } from "@waste/domain/map-planning/points"

export type MapCluster = {
  /** The point's own id for a lone point; a stable hash of the member ids otherwise. */
  id: string
  lngLat: LngLat
  count: number
  points: MapPoint[]
  /** Distinct fractions across the members, most frequent first. */
  fractions: string[]
  /** True when every member sits on the same coordinate — zooming cannot split it. */
  singleLocation: boolean
}

/** Screen distance within which markers fold into one badge. */
export const DEFAULT_CLUSTER_RADIUS_PX = 44

type Working = { points: MapPoint[]; pixels: WorldPoint[]; centroid: WorldPoint }

const sameSpot = (a: LngLat, b: LngLat) =>
  Math.abs(a.lng - b.lng) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9

function centroidOf(pixels: readonly WorldPoint[]): WorldPoint {
  let x = 0
  let y = 0
  for (const pixel of pixels) {
    x += pixel.x
    y += pixel.y
  }
  return { x: x / pixels.length, y: y / pixels.length }
}

function finish(working: Working): MapCluster {
  const points = working.points
  const singleLocation = points.every((point) => sameSpot(point.lngLat, points[0].lngLat))
  const lngLat = singleLocation
    ? points[0].lngLat
    : {
        lng: points.reduce((sum, point) => sum + point.lngLat.lng, 0) / points.length,
        lat: points.reduce((sum, point) => sum + point.lngLat.lat, 0) / points.length,
      }
  return {
    id:
      points.length === 1
        ? points[0].id
        : `cluster-${avalancheHash(points.map((point) => point.id).join("|"))}`,
    lngLat,
    count: points.length,
    points,
    fractions: rankFractions(points.map((point) => point.fractions)),
    singleLocation,
  }
}

export function clusterPoints(
  points: readonly MapPoint[],
  zoom: number,
  radiusPx: number = DEFAULT_CLUSTER_RADIUS_PX,
): MapCluster[] {
  const sorted = [...points].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const cells = new Map<string, Working>()
  for (const point of sorted) {
    const pixel = worldPoint(point.lngLat, zoom)
    const key = `${Math.floor(pixel.x / radiusPx)}:${Math.floor(pixel.y / radiusPx)}`
    const cell = cells.get(key)
    if (cell) {
      cell.points.push(point)
      cell.pixels.push(pixel)
    } else {
      cells.set(key, { points: [point], pixels: [pixel], centroid: pixel })
    }
  }

  // Merge pass: fold a cell into an earlier cluster whose centroid is within
  // the radius, so two markers 1 px apart never split on a grid line.
  const merged: Working[] = []
  for (const cell of cells.values()) {
    cell.centroid = centroidOf(cell.pixels)
    const host = merged.find((candidate) => {
      const dx = candidate.centroid.x - cell.centroid.x
      const dy = candidate.centroid.y - cell.centroid.y
      return Math.sqrt(dx * dx + dy * dy) < radiusPx
    })
    if (host) {
      host.points.push(...cell.points)
      host.pixels.push(...cell.pixels)
      host.centroid = centroidOf(host.pixels)
    } else {
      merged.push(cell)
    }
  }

  return merged
    .map((working) => {
      working.points.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return finish(working)
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

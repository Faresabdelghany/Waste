// Chunked directions (#124 §4, #171): a trip longer than one request takes
// — OpenRouteService's 50 waypoints (#118) — is measured as consecutive
// requests that share exactly one waypoint, the last of one being the first
// of the next, so each response splits at its `way_points` into one leg per
// pair and no leg is duplicated or omitted. W points are ceil((W − 1) /
// (max − 1)) requests: 2 for a 50-stop full trip, 5 for 200 stops.
import type { Position2D } from "@waste/contracts/geojson"

/** The points split into requests of at most `max` waypoints, each chunk starting where the one before it ends. */
export function chunkPoints(points: readonly Position2D[], max: number): Position2D[][] {
  if (points.length < 2) throw new Error("chunkPoints: a measurement takes at least two points")
  if (max < 2) throw new Error("chunkPoints: a request takes at least two waypoints, or no chunk could advance")
  const chunks: Position2D[][] = []
  for (let start = 0; start < points.length - 1; start += max - 1) chunks.push(points.slice(start, start + max))
  return chunks
}

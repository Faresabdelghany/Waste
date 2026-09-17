// GeoJSON (RFC 7946) geometry on the wire, the subset the API will carry: a
// Point for a located container or stop and a Polygon for a Service Area or
// Planning Area boundary. Positions are [longitude, latitude] in WGS 84,
// optionally followed by an altitude and nothing else. The object schemas
// strip unknown members, so foreign members such as `bbox` are dropped on
// parse rather than stored.
//
// The prototype does not store this shape yet: service areas and saved
// selections keep an unclosed `{ lng, lat }[]` in a JSON field and planning
// areas carry no geometry at all. Where that list becomes a closed ring is a
// decision for the Data step; neither this package (zod only) nor
// @waste/domain (nothing) may import the other, so the converter cannot live
// in either without a layering decision.
import * as z from "zod"

export const Longitude = z.number().min(-180).max(180)
export const Latitude = z.number().min(-90).max(90)

/** `[longitude, latitude]` or `[longitude, latitude, altitude]`. */
export const Position = z.tuple([Longitude, Latitude, z.number().optional()])
export type Position = z.infer<typeof Position>

export const Point = z.object({
  type: z.literal("Point"),
  coordinates: Position,
})
export type Point = z.infer<typeof Point>

const closes = (ring: readonly Position[]): boolean => {
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first.length === last.length && first.every((value, index) => value === last[index])
}

/** Three distinct positions besides the closing one, so the ring encloses an area at all. */
const enclosesArea = (ring: readonly Position[]): boolean =>
  new Set(ring.slice(0, -1).map((position) => position.join(","))).size >= 3

/**
 * Four or more positions, the last equal to the first, at least three of
 * them distinct. Geometric validity beyond that (no self-intersection,
 * winding order) is the database's job.
 */
export const LinearRing = z
  .array(Position)
  .min(4, { error: "a linear ring has at least four positions", abort: true })
  .refine(closes, { error: "a linear ring ends where it starts" })
  .refine(enclosesArea, { error: "a linear ring has at least three distinct positions" })
export type LinearRing = z.infer<typeof LinearRing>

/** An outer ring followed by any number of holes. */
export const Polygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(LinearRing).min(1, { error: "a polygon has an outer ring" }),
})
export type Polygon = z.infer<typeof Polygon>

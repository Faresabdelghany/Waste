// GeoJSON (RFC 7946) geometry on the wire, the subset the system stores:
// a Point for a located container or stop and a Polygon for a Service Area
// or Planning Area boundary. Positions are [longitude, latitude] in WGS 84,
// optionally followed by an altitude and nothing else. Object schemas strip
// unknown members, so foreign members such as `bbox` pass through unread.
import { z } from "zod"

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

/** Four or more positions, the last equal to the first. */
export const LinearRing = z
  .array(Position)
  .min(4, { error: "a linear ring has at least four positions", abort: true })
  .refine(closes, { error: "a linear ring ends where it starts" })
export type LinearRing = z.infer<typeof LinearRing>

/** An outer ring followed by any number of holes. Winding order is not enforced. */
export const Polygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(LinearRing).min(1, { error: "a polygon has an outer ring" }),
})
export type Polygon = z.infer<typeof Polygon>

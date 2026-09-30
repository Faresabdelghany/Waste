// The guided setup's road preview on the wire (#173, decided on #124 §4 and
// #132 §5): `POST /routing/preview` measures a drafted route's points in the
// order the wizard draws them — its depot first and its unloading station
// last where the draft places them — through the routing adapter the
// worker's Plans go through, interactive class, and writes nothing: no Plan,
// since a Plan belongs to a Route and the preview has none, and no job. The
// answer is the road (`basis: "road"`), one leg per consecutive pair of the
// body's points, or no road (`basis: "estimate"`) — the directions quota
// spent until `resumesAt`, the key refused, or the points refused in the
// provider's own words — which the web draws as the straight dashed line
// beside its prototype estimate. `provider` names whose geometry it is, for
// the attribution a map owes it (#124 §6). The two bases are the web's
// `RouteEstimateBasis` (@waste/domain/route-schemes/estimates).
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { LineString, Position2D } from "./geojson"
import { NonNegativeInt } from "./resource"
import { PICKUP_ORDER_MAX } from "./routes"

/** A route's most stops (PICKUP_ORDER_MAX), its depot and its station. */
export const ROUTING_PREVIEW_POINTS_MAX = PICKUP_ORDER_MAX + 2

export const RoutingPreviewRequest = z.strictObject({
  /** `[longitude, latitude]` each, in driving order; two consecutive at one place — two bins at one address — span a zero leg. */
  points: z
    .array(Position2D)
    .min(2, { error: "a preview needs two points or more" })
    .max(ROUTING_PREVIEW_POINTS_MAX, { error: `a preview takes at most ${ROUTING_PREVIEW_POINTS_MAX} points: a route's ${PICKUP_ORDER_MAX} stops, its depot and its station` }),
})
export type RoutingPreviewRequest = z.infer<typeof RoutingPreviewRequest>

/** The road from one point of the body to the next, with its measure; a point repeated is a zero leg over it. */
export const RoutingPreviewLeg = z.object({
  path: LineString,
  metres: NonNegativeInt,
  seconds: NonNegativeInt,
})
export type RoutingPreviewLeg = z.infer<typeof RoutingPreviewLeg>

export const RoutingPreviewRoad = z.object({
  basis: z.literal("road"),
  /** Whose geometry this is: what the map's attribution reads. */
  provider: z.string().min(1),
  /** One per consecutive pair of the body's points, in order. */
  legs: z.array(RoutingPreviewLeg),
  /** The sums of the legs. */
  distanceMetres: NonNegativeInt,
  durationSeconds: NonNegativeInt,
})
export type RoutingPreviewRoad = z.infer<typeof RoutingPreviewRoad>

export const RoutingPreviewEstimate = z.object({
  basis: z.literal("estimate"),
  provider: z.string().min(1),
  /** When the directions quota opens again — the "resumes at" sentence; null when waiting would not bring a road (the key refused, the points refused). */
  resumesAt: IsoDateTime.nullable(),
  /** Why there is no road, in one sentence: the quota's, the key's, or the provider's own. */
  reason: z.string().min(1),
})
export type RoutingPreviewEstimate = z.infer<typeof RoutingPreviewEstimate>

export const RoutingPreview = z.discriminatedUnion("basis", [RoutingPreviewRoad, RoutingPreviewEstimate])
export type RoutingPreview = z.infer<typeof RoutingPreview>

// Live positions and estimates on the wire (O8 of #290, decided on #344).
//
// A `Position` is where a session's vehicle was at one instant, as the
// Driver App recorded it (`record-positions`, driver-commands.ts), and a
// `RouteTrack` one session's positions in the order they were taken —
// read per route alone, under the Live board's grant and the routes' reach,
// so an office account reads its projects' routes and a Service Provider's
// account the routes it serves; there is no read of a driver's positions
// across routes. A long track is thinned to `TRACK_POINTS_MAX`, evenly, its
// last point always kept, and says so.
//
// A `RouteEta` is each stop of the route's active Plan with the instant the
// vehicle is expected there (@waste/domain/execution/eta): the Plan's legs
// from the route's departure or start, each stop's kerb time, the wait for a
// window, the unload visits on the way, and the progress so far; null for a
// stop passed, and for every stop where nothing can be said. A stop the
// active Plan does not name has no row.
import { PLAN_STOP_KINDS } from "@waste/domain/routing/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { NonNegativeInt, PositiveInt } from "./resource"

/** The most points one track answers: an eight-hour day at the Driver App's thirty seconds is under a thousand, so a track is thinned only when it is long. */
export const TRACK_POINTS_MAX = 2000

/** Where the vehicle was at one instant. */
export const Position = z.object({
  at: IsoDateTime,
  location: FlatPoint,
  accuracyM: PositiveInt,
  speedKmh: NonNegativeInt.nullable(),
  headingDeg: NonNegativeInt.nullable(),
})
export type Position = z.infer<typeof Position>

/** `GET /routes/:id/positions`: one session's track; the route's open session, else its latest, unless `sessionId` names one of its own. */
export const RouteTrackQuery = z.strictObject({ sessionId: Id.optional() })
export type RouteTrackQuery = z.infer<typeof RouteTrackQuery>

export const RouteTrack = z.object({
  routeId: Id,
  /** The session the track is of, or null for a route never started. */
  sessionId: Id.nullable(),
  /** In the order they were taken. */
  points: z.array(Position).max(TRACK_POINTS_MAX),
  /** Whether points were left out to stay within `TRACK_POINTS_MAX`. */
  thinned: z.boolean(),
})
export type RouteTrack = z.infer<typeof RouteTrack>

export const PlanStopKind = z.enum(PLAN_STOP_KINDS)

/** One stop of the active Plan with its estimate. */
export const StopEta = z.object({
  kind: PlanStopKind,
  /** The pickup a `pickup` stop is; null on an unload visit. */
  pickupId: Id.nullable(),
  /** The Plan's position, 1..n. */
  position: PositiveInt,
  /** When the vehicle is expected there; null for a stop passed, or where nothing can be said. */
  eta: IsoDateTime.nullable(),
})
export type StopEta = z.infer<typeof StopEta>

/** `GET /routes/:id/eta`: the route's estimates, read at `computedAt`. */
export const RouteEta = z.object({
  routeId: Id,
  /** The active Plan read, or null for a route without one, whose stops are then none. */
  planId: Id.nullable(),
  computedAt: IsoDateTime,
  stops: z.array(StopEta),
  /** When the trip is expected to end, or null. */
  finishAt: IsoDateTime.nullable(),
})
export type RouteEta = z.infer<typeof RouteEta>

/** What the Live board shows of a route's estimates: the next stop still to come and when, and when the trip ends. */
export const LiveEta = z.object({
  nextPickupId: Id.nullable(),
  nextAt: IsoDateTime.nullable(),
  finishAt: IsoDateTime.nullable(),
})
export type LiveEta = z.infer<typeof LiveEta>

// The Plan on the wire (#170, decided on #124 and #132): one calculation over
// one dated Route — who ordered it (`solver`), where its measurement stands
// (`status`, with `deferredUntil` beside `calculating` when the quota put it
// off, never a fourth status), what trip it measured, its totals once
// `ready`, and the provider provenance #132 §6 keeps off the fingerprint. The
// fingerprint itself is the server's key and never on the wire. `PlanDetail`
// adds the legs, each a stored LineString, fetched only when a map draws
// (`GET /plans/{id}`); `ActivePlan` is the reading a route's detail carries —
// enough for every per-route sentence of #132 §5 without a second request —
// `stale` being a reading of the Plan against the route's stops today, never
// a status. The vocabularies are the domain's, the same tuples the database
// reads into its CHECKs, so the two cannot drift.
import * as z from "zod"

import { PLAN_SOLVERS, PLAN_STATUSES, PLAN_TRIPS } from "@waste/domain/routing/vocabulary"

import { IsoDate, IsoDateTime } from "./dates"
import { LineString } from "./geojson"
import { Id } from "./ids"
import { NonNegativeInt, PositiveInt, stamped } from "./resource"

export const PlanSolver = z.enum(PLAN_SOLVERS)
export type PlanSolver = z.infer<typeof PlanSolver>
export const PlanStatus = z.enum(PLAN_STATUSES)
export type PlanStatus = z.infer<typeof PlanStatus>
export const PlanTrip = z.enum(PLAN_TRIPS)
export type PlanTrip = z.infer<typeof PlanTrip>

export const Plan = z.object({
  ...stamped,
  projectId: Id,
  routeId: Id,
  solver: PlanSolver,
  status: PlanStatus,
  trip: PlanTrip,
  /** The totals, the sum of the legs; null until `ready`. */
  distanceMetres: NonNegativeInt.nullable(),
  durationSeconds: NonNegativeInt.nullable(),
  /** When a quota-deferred measurement resumes (#132 §4); only ever beside `calculating`. */
  deferredUntil: IsoDateTime.nullable(),
  /** Why a `failed` Plan failed: the provider's sentence, or the structured `superseded`. */
  failureReason: z.string().nullable(),
  /** The provider that answered, and the response-side provenance. */
  provider: z.string().min(1),
  engineVersion: z.string().nullable(),
  graphDate: IsoDate.nullable(),
})
export type Plan = z.infer<typeof Plan>

/** One routed leg of the trip, 1..n in driving order: the stored geometry with its measure. */
export const PlanLeg = z.object({
  position: PositiveInt,
  path: LineString,
  metres: NonNegativeInt,
  seconds: NonNegativeInt,
})
export type PlanLeg = z.infer<typeof PlanLeg>

/** `GET /plans/{id}`: the Plan with its legs, fetched only when a map draws. */
export const PlanDetail = z.object({
  ...Plan.shape,
  legs: z.array(PlanLeg),
})
export type PlanDetail = z.infer<typeof PlanDetail>

/**
 * The active Plan as a route's read carries it (#124 §5): what every
 * per-route sentence of #132 §5 needs — Not measured (no Plan at all) ·
 * Measuring… · Waiting until `deferredUntil` · the totals · failed · Stale —
 * off the route alone, never a join to the quota.
 */
export const ActivePlan = z.object({
  id: Id,
  solver: PlanSolver,
  status: PlanStatus,
  trip: PlanTrip,
  distanceMetres: NonNegativeInt.nullable(),
  durationSeconds: NonNegativeInt.nullable(),
  /** A reading, never a status: the route's stops moved under the Plan (#124 §2), so its sequence covers them only in part. */
  stale: z.boolean(),
  deferredUntil: IsoDateTime.nullable(),
})
export type ActivePlan = z.infer<typeof ActivePlan>

// The dated Route on the wire (Issue #104): a dated, executable unit of work
// assigned to vehicles and drivers — never a Route Scheme, which is what
// recurs. A route is written by generation (#97 B) and moved by the
// dispatcher's five commands and the driver's session; there is no create and
// no patch. It carries its identity (scheme, group, `serviceDate`; ADR-0002),
// the `operatingDate` it runs on, its display `number` with the `label` a
// person reads (`RC-1042`, `routeLabel`; the two are held together at
// `label`), the Planned Assignment and the Actual Assignment as two singular
// states (#104 §7.2), the four instants its status moved, and its `progress`,
// derived from its pickups and never stored.
//
// The commands. `RouteAssign` moves the Planned Assignment on a route that
// has not started, each field `Id.nullable().optional()` so a form may clear
// one; `RouteReschedule` moves the `operatingDate` and never the
// `serviceDate`, the identity; `RouteCancel` carries the reason, which
// becomes the route's `note`; `PickupOrderSet` names every open pickup of the
// route once, in the order they will be visited (ADR-0002: the sequence is
// frozen once a session has started, which the route holds). The live read
// (`LiveRoute`) is a route with its open session and three readings — the
// latest point a proof carried, when the device was last seen, whether it is
// paused — for the dashboard, paged like every list.
import * as z from "zod"

import { IsoDate, IsoDateTime, IsoTime } from "./dates"
import { routeLabel, RouteStatus } from "./execution"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { Pickup } from "./pickups"
import { ActivePlan } from "./plans"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { changesSomething, eachOnce, eachOnceSentence, NonNegativeInt, PositiveInt, somethingToChange, stamped } from "./resource"
import { Session } from "./sessions"
import { Paragraph } from "./text"
import { Unload } from "./unloads"

/** A count of pickups: whole, zero or more. */
const Count = NonNegativeInt

/** A route's progress: how many pickups stand in each status, how many there are, and the fraction with an outcome. Derived, never stored. */
export const RouteProgress = z.object({
  planned: Count,
  completed: Count,
  skipped: Count,
  failed: Count,
  total: Count,
  fraction: z.number().min(0).max(1),
})
export type RouteProgress = z.infer<typeof RouteProgress>

/** The driver, vehicle and trailer of an assignment, each null while unsaid. */
export const RouteAssignment = z.object({
  vehicleId: Id.nullable(),
  driverId: Id.nullable(),
  trailerId: Id.nullable(),
})
export type RouteAssignment = z.infer<typeof RouteAssignment>

/** What a route whose label is not its number is told. */
export const LABEL_IS_THE_NUMBER = "label is the number under the route prefix"
export const labelIsTheNumber = { message: LABEL_IS_THE_NUMBER, path: ["label"] }

/** The label is the number's. */
export const labelMatches = (value: { number: number; label: string }): boolean => value.label === routeLabel(value.number)

/** A route's fields, spelled once for the resources that carry them — the three here and the driver's `DriverRouteDetail` (driver-commands.ts); each refines `labelMatches` again, since spreading takes the fields and not the rule. */
export const routeFields = {
  ...stamped,
  projectId: Id,
  routeSchemeId: Id,
  collectionGroupId: Id,
  /** The day the recurrence named: the identity, with the scheme and the group. */
  serviceDate: IsoDate,
  /** The day the route runs. */
  operatingDate: IsoDate,
  /** The display number; `label` is it under the prefix. */
  number: PositiveInt,
  label: z.string().min(1),
  status: RouteStatus,
  /** The deviation note: the holiday note, the regeneration sentence, or the dispatcher's cancel reason. */
  note: Paragraph.nullable(),
  cancelledByGeneration: z.boolean(),
  /** #97 B's, null until generation writes it. */
  generationRunId: Id.nullable(),
  plannedStartTime: IsoTime.nullable(),
  /** The Planned Assignment: what is expected to run the route. */
  planned: RouteAssignment.extend({
    serviceProviderId: Id.nullable(),
    depotId: Id.nullable(),
    unloadingStationId: Id.nullable(),
  }),
  /** The Actual Assignment: what the session that started the route went out with; every field null until then. */
  actual: RouteAssignment,
  dispatchedAt: IsoDateTime.nullable(),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  cancelledAt: IsoDateTime.nullable(),
  progress: RouteProgress,
}

export const Route = z.object(routeFields).refine(labelMatches, labelIsTheNumber)
export type Route = z.infer<typeof Route>

/**
 * A route as `GET /routes` lists it: with its active Plan's reading, the way
 * the live list carries it (#173), so a map or a list drawn over the page
 * reads every per-route sentence of #132 §5 — Not measured, Measuring…,
 * Waiting…, the totals, failed, Stale — without a second request or a join
 * to the quota. `Route` itself stays what a command and the outbox carry.
 */
export const RouteListItem = z
  .object({
    ...routeFields,
    /** The active Plan's reading, or null while the generated baseline stands unmeasured, drawn dashed (#124). */
    activePlan: ActivePlan.nullable(),
  })
  .refine(labelMatches, labelIsTheNumber)
export type RouteListItem = z.infer<typeof RouteListItem>

/** A route with what hangs off it: the pickups by position, the open session, every session, the unloads. */
export const RouteDetail = z
  .object({
    ...routeFields,
    /** By `sequence`: the active Plan's order where there is one, the baseline's otherwise (#170). */
    pickups: z.array(Pickup),
    /** The active Plan's reading, or null while the generated baseline stands unmeasured, drawn dashed (#124). */
    activePlan: ActivePlan.nullable(),
    /** The open session, or null. */
    session: Session.nullable(),
    /** Every session, oldest first. */
    sessions: z.array(Session),
    /** Oldest first. */
    unloads: z.array(Unload),
  })
  .refine(labelMatches, labelIsTheNumber)
export type RouteDetail = z.infer<typeof RouteDetail>

/** `POST /routes/:id/assign`: the Planned Assignment moved, any field cleared with null, on a route that has not started. */
export const RouteAssign = z
  .strictObject({
    vehicleId: Id.nullable().optional(),
    driverId: Id.nullable().optional(),
    trailerId: Id.nullable().optional(),
    depotId: Id.nullable().optional(),
    unloadingStationId: Id.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type RouteAssign = z.infer<typeof RouteAssign>

/** `POST /routes/:id/reschedule`: the day the route runs, or its planned start, moved; never the service date. */
export const RouteReschedule = z
  .strictObject({
    operatingDate: IsoDate.optional(),
    plannedStartTime: IsoTime.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type RouteReschedule = z.infer<typeof RouteReschedule>

/** `POST /routes/:id/cancel`: the reason, which becomes the route's note. */
export const RouteCancel = z.strictObject({ reason: Paragraph })
export type RouteCancel = z.infer<typeof RouteCancel>

/** The most pickups an order may name: a day's route has tens, a long one hundreds, and five hundred is room for any. */
export const PICKUP_ORDER_MAX = 500

export const EACH_PICKUP_ONCE = eachOnceSentence("pickup", "a stop has one place in the order")

/** `PUT /routes/:id/pickup-order`: every open pickup of the route, once, in the order they will be visited. */
export const PickupOrderSet = z.strictObject({
  pickupIds: z
    .array(Id)
    .min(1)
    .max(PICKUP_ORDER_MAX)
    .refine((ids) => eachOnce(ids), { message: EACH_PICKUP_ONCE }),
})
export type PickupOrderSet = z.infer<typeof PickupOrderSet>

/** A page of routes: one project's, one scheme's, one group's, over a window of operating days, on one service date, of one status, planned for one driver or one vehicle. */
export const RouteListQuery = ProjectScopedListQuery.extend({
  routeSchemeId: Id.optional(),
  collectionGroupId: Id.optional(),
  /** The first operating day of the window, inclusive. */
  from: IsoDate.optional(),
  /** The last, inclusive. */
  to: IsoDate.optional(),
  serviceDate: IsoDate.optional(),
  status: RouteStatus.optional(),
  plannedDriverId: Id.optional(),
  plannedVehicleId: Id.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type RouteListQuery = z.infer<typeof RouteListQuery>

/** `GET /routes/live`: a page of the routes running or due today. */
export const LiveRouteQuery = ProjectScopedListQuery
export type LiveRouteQuery = z.infer<typeof LiveRouteQuery>

/** A route as the live dashboard reads it: with its open session and three readings of it. */
export const LiveRoute = z
  .object({
    ...routeFields,
    /** The active Plan's reading, or null (#170). */
    activePlan: ActivePlan.nullable(),
    /** The open session, or null for a route due today that has not started. */
    session: Session.nullable(),
    /** The latest point a proof carried, or null. */
    lastLocation: FlatPoint.nullable(),
    /** The open session's `lastSeenAt`, or null without one. */
    lastSeenAt: IsoDateTime.nullable(),
    /** Whether the open session is paused. */
    paused: z.boolean(),
  })
  .refine(labelMatches, labelIsTheNumber)
export type LiveRoute = z.infer<typeof LiveRoute>

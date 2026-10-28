// The dated Route on the wire (Issue #104): a dated, executable unit of work
// assigned to vehicles and drivers — never a Route Scheme, which is what
// recurs. A route is written by generation (#97 B), or made by the office as
// an ad-hoc route with no scheme (`RouteCreate`, #111), and moved by the
// dispatcher's commands and the driver's session; there is no patch. It
// carries its identity (scheme, group, `serviceDate`; ADR-0002 — both null on
// an ad-hoc route, whose service date is the day it was made for),
// the `operatingDate` it runs on, its display `number` with the `label` a
// person reads (`RC-1042`, `routeLabel`; the two are held together at
// `label`), the Planned Assignment and the Actual Assignment as two singular
// states (#104 §7.2), the four instants its status moved, and its `progress`,
// derived from its pickups and never stored.
//
// The commands. `RouteAssign` moves the Planned Assignment on a route that
// has not started, each field `Id.nullable().optional()` so a form may clear
// one; `RouteReschedule` moves the `operatingDate` and never the
// `serviceDate`, the identity, onto a day the project rests on only when it
// says so; `RouteCancel` carries a reason code and the reason, which
// becomes the route's `note`; `RouteDispatchMany` dispatches a day or a
// selection, each route judged and answered on its own; `PickupOrderSet` names every open pickup of the
// route once, in the order they will be visited (ADR-0002: the sequence is
// frozen once a session has started, which the route holds). The live read
// (`LiveRoute`) is a route with its open session and three readings — the
// latest point a proof carried, when the device was last seen, whether it is
// paused — for the dashboard, paged like every list.
import type { RouteShift as DomainRouteShift } from "@waste/domain/execution/shift"
import type { RouteWorkload as DomainRouteWorkload } from "@waste/domain/execution/workload"
import * as z from "zod"

import { IsoDate, IsoDateTime, IsoTime } from "./dates"
import { OfficeCancelReasonCode, RouteCancelReasonCode, routeLabel, RouteStatus } from "./execution"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { Pickup } from "./pickups"
import { ActivePlan } from "./plans"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { changesSomething, eachOnce, eachOnceSentence, NonNegativeInt, PositiveInt, somethingToChange, stamped } from "./resource"
import { Session } from "./sessions"
import { DriverShift } from "./shifts"
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
  /** The scheme and the group that generated the route; both null on the office's ad-hoc route (#111), which no generation run touches. */
  routeSchemeId: Id.nullable(),
  collectionGroupId: Id.nullable(),
  /** The day the recurrence named: the identity, with the scheme and the group; on an ad-hoc route, the operating date it was made on. */
  serviceDate: IsoDate,
  /** The day the route runs. */
  operatingDate: IsoDate,
  /** The display number; `label` is it under the prefix. */
  number: PositiveInt,
  label: z.string().min(1),
  status: RouteStatus,
  /** The deviation note: the holiday note, the regeneration sentence, or the dispatcher's cancel reason. */
  note: Paragraph.nullable(),
  /** Why it was cancelled (O5 of #290): the office's code, or `regeneration` on a route a run cancelled; null on a route not cancelled, or cancelled before the codes. */
  cancelReasonCode: RouteCancelReasonCode.nullable(),
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
  /** The hold (#209): when the office last moved this planned route's day, start or Planned Assignment by hand, which the next generation run keeps; null while the route is the scheme's, and always once it leaves `planned`. */
  heldAt: IsoDateTime.nullable(),
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
 * What a route's stops take and weigh (O10 of #290), read live from its
 * stops, its containers' types and fractions and its planned vehicle: the
 * stop time its Duration adds to the active Plan's drive, and its expected
 * load against the vehicle's payload. Capacity is a reading, never a
 * constraint on the optimiser: a route over it is told so, for the office to
 * plan a tip. The domain's `RouteWorkload` is the shape, and this is held to it.
 */
export const RouteWorkload = z.object({
  /** Seconds at the stops still planned, the set the Plan orders: an emptying its container type's, a work order its service's. */
  stopSeconds: NonNegativeInt,
  /** Kilograms the stops that load waste — an emptying, a swap — are expected to weigh, litres times density, of those that can be; null where none can. */
  expectedKg: NonNegativeInt.nullable(),
  /** Stops that load waste whose weight cannot be expected: no container, no volume, no density. */
  unexpectedStops: NonNegativeInt,
  /** The planned vehicle's payload, or null. */
  capacityKg: PositiveInt.nullable(),
  /** How far the expected kilograms run over the payload, 0 within it; null where either is unknown. */
  overCapacityKg: NonNegativeInt.nullable(),
}) satisfies z.ZodType<DomainRouteWorkload>
export type RouteWorkload = z.infer<typeof RouteWorkload>

/**
 * A route's day against its planned driver's shift (O14 of #290), the
 * over-shift verdict read on the server: the route leaves at its planned
 * start, or the shift's start without one, and works the active Plan's
 * drive, the waiting its windows made, the stop time and the break. A route
 * too long for its shift is still ordered — the shift's end is never the
 * optimiser's bound — and told here how far it runs over. The domain's
 * `RouteShift` is the shape, and this is held to it.
 */
export const RouteShift = z.object({
  /** The planned driver's shift, or null for a route with no driver or a driver with no shift on record. */
  shift: DriverShift.nullable(),
  /** When the route leaves: its planned start, the shift's start without one; null where neither says. */
  startsAt: IsoTime.nullable(),
  /** The working time it plans: drive, waiting, stop time and break; null without a measured Plan. */
  workSeconds: NonNegativeInt.nullable(),
  /** How far it runs outside the shift, before its start or past its end, 0 within it; null without a shift or a measured Plan. */
  overShiftSeconds: NonNegativeInt.nullable(),
}) satisfies z.ZodType<DomainRouteShift>
export type RouteShift = z.infer<typeof RouteShift>

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
    /** What its stops take and weigh (O10 of #290). */
    workload: RouteWorkload,
    /** Its day against its planned driver's shift (O14 of #290). */
    shift: RouteShift,
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
    /** What its stops take and weigh (O10 of #290). */
    workload: RouteWorkload,
    /** Its day against its planned driver's shift (O14 of #290). */
    shift: RouteShift,
    /** The open session, or null. */
    session: Session.nullable(),
    /** Every session, oldest first. */
    sessions: z.array(Session),
    /** Oldest first. */
    unloads: z.array(Unload),
  })
  .refine(labelMatches, labelIsTheNumber)
export type RouteDetail = z.infer<typeof RouteDetail>

/**
 * `POST /routes` (#111): an ad-hoc route — the office's, with no scheme and
 * no group — on a project's day, its service date that same day, with the
 * depot, the unloading station, the Planned Assignment's vehicle and driver
 * and the note where given; `planned`, numbered from the company's counter.
 * Any optional field may be null, as a form sends one for the field it
 * leaves empty.
 */
export const RouteCreate = z.strictObject({
  projectId: Id,
  /** The day the route runs, and so its service date. */
  operatingDate: IsoDate,
  depotId: Id.nullable().optional(),
  unloadingStationId: Id.nullable().optional(),
  vehicleId: Id.nullable().optional(),
  driverId: Id.nullable().optional(),
  note: Paragraph.nullable().optional(),
})
export type RouteCreate = z.infer<typeof RouteCreate>

/** `POST /routes/:id/assign`: the Planned Assignment moved, any field cleared with null, on a route that has not started — the service provider too since O5 of #290. */
export const RouteAssign = z
  .strictObject({
    vehicleId: Id.nullable().optional(),
    driverId: Id.nullable().optional(),
    trailerId: Id.nullable().optional(),
    serviceProviderId: Id.nullable().optional(),
    depotId: Id.nullable().optional(),
    unloadingStationId: Id.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type RouteAssign = z.infer<typeof RouteAssign>

/**
 * `POST /routes/:id/reschedule`: the day the route runs, or its planned
 * start, moved; never the service date. A day its project's calendar rests
 * on is taken only with `acceptNonWorkingDay` (O5 of #290): the move is made
 * knowingly, and the flag alone moves nothing.
 */
export const RouteReschedule = z
  .strictObject({
    operatingDate: IsoDate.optional(),
    plannedStartTime: IsoTime.nullable().optional(),
    acceptNonWorkingDay: z.literal(true).optional(),
  })
  .refine(({ acceptNonWorkingDay: _accepted, ...moved }) => changesSomething(moved), somethingToChange)
export type RouteReschedule = z.infer<typeof RouteReschedule>

/** `POST /routes/:id/cancel`: why, as one of the office's codes (O5 of #290), and the free reason, which becomes the route's note. */
export const RouteCancel = z.strictObject({ reasonCode: OfficeCancelReasonCode, reason: Paragraph })
export type RouteCancel = z.infer<typeof RouteCancel>

/** The most routes one bulk dispatch names: each is a savepoint of the request's transaction, so fifty, below the 64 subtransactions Postgres caches per transaction, as the CSV import's `IMPORT_BATCH_MAX`; a larger day goes in several. */
export const DISPATCH_MANY_MAX = 50

export const EACH_ROUTE_ONCE = eachOnceSentence("route", "a route is dispatched once")

/** `POST /routes/dispatch` (O5 of #290): the routes of a day, or a selection of them, each dispatched as its own `POST /routes/:id/dispatch` would be. */
export const RouteDispatchMany = z.strictObject({
  routeIds: z
    .array(Id)
    .min(1)
    .max(DISPATCH_MANY_MAX)
    .refine((ids) => eachOnce(ids), { message: EACH_ROUTE_ONCE }),
})
export type RouteDispatchMany = z.infer<typeof RouteDispatchMany>

/** One route's answer in a bulk dispatch: dispatched, with the route as it now stands, or refused with the status and the sentence its own dispatch answers. */
export const RouteDispatchResult = z.discriminatedUnion("outcome", [
  z.object({ routeId: Id, outcome: z.literal("dispatched"), route: Route }),
  z.object({ routeId: Id, outcome: z.literal("refused"), status: z.union([z.literal(404), z.literal(409)]), detail: z.string().min(1) }),
])
export type RouteDispatchResult = z.infer<typeof RouteDispatchResult>

/** `POST /routes/dispatch`'s answer: one result per route the body named, in its order. */
export const RouteDispatchResults = z.object({ results: z.array(RouteDispatchResult) })
export type RouteDispatchResults = z.infer<typeof RouteDispatchResults>

/** `POST /routes/:id/release-hold` (#226): a held planned route handed back to its scheme. Takes nothing. */
export const RouteReleaseHold = z.strictObject({})
export type RouteReleaseHold = z.infer<typeof RouteReleaseHold>

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

export const EACH_STOP_MOVED_ONCE = eachOnceSentence("pickup", "a stop moves once")

/** The open stops a move or a split takes off the route, each once; as many as an order may name. */
const MovedStops = z
  .array(Id)
  .min(1)
  .max(PICKUP_ORDER_MAX)
  .refine((ids) => eachOnce(ids), { message: EACH_STOP_MOVED_ONCE })

/** `POST /routes/:id/move-stops` (O23 of #290): open stops of the route moved onto another of its project that has not started, each taken off here and added there as the office's. */
export const RouteMoveStops = z.strictObject({ pickupIds: MovedStops, toRouteId: Id })
export type RouteMoveStops = z.infer<typeof RouteMoveStops>

/** `POST /routes/:id/split` (O23 of #290): open stops of the route moved onto a new ad-hoc route of its day, crewed by the vehicle and the driver the body names, where it names them. */
export const RouteSplit = z.strictObject({
  pickupIds: MovedStops,
  vehicleId: Id.nullable().optional(),
  driverId: Id.nullable().optional(),
  note: Paragraph.nullable().optional(),
})
export type RouteSplit = z.infer<typeof RouteSplit>

/** `POST /routes/:id/merge` (O23 of #290): every open stop of the route the body names moved onto this one, and that route cancelled as `merged`. */
export const RouteMerge = z.strictObject({ routeId: Id })
export type RouteMerge = z.infer<typeof RouteMerge>

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

// The Pickup on the wire (Issue #104): one stop-level service action inside a
// dated Route, from planning through execution, its outcome and proof
// recorded against that same record. It carries the place and the fraction
// on the service date (#104 §7.11) — a placement that moves next month must
// not move a pickup generated for this week — and a `Stop` is its route-line
// presentation, drawn by the client from the pickups by position; the depot
// at the head and the unloads at the tail are not pickups.
//
// A pickup is written by generation and by commands, never by a form: the
// device's `complete-pickup`, `skip-pickup` and `fail-pickup` decide its
// outcome (driver-commands.ts), the dispatcher adds a stop to a route that
// has not started (`PickupAdd`, #111) — a container, whose placement on the
// route's service date gives the place and the fraction as generation's
// would, or an address-only stop naming a property or a shared collection
// point with the fraction collected there — and removes one (`PickupRemove`,
// `planned → skipped · removed-by-dispatcher`) and corrects an outcome after
// the fact
// (`PickupCorrection`): the audited change, which appends a `correction`
// proof and moves the status. A correction to `skipped` or `failed` says why
// and one to `completed` does not (`REASON_WITH_A_MISS`, at `reason`), the
// rule `pickup_reason_shape` holds in the table. The prototype's `Next` and
// `Attention` are readings (`nextPickup`, a `failed` status) and its
// `Rescheduled` is a Ticket's outcome, not a status here. A stop the office
// added carries `origin = office`, which generation's refresh leaves where
// the office put it; `containerId` is null on an address-only one.
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { OfficeStopService, PickupOrigin, PickupOutcome, PickupReason, PickupService, PickupStatus } from "./execution"
import { Id } from "./ids"
import { ProofOfService } from "./proofs"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { PositiveInt, stamped } from "./resource"
import { Paragraph } from "./text"

export { PickupOutcome }

export const Pickup = z.object({
  ...stamped,
  projectId: Id,
  routeId: Id,
  /** The container emptied; null on an address-only stop the office added (#111), which names its place and fraction alone. */
  containerId: Id.nullable(),
  /** Stop order, 1..n: the generated baseline, never overwritten by a Plan (#124); a stop the office added is appended after the last. */
  position: PositiveInt,
  /**
   * The stop's place in the current execution order (#170): the active Plan's
   * where there is one, the baseline's otherwise. Computed on read, never
   * stored. On every route read that carries the stop (`RouteDetail`,
   * `DriverRouteDetail`), on the list's (`PickupListItem`, #219) and on the
   * stop's own read and its commands' answers (`PickupDetail`); absent where
   * a route's command or an event recorded before it names the stop.
   */
  sequence: PositiveInt.optional(),
  status: PickupStatus,
  /**
   * Who put the stop on the route (#111): generation, or the office, whose
   * stop a refresh never skips or moves. On every answer; absent on an event
   * the outbox took before #111, every one of which was generation's, so it
   * reads as `generation` and never as a dead letter.
   */
  origin: PickupOrigin.default("generation"),
  /**
   * What the stop is for (O3 of #290): `empty`, emptying its container, or
   * one of the office's work orders. On every answer; absent on an event the
   * outbox took before it, every one of which emptied, so it reads as
   * `empty` — and Finance's pricing of a stop reads it off the payload.
   */
  service: PickupService.default("empty"),
  /** Why a skipped or failed pickup was not collected; null otherwise. */
  reason: PickupReason.nullable(),
  note: Paragraph.nullable(),
  /** The place on the service date: exactly one of the two. */
  propertyId: Id.nullable(),
  sharedCollectionPointId: Id.nullable(),
  /** The placement's fraction on the service date. */
  wasteFractionId: Id,
  /** The first arrival's instant. */
  arrivedAt: IsoDateTime.nullable(),
  /** When the status left planned. */
  outcomeAt: IsoDateTime.nullable(),
})
export type Pickup = z.infer<typeof Pickup>

/**
 * A pickup as `GET /pickups` lists it (#219): with its `sequence` always, the
 * place its route's detail gives it — the active Plan's order, the baseline's
 * until the route has one — so a list of stops across routes reads the
 * order the driver reads, without a read per route.
 */
export const PickupListItem = Pickup.extend({
  sequence: PositiveInt,
})
export type PickupListItem = z.infer<typeof PickupListItem>

/**
 * A pickup with its proofs in recording order. The API's answers carry its
 * `sequence` (#219); it stays optional here because the outbox's consumers
 * read this shape off `pickup-skipped` and `pickup-corrected` events
 * recorded before it did.
 */
export const PickupDetail = Pickup.extend({
  proofs: z.array(ProofOfService),
})
export type PickupDetail = z.infer<typeof PickupDetail>

/** What a stop the office adds that names neither a container nor an address is told. */
export const A_CONTAINER_OR_AN_ADDRESS = "Name a container, or a property or a shared collection point with the waste fraction collected there"
/** What a container's stop naming a place or a fraction beside it is told: the placement gives both. */
export const THE_CONTAINER_ALONE = "A container's stop takes its place and fraction from the container's placement on the route's service date; name the container alone"
/** What an address-only stop naming two places is told. */
export const ONE_ADDRESS = "Name a property or a shared collection point, not both"
/** What an address-only stop without its fraction is told. */
export const AN_ADDRESS_WITH_ITS_FRACTION = "An address-only stop names the waste fraction collected there"
/** What a repair or a wash at an address alone is told. */
export const A_WORK_ORDER_OF_A_CONTAINER = "A repair or a wash is of a container: name the container"

const given = (value: string | null | undefined): value is string => value != null

/** The shape of a stop the office adds: a container alone, or one place with its fraction. A null counts as not given, as a form sends one for the field it leaves empty. */
function addedStopIssues(body: { service?: string; containerId?: string | null; propertyId?: string | null; sharedCollectionPointId?: string | null; wasteFractionId?: string | null }, context: z.RefinementCtx): void {
  const place = [given(body.propertyId), given(body.sharedCollectionPointId)].filter(Boolean).length
  // A work order is of a container where it stands: the table's `pickup_service_container_shape`, at the boundary.
  if (body.service !== undefined && body.service !== "empty" && !given(body.containerId)) {
    context.addIssue({ code: "custom", message: A_WORK_ORDER_OF_A_CONTAINER, path: ["containerId"] })
    return
  }
  if (given(body.containerId)) {
    for (const path of ["propertyId", "sharedCollectionPointId", "wasteFractionId"] as const) {
      if (given(body[path])) context.addIssue({ code: "custom", message: THE_CONTAINER_ALONE, path: [path] })
    }
    return
  }
  if (place === 0) context.addIssue({ code: "custom", message: A_CONTAINER_OR_AN_ADDRESS, path: ["containerId"] })
  else if (place > 1) context.addIssue({ code: "custom", message: ONE_ADDRESS, path: ["sharedCollectionPointId"] })
  else if (!given(body.wasteFractionId)) context.addIssue({ code: "custom", message: AN_ADDRESS_WITH_ITS_FRACTION, path: ["wasteFractionId"] })
}

/**
 * `POST /routes/:id/pickups` (#111): the dispatcher adds a stop to a route
 * that has not started — a container of the route's project, or an address
 * of it (a property or a shared collection point) with the fraction
 * collected there — and a note the driver reads at the stop. Its service
 * (O3 of #290) is an emptying unless it says a repair or a wash, each of a
 * container; a container already a stop of the route may be named again,
 * for an extra emptying or a work order beside its collection.
 */
export const PickupAdd = z
  .strictObject({
    service: OfficeStopService.default("empty").describe("An emptying when absent; a repair or a wash names a container."),
    containerId: Id.nullable().optional(),
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    wasteFractionId: Id.nullable().optional(),
    note: Paragraph.nullable().optional(),
  })
  .superRefine(addedStopIssues)
export type PickupAdd = z.infer<typeof PickupAdd>

/** `POST /pickups/:id/remove`: the dispatcher takes a stop off a route that has not started, saying why. */
export const PickupRemove = z.strictObject({ reason: Paragraph })
export type PickupRemove = z.infer<typeof PickupRemove>

/** What a correction giving a reason with a completion, or none with a skip or a failure, is told. */
export const REASON_WITH_A_MISS = "Give a reason with skipped or failed, and none with completed"
const reasonWithAMiss = { message: REASON_WITH_A_MISS, path: ["reason"] }

/** A reason goes with a skip or a failure and not with a completion: the table's `pickup_reason_shape`, at the boundary. */
export const reasonWithOutcome = (value: { outcome: string; reason?: string | null }): boolean => (value.outcome === "skipped" || value.outcome === "failed") === (value.reason != null)

/** `POST /pickups/:id/correct-outcome`: the audited correction, appending a correction proof and moving the status. */
export const PickupCorrection = z
  .strictObject({
    outcome: PickupOutcome,
    reason: PickupReason.optional(),
    /** Why the outcome is being corrected: the correction proof's note. */
    note: Paragraph,
  })
  .refine(reasonWithOutcome, reasonWithAMiss)
export type PickupCorrection = z.infer<typeof PickupCorrection>

/** A page of pickups: one project's, one route's, one container's, of one status, at one property, over a window of the route's operating date. */
export const PickupListQuery = ProjectScopedListQuery.extend({
  routeId: Id.optional(),
  containerId: Id.optional(),
  status: PickupStatus.optional(),
  propertyId: Id.optional(),
  /** The first day of the window over the route's operating date, inclusive. */
  from: IsoDate.optional(),
  /** The last day, inclusive. */
  to: IsoDate.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type PickupListQuery = z.infer<typeof PickupListQuery>

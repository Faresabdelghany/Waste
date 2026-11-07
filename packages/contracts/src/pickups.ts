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
import { addedStopIssues, CODE_WITH_CONTAMINATION, codeWithOutcome, REASON_WITH_A_MISS, reasonWithOutcome } from "@waste/domain/execution/office-stops"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { FillLevel, OfficeStopService, PickupOrigin, PickupOutcome, PickupReason, PickupService, PickupStatus } from "./execution"
import { Id } from "./ids"
import { ProofOfService } from "./proofs"
import { dayWindow, ProjectScopedListQuery } from "./queries"
import { PositiveInt, stamped } from "./resource"
import { Paragraph } from "./text"

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
  /** The wrong waste the stop was tagged with (M5 of #293); a payload the outbox took before it carries none, and reads as untagged. */
  contaminantCodeId: Id.nullable().default(null),
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
  /**
   * What a ledger work order booked (O3b of #290): a delivery's subscription,
   * a removal's or a swap's warehouse, a swap's replacement; null where the
   * service books none. Absent on an event the outbox took before them, which
   * booked none, so each reads as null.
   */
  subscriptionId: Id.nullable().default(null),
  warehouseId: Id.nullable().default(null),
  replacementContainerId: Id.nullable().default(null),
  /** The Bulky Booking a `bulky` stop collects (O11 of #290); null for any other service, and absent on an event the outbox took before it, which named none. */
  bulkyBookingId: Id.nullable().default(null),
  /** The stop this one was moved from onto its route (O23 of #290), which it stands for; null on every stop no move made, and absent on an event the outbox took before moves, which named none. */
  movedFromPickupId: Id.nullable().default(null),
  /** How full its container was, the driver's latest estimate (M23 of #293); null where none was given, and absent on an event the outbox took before it, which carried none. */
  fill: FillLevel.nullable().default(null),
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

/** The shape of a stop the office adds, each issue at its field (@waste/domain/execution/office-stops). */
const addedStopShaped = (body: Parameters<typeof addedStopIssues>[0], context: z.RefinementCtx): void => {
  for (const issue of addedStopIssues(body)) context.addIssue({ code: "custom", message: issue.message, path: [issue.path] })
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
    service: OfficeStopService.default("empty").describe("An emptying when absent; every work order names a container, a delivery, a removal and a swap their ledger bookings, and a bulky collection its booking alone."),
    containerId: Id.nullable().optional(),
    /** A delivery's: the subscription the container serves under once delivered, which says the place. */
    subscriptionId: Id.nullable().optional(),
    /** A removal's or a swap's: the warehouse the container taken goes back to. */
    warehouseId: Id.nullable().optional(),
    /** A swap's: the container from stock that replaces the one taken. */
    replacementContainerId: Id.nullable().optional(),
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    wasteFractionId: Id.nullable().optional(),
    note: Paragraph.nullable().optional(),
    /** The ticket the stop is booked to answer (O3c of #290): an open container request, overflow or defect of the route's project, whose container and place the stop is held to; it then names this stop as its booking. */
    ticketId: Id.nullable().optional(),
    /** The Bulky Booking a `bulky` stop collects (O11 of #290): a booked one of the route's project, for the route's day, whose place and fraction the stop takes. */
    bulkyBookingId: Id.nullable().optional(),
  })
  .superRefine(addedStopShaped)
export type PickupAdd = z.infer<typeof PickupAdd>

/** `POST /pickups/:id/remove`: the dispatcher takes a stop off a route that has not started, saying why. */
export const PickupRemove = z.strictObject({ reason: Paragraph })
export type PickupRemove = z.infer<typeof PickupRemove>

const reasonWithAMiss = { message: REASON_WITH_A_MISS, path: ["reason"] }
const codeWithContamination = { message: CODE_WITH_CONTAMINATION, path: ["contaminantCodeId"] }

/** `POST /pickups/:id/correct-outcome`: the audited correction, appending a correction proof and moving the status — and, since M5a, the code the stop is tagged with, or none. */
export const PickupCorrection = z
  .strictObject({
    outcome: PickupOutcome,
    reason: PickupReason.optional(),
    /** Why the outcome is being corrected: the correction proof's note. */
    note: Paragraph,
    /** The wrong waste the stop is tagged with; null untags, and absent keeps the stop's code where the corrected outcome still takes one. */
    contaminantCodeId: Id.nullable().optional(),
  })
  .refine(reasonWithOutcome, reasonWithAMiss)
  .refine(codeWithOutcome, codeWithContamination)
export type PickupCorrection = z.infer<typeof PickupCorrection>

/** A page of pickups: one project's, one route's, one container's, of one status, at one property, over a window of the route's operating date. */
export const PickupListQuery = dayWindow(
  ProjectScopedListQuery.extend({
    routeId: Id.optional(),
    containerId: Id.optional(),
    status: PickupStatus.optional(),
    propertyId: Id.optional(),
  }),
)
export type PickupListQuery = z.infer<typeof PickupListQuery>

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
// outcome (driver-commands.ts), the dispatcher removes a stop from a route
// that has not started (`PickupRemove`, `planned → skipped ·
// removed-by-dispatcher`) and corrects an outcome after the fact
// (`PickupCorrection`): the audited change, which appends a `correction`
// proof and moves the status. A correction to `skipped` or `failed` says why
// and one to `completed` does not (`REASON_WITH_A_MISS`, at `reason`), the
// rule `pickup_reason_shape` holds in the table. The prototype's `Next` and
// `Attention` are readings (`nextPickup`, a `failed` status) and its
// `Rescheduled` is a Ticket's outcome, not a status here.
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { PickupReason, PickupStatus } from "./execution"
import { Id } from "./ids"
import { ProofOfService } from "./proofs"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { PositiveInt, stamped } from "./resource"
import { Paragraph } from "./text"

/** An outcome a pickup may be moved to: any status but planned. */
export const PickupOutcome = PickupStatus.exclude(["planned"])
export type PickupOutcome = z.infer<typeof PickupOutcome>

export const Pickup = z.object({
  ...stamped,
  projectId: Id,
  routeId: Id,
  containerId: Id,
  /** Stop order, 1..n. */
  position: PositiveInt,
  status: PickupStatus,
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

/** A pickup with its proofs in recording order. */
export const PickupDetail = Pickup.extend({
  proofs: z.array(ProofOfService),
})
export type PickupDetail = z.infer<typeof PickupDetail>

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

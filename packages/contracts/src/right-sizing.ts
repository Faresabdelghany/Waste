// The wire of right-sizing proposals (M23 of #293, row 26.5): a
// subscription's container a size down or up, or its collections fewer or
// more, proposed nightly from the fill estimates its drivers recorded
// (@waste/domain/inspections/right-sizing). The routes are
// apps/api/src/routes/right-sizing.ts.
//
// A proposal changes nothing. The office approves it — a size into the
// subscription's change from a day, its product the suggested one unless the
// office names another, in the same transaction; a frequency recorded alone,
// the office changing the collection group itself — or dismisses it with
// why. Approve is refused on a subscription that changed since the proposal
// was made: its evidence is stale, and the next night proposes afresh.
import { RIGHT_SIZING_DIRECTIONS, RIGHT_SIZING_STATUSES } from "@waste/domain/inspections/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { FillLevel } from "./execution"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { stamped } from "./resource"
import { Paragraph } from "./text"

export const RightSizingDirection = z.enum(RIGHT_SIZING_DIRECTIONS)
export type RightSizingDirection = z.infer<typeof RightSizingDirection>
export const RightSizingStatus = z.enum(RIGHT_SIZING_STATUSES)
export type RightSizingStatus = z.infer<typeof RightSizingStatus>

export const RightSizingProposal = z.object({
  ...stamped,
  projectId: Id,
  subscriptionId: Id,
  /** The subscription's product when the proposal was made. */
  productId: Id,
  direction: RightSizingDirection,
  /** The product a size down or up; null for a frequency. */
  suggestedProductId: Id.nullable(),
  /** The estimates read, newest first, and the instant of the newest. */
  evidence: z.array(FillLevel),
  evidenceThrough: IsoDateTime,
  status: RightSizingStatus,
  decidedAt: IsoDateTime.nullable(),
  decidedBy: Id.nullable(),
  /** Why it was dismissed; null otherwise. */
  dismissNote: Paragraph.nullable(),
  /** The day the approved change took effect, and the subscription replacing this one from it; null for a frequency's approval and while undecided. */
  changedOn: IsoDate.nullable(),
  replacementSubscriptionId: Id.nullable(),
})
export type RightSizingProposal = z.infer<typeof RightSizingProposal>

/** `POST /right-sizing-proposals/:id/approve`: the day a size takes effect, and the product where the office picks another than the suggested one. A frequency's approval takes neither. */
export const RightSizingApprove = z.strictObject({
  on: IsoDate.optional(),
  productId: Id.optional(),
})
export type RightSizingApprove = z.infer<typeof RightSizingApprove>

/** `POST /right-sizing-proposals/:id/dismiss`: why the proposal is not taken. */
export const RightSizingDismiss = z.strictObject({ note: Paragraph })
export type RightSizingDismiss = z.infer<typeof RightSizingDismiss>

/** A page of proposals: one project's, one subscription's, one status's. */
export const RightSizingListQuery = ProjectScopedListQuery.extend({
  subscriptionId: Id.optional(),
  status: RightSizingStatus.optional(),
})
export type RightSizingListQuery = z.infer<typeof RightSizingListQuery>

/** `POST /right-sizing-proposals/run`: how many proposals the caller's projects' evidence made now. */
export const RightSizingRun = z.object({ proposed: z.number().int().nonnegative() })
export type RightSizingRun = z.infer<typeof RightSizingRun>

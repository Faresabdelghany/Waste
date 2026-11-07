// A weight review on the wire (Issue #112 §5): the columns, the row type and
// `reviewOf`, which the office's decisions answer and `weight-reviewed`
// carries.
import type { WeightReview } from "@waste/contracts/weight-control"

import { weightReview } from "../schema/finance"

export const reviewColumns = {
  id: weightReview.id,
  recordedAt: weightReview.recordedAt,
  projectId: weightReview.projectId,
  unloadId: weightReview.unloadId,
  decision: weightReview.decision,
  note: weightReview.note,
  correctionUnloadId: weightReview.correctionUnloadId,
  reviewedBy: weightReview.reviewedBy,
}

export type ReviewRow = Pick<typeof weightReview.$inferSelect, keyof typeof reviewColumns>

/** The review on the wire. The decision is text with a CHECK in the database and an enum here. */
export function reviewOf(row: ReviewRow): WeightReview {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    unloadId: row.unloadId,
    decision: row.decision,
    note: row.note,
    correctionUnloadId: row.correctionUnloadId,
    reviewedBy: row.reviewedBy,
  }
}

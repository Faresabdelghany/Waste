// What a weight review (O9 of #290) holds to: a correction names the new
// Unload it wrote, never the one reviewed, and no other decision names one —
// the table's `weight_review_correction_shape`.
import type { WeightReviewDecision } from "./vocabulary"

/** What a review whose correction does not go with its decision is told. */
export const CORRECTION_NAMES_ITS_UNLOAD = "A correction names the new unload it wrote, never the one reviewed, and no other decision names one"

/** A correction names a new unload and not the reviewed one; an approval or a rejection names none. */
export const correctionShape = (review: { decision: WeightReviewDecision; unloadId: string; correctionUnloadId: string | null }): boolean =>
  (review.decision === "corrected") === (review.correctionUnloadId !== null) && (review.correctionUnloadId === null || review.correctionUnloadId !== review.unloadId)

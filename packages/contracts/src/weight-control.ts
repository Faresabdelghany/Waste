// Weight control on the wire (Issue #112): the review of an Unload's weight,
// the workflow over weighbridge evidence Execution deferred here (#104). A
// review is a ledger row per decision — `recorded`, never `updatedAt` — on an
// unload: approved, rejected with a note, or corrected by a new Unload row
// the review names (`correctionShape`: a correction names its unload and
// never the reviewed one; the other two name none). The unload's status is
// the latest row's decision, or `captured` when nobody has looked, and
// travels beside every `Unload` as `WeightReviewState` (finance.ts, since
// this module reads the unload's weights rule and unloads.ts could not
// import it back).
//
// The three commands, each 201 with the review and no `Location`, since a
// review is read on the unload's list: `approve` with a note if any, `reject`
// with the note that says why, and `correct` — the new Unload's weights under
// the rule `UnloadCreate` carries (gross and tare together or neither, net is
// gross less tare) with the station's ticket and the note that says what was
// wrong; the new row is `captured` and may be reviewed and corrected in its
// turn. The same decision again answers 200 without a write, and every
// command on a corrected unload is refused with the row to review named.
import { WeightReviewDecision, WeightReviewState } from "./finance"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { PositiveInt, recorded } from "./resource"
import { Label, Paragraph } from "./text"
import { bothGrossAndTare, netIsGrossLessTare, weightsAddUp, weightsPaired } from "./unloads"
import * as z from "zod"

export { WeightReviewState }

/** What a review whose correction does not go with its decision is told. */
export const CORRECTION_NAMES_ITS_UNLOAD = "A correction names the new unload it wrote, never the one reviewed, and no other decision names one"
const correctionNamesItsUnload = { message: CORRECTION_NAMES_ITS_UNLOAD, path: ["correctionUnloadId"] }

/** A correction names a new unload and not the reviewed one; an approval or a rejection names none: the table's `weight_review_correction_shape`, at the boundary. */
export const correctionShape = (review: { decision: WeightReviewDecision; unloadId: string; correctionUnloadId: string | null }): boolean =>
  (review.decision === "corrected") === (review.correctionUnloadId !== null) && (review.correctionUnloadId === null || review.correctionUnloadId !== review.unloadId)

export const WeightReview = z
  .object({
    ...recorded,
    projectId: Id,
    unloadId: Id,
    decision: WeightReviewDecision,
    /** A rejection says why. */
    note: Paragraph.nullable(),
    /** On a correction: the new Unload row it wrote. */
    correctionUnloadId: Id.nullable(),
    reviewedBy: Id,
  })
  .refine(correctionShape, correctionNamesItsUnload)
export type WeightReview = z.infer<typeof WeightReview>

/** `POST /unloads/:id/approve`: a note if any. */
export const WeightApprove = z.strictObject({ note: Paragraph.optional() })
export type WeightApprove = z.infer<typeof WeightApprove>

/** `POST /unloads/:id/reject`: the note says why. */
export const WeightReject = z.strictObject({ note: Paragraph })
export type WeightReject = z.infer<typeof WeightReject>

/** `POST /unloads/:id/correct`: the new Unload's weights under the rule the office's capture carries, the station's ticket, and the note that says what was wrong. */
export const WeightCorrect = z
  .strictObject({
    netKg: PositiveInt,
    grossKg: PositiveInt.optional(),
    tareKg: PositiveInt.optional(),
    weighbridgeTicket: Label.optional(),
    note: Paragraph,
  })
  .refine(weightsPaired, bothGrossAndTare)
  .refine(weightsAddUp, netIsGrossLessTare)
export type WeightCorrect = z.infer<typeof WeightCorrect>

/** A page of one unload's reviews (`GET /unloads/:id/reviews`), oldest first: the path says the unload, so the page is the only parameter. */
export const WeightReviewListQuery = PageRequest
export type WeightReviewListQuery = z.infer<typeof WeightReviewListQuery>

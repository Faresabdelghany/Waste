// An Unload's review status as a query (Issue #112, §5): the latest weight
// review of an unload, read beside every `Unload` the way the Container
// Asset State is read beside a Container (asset-state.ts). Nothing stores it
// — the status is a reading, `@waste/domain/finance/readings`'s
// `weightReviewStatus`: the latest row's decision, or `captured` when there
// is none — so every route that answers an Unload joins this lookup and reads
// the status off the row it finds.
//
//   const review = weightReviewOf(tx, principal.companyId, unload.id)
//   tx.select({ ...columns, reviewStatus: reviewStatus(review.decision), ... })
//     .from(unload)
//     .leftJoinLateral(review, sql`true`)
//
// A LATERAL lookup per row, never a fold of the whole ledger: `select … from
// weight_review where company_id = ? and unload_id = <the row's id> order by
// id desc limit 1`, one backward probe into `weight_review_unload_id_idx`
// (`(company_id, unload_id, id)`, ascending for the reason the stock
// movement's index is: drizzle-kit's `DESC` is `DESC NULLS LAST`, which
// `ORDER BY id DESC` does not match). The fold is in recording order — the
// id, a UUIDv7 — since a review appended later is the later word whatever
// its clock said.
//
// `reviewStatus(decision)` is `coalesce(decision, 'captured')`, the domain's
// fold as SQL, so a list can filter by status (`?reviewStatus=`) in the
// statement and the two cannot say different things.
import { weightReviewStatus } from "@waste/domain/finance/readings"
import type { WeightReviewStatus } from "@waste/domain/finance/vocabulary"
import { and, desc, eq, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import type { Db } from "../client"
import { literal } from "../schema/checks"
import { weightReview } from "../schema/finance"

/** What the lookup yields for an unload: its latest review's id, decision, the correction it wrote, and when it was recorded. */
export const WEIGHT_REVIEW_COLUMNS = {
  reviewId: weightReview.id,
  decision: weightReview.decision,
  correctionUnloadId: weightReview.correctionUnloadId,
  recordedAt: weightReview.recordedAt,
}

/** The alias the lookup joins under. */
export const WEIGHT_REVIEW_STATE = "weight_review_state"

/**
 * The latest review of the unload `unloadId` names — the outer query's
 * `unload.id` — as a subquery to `leftJoinLateral` onto `unload`, `sql\`true\``
 * being the join's condition since the correlation is inside. `db` is the
 * pool or the request's transaction; the statement runs where the join runs.
 */
export function weightReviewOf(db: Pick<Db, "select">, companyId: string, unloadId: PgColumn | SQL) {
  return db
    .select(WEIGHT_REVIEW_COLUMNS)
    .from(weightReview)
    .where(and(eq(weightReview.companyId, companyId), eq(weightReview.unloadId, unloadId)))
    .orderBy(desc(weightReview.id))
    .limit(1)
    .as(WEIGHT_REVIEW_STATE)
}

/** The status a latest decision folds onto: the decision itself, or `captured` for an unload nobody has reviewed — the domain's `weightReviewStatus` as SQL. */
export function reviewStatus(decision: PgColumn | SQL): SQL<WeightReviewStatus> {
  return sql<WeightReviewStatus>`coalesce(${decision}, ${sql.raw(literal(weightReviewStatus(null)))})`
}

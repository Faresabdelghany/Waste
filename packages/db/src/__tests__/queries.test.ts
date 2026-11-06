// What a ledger says about the present is a query (migrations/README.md):
// the Container Asset State and an Unload's weight review, each the domain's
// fold as SQL over one probe per row of the ledger's latest entry, by the
// statement drizzle renders. A mock database renders and connects to nothing.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { weightReviewStatus } from "@waste/domain/finance/readings"
import { eq, sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/postgres-js"

import { CASING } from "../casing"
import { ASSET_STATE, assetStateOf, assetStatus } from "../query/asset-state"
import { reviewStatus, WEIGHT_REVIEW_STATE, weightReviewOf } from "../query/weight-review"
import { container } from "../schema/containers"
import { unload } from "../schema/execution"
import { weightReview } from "../schema/finance"
import { stockMovement } from "../schema/stock"

const dialect = new PgDialect({ casing: CASING })

describe("the asset-state query", () => {
  test("assetStatus is a CASE over the domain's fold, place by place, null otherwise", () => {
    const query = dialect.sqlToQuery(assetStatus(stockMovement.toKind))
    assert.equal(query.sql, `case "wms"."stock_movement"."to_kind" when 'warehouse' then 'in-warehouse' when 'maintenance' then 'in-maintenance' when 'service' then 'in-service' when 'scrap' then 'retired' else null end`)
    assert.deepEqual(query.params, [])
  })

  test("assetStateOf is a LATERAL lookup of one container's latest movement — one probe per row, never a fold of the whole ledger", () => {
    const db = drizzle.mock({ casing: CASING })
    const companyId = "018f7c31-a000-7000-8000-000000000001"
    const state = assetStateOf(db, companyId, container.id)
    const { sql: text, params } = db
      .select({ id: container.id, status: assetStatus(state.toKind), warehouseId: state.toWarehouseId })
      .from(container)
      .leftJoinLateral(state, sql`true`)
      .where(eq(container.companyId, companyId))
      .toSQL()
    assert.equal(
      text,
      `select "wms"."container"."id", case "asset_state"."to_kind" when 'warehouse' then 'in-warehouse' when 'maintenance' then 'in-maintenance' when 'service' then 'in-service' when 'scrap' then 'retired' else null end, "asset_state"."to_warehouse_id" from "wms"."container" left join lateral (select "id", "to_kind", "to_warehouse_id", "placement_id", "occurred_at" from "wms"."stock_movement" where ("wms"."stock_movement"."company_id" = $1 and "wms"."stock_movement"."container_id" = "wms"."container"."id") order by "wms"."stock_movement"."id" desc limit $2) "${ASSET_STATE}" on true where "wms"."container"."company_id" = $3`,
    )
    assert.deepEqual(params, [companyId, 1, companyId])
  })
})

describe("the weight-review query", () => {
  test("reviewStatus is the domain's fold as SQL: the decision, or captured", () => {
    const query = dialect.sqlToQuery(reviewStatus(weightReview.decision))
    assert.equal(query.sql, `coalesce("wms"."weight_review"."decision", 'captured')`)
    assert.deepEqual(query.params, [])
    assert.equal(weightReviewStatus(null), "captured")
  })

  test("weightReviewOf is a LATERAL lookup of one unload's latest review — one probe per row, never a fold of the whole ledger", () => {
    const db = drizzle.mock({ casing: CASING })
    const companyId = "018f7c35-a000-7000-8000-000000000001"
    const review = weightReviewOf(db, companyId, unload.id)
    const { sql: text, params } = db
      .select({ id: unload.id, status: reviewStatus(review.decision), correctionUnloadId: review.correctionUnloadId })
      .from(unload)
      .leftJoinLateral(review, sql`true`)
      .where(eq(unload.companyId, companyId))
      .toSQL()
    assert.equal(
      text,
      `select "wms"."unload"."id", coalesce("${WEIGHT_REVIEW_STATE}"."decision", 'captured'), "${WEIGHT_REVIEW_STATE}"."correction_unload_id" from "wms"."unload" left join lateral (select "id", "decision", "correction_unload_id", "recorded_at" from "wms"."weight_review" where ("wms"."weight_review"."company_id" = $1 and "wms"."weight_review"."unload_id" = "wms"."unload"."id") order by "wms"."weight_review"."id" desc limit $2) "${WEIGHT_REVIEW_STATE}" on true where "wms"."unload"."company_id" = $3`,
    )
    assert.deepEqual(params, [companyId, 1, companyId])
  })
})

// What a ledger says about the present is a query (migrations/README.md):
// the Container Asset State and an Unload's weight review, each the domain's
// fold as SQL over one probe per row of the ledger's latest entry. The folds
// are held to the domain's functions over every value they can meet, on the
// database; the probe is the shape of the statement drizzle renders, which a
// mock database renders and connects to nothing. What the probe finds, row by
// row, is resources.test.ts's and finance.test.ts's.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { weightReviewStatus } from "@waste/domain/finance/readings"
import { WEIGHT_REVIEW_DECISIONS, type WeightReviewDecision } from "@waste/domain/finance/vocabulary"
import { assetStateOf as stateAfter } from "@waste/domain/resources/asset-state"
import { STOCK_PLACE_KINDS, type StockPlaceKind } from "@waste/domain/resources/vocabulary"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"

import { CASING } from "../casing"
import { createDb, type Database } from "../client"
import { assetStateOf, assetStatus } from "../query/asset-state"
import { reviewStatus, weightReviewOf } from "../query/weight-review"
import { container } from "../schema/containers"
import { unload } from "../schema/execution"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

/** Every place a movement names, and none: a container with no movement. */
const PLACES: (StockPlaceKind | null)[] = [...STOCK_PLACE_KINDS, null]
/** Every decision a review records, and none: an unload nobody has reviewed. */
const DECISIONS: (WeightReviewDecision | null)[] = [...WEIGHT_REVIEW_DECISIONS, null]

describe("the ledgers' folds in SQL are the domain's", { skip: database.skip }, () => {
  let pool: Database
  before(() => {
    pool = createDb(database.appUrl, { max: 1 })
  })
  after(() => pool.close())

  test("assetStatus is a CASE over the domain's fold, place by place, null otherwise", async () => {
    const rows = await pool.db.execute<{ n: number; status: string | null }>(sql`
      select t.n, ${assetStatus(sql`t.to_kind`)} as status
        from (values ${sql.join(
          PLACES.map((place, n) => sql`(${n}::int, ${place}::text)`),
          sql`, `,
        )}) as t(n, to_kind)
       order by t.n
    `)
    assert.deepEqual(
      rows.map((row) => row.status),
      PLACES.map((place) => (place === null ? null : stateAfter({ toKind: place }))),
    )
  })

  test("reviewStatus is the domain's fold as SQL: the decision, or captured", async () => {
    const rows = await pool.db.execute<{ n: number; status: string }>(sql`
      select t.n, ${reviewStatus(sql`t.decision`)} as status
        from (values ${sql.join(
          DECISIONS.map((decision, n) => sql`(${n}::int, ${decision}::text)`),
          sql`, `,
        )}) as t(n, decision)
       order by t.n
    `)
    assert.deepEqual(
      rows.map((row) => row.status),
      DECISIONS.map(weightReviewStatus),
    )
  })
})

/**
 * The lateral subquery a statement over `outer` joins for `ledger`: what it
 * filters on, and the parameter its limit binds. Refuses a statement that
 * joins none, or one not latest-first by id.
 */
function lateralProbe(text: string, params: unknown[], ledger: string): { where: string; limit: unknown; company: unknown } {
  const probe = new RegExp(`left join lateral \\(select .+ from "wms"\\."${ledger}" where (.+) order by "wms"\\."${ledger}"\\."id" desc limit \\$(\\d+)\\) "[a-z_]+" on true`).exec(text)
  assert.ok(probe, `no lateral probe of ${ledger}, latest id first: ${text}`)
  const company = new RegExp(`"wms"\\."${ledger}"\\."company_id" = \\$(\\d+)`).exec(probe[1]!)
  return { where: probe[1]!, limit: params[Number(probe[2]) - 1], company: company === null ? undefined : params[Number(company[1]) - 1] }
}

describe("the latest-entry lookups", () => {
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
    const probe = lateralProbe(text, params, "stock_movement")
    assert.match(probe.where, /"wms"\."stock_movement"\."container_id" = "wms"\."container"\."id"/, "correlated on the outer row's container")
    assert.equal(probe.company, companyId, "the probe filters the ledger to the company: the tenant fence, and the leading column of its index")
    assert.equal(probe.limit, 1)
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
    const probe = lateralProbe(text, params, "weight_review")
    assert.match(probe.where, /"wms"\."weight_review"\."unload_id" = "wms"\."unload"\."id"/, "correlated on the outer row's unload")
    assert.equal(probe.company, companyId, "the probe filters the ledger to the company: the tenant fence, and the leading column of its index")
    assert.equal(probe.limit, 1)
  })
})

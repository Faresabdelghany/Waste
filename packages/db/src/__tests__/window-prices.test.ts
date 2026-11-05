// The window prices against the demo (M16b of #293): migrated and seeded,
// every price row carries no tier, and every one resolves exactly as it did —
// its list for its product, on its first day, under its own conditions —
// whatever quantity the occurrence names. Then the tier in the row's key: two
// rows of one product and conditions may run together only as two tiers.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { resolvePrice, type PriceRow } from "@waste/domain/finance/pricing"
import type { CustomerKind } from "@waste/domain/registry/vocabulary"
import { and, asc, eq } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { priceListRow } from "../schema/finance"
import { seedDemo } from "../seed/demo"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

describe("the window prices against the demo", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_window_prices")
    await migrateDatabase(fresh.url)
    await seedDemo(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  const rowsOf = async () =>
    (await owner.db.select().from(priceListRow).orderBy(asc(priceListRow.id))).map((row) => ({
      ...row,
      customerKind: row.customerKind as CustomerKind | null,
    }))

  test("every seeded price row has no tier and resolves as before, whatever the quantity", async () => {
    const rows = await rowsOf()
    assert.ok(rows.length > 0, "the demo prices something")
    for (const row of rows) {
      assert.equal(row.fromQuantity, null, row.id)
      const list: PriceRow[] = rows.filter((other) => other.priceListId === row.priceListId && other.productId === row.productId)
      const input = { on: row.validFrom, planningAreaId: row.planningAreaId, customerKind: row.customerKind, containerTypeId: row.containerTypeId, wasteFractionId: row.wasteFractionId, customerId: row.customerId }
      // The resolver as it was: the same rows with the tier taken off.
      const before = resolvePrice(list.map(({ fromQuantity: _tier, ...untiered }) => untiered), input)
      for (const quantity of [undefined, 0.25, 1, 2.34, 40, 100_000]) {
        const now = resolvePrice(list, { ...input, quantity })
        assert.deepEqual(
          now.verdicts.map((verdict) => [verdict.row.id, verdict.eligible, verdict.reason, verdict.score, verdict.winner]),
          before.verdicts.map((verdict) => [verdict.row.id, verdict.eligible, verdict.reason, verdict.score, verdict.winner]),
          `${row.id} at ${quantity}`,
        )
      }
    }
  })

  test("a row of one product and conditions runs beside another only as another tier", async () => {
    const [row] = await rowsOf()
    assert.ok(row)
    const { id: _id, conditionKey: _key, createdAt: _created, updatedAt: _updated, ...copy } = row
    const again = () => owner.db.insert(priceListRow).values({ ...copy, id: crypto.randomUUID() })
    await assert.rejects(again(), (error: { cause?: { constraint_name?: string } }) => error.cause?.constraint_name === "price_list_row_no_overlap")
    const tier = await owner.db.insert(priceListRow).values({ ...copy, id: crypto.randomUUID(), fromQuantity: 5 }).returning({ id: priceListRow.id })
    assert.equal(tier.length, 1, "a tier from 5 runs beside the row with none")
    await assert.rejects(
      owner.db.insert(priceListRow).values({ ...copy, id: crypto.randomUUID(), fromQuantity: 5 }),
      (error: { cause?: { constraint_name?: string } }) => error.cause?.constraint_name === "price_list_row_no_overlap",
    )
    await owner.db.delete(priceListRow).where(and(eq(priceListRow.id, tier[0]!.id)))
  })
})

// Apply index over many prices (#291 C8): a customer list larger than one
// statement takes is indexed in batches. Its own file, since it writes 4 000
// rows and their successors, over the setup price-indexation.test.ts shares.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { PriceList } from "@waste/contracts/price-lists"
import { type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { priceListRow } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { WRITE_BATCH } from "../routes/indexation"
import { type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { answered, create, JANUARY, NEW_YEAR, send, setUpIndexation, tearDownIndexation, type IndexationSuite } from "./price-indexation-suite"
import { testId, type Tenant } from "./tenant"

const database = databaseUnderTest()

describe("Apply index over many prices", { skip: database.skip }, () => {
  let suite: IndexationSuite
  let pool: Database
  let a: Tenant
  let olivia: Call

  before(async () => {
    suite = await setUpIndexation(database.url)
    ;({ pool, a, olivia } = suite)
  })
  after(() => tearDownIndexation(suite))

  describe("a list larger than one statement takes", () => {
    test("is indexed in batches: every row ended and its successor written, in one request", async () => {
      // A successor binds about seventeen parameters and Postgres takes 65 535 a statement: 4 000 rows are past one statement's worth.
      const count = 4_000
      assert.ok(count > WRITE_BATCH && count * 17 > 65_535)
      const list = await create(olivia, "/price-lists", { projectId: a.projects.copenhagen.id, code: "pl-idx-large", name: "Large", validFrom: JANUARY }, PriceList)
      const projectId = a.projects.copenhagen.id
      const productIds = Array.from({ length: count }, () => testId())
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        for (let start = 0; start < count; start += 1_000) {
          const ids = productIds.slice(start, start + 1_000)
          await tx.insert(product).values(ids.map((id, offset) => ({ id, companyId: a.companyId, projectId, name: `Bulk ${start + offset}`, kind: "additional-service", status: "active", unit: "job", vatPercent: 25 })))
          await tx.insert(priceListRow).values(ids.map((productId, offset) => ({ id: testId(), companyId: a.companyId, projectId, priceListId: list.id, productId, unitPriceMinor: 1_000 + start + offset, validFrom: JANUARY })))
        }
      })
      const result = await answered(await send(olivia, `/price-lists/${list.id}/index`, { label: "CPI", basisPoints: 1_000, appliedFrom: NEW_YEAR }), 201)
      assert.equal(result.lines.length, count)
      assert.ok(result.lines.every((line) => line.skipped === null && line.indexedId !== null && line.toMinor === Math.round(line.fromMinor * 1.1)))
      const written = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.select({ validTo: priceListRow.validTo }).from(priceListRow).where(eq(priceListRow.priceListId, list.id)))
      assert.deepEqual([written.length, written.filter((row) => row.validTo === NEW_YEAR).length], [2 * count, count])
    })
  })
})

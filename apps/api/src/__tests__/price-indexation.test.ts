// Apply index over many prices (#291 C8), a customer list's rows:
// `POST /price-lists/:id/index` — the preview, the write, the chain, the rows
// left with their reasons, and the refusals. A list larger than one statement
// takes is price-indexation-batches.test.ts, and a provider's or an award's
// prices provider-price-indexation.test.ts, over the same setup.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { type Product } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { PriceList, PriceListRow, PriceResolution } from "@waste/contracts/price-lists"
import { nothingToIndex } from "@waste/domain/finance/indexation"

import { INDEX_BELOW_ZERO } from "../routes/indexation"
import { type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { type ProductFixtures } from "./finance-fixtures"
import { answered, create, JANUARY, JUNE, LATER, MARCH_NEXT, NEW_YEAR, refused, send, setUpIndexation, tearDownIndexation, type IndexationSuite } from "./price-indexation-suite"
import { type Tenant } from "./tenant"

const database = databaseUnderTest()
const RowPage = Page(PriceListRow)

describe("Apply index over many prices", { skip: database.skip }, () => {
  let suite: IndexationSuite
  let a: Tenant
  let b: Tenant
  let products: ProductFixtures
  let retired: Product
  let olivia: Call
  let other: Call
  let ungranted: Call

  before(async () => {
    suite = await setUpIndexation(database.url)
    ;({ a, b, products, retired, olivia, other, ungranted } = suite)
  })
  after(() => tearDownIndexation(suite))

  describe("POST /price-lists/:id/index", () => {
    let list: PriceList
    let running: PriceListRow
    let organisations: PriceListRow
    let typedIn: PriceListRow
    let scheduled: PriceListRow
    let ended: PriceListRow
    let ofRetired: PriceListRow

    before(async () => {
      list = await create(olivia, "/price-lists", { projectId: a.projects.copenhagen.id, code: "pl-idx", name: "Index", validFrom: JANUARY }, PriceList)
      const row = (values: Record<string, unknown>) => create(olivia, `/price-lists/${list.id}/rows`, values, PriceListRow, "/price-list-rows")
      running = await row({ productId: products.residual.id, unitPriceMinor: 10_050, validFrom: JANUARY, note: "Kerbside" })
      organisations = await row({ productId: products.glass.id, unitPriceMinor: 333, customerKind: "organisation", validFrom: JANUARY, validTo: LATER })
      typedIn = await row({ productId: products.rental.id, unitPriceMinor: 4_000, validFrom: NEW_YEAR })
      scheduled = await row({ productId: products.residual.id, unitPriceMinor: 9_000, customerKind: "person", validFrom: MARCH_NEXT })
      ended = await row({ productId: products.unrated.id, unitPriceMinor: 700, validFrom: JANUARY, validTo: JUNE })
      ofRetired = await row({ productId: retired.id, unitPriceMinor: 1_000, validFrom: JANUARY })
      const status = await olivia(`/products/${retired.id}`, { method: "PATCH", body: { status: "inactive" } })
      assert.equal(status.status, 200, JSON.stringify(await status.clone().json()))
    })

    const rows = async (query = "") => {
      const response = await olivia(`/price-lists/${list.id}/rows?limit=200${query}`)
      assert.equal(response.status, 200)
      return RowPage.parse(await response.json()).items
    }
    const index = { label: "CPI 2027", basisPoints: 320, appliedFrom: NEW_YEAR }

    test("the preview answers each row in force on the day or after it, indexed or left with why, and writes nothing", async () => {
      const before = await rows()
      const preview = await answered(await send(olivia, `/price-lists/${list.id}/index`, { ...index, dryRun: true }), 200)
      assert.deepEqual(preview, {
        dryRun: true,
        ...index,
        lines: [
          { id: running.id, productId: products.residual.id, fromMinor: 10_050, toMinor: 10_372, indexedId: null, skipped: null },
          { id: organisations.id, productId: products.glass.id, fromMinor: 333, toMinor: 344, indexedId: null, skipped: null },
          { id: typedIn.id, productId: products.rental.id, fromMinor: 4_000, toMinor: null, indexedId: null, skipped: "starts-on-index-day" },
          { id: scheduled.id, productId: products.residual.id, fromMinor: 9_000, toMinor: null, indexedId: null, skipped: "scheduled" },
          { id: ofRetired.id, productId: retired.id, fromMinor: 1_000, toMinor: null, indexedId: null, skipped: "product-not-active" },
        ],
      })
      assert.ok(!preview.lines.some((line) => line.id === ended.id), "a row ended before the day is not in the plan")
      assert.deepEqual(await rows(), before, "a preview writes nothing")
    })

    test("refuses a price below zero at basisPoints, a preview too, and a list or a caller it does not reach", async () => {
      const below = await refused(await send(olivia, `/price-lists/${list.id}/index`, { ...index, basisPoints: -20_000, dryRun: true }), 400)
      assert.deepEqual(below.errors, [{ path: "basisPoints", message: INDEX_BELOW_ZERO }])
      await refused(await send(olivia, `/price-lists/${list.id}/index`, { ...index, base: "bid" }), 400)
      const theirs = await create(other, "/price-lists", { projectId: b.projects.copenhagen.id, code: "pl-theirs", name: "Theirs", validFrom: JANUARY }, PriceList)
      await refused(await send(olivia, `/price-lists/${theirs.id}/index`, index), 404)
      await refused(await send(ungranted, `/price-lists/${theirs.id}/index`, index), 403)
    })

    test("the write ends each indexed row on the day and writes its successor on the chain; the price on a day is that day's row", async () => {
      const result = await answered(await send(olivia, `/price-lists/${list.id}/index`, index), 201)
      assert.equal(result.dryRun, false)
      const indexed = result.lines.filter((line) => line.skipped === null)
      assert.deepEqual(
        indexed.map((line) => [line.id, line.toMinor]),
        [
          [running.id, 10_372],
          [organisations.id, 344],
        ],
      )
      assert.deepEqual(
        result.lines.filter((line) => line.skipped !== null).map((line) => line.indexedId),
        [null, null, null],
      )

      const all = new Map((await rows()).map((row) => [row.id, row]))
      assert.equal(all.get(running.id)?.validTo, NEW_YEAR, "the old row ends on the day")
      assert.equal(all.get(organisations.id)?.validTo, NEW_YEAR)
      const next = all.get(indexed[0].indexedId ?? "")
      assert.ok(next !== undefined)
      assert.deepEqual(
        [next.unitPriceMinor, next.productId, next.customerKind, next.note, next.indexedFromId, next.indexLabel, next.indexBasisPoints, next.validFrom, next.validTo],
        [10_372, products.residual.id, null, null, running.id, "CPI 2027", 320, NEW_YEAR, null],
      )
      const glass = all.get(indexed[1].indexedId ?? "")
      assert.deepEqual([glass?.unitPriceMinor, glass?.customerKind, glass?.validFrom, glass?.validTo], [344, "organisation", NEW_YEAR, LATER], "the successor keeps the conditions and the old end")
      for (const untouched of [typedIn, scheduled, ofRetired, ended]) assert.deepEqual(all.get(untouched.id), untouched, "a row left is left as it was")

      // The resolver reads the row in force on each side of the day.
      const resolve = async (on: string) => {
        const response = await olivia(`/price-lists/${list.id}/resolve?productId=${products.residual.id}&on=${on}`)
        assert.equal(response.status, 200)
        return PriceResolution.parse(await response.json()).unitPriceMinor
      }
      assert.equal(await resolve("2026-12-31"), 10_050)
      assert.equal(await resolve(NEW_YEAR), 10_372)
    })

    test("a second write on the day indexes nothing and is refused; its preview says why each row stays", async () => {
      const again = await refused(await send(olivia, `/price-lists/${list.id}/index`, index), 409)
      assert.equal(again.detail, nothingToIndex(NEW_YEAR))
      const preview = await answered(await send(olivia, `/price-lists/${list.id}/index`, { ...index, dryRun: true }), 200)
      assert.ok(preview.lines.every((line) => line.skipped !== null))
    })

    test("a later index compounds over the indexed price and extends the chain", async () => {
      const result = await answered(await send(olivia, `/price-lists/${list.id}/index`, { label: "Fuel", basisPoints: -100, appliedFrom: "2027-07-01" }), 201)
      // The default row's successor, and the scheduled row, in force since March, indexed for the first time.
      const residual = result.lines.find((line) => line.fromMinor === 10_372)
      assert.deepEqual([residual?.productId, residual?.toMinor], [products.residual.id, 10_268])
      assert.deepEqual(result.lines.find((line) => line.id === scheduled.id)?.toMinor, 8_910)
      const all = new Map((await rows()).map((row) => [row.id, row]))
      const tail = all.get(residual?.indexedId ?? "")
      assert.equal(all.get(tail?.indexedFromId ?? "")?.indexedFromId, running.id, "the chain runs back to the row typed in")
    })
  })
})

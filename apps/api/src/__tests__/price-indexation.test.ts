// Apply index over many prices (#291 C8): `POST /price-lists/:id/index` over
// a customer list's rows, and `POST /service-provider-prices/index` over a
// provider's or an award's prices — the preview, the write, the chain, the
// rows left with their reasons, and the refusals.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Product } from "@waste/contracts/catalogue"
import { IndexResult } from "@waste/contracts/finance"
import { Page } from "@waste/contracts/pagination"
import { PriceList, PriceListRow, PriceResolution } from "@waste/contracts/price-lists"
import { ServiceProviderPrice } from "@waste/contracts/service-provider-prices"
import { createDb, type Database } from "@waste/db/client"
import { nothingToIndex } from "@waste/domain/finance/indexation"

import { createApp } from "../app"
import { INDEX_PRICE_BELOW_ZERO } from "../routes/indexation"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { seedProducts, seedServiceArea, type ProductFixtures, type SeededServiceArea } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const RowPage = Page(PriceListRow)
const PricePage = Page(ServiceProviderPrice)

const JANUARY = "2026-01-01"
const JUNE = "2026-06-01"
const JULY = "2026-07-01"
const NEW_YEAR = "2027-01-01"
const MARCH_NEXT = "2027-03-01"
const LATER = "2028-01-01"

describe("Apply index over many prices", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let products: ProductFixtures
  let retired: Product
  let olivia: Call
  let other: Call
  let ungranted: Call
  let nordren: SeededServiceArea
  let cityhaul: SeededServiceArea

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    products = await seedProducts(pool, a)
    nordren = await seedServiceArea(pool, a, { code: "CA-IDX-1", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: a.serviceProviders.nordren.id } })
    cityhaul = await seedServiceArea(pool, a, { code: "CA-IDX-2", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: a.serviceProviders.cityhaul.id } })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    retired = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Retired service", kind: "additional-service", unit: "job", status: "active", vatPercent: 25 }, Product)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>, at?: `/${string}`): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema, at)
  const answered = async (response: Response, status: number): Promise<IndexResult> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    assert.equal(response.headers.get("Location"), null, "many rows were made, none named")
    return IndexResult.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const send = (call: Call, path: string, body: unknown) => call(path, { method: "POST", body })

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
      assert.deepEqual(below.errors, [{ path: "basisPoints", message: INDEX_PRICE_BELOW_ZERO }])
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
        [10_372, products.residual.id, null, "Kerbside", running.id, "CPI 2027", 320, NEW_YEAR, null],
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

  describe("POST /service-provider-prices/index", () => {
    let nordrenResidual: ServiceProviderPrice
    let nordrenGlass: ServiceProviderPrice
    let cityhaulResidual: ServiceProviderPrice

    before(async () => {
      const price = (values: Record<string, unknown>) => create(olivia, "/service-provider-prices", { validFrom: JANUARY, ...values }, ServiceProviderPrice)
      nordrenResidual = await price({ serviceAreaAssignmentId: nordren.assignmentId, productId: products.residual.id, bidMinor: 3_000, unitPriceMinor: 3_200 })
      nordrenGlass = await price({ serviceAreaAssignmentId: nordren.assignmentId, productId: products.glass.id, bidMinor: 1_000 })
      cityhaulResidual = await price({ serviceAreaAssignmentId: cityhaul.assignmentId, productId: products.residual.id, bidMinor: 5_000 })
    })

    const prices = async (query: string) => {
      const response = await olivia(`/service-provider-prices?limit=200&${query}`)
      assert.equal(response.status, 200)
      return PricePage.parse(await response.json()).items
    }

    test("a provider's preview reads every price under its assignments and no other, over the base asked", async () => {
      const preview = await answered(await send(olivia, "/service-provider-prices/index", { serviceProviderId: a.serviceProviders.nordren.id, label: "CPI", basisPoints: 500, base: "bid", appliedFrom: JULY, dryRun: true }), 200)
      assert.deepEqual(
        preview.lines.map((line) => [line.id, line.fromMinor, line.toMinor]),
        [
          [nordrenResidual.id, 3_200, 3_150],
          [nordrenGlass.id, 1_000, 1_050],
        ],
      )
    })

    test("an award's write indexes its prices alone, over the current fee, on the chain the single index writes", async () => {
      const result = await answered(await send(olivia, "/service-provider-prices/index", { serviceAreaAssignmentId: cityhaul.assignmentId, label: "CPI", basisPoints: 500, base: "current-fee", appliedFrom: JULY }), 201)
      assert.deepEqual(
        result.lines.map((line) => [line.id, line.toMinor]),
        [[cityhaulResidual.id, 5_250]],
      )
      const chain = await prices(`serviceAreaAssignmentId=${cityhaul.assignmentId}`)
      assert.deepEqual(
        chain.map((item) => [item.validFrom, item.validTo, item.bidMinor, item.unitPriceMinor, item.indexedFromId, item.indexBase]),
        [
          [JANUARY, JULY, 5_000, 5_000, null, null],
          [JULY, null, 5_000, 5_250, cityhaulResidual.id, "current-fee"],
        ],
      )
      assert.equal(chain[1].id, result.lines[0].indexedId)
      assert.equal((await prices(`serviceAreaAssignmentId=${nordren.assignmentId}`)).length, 2, "the other award is untouched")
    })

    test("names exactly one scope, and one it reaches", async () => {
      const body = { label: "CPI", basisPoints: 500, base: "bid", appliedFrom: JULY }
      await refused(await send(olivia, "/service-provider-prices/index", body), 400)
      await refused(await send(olivia, "/service-provider-prices/index", { ...body, serviceProviderId: a.serviceProviders.nordren.id, serviceAreaAssignmentId: nordren.assignmentId }), 400)
      const stranger = await refused(await send(olivia, "/service-provider-prices/index", { ...body, serviceProviderId: testId() }), 400)
      assert.deepEqual(stranger.errors?.map((error) => error.path), ["serviceProviderId"])
      const award = await refused(await send(olivia, "/service-provider-prices/index", { ...body, serviceAreaAssignmentId: testId() }), 400)
      assert.deepEqual(award.errors?.map((error) => error.path), ["serviceAreaAssignmentId"])
      await refused(await send(ungranted, "/service-provider-prices/index", { ...body, serviceProviderId: b.serviceProviders.nordren.id }), 403)
    })
  })
})

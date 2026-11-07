// Apply index over many prices (#291 C8), a provider's or an award's prices:
// `POST /service-provider-prices/index` — the preview, the write on the
// chain, the scope and its refusals, over the setup price-indexation.test.ts
// shares.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Product } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { ServiceProviderPrice } from "@waste/contracts/service-provider-prices"
import { type Database } from "@waste/db/client"
import { unofferedProduct } from "@waste/domain/registry/catalogue"

import { type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { seedServiceArea, type ProductFixtures, type SeededServiceArea } from "./finance-fixtures"
import { answered, create, JANUARY, JULY, refused, send, setUpIndexation, tearDownIndexation, type IndexationSuite } from "./price-indexation-suite"
import { testId, type Tenant } from "./tenant"

const database = databaseUnderTest()
const PricePage = Page(ServiceProviderPrice)

describe("Apply index over many prices", { skip: database.skip }, () => {
  let suite: IndexationSuite
  let pool: Database
  let a: Tenant
  let b: Tenant
  let products: ProductFixtures
  let olivia: Call
  let ungranted: Call
  let nordren: SeededServiceArea
  let cityhaul: SeededServiceArea

  before(async () => {
    suite = await setUpIndexation(database.url)
    ;({ pool, a, b, products, olivia, ungranted, nordren, cityhaul } = suite)
  })
  after(() => tearDownIndexation(suite))

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

    test("a price whose product is no longer active: the bulk index leaves it, and the single index refuses it, since the next row is a new reference to the product", async () => {
      const award = await seedServiceArea(pool, a, { code: "CA-IDX-3", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: a.serviceProviders.cityhaul.id } })
      const offered = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Offered, then not", kind: "additional-service", unit: "job", status: "active", vatPercent: 25 }, Product)
      const price = await create(olivia, "/service-provider-prices", { serviceAreaAssignmentId: award.assignmentId, productId: offered.id, bidMinor: 2_000, validFrom: JANUARY }, ServiceProviderPrice)
      const retiring = await olivia(`/products/${offered.id}`, { method: "PATCH", body: { status: "inactive" } })
      assert.equal(retiring.status, 200)
      const preview = await answered(await send(olivia, "/service-provider-prices/index", { serviceAreaAssignmentId: award.assignmentId, label: "CPI", basisPoints: 500, base: "bid", appliedFrom: JULY, dryRun: true }), 200)
      assert.deepEqual(preview.lines.map((line) => line.skipped), ["product-not-active"])
      const single = await refused(await send(olivia, `/service-provider-prices/${price.id}/index`, { label: "CPI", basisPoints: 500, base: "bid", appliedFrom: JULY }), 409)
      assert.equal(single.detail, unofferedProduct("inactive"))
      assert.equal((await prices(`serviceAreaAssignmentId=${award.assignmentId}`)).length, 1, "a refused index ends nothing")
    })
  })
})

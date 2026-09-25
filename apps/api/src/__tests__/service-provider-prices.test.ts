import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Product } from "@waste/contracts/catalogue"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { ServiceProviderPrice } from "@waste/contracts/service-provider-prices"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { seedProducts, seedServiceArea, type ProductFixtures, type SeededServiceArea } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { seedPlanning, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const PricePage = Page(ServiceProviderPrice)

const MODULE = "commercial.service-provider-prices"

/** The days the periods of this file are cut from; every test says which of them it means. */
const JANUARY = "2026-01-01"
const MARCH = "2026-03-01"
const JUNE = "2026-06-30"
const JULY = "2026-07-01"
const OCTOBER = "2026-10-01"
const DECEMBER = "2026-12-31"
const NEXT_YEAR = "2027-01-01"

/** The sentences this family answers with, pinned here so a change to one is a change to this file too. */
const PRICE_RUNNING = "This assignment already prices this product over part of that period; end it first"
const OUTSIDE_ASSIGNMENT = "Outside the assignment's period"
const INDEX_OUTSIDE = "The index applies inside the price's period"
const priceEnded = (day: string) => `This price ended on ${day}; index the price in force`

describe("the service provider price endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let planning: PlanningFixtures
  let products: ProductFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager at NordRen: `view` on this module by charter, no project. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** NordRen's Copenhagen award, assigned from March through the year; CityHaul's Copenhagen award; NordRen's Harbor award, out of the viewer's reach. */
  let nordren: SeededServiceArea
  let cityhaul: SeededServiceArea
  let harbor: SeededServiceArea
  let harborProduct: Product
  let draftProduct: Product
  /** A product no other test prices: the chain the index tests build. */
  let bulky: Product
  let theirPrice: ServiceProviderPrice

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    planning = await seedPlanning(pool, a)
    products = await seedProducts(pool, a)
    nordren = await seedServiceArea(pool, a, { code: "CA-Ø-2", planningAreaIds: [planning.areas.centrum.id], validFrom: JANUARY, validTo: NEXT_YEAR, assignment: { serviceProviderId: a.serviceProviders.nordren.id, validFrom: MARCH } })
    cityhaul = await seedServiceArea(pool, a, { code: "CA-V-1", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: a.serviceProviders.cityhaul.id } })
    harbor = await seedServiceArea(pool, a, { projectId: a.projects.harbor.id, code: "CA-HAVN", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: a.serviceProviders.nordren.id } })
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    harborProduct = await create(olivia, "/products", { projectId: a.projects.harbor.id, name: "Harbor collection", kind: "container-collection", unit: "pickup", status: "active" }, Product)
    draftProduct = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Not yet offered", kind: "additional-service", unit: "job" }, Product)
    bulky = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Bulky waste collection", kind: "additional-service", unit: "job", status: "active", vatPercent: 25 }, Product)
    const theirProducts = await seedProducts(pool, b)
    const theirs = await seedServiceArea(pool, b, { code: "CA-THEIRS", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: b.serviceProviders.nordren.id } })
    theirPrice = await create(other, "/service-provider-prices", { serviceAreaAssignmentId: theirs.assignmentId, productId: theirProducts.residual.id, bidMinor: 100, validFrom: JANUARY }, ServiceProviderPrice)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A price body a caller may send: NordRen's assignment, the residual collection, a bid of 30.00 kr, the assignment's period. */
  const body = (values: Record<string, unknown> = {}) => ({
    serviceAreaAssignmentId: nordren.assignmentId,
    productId: products.residual.id,
    bidMinor: 3_000,
    validFrom: MARCH,
    validTo: NEXT_YEAR,
    ...values,
  })

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const price = (values: Record<string, unknown> = {}) => create(olivia, "/service-provider-prices", body(values), ServiceProviderPrice)
  const one = async (call: Call, id: string): Promise<ServiceProviderPrice> => {
    const response = await call(`/service-provider-prices/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceProviderPrice.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<ServiceProviderPrice> => {
    const response = await call(`/service-provider-prices/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceProviderPrice.parse(await response.json())
  }
  /** The index command: a create, read at the new row's address. */
  const index = async (call: Call, id: string, values: Record<string, unknown>): Promise<ServiceProviderPrice> =>
    created(call, `/service-provider-prices/${id}/index`, await call(`/service-provider-prices/${id}/index`, { method: "POST", body: values }), ServiceProviderPrice, "/service-provider-prices")
  const page = async (call: Call, query = "") => {
    const response = await call(`/service-provider-prices${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PricePage.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)
  const messages = (problem: { errors?: { message: string }[] }) => problem.errors?.map((error) => error.message)

  describe("POST /service-provider-prices", () => {
    test("mints the id, takes the project and the currency from the assignment's project, defaults the fee to the bid, starts the chain with no index, and the read agrees", async () => {
      const made = await price()
      assert.equal(Id.parse(made.id), made.id, "a version 7 id the server minted")
      assert.deepEqual([made.projectId, made.serviceAreaAssignmentId, made.productId], [a.projects.copenhagen.id, nordren.assignmentId, products.residual.id])
      assert.deepEqual([made.bidMinor, made.unitPriceMinor, made.currency], [3_000, 3_000, "DKK"], "the fee is the bid until indexed, in the project's currency")
      assert.deepEqual([made.indexedFromId, made.indexLabel, made.indexBasisPoints, made.indexBase, made.notes], [null, null, null, null, null])
      assert.deepEqual([made.validFrom, made.validTo], [MARCH, NEXT_YEAR])
      assert.deepEqual(await one(olivia, made.id), made)
      const quoted = await price({ productId: products.glass.id, unitPriceMinor: 3_200, notes: "Base collection 32.00 flat per pickup" })
      assert.deepEqual([quoted.bidMinor, quoted.unitPriceMinor, quoted.notes], [3_000, 3_200, "Base collection 32.00 flat per pickup"], "a fee given stands beside the bid")
    })

    test("refuses an assignment outside the caller's projects, a product of another project, a period outside the assignment's at the bound, an end before the start, and a member the server owns", async () => {
      const outOfReach = await refused(await viewer("/service-provider-prices", { method: "POST", body: body({ serviceAreaAssignmentId: harbor.assignmentId }) }), 400)
      assert.deepEqual([paths(outOfReach), messages(outOfReach)], [["serviceAreaAssignmentId"], ["Not an assignment of this project"]])
      const nobodys = await refused(await olivia("/service-provider-prices", { method: "POST", body: body({ serviceAreaAssignmentId: testId() }) }), 400)
      assert.deepEqual(paths(nobodys), ["serviceAreaAssignmentId"])
      const wrongProduct = await refused(await olivia("/service-provider-prices", { method: "POST", body: body({ productId: harborProduct.id }) }), 400)
      assert.deepEqual([paths(wrongProduct), messages(wrongProduct)], [["productId"], ["Not a product of this project"]])
      const early = await refused(await olivia("/service-provider-prices", { method: "POST", body: body({ productId: products.rental.id, validFrom: JANUARY, validTo: null }) }), 400)
      assert.deepEqual([paths(early), messages(early)], [["validFrom", "validTo"], [OUTSIDE_ASSIGNMENT, OUTSIDE_ASSIGNMENT]])
      const backwards = await refused(await olivia("/service-provider-prices", { method: "POST", body: body({ validFrom: JULY, validTo: MARCH }) }), 400)
      assert.deepEqual(messages(backwards), [ENDS_AFTER_IT_STARTS])
      for (const [field, value] of [["currency", "EUR"], ["indexedFromId", testId()], ["projectId", a.projects.copenhagen.id], ["id", testId()]] as const) {
        const owned = await refused(await olivia("/service-provider-prices", { method: "POST", body: body({ [field]: value }) }), 400)
        assert.ok(owned.errors?.some((error) => error.message.includes(field)), `${field}: ${JSON.stringify(owned.errors)}`)
      }
      const lars_ = await refused(await lars("/service-provider-prices", { method: "POST", body: body() }), 403)
      assert.match(lars_.detail ?? "", /create/, "the manager's charter grants view alone")
      await refused(await ungranted("/service-provider-prices", { method: "POST", body: body() }), 403)
    })

    test("refuses a product that is not active with the status sentence, a second price of the product over an overlapping period with its sentence, and takes another product and the next period", async () => {
      const draft = await refused(await olivia("/service-provider-prices", { method: "POST", body: body({ productId: draftProduct.id }) }), 409)
      assert.equal(draft.detail, "The product is draft; only an active product can be subscribed to")
      const twice = await refused(await olivia("/service-provider-prices", { method: "POST", body: body({ bidMinor: 3_100, validFrom: JULY }) }), 409)
      assert.equal(twice.detail, PRICE_RUNNING)
      const unrated = await price({ productId: products.unrated.id, bidMinor: 1_000, validTo: JULY })
      const next = await price({ productId: products.unrated.id, bidMinor: 1_100, validFrom: JULY })
      assert.deepEqual([unrated.validTo, next.validFrom], [JULY, JULY])
    })
  })

  describe("GET /service-provider-prices", () => {
    test("answers the caller's prices in id order, by project, assignment, provider, product and day, and holds nothing of another company's", async () => {
      const all = await page(olivia, "?limit=200")
      const ids = all.items.map((item) => item.id)
      assert.deepEqual(ids, [...ids].sort(), "oldest first")
      assert.equal(all.items.some((item) => item.id === theirPrice.id), false)
      const ofAssignment = await page(olivia, `?serviceAreaAssignmentId=${nordren.assignmentId}&limit=200`)
      assert.ok(ofAssignment.items.length >= 4)
      assert.ok(ofAssignment.items.every((item) => item.serviceAreaAssignmentId === nordren.assignmentId))
      const cityhauls = await page(olivia, `?serviceProviderId=${a.serviceProviders.cityhaul.id}&limit=200`)
      assert.deepEqual(cityhauls.items, [], "CityHaul has no price yet")
      const nordrens = await page(olivia, `?serviceProviderId=${a.serviceProviders.nordren.id}&limit=200`)
      assert.equal(nordrens.items.length, ofAssignment.items.length, "every price of NordRen's is under its Copenhagen assignment")
      const unrated = await page(olivia, `?productId=${products.unrated.id}&validOn=${JUNE}`)
      assert.deepEqual(unrated.items.map((item) => item.bidMinor), [1_000])
      const later = await page(olivia, `?productId=${products.unrated.id}&validOn=${JULY}`)
      assert.deepEqual(later.items.map((item) => item.bidMinor), [1_100])
      const cairo = await refused(await viewer(`/service-provider-prices?projectId=${a.projects.cairo.id}`), 400)
      assert.deepEqual(paths(cairo), ["projectId"])
      await refused(await olivia("/service-provider-prices?validOn=2026-02-30"), 400)
    })

    test("shows an office account only its projects, and a provider's account the prices under its own assignments alone", async () => {
      const harborPrice = await create(olivia, "/service-provider-prices", { serviceAreaAssignmentId: harbor.assignmentId, productId: harborProduct.id, bidMinor: 500, validFrom: JANUARY }, ServiceProviderPrice)
      const cityhaulPrice = await create(olivia, "/service-provider-prices", { serviceAreaAssignmentId: cityhaul.assignmentId, productId: products.glass.id, bidMinor: 700, validFrom: JANUARY }, ServiceProviderPrice)
      const seen = await page(viewer, "?limit=200")
      assert.ok(seen.items.every((item) => item.projectId === a.projects.copenhagen.id))
      assert.equal(seen.items.some((item) => item.id === harborPrice.id), false)
      const his = await page(lars, "?limit=200")
      assert.ok(his.items.length >= 5)
      assert.ok(his.items.every((item) => item.serviceAreaAssignmentId === nordren.assignmentId || item.serviceAreaAssignmentId === harbor.assignmentId), "Lars reads the prices under NordRen's two assignments, Harbor's included, since his reach is the provider's and not a project's")
      assert.equal(his.items.some((item) => item.id === cityhaulPrice.id), false, "and nothing of CityHaul's")
      assert.deepEqual(await one(lars, harborPrice.id), harborPrice)
      await refused(await lars(`/service-provider-prices/${cityhaulPrice.id}`), 404)
      await refused(await ungranted("/service-provider-prices"), 403)
      assert.equal((await app.request("/service-provider-prices")).status, 401)
    })
  })

  describe("GET /service-provider-prices/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const harborPrice = (await page(olivia, `?projectId=${a.projects.harbor.id}`)).items[0]
      await refused(await olivia(`/service-provider-prices/${theirPrice.id}`), 404)
      await refused(await viewer(`/service-provider-prices/${harborPrice.id}`), 404)
      await refused(await olivia(`/service-provider-prices/${testId()}`), 404)
      await refused(await olivia("/service-provider-prices/not-an-id"), 400)
    })
  })

  describe("PATCH /service-provider-prices/:id", () => {
    test("changes the notes and the end, moving the stamp; the bid, the fee, the assignment, the product and the start are not fields of the patch; a provider's account changes nothing", async () => {
      const made = await price({ productId: products.rental.id, bidMinor: 20_000 })
      await nextMillisecond()
      const changed = await patch(olivia, made.id, { notes: "Per bin per month", validTo: OCTOBER })
      assert.deepEqual([changed.notes, changed.validTo, changed.bidMinor, changed.unitPriceMinor], ["Per bin per month", OCTOBER, 20_000, 20_000])
      assert.ok(changed.updatedAt > made.updatedAt)
      for (const field of ["bidMinor", "unitPriceMinor", "serviceAreaAssignmentId", "productId", "validFrom", "currency"]) {
        const owned = await refused(await olivia(`/service-provider-prices/${made.id}`, { method: "PATCH", body: { [field]: 1 } }), 400)
        assert.ok(owned.errors?.some((error) => error.message.includes(field)), `${field}: ${JSON.stringify(owned.errors)}`)
      }
      await refused(await lars(`/service-provider-prices/${made.id}`, { method: "PATCH", body: { notes: "Lars's" } }), 403)
      await refused(await olivia(`/service-provider-prices/${theirPrice.id}`, { method: "PATCH", body: { notes: "Mine" } }), 404)
      await refused(await olivia(`/service-provider-prices/${made.id}`, { method: "PATCH", body: {} }), 400)
    })

    test("refuses an end outside the assignment's period, an end before the start in the contracts' words, and a reopened row meeting the next of the chain with the overlap sentence", async () => {
      const made = (await page(olivia, `?productId=${products.unrated.id}&validOn=${JUNE}`)).items[0]
      const outside = await refused(await olivia(`/service-provider-prices/${made.id}`, { method: "PATCH", body: { validTo: "2027-06-01" } }), 400)
      assert.deepEqual([paths(outside), messages(outside)], [["validTo"], [OUTSIDE_ASSIGNMENT]])
      const backwards = await refused(await olivia(`/service-provider-prices/${made.id}`, { method: "PATCH", body: { validTo: JANUARY } }), 400)
      assert.deepEqual(messages(backwards), [ENDS_AFTER_IT_STARTS])
      const overlapping = await refused(await olivia(`/service-provider-prices/${made.id}`, { method: "PATCH", body: { validTo: OCTOBER } }), 409)
      assert.equal(overlapping.detail, PRICE_RUNNING)
      assert.equal((await patch(olivia, made.id, { validTo: JUNE })).validTo, JUNE, "a shorter end meets nothing")
    })
  })

  describe("POST /service-provider-prices/:id/index", () => {
    test("writes two rows: this one ended on the day, the next from it with the indexed fee, the same bid and currency, the chain and the old end; a day reads its own fee", async () => {
      const first = await price({ productId: bulky.id, bidMinor: 3_000, validFrom: MARCH, validTo: NEXT_YEAR, notes: "The bid" })
      await nextMillisecond()
      const second = await index(olivia, first.id, { label: "CPI", basisPoints: 500, base: "bid", appliedFrom: JULY })
      assert.notEqual(second.id, first.id, "a new row, not an update")
      assert.deepEqual([second.serviceAreaAssignmentId, second.productId, second.bidMinor, second.currency], [first.serviceAreaAssignmentId, first.productId, 3_000, "DKK"])
      assert.equal(second.unitPriceMinor, 3_150, "round(3000 × 1.05)")
      assert.deepEqual([second.indexedFromId, second.indexLabel, second.indexBasisPoints, second.indexBase], [first.id, "CPI", 500, "bid"])
      assert.deepEqual([second.validFrom, second.validTo], [JULY, NEXT_YEAR], "from the day, to where the old row ended")
      assert.equal(second.notes, null)
      const ended = await one(olivia, first.id)
      assert.deepEqual([ended.validFrom, ended.validTo, ended.unitPriceMinor, ended.bidMinor], [MARCH, JULY, 3_000, 3_000], "the old row ends on the day and keeps its fee")
      assert.ok(ended.updatedAt > first.updatedAt)
      const before = await page(olivia, `?productId=${bulky.id}&serviceAreaAssignmentId=${nordren.assignmentId}&validOn=${JUNE}`)
      assert.deepEqual(before.items.map((item) => item.unitPriceMinor), [3_000])
      const after_ = await page(olivia, `?productId=${bulky.id}&serviceAreaAssignmentId=${nordren.assignmentId}&validOn=${JULY}`)
      assert.deepEqual(after_.items.map((item) => item.unitPriceMinor), [3_150])
      // A deflator over the current fee compounds: round(3150 × 0.98) = 3087, and the chain points at the second row.
      const third = await index(olivia, second.id, { label: "Fuel adjustment", basisPoints: -200, base: "current-fee", appliedFrom: OCTOBER })
      assert.deepEqual([third.unitPriceMinor, third.bidMinor, third.indexedFromId, third.indexBase, third.validFrom, third.validTo], [3_087, 3_000, second.id, "current-fee", OCTOBER, NEXT_YEAR])
      assert.equal((await one(olivia, second.id)).validTo, OCTOBER)
      const chain = (await page(olivia, `?productId=${bulky.id}&serviceAreaAssignmentId=${nordren.assignmentId}&limit=200`)).items
      assert.deepEqual(
        chain.map((item) => [item.validFrom, item.validTo, item.unitPriceMinor, item.bidMinor, item.indexedFromId]),
        [
          [MARCH, JULY, 3_000, 3_000, null],
          [JULY, OCTOBER, 3_150, 3_000, first.id],
          [OCTOBER, NEXT_YEAR, 3_087, 3_000, second.id],
        ],
        "the bid never moves; the chain is the history",
      )
    })

    test("refuses a day on or before the row's start at appliedFrom, a row already ended on or before the day with its sentence, a base outside the two, a role that may view but not edit, and a row outside the caller's reach", async () => {
      const chain = (await page(olivia, `?productId=${bulky.id}&serviceAreaAssignmentId=${nordren.assignmentId}&limit=200`)).items
      assert.equal(chain.length, 3, "the chain the test above built")
      const [first, , third] = chain
      const early = await refused(await olivia(`/service-provider-prices/${third.id}/index`, { method: "POST", body: { label: "CPI", basisPoints: 100, base: "bid", appliedFrom: OCTOBER } }), 400)
      assert.deepEqual([paths(early), messages(early)], [["appliedFrom"], [INDEX_OUTSIDE]])
      const over = await refused(await olivia(`/service-provider-prices/${first.id}/index`, { method: "POST", body: { label: "CPI", basisPoints: 100, base: "bid", appliedFrom: DECEMBER } }), 409)
      assert.equal(over.detail, priceEnded(JULY))
      const onTheEnd = await refused(await olivia(`/service-provider-prices/${first.id}/index`, { method: "POST", body: { label: "CPI", basisPoints: 100, base: "bid", appliedFrom: JULY } }), 409)
      assert.equal(onTheEnd.detail, priceEnded(JULY))
      const base = await refused(await olivia(`/service-provider-prices/${third.id}/index`, { method: "POST", body: { label: "CPI", basisPoints: 100, base: "wholesale", appliedFrom: DECEMBER } }), 400)
      assert.deepEqual(paths(base), ["base"])
      await refused(await lars(`/service-provider-prices/${third.id}/index`, { method: "POST", body: { label: "CPI", basisPoints: 100, base: "bid", appliedFrom: DECEMBER } }), 403)
      await refused(await olivia(`/service-provider-prices/${theirPrice.id}/index`, { method: "POST", body: { label: "CPI", basisPoints: 100, base: "bid", appliedFrom: DECEMBER } }), 404)
      const harborPrice = (await page(olivia, `?projectId=${a.projects.harbor.id}`)).items[0]
      await refused(await viewer(`/service-provider-prices/${harborPrice.id}/index`, { method: "POST", body: { label: "CPI", basisPoints: 100, base: "bid", appliedFrom: DECEMBER } }), 404)
      assert.equal((await page(olivia, `?productId=${bulky.id}&serviceAreaAssignmentId=${nordren.assignmentId}&limit=200`)).items.length, 3, "a refused index wrote nothing")
    })

    test("the indexed row can meet no other: the ground it takes is the tail of the row it splits, which the constraint holds clear — a create over it is refused, and the split row is indexed again inside what it kept", async () => {
      const chain = (await page(olivia, `?productId=${bulky.id}&serviceAreaAssignmentId=${nordren.assignmentId}&limit=200`)).items
      const [first, second] = chain
      assert.deepEqual([first.validFrom, first.validTo, second.validFrom, second.validTo], [MARCH, JULY, JULY, OCTOBER])
      // What the indexed row's ground looks like to anyone else: taken, in the create's words.
      const wedge = await refused(await olivia("/service-provider-prices", { method: "POST", body: { serviceAreaAssignmentId: nordren.assignmentId, productId: bulky.id, bidMinor: 1, validFrom: JULY, validTo: OCTOBER } }), 409)
      assert.equal(wedge.detail, PRICE_RUNNING)
      // The ended row is indexed again inside the period it kept: the new row takes [May, July), the tail of [March, July), and meets nothing.
      const again = await index(olivia, first.id, { label: "Spring CPI", basisPoints: 100, base: "bid", appliedFrom: "2026-05-01" })
      assert.deepEqual([again.validFrom, again.validTo, again.indexedFromId, again.unitPriceMinor], ["2026-05-01", JULY, first.id, 3_030])
      assert.deepEqual([(await one(olivia, first.id)).validTo, (await one(olivia, second.id)).validFrom], ["2026-05-01", JULY], "the split row ends on the day; the next row of the chain is untouched")
      const rows = (await page(olivia, `?productId=${bulky.id}&serviceAreaAssignmentId=${nordren.assignmentId}&limit=200`)).items
      assert.deepEqual(
        rows.map((item) => [item.validFrom, item.validTo]).sort(),
        [
          [MARCH, "2026-05-01"],
          ["2026-05-01", JULY],
          [JULY, OCTOBER],
          [OCTOBER, NEXT_YEAR],
        ],
        "four rows tiling the period, none overlapping",
      )
    })
  })
})

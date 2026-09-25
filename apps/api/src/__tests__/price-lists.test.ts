import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType, Product, WasteFraction } from "@waste/contracts/catalogue"
import { Customer } from "@waste/contracts/customers"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { PriceList, PriceListRow, PriceResolution } from "@waste/contracts/price-lists"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { seedProducts, type ProductFixtures } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { seedPlanning, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const PriceListPage = Page(PriceList)
const RowPage = Page(PriceListRow)

const MODULE = "commercial.price-rows"

/** The days the periods of this file are cut from; every test says which of them it means. */
const JANUARY = "2026-01-01"
const MARCH = "2026-03-01"
const JULY = "2026-07-01"
const AUGUST = "2026-08-20"
const NEXT_YEAR = "2027-01-01"

/** The sentences this family answers with, pinned here so a change to one is a change to this file too. */
const DEFAULT_TAKEN = "This project already has a default price list; unset it first"
const LIST_RUNNING = "A price list of this code is already in force over part of that period"
const ROW_RUNNING = "A row of this product with these conditions is already in force over part of that period; end it first or schedule this one after it"
const OUTSIDE_LIST = "Outside the price list's period"
const defaultInCurrency = (currency: string) => `A default price list is in the project's currency (${currency})`

describe("the price list endpoints", { skip: database.skip }, () => {
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
  /** The Service Provider Manager, granted view: a provider's account works in no project and reaches no list. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** What a row's conditions name. */
  let bin: ContainerType
  let residual: WasteFraction
  let glass: WasteFraction
  let osterbro: Customer
  let cowork: Customer
  /** A product not yet offered, and one of another project. */
  let draftProduct: Product
  let harborProduct: Product
  /** The other company's rows, for the 400s. */
  let theirType: ContainerType
  let theirList: PriceList

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
    planning = await seedPlanning(pool, a)
    products = await seedProducts(pool, a)
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    bin = await create(olivia, "/container-types", { name: "660 L container", volumeLitres: 660 }, ContainerType)
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
    osterbro = await create(olivia, "/customers", { kind: "organisation", name: "Østerbro Housing Association" }, Customer)
    cowork = await create(olivia, "/customers", { kind: "organisation", name: "Nørrebro CoWork ApS" }, Customer)
    draftProduct = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Not yet offered", kind: "additional-service", unit: "job" }, Product)
    harborProduct = await create(olivia, "/products", { projectId: a.projects.harbor.id, name: "Harbor collection", kind: "container-collection", unit: "pickup", status: "active" }, Product)
    theirType = await create(other, "/container-types", { name: "Their bin" }, ContainerType)
    theirList = await create(other, "/price-lists", { projectId: b.projects.copenhagen.id, code: "pl-theirs", name: "Theirs", validFrom: JANUARY }, PriceList)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A list body a caller may send: Copenhagen Central, the year 2026, nothing else decided. */
  const body = (code: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    code,
    name: `List ${code}`,
    validFrom: JANUARY,
    validTo: NEXT_YEAR,
    ...values,
  })

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const list = (code: string, values: Record<string, unknown> = {}) => create(olivia, "/price-lists", body(code, values), PriceList)
  /** A row posted under its list, read at `/price-list-rows/{id}`. */
  const row = async (call: Call, listId: string, values: Record<string, unknown>): Promise<PriceListRow> =>
    created(call, `/price-lists/${listId}/rows`, await call(`/price-lists/${listId}/rows`, { method: "POST", body: values }), PriceListRow, "/price-list-rows")
  /** The residual collection over the whole of 2026 unless said otherwise. */
  const rowBody = (values: Record<string, unknown> = {}) => ({ productId: products.residual.id, unitPriceMinor: 4_500, validFrom: JANUARY, validTo: NEXT_YEAR, ...values })
  const one = async (call: Call, id: string): Promise<PriceList> => {
    const response = await call(`/price-lists/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PriceList.parse(await response.json())
  }
  const oneRow = async (call: Call, id: string): Promise<PriceListRow> => {
    const response = await call(`/price-list-rows/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PriceListRow.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<PriceList> => {
    const response = await call(`/price-lists/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PriceList.parse(await response.json())
  }
  const patchRow = async (call: Call, id: string, values: unknown): Promise<PriceListRow> => {
    const response = await call(`/price-list-rows/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PriceListRow.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/price-lists${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PriceListPage.parse(await response.json())
  }
  const rows = async (call: Call, listId: string, query = "") => {
    const response = await call(`/price-lists/${listId}/rows${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RowPage.parse(await response.json())
  }
  const resolve = async (call: Call, listId: string, query: Record<string, string>): Promise<PriceResolution> => {
    const response = await call(`/price-lists/${listId}/resolve?${new URLSearchParams(query)}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PriceResolution.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)
  const messages = (problem: { errors?: { message: string }[] }) => problem.errors?.map((error) => error.message)

  describe("POST /price-lists", () => {
    test("mints the id, defaults the currency to the project's and the flag to false, and the read agrees", async () => {
      const made = await list("pl-a")
      assert.equal(Id.parse(made.id), made.id, "a version 7 id the server minted")
      assert.deepEqual([made.projectId, made.code, made.name], [a.projects.copenhagen.id, "pl-a", "List pl-a"])
      assert.equal(made.currency, "DKK", "Copenhagen Central bills in DKK")
      assert.equal(made.isDefault, false)
      assert.equal(made.notes, null)
      assert.deepEqual([made.validFrom, made.validTo], [JANUARY, NEXT_YEAR])
      assert.deepEqual(await one(olivia, made.id), made)
      const cairo = await list("pl-cai", { projectId: a.projects.cairo.id })
      assert.equal(cairo.currency, "EGP", "Cairo Operations bills in EGP, and the list follows the project")
    })

    test("takes a default list in the project's currency, refuses a second default with its sentence whatever its period, and a default in another currency at isDefault", async () => {
      const tariff = await list("pl-cph-2026", { isDefault: true, notes: "The tariff" })
      assert.equal(tariff.isDefault, true)
      const second = await refused(await olivia("/price-lists", { method: "POST", body: body("pl-cph-2027", { isDefault: true, validFrom: NEXT_YEAR, validTo: null }) }), 409)
      assert.equal(second.detail, DEFAULT_TAKEN)
      const euro = await refused(await olivia("/price-lists", { method: "POST", body: body("pl-eur-default", { isDefault: true, currency: "EUR" }) }), 400)
      assert.deepEqual(paths(euro), ["isDefault"])
      assert.deepEqual(messages(euro), [defaultInCurrency("DKK")])
      // A named list in another currency is fine: an agreement in EUR is priced under it.
      const named = await list("pl-eur", { currency: "EUR" })
      assert.equal(named.currency, "EUR")
    })

    test("refuses a period overlapping another list of the code with its sentence, and takes one back to back", async () => {
      await list("pl-year")
      const overlapping = await refused(await olivia("/price-lists", { method: "POST", body: body("pl-year", { validFrom: JULY, validTo: null }) }), 409)
      assert.equal(overlapping.detail, LIST_RUNNING)
      const next = await list("pl-year", { validFrom: NEXT_YEAR, validTo: null })
      assert.equal(next.validFrom, NEXT_YEAR, "the next tariff year begins where this one ends")
    })

    test("refuses a project the caller does not work in, a member the server owns, and an end on or before the start", async () => {
      const harbor = await refused(await viewer("/price-lists", { method: "POST", body: body("pl-h", { projectId: a.projects.harbor.id }) }), 400)
      assert.deepEqual(paths(harbor), ["projectId"])
      const owned = await refused(await olivia("/price-lists", { method: "POST", body: body("pl-owned", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      const backwards = await refused(await olivia("/price-lists", { method: "POST", body: body("pl-back", { validTo: JANUARY }) }), 400)
      assert.deepEqual(paths(backwards), ["validTo"])
      assert.deepEqual(messages(backwards), [ENDS_AFTER_IT_STARTS])
    })

    test("refuses a role without the grant, and a provider's account naming a project it does not work in", async () => {
      await refused(await ungranted("/price-lists", { method: "POST", body: body("pl-u") }), 403)
      const lars_ = await refused(await lars("/price-lists", { method: "POST", body: body("pl-lars") }), 400)
      assert.deepEqual(paths(lars_), ["projectId"], "Lars works in no project, so every project is one he does not work in")
    })
  })

  describe("GET /price-lists", () => {
    test("answers the company's lists in id order, filters by project, day and default, and holds nothing of another company's", async () => {
      const all = await page(olivia, "?limit=200")
      const ids = all.items.map((item) => item.id)
      assert.deepEqual(ids, [...ids].sort(), "oldest first")
      assert.equal(all.items.some((item) => item.id === theirList.id), false)
      const copenhagen = await page(olivia, `?projectId=${a.projects.copenhagen.id}&limit=200`)
      assert.ok(copenhagen.items.length > 0)
      assert.ok(copenhagen.items.every((item) => item.projectId === a.projects.copenhagen.id))
      const defaults = await page(olivia, "?isDefault=true&limit=200")
      assert.deepEqual(defaults.items.map((item) => item.code), ["pl-cph-2026"])
      const inForce = await page(olivia, `?validOn=${AUGUST}&limit=200`)
      assert.ok(inForce.items.every((item) => item.validFrom <= AUGUST && (item.validTo === null || item.validTo > AUGUST)))
      assert.equal(inForce.items.some((item) => item.code === "pl-year" && item.validFrom === NEXT_YEAR), false, "the next year's list is not in force in August")
      const cairoProject = await refused(await viewer(`/price-lists?projectId=${a.projects.cairo.id}`), 400)
      assert.deepEqual(paths(cairoProject), ["projectId"])
    })

    test("shows an account only the projects it works in, and answers an empty page to a provider's account, though its role may view", async () => {
      const seen = await page(viewer, "?limit=200")
      assert.ok(seen.items.length > 0)
      assert.ok(seen.items.every((item) => item.projectId === a.projects.copenhagen.id))
      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null }, "a provider never sees a customer's prices")
      await refused(await ungranted("/price-lists"), 403)
      assert.equal((await app.request("/price-lists")).status, 401)
    })
  })

  describe("GET /price-lists/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, for a provider's account, and for an id nobody minted", async () => {
      const cairo = (await page(olivia, `?projectId=${a.projects.cairo.id}`)).items[0]
      await refused(await olivia(`/price-lists/${theirList.id}`), 404)
      await refused(await viewer(`/price-lists/${cairo.id}`), 404)
      await refused(await lars(`/price-lists/${cairo.id}`), 404)
      await refused(await olivia(`/price-lists/${testId()}`), 404)
      await refused(await olivia("/price-lists/not-an-id"), 400)
    })
  })

  describe("PATCH /price-lists/:id", () => {
    test("changes the name and the notes and moves the stamp; the code, the currency and the project are not fields of the patch", async () => {
      const made = await list("pl-patch")
      await nextMillisecond()
      const changed = await patch(olivia, made.id, { name: "Renamed", notes: "Now with notes" })
      assert.deepEqual([changed.name, changed.notes], ["Renamed", "Now with notes"])
      assert.ok(changed.updatedAt > made.updatedAt)
      for (const field of ["code", "currency", "projectId"]) {
        const owned = await refused(await olivia(`/price-lists/${made.id}`, { method: "PATCH", body: { [field]: "x" } }), 400)
        assert.ok(owned.errors?.some((error) => error.message.includes(field)), `${field}: ${JSON.stringify(owned.errors)}`)
      }
    })

    test("refuses a shortening under its rows counting them, and takes it once they end", async () => {
      const made = await list("pl-rows")
      const first = await row(olivia, made.id, rowBody())
      const second = await row(olivia, made.id, rowBody({ productId: products.glass.id, unitPriceMinor: 6_000 }))
      const two = await refused(await olivia(`/price-lists/${made.id}`, { method: "PATCH", body: { validTo: JULY } }), 409)
      assert.equal(two.detail, "2 price rows fall outside the new period; end them first")
      await patchRow(olivia, second.id, { validTo: JULY })
      const one_ = await refused(await olivia(`/price-lists/${made.id}`, { method: "PATCH", body: { validTo: JULY } }), 409)
      assert.equal(one_.detail, "1 price row falls outside the new period; end it first")
      await patchRow(olivia, first.id, { validTo: JULY })
      const shortened = await patch(olivia, made.id, { validTo: JULY })
      assert.equal(shortened.validTo, JULY)
      // Widening back is free: nothing is stranded by a longer period.
      assert.equal((await patch(olivia, made.id, { validTo: null })).validTo, null)
    })

    test("makes a list the default and unmakes it: a default in another currency is refused at isDefault, a second default with its sentence, and once the default is unset another takes its place", async () => {
      const euro = (await page(olivia, "?limit=200")).items.find((item) => item.code === "pl-eur")
      assert.ok(euro)
      const wrongCurrency = await refused(await olivia(`/price-lists/${euro.id}`, { method: "PATCH", body: { isDefault: true } }), 400)
      assert.deepEqual([paths(wrongCurrency), messages(wrongCurrency)], [["isDefault"], [defaultInCurrency("DKK")]])
      const tariff = (await page(olivia, "?isDefault=true")).items[0]
      const plain = (await page(olivia, "?limit=200")).items.find((item) => item.code === "pl-a")
      assert.ok(plain)
      const taken = await refused(await olivia(`/price-lists/${plain.id}`, { method: "PATCH", body: { isDefault: true } }), 409)
      assert.equal(taken.detail, DEFAULT_TAKEN)
      assert.equal((await patch(olivia, tariff.id, { isDefault: false })).isDefault, false, "unsetting the default is taken; the agreements are then no-price-list")
      assert.equal((await patch(olivia, plain.id, { isDefault: true })).isDefault, true)
      // Back as it was, for the tests that read the default.
      await patch(olivia, plain.id, { isDefault: false })
      await patch(olivia, tariff.id, { isDefault: true })
    })

    test("refuses an end before the stored start in the contracts' words, a period overlapping another list of the code, an empty patch, another company's list, and a role without the grant", async () => {
      const made = await list("pl-move", { validFrom: MARCH, validTo: JULY })
      const backwards = await refused(await olivia(`/price-lists/${made.id}`, { method: "PATCH", body: { validTo: JANUARY } }), 400)
      assert.deepEqual([paths(backwards), messages(backwards)], [["validTo"], [ENDS_AFTER_IT_STARTS]])
      await list("pl-move", { validFrom: JULY, validTo: null })
      const overlapping = await refused(await olivia(`/price-lists/${made.id}`, { method: "PATCH", body: { validTo: AUGUST } }), 409)
      assert.equal(overlapping.detail, LIST_RUNNING)
      await refused(await olivia(`/price-lists/${made.id}`, { method: "PATCH", body: {} }), 400)
      await refused(await olivia(`/price-lists/${theirList.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      await refused(await lars(`/price-lists/${made.id}`, { method: "PATCH", body: { name: "Lars's" } }), 403)
      await refused(await ungranted(`/price-lists/${theirList.id}`, { method: "PATCH", body: { name: "x" } }), 403)
    })
  })

  describe("POST /price-lists/:id/rows", () => {
    test("adds the default row and a conditioned row, mints their ids, takes the list and the project from the path, and reads them at /price-list-rows/{id}", async () => {
      const made = await list("pl-rows-2")
      const everyone = await row(olivia, made.id, rowBody())
      assert.equal(Id.parse(everyone.id), everyone.id)
      assert.deepEqual([everyone.priceListId, everyone.projectId, everyone.productId, everyone.unitPriceMinor], [made.id, made.projectId, products.residual.id, 4_500])
      assert.deepEqual([everyone.planningAreaId, everyone.customerKind, everyone.containerTypeId, everyone.wasteFractionId, everyone.customerId, everyone.note], [null, null, null, null, null, null])
      const zoned = await row(olivia, made.id, rowBody({ unitPriceMinor: 5_200, planningAreaId: planning.areas.centrum.id, customerKind: "organisation", containerTypeId: bin.id, wasteFractionId: residual.id, note: "Centrum businesses" }))
      assert.deepEqual([zoned.planningAreaId, zoned.customerKind, zoned.containerTypeId, zoned.wasteFractionId, zoned.note], [planning.areas.centrum.id, "organisation", bin.id, residual.id, "Centrum businesses"])
      assert.deepEqual(await oneRow(olivia, zoned.id), zoned)
      assert.equal("conditionKey" in zoned, false, "the database's device stays off the wire")
    })

    test("refuses a row outside the list's period at the bound, one ending on or before its start, and a product, planning area, container type, waste fraction or customer that is not this project's or this company's", async () => {
      const made = await list("pl-rows-3", { validFrom: MARCH, validTo: JULY })
      const early = await refused(await olivia(`/price-lists/${made.id}/rows`, { method: "POST", body: rowBody({ validFrom: JANUARY, validTo: null }) }), 400)
      assert.deepEqual(paths(early), ["validFrom", "validTo"])
      assert.deepEqual(messages(early), [OUTSIDE_LIST, OUTSIDE_LIST])
      const backwards = await refused(await olivia(`/price-lists/${made.id}/rows`, { method: "POST", body: rowBody({ validFrom: JULY, validTo: MARCH }) }), 400)
      assert.deepEqual(messages(backwards), [ENDS_AFTER_IT_STARTS])
      const cases: [Record<string, unknown>, string, string][] = [
        [{ productId: harborProduct.id }, "productId", "Not a product of this project"],
        [{ planningAreaId: planning.areas.harbor.id }, "planningAreaId", "Not a planning area of this project"],
        [{ containerTypeId: theirType.id }, "containerTypeId", "Not a container type of this company"],
        [{ wasteFractionId: testId() }, "wasteFractionId", "Not a waste fraction of this company"],
        [{ customerId: testId() }, "customerId", "Not a customer of this company"],
      ]
      for (const [values, path, message] of cases) {
        const problem = await refused(await olivia(`/price-lists/${made.id}/rows`, { method: "POST", body: rowBody({ validFrom: MARCH, validTo: JULY, ...values }) }), 400)
        assert.deepEqual([paths(problem), messages(problem)], [[path], [message]])
      }
    })

    test("refuses a product that is not active with the status sentence, after the body's 400s", async () => {
      const made = await list("pl-rows-4")
      const draft = await refused(await olivia(`/price-lists/${made.id}/rows`, { method: "POST", body: rowBody({ productId: draftProduct.id }) }), 409)
      assert.equal(draft.detail, "The product is draft; only an active product can be subscribed to")
      const both = await refused(await olivia(`/price-lists/${made.id}/rows`, { method: "POST", body: rowBody({ productId: draftProduct.id, validTo: JANUARY }) }), 400)
      assert.deepEqual(paths(both), ["validTo"], "the period's 400 before the status's 409")
    })

    test("refuses a row of the product with the same conditions over an overlapping period with its sentence, takes one with other conditions, and takes the scheduled change back to back", async () => {
      const made = await list("pl-rows-5", { validTo: null })
      await row(olivia, made.id, rowBody({ validTo: null }))
      const twice = await refused(await olivia(`/price-lists/${made.id}/rows`, { method: "POST", body: rowBody({ unitPriceMinor: 4_700, validFrom: JULY, validTo: null }) }), 409)
      assert.equal(twice.detail, ROW_RUNNING)
      const zoned = await row(olivia, made.id, rowBody({ unitPriceMinor: 5_000, planningAreaId: planning.areas.centrum.id, validTo: null }))
      assert.equal(zoned.planningAreaId, planning.areas.centrum.id, "a default row and a zone row of one product coexist")
      const ended = await row(olivia, made.id, rowBody({ productId: products.glass.id, unitPriceMinor: 6_000, validTo: NEXT_YEAR }))
      const scheduled = await row(olivia, made.id, rowBody({ productId: products.glass.id, unitPriceMinor: 6_300, validFrom: NEXT_YEAR, validTo: null }))
      assert.deepEqual([ended.validTo, scheduled.validFrom], [NEXT_YEAR, NEXT_YEAR], "a scheduled change is the next row")
    })

    test("answers 404 for a list outside the caller's reach, and 403 for a role without create", async () => {
      const cairo = (await page(olivia, `?projectId=${a.projects.cairo.id}`)).items[0]
      await refused(await viewer(`/price-lists/${cairo.id}/rows`, { method: "POST", body: rowBody() }), 404)
      await refused(await olivia(`/price-lists/${theirList.id}/rows`, { method: "POST", body: rowBody() }), 404)
      await refused(await ungranted(`/price-lists/${theirList.id}/rows`, { method: "POST", body: rowBody() }), 403)
    })
  })

  describe("GET /price-lists/:id/rows", () => {
    test("answers the list's rows in id order, by product and by day, and 404 for a list outside the caller's reach", async () => {
      const made = await list("pl-read", { validTo: null })
      const first = await row(olivia, made.id, rowBody({ validTo: JULY }))
      const second = await row(olivia, made.id, rowBody({ validFrom: JULY, validTo: null, unitPriceMinor: 4_800 }))
      const glassRow = await row(olivia, made.id, rowBody({ productId: products.glass.id, unitPriceMinor: 6_000, validTo: null }))
      assert.deepEqual((await rows(olivia, made.id)).items.map((item) => item.id), [first.id, second.id, glassRow.id])
      assert.deepEqual((await rows(olivia, made.id, `?productId=${products.glass.id}`)).items.map((item) => item.id), [glassRow.id])
      assert.deepEqual((await rows(olivia, made.id, `?validOn=${AUGUST}`)).items.map((item) => item.id), [second.id, glassRow.id])
      assert.deepEqual((await rows(olivia, made.id, `?validOn=${MARCH}&productId=${products.residual.id}`)).items.map((item) => item.id), [first.id])
      await refused(await olivia(`/price-lists/${theirList.id}/rows`), 404)
      await refused(await olivia(`/price-lists/${made.id}/rows?validOn=2026-02-30`), 400)
    })
  })

  describe("GET and PATCH /price-list-rows/:id", () => {
    test("changes the price, the note and the end, moving the stamp; a condition, the product, the start and the list are not fields of the patch", async () => {
      const made = await list("pl-row-patch")
      const first = await row(olivia, made.id, rowBody())
      await nextMillisecond()
      const changed = await patchRow(olivia, first.id, { unitPriceMinor: 4_600, note: "Corrected a typo", validTo: JULY })
      assert.deepEqual([changed.unitPriceMinor, changed.note, changed.validTo], [4_600, "Corrected a typo", JULY])
      assert.ok(changed.updatedAt > first.updatedAt)
      assert.deepEqual(await oneRow(olivia, first.id), changed)
      for (const field of ["planningAreaId", "customerKind", "containerTypeId", "wasteFractionId", "customerId", "productId", "validFrom", "priceListId"]) {
        const owned = await refused(await olivia(`/price-list-rows/${first.id}`, { method: "PATCH", body: { [field]: "x" } }), 400)
        assert.ok(owned.errors?.some((error) => error.message.includes(field)), `${field}: ${JSON.stringify(owned.errors)}`)
      }
    })

    test("refuses an end outside the list's period, an end before the start in the contracts' words, and a reopened row meeting the scheduled one with the overlap sentence", async () => {
      const made = await list("pl-row-move")
      const current = await row(olivia, made.id, rowBody({ validTo: JULY }))
      await row(olivia, made.id, rowBody({ validFrom: JULY, validTo: NEXT_YEAR, unitPriceMinor: 4_800 }))
      const outside = await refused(await olivia(`/price-list-rows/${current.id}`, { method: "PATCH", body: { validTo: null } }), 400)
      assert.deepEqual([paths(outside), messages(outside)], [["validTo"], [OUTSIDE_LIST]])
      const backwards = await refused(await olivia(`/price-list-rows/${current.id}`, { method: "PATCH", body: { validTo: JANUARY } }), 400)
      assert.deepEqual(messages(backwards), [ENDS_AFTER_IT_STARTS])
      const overlapping = await refused(await olivia(`/price-list-rows/${current.id}`, { method: "PATCH", body: { validTo: AUGUST } }), 409)
      assert.equal(overlapping.detail, ROW_RUNNING)
      assert.equal((await patchRow(olivia, current.id, { validTo: MARCH })).validTo, MARCH, "a shorter end meets nothing")
    })

    test("answers 404 for another company's row, one in a project the caller does not work in, and an id nobody minted; 403 for a role without the grant", async () => {
      const theirRow = await row(other, theirList.id, { productId: (await create(other, "/products", { projectId: b.projects.copenhagen.id, name: "Their product", kind: "additional-service", unit: "job", status: "active" }, Product)).id, unitPriceMinor: 100, validFrom: JANUARY })
      await refused(await olivia(`/price-list-rows/${theirRow.id}`), 404)
      await refused(await olivia(`/price-list-rows/${theirRow.id}`, { method: "PATCH", body: { note: "mine" } }), 404)
      const cairo = (await page(olivia, `?projectId=${a.projects.cairo.id}`)).items[0]
      const cairoProduct = await create(olivia, "/products", { projectId: a.projects.cairo.id, name: "Cairo collection", kind: "container-collection", unit: "pickup", status: "active" }, Product)
      const cairoRow = await row(olivia, cairo.id, { productId: cairoProduct.id, unitPriceMinor: 100, validFrom: JANUARY, validTo: NEXT_YEAR })
      await refused(await viewer(`/price-list-rows/${cairoRow.id}`), 404)
      await refused(await lars(`/price-list-rows/${cairoRow.id}`), 404)
      await refused(await olivia(`/price-list-rows/${testId()}`), 404)
      await refused(await ungranted(`/price-list-rows/${theirRow.id}`), 403)
    })
  })

  describe("GET /price-lists/:id/resolve", () => {
    test("the row matching the most conditions wins: every verdict is answered with the winner first and scored, and the VAT rate and the currency ride beside", async () => {
      const made = await list("pl-resolve", { validTo: null })
      const everyone = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_000, validTo: null }))
      const zoned = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_200, planningAreaId: planning.areas.centrum.id, validTo: null }))
      const business = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_400, planningAreaId: planning.areas.centrum.id, customerKind: "organisation", validTo: null }))
      const resolution = await resolve(olivia, made.id, { productId: products.residual.id, on: AUGUST, planningAreaId: planning.areas.centrum.id, customerKind: "organisation" })
      assert.equal(resolution.winner?.row.id, business.id)
      assert.deepEqual([resolution.unitPriceMinor, resolution.vatPercent, resolution.currency], [1_400, 25, "DKK"])
      assert.deepEqual(resolution.winner?.matched, ["Planning area Centrum", "Customer kind organisation"])
      assert.deepEqual(
        resolution.verdicts.map((verdict) => [verdict.row.id, verdict.score, verdict.winner]),
        [
          [business.id, 2, true],
          [zoned.id, 1, false],
          [everyone.id, 0, false],
        ],
      )
      // A person without the kind: the zone row wins, and the business row says what it needed.
      const household = await resolve(olivia, made.id, { productId: products.residual.id, on: AUGUST, planningAreaId: planning.areas.centrum.id, customerKind: "person" })
      assert.equal(household.winner?.row.id, zoned.id)
      assert.equal(household.verdicts.find((verdict) => verdict.row.id === business.id)?.reason, "Customer kind is organisation, not person")
      // Outside the zone: the default row, and the zone row spelled by the area's name.
      const elsewhere = await resolve(olivia, made.id, { productId: products.residual.id, on: AUGUST })
      assert.equal(elsewhere.winner?.row.id, everyone.id)
      assert.equal(elsewhere.verdicts.find((verdict) => verdict.row.id === zoned.id)?.reason, "Requires planning area Centrum")
    })

    test("a negotiated row for the customer wins over any conditions, and is not eligible for anyone else, the sentence naming the customer", async () => {
      const made = await list("pl-deal", { validTo: null })
      const business = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_400, planningAreaId: planning.areas.centrum.id, customerKind: "organisation", validTo: null }))
      const deal = await row(olivia, made.id, rowBody({ unitPriceMinor: 900, customerId: cowork.id, validTo: null }))
      const theirs = await resolve(olivia, made.id, { productId: products.residual.id, on: AUGUST, planningAreaId: planning.areas.centrum.id, customerKind: "organisation", customerId: cowork.id })
      assert.equal(theirs.winner?.row.id, deal.id)
      assert.equal(theirs.winner?.score, 100)
      assert.deepEqual(theirs.winner?.matched, ["Negotiated · Nørrebro CoWork ApS"])
      assert.equal(theirs.unitPriceMinor, 900)
      const others = await resolve(olivia, made.id, { productId: products.residual.id, on: AUGUST, planningAreaId: planning.areas.centrum.id, customerKind: "organisation", customerId: osterbro.id })
      assert.equal(others.winner?.row.id, business.id)
      assert.deepEqual(others.verdicts.find((verdict) => verdict.row.id === deal.id), {
        row: deal,
        eligible: false,
        reason: "Negotiated for Nørrebro CoWork ApS, not this customer",
        matched: [],
        score: -1,
        winner: false,
      })
    })

    test("a tie goes to the row with the newest effective-from date", async () => {
      const made = await list("pl-tie", { validTo: null })
      const older = await row(olivia, made.id, rowBody({ productId: products.glass.id, unitPriceMinor: 1_200, planningAreaId: planning.areas.centrum.id, validFrom: JANUARY, validTo: null }))
      // The same conditions again would be the exclusion constraint's; a second zone row of the same set is the next period, so the tie is made with a fraction condition of the same count.
      const newer = await row(olivia, made.id, rowBody({ productId: products.glass.id, unitPriceMinor: 1_300, wasteFractionId: glass.id, validFrom: MARCH, validTo: null }))
      const resolution = await resolve(olivia, made.id, { productId: products.glass.id, on: AUGUST, planningAreaId: planning.areas.centrum.id, wasteFractionId: glass.id })
      assert.deepEqual(resolution.verdicts.map((verdict) => [verdict.row.id, verdict.score]), [[newer.id, 1], [older.id, 1]])
      assert.equal(resolution.winner?.row.id, newer.id)
    })

    test("a row outside its effective period does not compete, with the sentence saying which way, and a condition the input lacks or differs reads as a person does", async () => {
      const made = await list("pl-verdicts", { validTo: null })
      const everyone = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_000, validTo: null }))
      const expired = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_200, planningAreaId: planning.areas.centrum.id, validTo: JULY }))
      const scheduled = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_300, planningAreaId: planning.areas.centrum.id, validFrom: NEXT_YEAR, validTo: null }))
      const binned = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_500, containerTypeId: bin.id, validTo: null }))
      const glassy = await row(olivia, made.id, rowBody({ unitPriceMinor: 1_600, wasteFractionId: glass.id, validTo: null }))
      const resolution = await resolve(olivia, made.id, { productId: products.residual.id, on: AUGUST, planningAreaId: planning.areas.centrum.id, wasteFractionId: residual.id })
      assert.equal(resolution.winner?.row.id, everyone.id)
      const reasons = new Map(resolution.verdicts.map((verdict) => [verdict.row.id, verdict.reason]))
      assert.equal(reasons.get(expired.id), "Expired on 2026-07-01")
      assert.equal(reasons.get(scheduled.id), "Not effective until 2027-01-01")
      assert.equal(reasons.get(binned.id), "Requires container type 660 L container")
      assert.equal(reasons.get(glassy.id), "Waste fraction is Glass, not Residual waste")
      assert.deepEqual(resolution.verdicts[0].row.id, everyone.id, "the winner first, the ineligible after")
      // No row at all is no winner: the product with no rows here.
      const none = await resolve(olivia, made.id, { productId: products.unrated.id, on: AUGUST })
      assert.deepEqual([none.verdicts, none.winner, none.unitPriceMinor, none.vatPercent], [[], null, null, null], "a product with no rate answers null, which would block an event with no-vat-rate")
    })

    test("refuses a day that is not one, a missing product, a product of another project on the query string, and answers 404 for a list outside the caller's reach", async () => {
      const made = (await page(olivia, "?limit=200")).items.find((item) => item.code === "pl-resolve")
      assert.ok(made)
      const day = await refused(await olivia(`/price-lists/${made.id}/resolve?productId=${products.residual.id}&on=2026-02-30`), 400)
      assert.deepEqual(paths(day), ["on"])
      const missing = await refused(await olivia(`/price-lists/${made.id}/resolve?on=${AUGUST}`), 400)
      assert.deepEqual(paths(missing), ["productId"])
      const harbor = await refused(await olivia(`/price-lists/${made.id}/resolve?productId=${harborProduct.id}&on=${AUGUST}`), 400)
      assert.deepEqual([paths(harbor), messages(harbor)], [["productId"], ["Not a product of this project"]])
      assert.match(harbor.detail ?? "", /query/, "the product came in the query string")
      await refused(await lars(`/price-lists/${made.id}/resolve?productId=${products.residual.id}&on=${AUGUST}`), 404)
      await refused(await olivia(`/price-lists/${theirList.id}/resolve?productId=${products.residual.id}&on=${AUGUST}`), 404)
      await refused(await ungranted(`/price-lists/${theirList.id}/resolve?productId=${products.residual.id}&on=${AUGUST}`), 403)
    })
  })
})

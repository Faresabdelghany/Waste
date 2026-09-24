import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product, WasteFraction } from "@waste/contracts/catalogue"
import { Container, ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property, SharedCollectionPoint } from "@waste/contracts/customers"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const AgreementPage = Page(Agreement)
const SubscriptionPage = Page(Subscription)

const MODULE = "customers.agreements"

/** The days the periods of this file are cut from; every test says which of them it means. */
const JANUARY = "2026-01-01"
const APRIL = "2026-04-01"
const JULY = "2026-07-01"
const OCTOBER = "2026-10-01"
const NEXT_YEAR = "2027-01-01"

describe("the agreement and subscription endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted view: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** Who the agreements of this company are with, and who pays for them. */
  let acme: Customer
  let boligforening: Customer
  /** Where a subscription is delivered: a property and a point of Copenhagen Central, and a property of Harbor Commercial. */
  let parkvej: Property
  let harborProperty: Property
  let bank: SharedCollectionPoint
  /** What a subscription subscribes to, in each project. */
  let residual: Product
  let harborResidual: Product
  /** What the one placement of this file needs: a container's type and the fraction it takes. */
  let bin: ContainerType
  let residualWaste: WasteFraction
  /** The other company's. */
  let theirCustomer: Customer
  let theirAgreement: Agreement

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    acme = await create(olivia, "/customers", { kind: "organisation", name: "Acme Housing" }, Customer)
    boligforening = await create(olivia, "/customers", { kind: "organisation", name: "Kystbyen Boligforening" }, Customer)
    parkvej = await create(
      olivia,
      "/properties",
      { projectId: a.projects.copenhagen.id, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", kind: "residential" },
      Property,
    )
    harborProperty = await create(
      olivia,
      "/properties",
      { projectId: a.projects.harbor.id, name: "Havnegade 4", address: "Havnegade 4, 1058 København K", kind: "commercial" },
      Property,
    )
    bank = await create(
      olivia,
      "/shared-collection-points",
      {
        projectId: a.projects.copenhagen.id,
        name: "Parkvej bank",
        kind: "underground",
        address: "Parkvej 20, 2100 København Ø",
        location: { type: "Point", coordinates: [12.5683, 55.6761] },
        operatingModel: "municipal",
        accessMode: "open",
        billingMode: "municipal",
      },
      SharedCollectionPoint,
    )
    residual = await create(
      olivia,
      "/products",
      { projectId: a.projects.copenhagen.id, name: "Residual collection", kind: "container-collection", unit: "pickup" },
      Product,
    )
    harborResidual = await create(
      olivia,
      "/products",
      { projectId: a.projects.harbor.id, name: "Residual collection", kind: "container-collection", unit: "pickup" },
      Product,
    )
    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    residualWaste = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirCustomer = await create(other, "/customers", { kind: "organisation", name: "Their Housing" }, Customer)
    theirAgreement = await create(
      other,
      "/agreements",
      {
        projectId: b.projects.copenhagen.id,
        number: "THEIRS-1",
        customerId: theirCustomer.id,
        payerCustomerId: theirCustomer.id,
        billingCadence: "monthly",
        currency: "DKK",
        validFrom: JANUARY,
      },
      Agreement,
    )
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** An agreement body a caller may send: the fields with no default, on Copenhagen Central and Acme unless a test says otherwise. */
  const body = (number: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    number,
    customerId: acme.id,
    payerCustomerId: boligforening.id,
    billingCadence: "monthly",
    currency: "DKK",
    validFrom: JANUARY,
    ...values,
  })

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const agreement = (number: string, values: Record<string, unknown> = {}) => create(olivia, "/agreements", body(number, values), Agreement)
  const one = async (call: Call, id: string): Promise<Agreement> => {
    const response = await call(`/agreements/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Agreement.parse(await response.json())
  }
  const oneSubscription = async (call: Call, id: string): Promise<Subscription> => {
    const response = await call(`/subscriptions/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Subscription.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Agreement> => {
    const response = await call(`/agreements/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Agreement.parse(await response.json())
  }
  const patchSubscription = async (id: string, values: unknown): Promise<Subscription> => {
    const response = await olivia(`/subscriptions/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Subscription.parse(await response.json())
  }
  const page = async (call: Call, query = "") => AgreementPage.parse(await (await call(`/agreements${query}`)).json())
  const subscriptions = async (call: Call, agreementId: string, query = "") =>
    SubscriptionPage.parse(await (await call(`/agreements/${agreementId}/subscriptions${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  /** One product at one place under an agreement; the place is Parkvej 18 unless a test names another. */
  const subscribe = (agreementId: string, values: Record<string, unknown> = {}) =>
    create(olivia, `/agreements/${agreementId}/subscriptions`, { productId: residual.id, propertyId: parkvej.id, validFrom: JANUARY, ...values }, Subscription)

  describe("POST /agreements", () => {
    test("mints the id, defaults the status to draft, and keeps the period it was given", async () => {
      const created = await agreement("AGR-2401", { notes: "Signed at the counter", validTo: NEXT_YEAR })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.status, "draft", "an agreement is written before it is signed")
      assert.deepEqual([created.validFrom, created.validTo], [JANUARY, NEXT_YEAR])
      assert.equal(created.payerCustomerId, boligforening.id, "the payer is a customer of its own")
      assert.deepEqual(await one(olivia, created.id), created)

      const running = await agreement("AGR-2402")
      assert.equal(running.validTo, null, "an agreement with no end is one that is still running")
    })

    test("holds the customer and the payer to this company, naming the field", async () => {
      const foreign = await refused(await olivia("/agreements", { method: "POST", body: body("AGR-2403", { customerId: theirCustomer.id }) }), 400)
      assert.deepEqual(foreign.errors, [{ path: "customerId", message: "Not a customer of this company" }])
      const payer = await refused(await olivia("/agreements", { method: "POST", body: body("AGR-2404", { payerCustomerId: testId() }) }), 400)
      assert.deepEqual(payer.errors, [{ path: "payerCustomerId", message: "Not a customer of this company" }])
    })

    test("refuses a project the caller does not work in, and a member the server owns", async () => {
      const foreign = await refused(
        await olivia("/agreements", { method: "POST", body: body("AGR-2405", { projectId: b.projects.copenhagen.id }) }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(await olivia("/agreements", { method: "POST", body: body("AGR-2406", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a period that ends where it starts: an empty period is in force on no day at all", async () => {
      const problem = await refused(await olivia("/agreements", { method: "POST", body: body("AGR-2407", { validTo: JANUARY }) }), 400)
      assert.deepEqual(problem.errors?.map((error) => error.path), ["validTo"])
      assert.match(problem.errors?.[0].message ?? "", /comes after validFrom/)
    })

    test("lets one number name a later agreement once the earlier one has ended, and refuses an overlap", async () => {
      const first = await agreement("AGR-2410", { validFrom: JANUARY, validTo: JULY })
      const second = await agreement("AGR-2410", { validFrom: JULY, validTo: NEXT_YEAR })
      assert.notEqual(first.id, second.id, "the same number names one agreement at a time, and the next one after it")

      const problem = await refused(
        await olivia("/agreements", { method: "POST", body: body("AGR-2410", { validFrom: APRIL, validTo: OCTOBER }) }),
        409,
      )
      assert.equal(problem.detail, "An agreement numbered AGR-2410 is already valid over part of that period")
      assert.doesNotMatch(problem.detail ?? "", /no_overlap/)
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/agreements", { method: "POST", body: body("AGR-2411") }), 403)
      assert.match(problem.detail ?? "", /create on customers\.agreements/)
    })
  })

  describe("GET /agreements", () => {
    test("answers the company's agreements in id order and holds nothing of another company's", async () => {
      const mine = await agreement("AGR-2420")
      const ids = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirAgreement.id))
      assert.deepEqual((await page(other, "?limit=200")).items.map((row) => row.number), ["THEIRS-1"])
    })

    test("filters by project, by the customer or the payer, by the number and by the day the period covers", async () => {
      const harbor = await agreement("AGR-2421", { projectId: a.projects.harbor.id })
      const ended = await agreement("AGR-2422", { validFrom: JANUARY, validTo: APRIL })

      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)

      const byNumber = await page(olivia, "?limit=200&number=AGR-2422")
      assert.deepEqual(byNumber.items.map((row) => row.id), [ended.id])

      const byCustomer = (await page(olivia, `?limit=200&customerId=${acme.id}`)).items
      assert.ok(byCustomer.some((row) => row.id === ended.id))
      const byPayer = (await page(olivia, `?limit=200&customerId=${boligforening.id}`)).items
      assert.ok(byPayer.some((row) => row.id === ended.id), "the payer's agreements are found by the same filter")
      assert.deepEqual((await page(olivia, `?limit=200&customerId=${theirCustomer.id}`)).items, [])

      const onJuly = (await page(olivia, `?limit=200&validOn=${JULY}&number=AGR-2422`)).items
      assert.deepEqual(onJuly, [], "an agreement that ended in April is in force on no day in July")
      const inFebruary = (await page(olivia, "?limit=200&validOn=2026-02-01&number=AGR-2422")).items
      assert.deepEqual(inFebruary.map((row) => row.id), [ended.id])
      const onTheLastDay = (await page(olivia, `?limit=200&validOn=${APRIL}&number=AGR-2422`)).items
      assert.deepEqual(onTheLastDay, [], "validTo is the first day out of force")
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await agreement("AGR-2423")
      const elsewhere = await agreement("AGR-2424", { projectId: a.projects.harbor.id })
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      const { items, nextCursor } = await page(lars, "?limit=200")
      assert.deepEqual(items, [])
      assert.equal(nextCursor, null)

      const problem = await refused(await viewer(`/agreements?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without customers.agreements view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/agreements"), 403)).detail ?? "", /view on customers\.agreements/)
      assert.equal((await app.request("/agreements")).status, 401)
    })
  })

  describe("GET /agreements/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/agreements/${theirAgreement.id}`), 404)
      assert.match(foreign.detail ?? "", /agreement/i)
      assert.equal((await one(other, theirAgreement.id)).number, "THEIRS-1", "still there for its own company")

      const elsewhere = await agreement("AGR-2430", { projectId: a.projects.harbor.id })
      await refused(await viewer(`/agreements/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).number, "AGR-2430")
      await refused(await olivia(`/agreements/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/agreements/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /agreements/:id", () => {
    test("changes what the body names and leaves the rest", async () => {
      const created = await agreement("AGR-2440")
      const changed = await patch(olivia, created.id, { status: "active", validTo: NEXT_YEAR })
      assert.equal(changed.status, "active")
      assert.equal(changed.validTo, NEXT_YEAR)
      assert.equal(changed.number, "AGR-2440", "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const reopened = await patch(olivia, created.id, { validTo: null })
      assert.equal(reopened.validTo, null, "a null takes the end off again")
    })

    test("refuses an end before the stored start, which the body alone cannot see", async () => {
      const created = await agreement("AGR-2441", { validFrom: JULY })
      const problem = await refused(await olivia(`/agreements/${created.id}`, { method: "PATCH", body: { validTo: APRIL } }), 400)
      assert.deepEqual(problem.errors?.map((error) => error.path), ["validTo"])
      assert.equal((await one(olivia, created.id)).validTo, null)
    })

    test("refuses a shortening that would leave its subscriptions outside, and writes nothing", async () => {
      const created = await agreement("AGR-2442")
      const running = await subscribe(created.id, { validFrom: JULY })

      const anyEnd = await refused(await olivia(`/agreements/${created.id}`, { method: "PATCH", body: { validTo: NEXT_YEAR } }), 409)
      assert.equal(anyEnd.detail, "1 subscription would fall outside the agreement's period; end it first")
      assert.equal((await one(olivia, created.id)).updatedAt, created.updatedAt, "a refused patch does not move the stamp")

      await patchSubscription(running.id, { validTo: OCTOBER })
      const ended = await patch(olivia, created.id, { validTo: NEXT_YEAR })
      assert.equal(ended.validTo, NEXT_YEAR, "an end the subscription now fits inside is taken")

      const shortened = await refused(await olivia(`/agreements/${created.id}`, { method: "PATCH", body: { validTo: APRIL } }), 409)
      assert.equal(shortened.detail, "1 subscription would fall outside the agreement's period; end it first")
      const moved = await refused(await olivia(`/agreements/${created.id}`, { method: "PATCH", body: { validFrom: OCTOBER } }), 409)
      assert.equal(moved.detail, "1 subscription would fall outside the agreement's period; end it first")

      const stored = await one(olivia, created.id)
      assert.deepEqual([stored.validFrom, stored.validTo], [JANUARY, NEXT_YEAR])
      assert.equal(stored.updatedAt, ended.updatedAt)
    })

    test("counts the subscriptions in the way, and the sentence reads as a plural once there is more than one", async () => {
      const created = await agreement("AGR-2445")
      await subscribe(created.id, { validFrom: JULY })
      await subscribe(created.id, { sharedCollectionPointId: bank.id, propertyId: null, validFrom: JULY })
      const problem = await refused(await olivia(`/agreements/${created.id}`, { method: "PATCH", body: { validTo: NEXT_YEAR } }), 409)
      assert.equal(problem.detail, "2 subscriptions would fall outside the agreement's period; end them first")
    })

    test("refuses a period that overlaps another agreement of the same number", async () => {
      await agreement("AGR-2443", { validFrom: JANUARY, validTo: JULY })
      const later = await agreement("AGR-2443", { validFrom: JULY, validTo: NEXT_YEAR })
      const problem = await refused(await olivia(`/agreements/${later.id}`, { method: "PATCH", body: { validFrom: APRIL } }), 409)
      assert.equal(problem.detail, "An agreement numbered AGR-2443 is already valid over part of that period")
      assert.equal((await one(olivia, later.id)).validFrom, JULY)
    })

    test("refuses another company's agreement, an empty patch, and a role that may view but not edit", async () => {
      await refused(await olivia(`/agreements/${theirAgreement.id}`, { method: "PATCH", body: { status: "active" } }), 404)
      assert.equal((await one(other, theirAgreement.id)).status, "draft")
      const created = await agreement("AGR-2444")
      assert.deepEqual(
        (await refused(await olivia(`/agreements/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      assert.match((await refused(await lars(`/agreements/${created.id}`, { method: "PATCH", body: { status: "active" } }), 403)).detail ?? "", /edit on customers\.agreements/)
    })
  })

  describe("POST /agreements/:id/subscriptions", () => {
    test("writes one product at one place, taking the agreement and the project from the path", async () => {
      const created = await agreement("AGR-2450")
      const written = await subscribe(created.id, { quantity: 2, validTo: NEXT_YEAR })
      assert.equal(Id.parse(written.id), written.id)
      assert.equal(written.agreementId, created.id)
      assert.equal(written.projectId, created.projectId, "the project is the agreement's; a body cannot name a second one")
      assert.deepEqual([written.propertyId, written.sharedCollectionPointId], [parkvej.id, null])
      assert.equal(written.quantity, 2)
      assert.deepEqual(await oneSubscription(olivia, written.id), written)

      const atThePoint = await subscribe(created.id, { sharedCollectionPointId: bank.id, propertyId: null })
      assert.deepEqual([atThePoint.propertyId, atThePoint.sharedCollectionPointId], [null, bank.id])
      assert.equal(atThePoint.quantity, 1, "one of the product at the place unless a body says otherwise")
    })

    test("answers 404 for an agreement outside the caller's projects", async () => {
      const elsewhere = await agreement("AGR-2451", { projectId: a.projects.harbor.id })
      const problem = await refused(
        await viewer(`/agreements/${elsewhere.id}/subscriptions`, { method: "POST", body: { productId: harborResidual.id, propertyId: harborProperty.id, validFrom: JANUARY } }),
        404,
      )
      assert.match(problem.detail ?? "", /agreement/i)
      await refused(
        await olivia(`/agreements/${theirAgreement.id}/subscriptions`, { method: "POST", body: { productId: residual.id, propertyId: parkvej.id, validFrom: JANUARY } }),
        404,
      )
    })

    test("holds the product and the place to the agreement's project, naming the field", async () => {
      const created = await agreement("AGR-2452")
      const product = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: harborResidual.id, propertyId: parkvej.id, validFrom: JANUARY } }),
        400,
      )
      assert.deepEqual(product.errors, [{ path: "productId", message: "Not a product of this project" }])
      const property = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: residual.id, propertyId: harborProperty.id, validFrom: JANUARY } }),
        400,
      )
      assert.deepEqual(property.errors, [{ path: "propertyId", message: "Not a property of this project" }])
      const point = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: residual.id, sharedCollectionPointId: testId(), validFrom: JANUARY } }),
        400,
      )
      assert.deepEqual(point.errors, [{ path: "sharedCollectionPointId", message: "Not a shared collection point of this project" }])
      const nowhere = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: residual.id, validFrom: JANUARY } }),
        400,
      )
      assert.match(nowhere.errors?.[0].message ?? "", /exactly one of propertyId and sharedCollectionPointId/)
    })

    test("refuses a period outside the agreement's, naming the bound", async () => {
      const created = await agreement("AGR-2453", { validFrom: APRIL, validTo: OCTOBER })
      const early = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: residual.id, propertyId: parkvej.id, validFrom: JANUARY, validTo: JULY } }),
        400,
      )
      assert.deepEqual(early.errors, [{ path: "validFrom", message: "Outside the agreement's period" }])
      const open = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: residual.id, propertyId: parkvej.id, validFrom: APRIL } }),
        400,
      )
      assert.deepEqual(open.errors, [{ path: "validTo", message: "Outside the agreement's period" }])
      const both = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: residual.id, propertyId: parkvej.id, validFrom: JANUARY, validTo: NEXT_YEAR } }),
        400,
      )
      assert.deepEqual(both.errors?.map((error) => error.path), ["validFrom", "validTo"])
      const inside = await subscribe(created.id, { validFrom: APRIL, validTo: OCTOBER })
      assert.deepEqual([inside.validFrom, inside.validTo], [APRIL, OCTOBER], "the agreement's own period is inside itself")
    })

    test("refuses a second subscription of the same product at the same place over part of the period, and takes one back to back", async () => {
      const created = await agreement("AGR-2454")
      await subscribe(created.id, { validFrom: JANUARY, validTo: JULY })
      const next = await subscribe(created.id, { validFrom: JULY, validTo: NEXT_YEAR })
      assert.equal(next.validFrom, JULY, "the day one ends is the day the next may begin")

      const problem = await refused(
        await olivia(`/agreements/${created.id}/subscriptions`, { method: "POST", body: { productId: residual.id, propertyId: parkvej.id, validFrom: APRIL, validTo: OCTOBER } }),
        409,
      )
      assert.equal(problem.detail, "The agreement already subscribes to that product at that place over part of that period")
      assert.doesNotMatch(problem.detail ?? "", /no_overlap/)

      const elsewhere = await subscribe(created.id, { sharedCollectionPointId: bank.id, propertyId: null, validFrom: APRIL, validTo: OCTOBER })
      assert.equal(elsewhere.sharedCollectionPointId, bank.id, "the same product at another place is another subscription")
    })
  })

  describe("GET /agreements/:id/subscriptions", () => {
    test("answers the agreement's subscriptions, and only the one in force on the day asked", async () => {
      const created = await agreement("AGR-2460")
      const first = await subscribe(created.id, { validFrom: JANUARY, validTo: JULY })
      const second = await subscribe(created.id, { validFrom: OCTOBER })
      const elsewhere = await agreement("AGR-2461")
      const outside = await subscribe(elsewhere.id, { validFrom: JANUARY })

      const all = await subscriptions(olivia, created.id, "?limit=200")
      assert.deepEqual(all.items.map((row) => row.id).sort(), [first.id, second.id].sort())
      assert.ok(!all.items.some((row) => row.id === outside.id), "another agreement's subscriptions are not this one's")

      assert.deepEqual((await subscriptions(olivia, created.id, `?validOn=${APRIL}`)).items.map((row) => row.id), [first.id])
      assert.deepEqual((await subscriptions(olivia, created.id, `?validOn=${NEXT_YEAR}`)).items.map((row) => row.id), [second.id])
      assert.deepEqual((await subscriptions(olivia, created.id, `?validOn=${JULY}`)).items, [], "no subscription covers the gap between them")

      await refused(await viewer(`/agreements/${theirAgreement.id}/subscriptions`), 404)
    })
  })

  describe("GET and PATCH /subscriptions/:id", () => {
    test("answers 404 for another company's subscription and for an id nobody minted", async () => {
      const theirs = await create(
        other,
        `/agreements/${theirAgreement.id}/subscriptions`,
        { productId: (await create(other, "/products", { projectId: b.projects.copenhagen.id, name: "Residual collection", kind: "container-collection", unit: "pickup" }, Product)).id,
          propertyId: (await create(other, "/properties", { projectId: b.projects.copenhagen.id, name: "Their Parkvej", address: "Parkvej 1", kind: "residential" }, Property)).id,
          validFrom: JANUARY },
        Subscription,
      )
      await refused(await olivia(`/subscriptions/${theirs.id}`), 404)
      await refused(await olivia(`/subscriptions/${testId()}`), 404)
      assert.equal((await oneSubscription(other, theirs.id)).agreementId, theirAgreement.id)
    })

    test("changes the quantity and the period, and refuses a period outside the agreement's", async () => {
      const created = await agreement("AGR-2470", { validFrom: APRIL, validTo: OCTOBER })
      const written = await subscribe(created.id, { validFrom: APRIL, validTo: OCTOBER })

      const changed = await patchSubscription(written.id, { quantity: 3 })
      assert.equal(changed.quantity, 3)
      assert.equal(changed.validTo, OCTOBER, "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > written.updatedAt)

      const early = await refused(await olivia(`/subscriptions/${written.id}`, { method: "PATCH", body: { validFrom: JANUARY } }), 400)
      assert.deepEqual(early.errors, [{ path: "validFrom", message: "Outside the agreement's period" }])
      const open = await refused(await olivia(`/subscriptions/${written.id}`, { method: "PATCH", body: { validTo: null } }), 400)
      assert.deepEqual(open.errors, [{ path: "validTo", message: "Outside the agreement's period" }])
      const backwards = await refused(await olivia(`/subscriptions/${written.id}`, { method: "PATCH", body: { validTo: APRIL } }), 400)
      assert.deepEqual(backwards.errors?.map((error) => error.path), ["validTo"])
      assert.equal((await oneSubscription(olivia, written.id)).validFrom, APRIL)
    })

    test("refuses an end that would leave its placements outside, and writes nothing", async () => {
      const created = await agreement("AGR-2471")
      const written = await subscribe(created.id, { validFrom: JANUARY })
      const container = await create(
        olivia,
        "/containers",
        { projectId: a.projects.copenhagen.id, label: "BIN-2471", containerTypeId: bin.id },
        Container,
      )
      await create(
        olivia,
        `/containers/${container.id}/placements`,
        { subscriptionId: written.id, wasteFractionId: residualWaste.id, validFrom: JULY },
        ContainerServicePlacement,
      )

      const problem = await refused(await olivia(`/subscriptions/${written.id}`, { method: "PATCH", body: { validTo: APRIL } }), 409)
      assert.equal(problem.detail, "1 placement would fall outside the subscription's period; end it first")
      const stored = await oneSubscription(olivia, written.id)
      assert.deepEqual([stored.validFrom, stored.validTo], [JANUARY, null])
      assert.equal(stored.updatedAt, written.updatedAt, "a refused patch does not move the stamp")
    })

    test("refuses a role that may view but not edit", async () => {
      const created = await agreement("AGR-2472")
      const written = await subscribe(created.id)
      const problem = await refused(await lars(`/subscriptions/${written.id}`, { method: "PATCH", body: { quantity: 2 } }), 403)
      assert.match(problem.detail ?? "", /edit on customers\.agreements/)
    })
  })

})

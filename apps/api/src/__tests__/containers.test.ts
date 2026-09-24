import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product, ServiceFrequency, WasteFraction } from "@waste/contracts/catalogue"
import { Container, ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property } from "@waste/contracts/customers"
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
const ContainerPage = Page(Container)
const PlacementPage = Page(ContainerServicePlacement)

const MODULE = "resources.containers"
const AGREEMENTS = "customers.agreements"

/** The days the periods of this file are cut from; every test says which of them it means. */
const JANUARY = "2026-01-01"
const FEBRUARY = "2026-02-01"
const APRIL = "2026-04-01"
const JULY = "2026-07-01"
const OCTOBER = "2026-10-01"
const NEXT_YEAR = "2027-01-01"

describe("the container and placement endpoints", { skip: database.skip }, () => {
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

  /** This company's master data: what a container and a placement point at. */
  let bin: ContainerType
  let residual: WasteFraction
  let weekly: ServiceFrequency
  let fortnightly: ServiceFrequency
  /** A cadence of Harbor Commercial: this company's, but not a Copenhagen placement's to name. */
  let harborWeekly: ServiceFrequency
  /** What is subscribed to in Copenhagen Central, and where. */
  let subscribed: Subscription
  /** The same in Harbor Commercial, which a Copenhagen container may not serve. */
  let harborSubscription: Subscription
  /** A subscription of its own, so the product behind it can be changed without touching another test's. */
  let inherited: Subscription
  let inheritedProduct: Product
  let parkvej: Property
  let havnegade: Property
  /** The other company's. */
  let theirBin: ContainerType
  let theirContainer: Container

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: MODULE, actions: ["view", "create", "edit"] },
      { moduleKey: AGREEMENTS, actions: ["view"] },
    ])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    weekly = await frequency(a.projects.copenhagen.id, "Weekly", 1)
    fortnightly = await frequency(a.projects.copenhagen.id, "Fortnightly", 1, 2)
    harborWeekly = await frequency(a.projects.harbor.id, "Weekly", 1)

    const customer = await create(olivia, "/customers", { kind: "organisation", name: "Acme Housing" }, Customer)
    parkvej = await property(a.projects.copenhagen.id, "Parkvej 18", "Parkvej 18, 2100 København Ø")
    havnegade = await property(a.projects.harbor.id, "Havnegade 4", "Havnegade 4, 1058 København K")

    subscribed = await subscribeTo(
      await agreement("AGR-3401", a.projects.copenhagen.id, customer.id),
      (await product(a.projects.copenhagen.id, "Residual collection", weekly.id)).id,
      parkvej.id,
    )
    harborSubscription = await subscribeTo(
      await agreement("AGR-3402", a.projects.harbor.id, customer.id),
      (await product(a.projects.harbor.id, "Residual collection", harborWeekly.id)).id,
      havnegade.id,
    )
    inheritedProduct = await product(a.projects.copenhagen.id, "Inherited cadence collection", weekly.id)
    inherited = await subscribeTo(
      await agreement("AGR-3403", a.projects.copenhagen.id, customer.id),
      inheritedProduct.id,
      (await property(a.projects.copenhagen.id, "Strandvej 7", "Strandvej 7, 2100 København Ø")).id,
    )

    theirBin = await create(other, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    theirContainer = await create(
      other,
      "/containers",
      { projectId: b.projects.copenhagen.id, label: "BIN-THEIRS", containerTypeId: theirBin.id },
      Container,
    )
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  const frequency = (projectId: string, name: string, collectionsPerWeek: number, weeksBetween?: number) =>
    create(olivia, "/service-frequencies", { projectId, name, collectionsPerWeek, ...(weeksBetween === undefined ? {} : { weeksBetween }) }, ServiceFrequency)
  const property = (projectId: string, name: string, address: string) =>
    create(olivia, "/properties", { projectId, name, address, kind: "residential" }, Property)
  const product = (projectId: string, name: string, serviceFrequencyId: string) =>
    create(olivia, "/products", { projectId, name, kind: "container-collection", unit: "pickup", serviceFrequencyId }, Product)
  const agreement = (number: string, projectId: string, customerId: string) =>
    create(
      olivia,
      "/agreements",
      { projectId, number, customerId, payerCustomerId: customerId, billingCadence: "monthly", currency: "DKK", validFrom: JANUARY },
      Agreement,
    )
  const subscribeTo = (held: Agreement, productId: string, propertyId: string) =>
    create(olivia, `/agreements/${held.id}/subscriptions`, { productId, propertyId, validFrom: JANUARY }, Subscription)
  /** Gives a subscription an end, so a placement of it has a bound to fall outside of. */
  const endSubscription = async (held: Subscription, validTo: string): Promise<Subscription> => {
    const response = await olivia(`/subscriptions/${held.id}`, { method: "PATCH", body: { validTo } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Subscription.parse(await response.json())
  }

  /** A container body a caller may send: a label of this test's own, in Copenhagen Central unless it says otherwise. */
  const body = (label: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    label,
    containerTypeId: bin.id,
    ...values,
  })
  const container = (label: string, values: Record<string, unknown> = {}) => create(olivia, "/containers", body(label, values), Container)
  const one = async (call: Call, id: string): Promise<Container> => {
    const response = await call(`/containers/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Container.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Container> => {
    const response = await call(`/containers/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Container.parse(await response.json())
  }
  const page = async (call: Call, query = "") => ContainerPage.parse(await (await call(`/containers${query}`)).json())

  /** Puts a container into service under a subscription; the fraction is residual unless a test says otherwise. */
  const place = (into: Container, values: Record<string, unknown> = {}) =>
    create(
      olivia,
      `/containers/${into.id}/placements`,
      { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY, ...values },
      ContainerServicePlacement,
    )
  const onePlacement = async (call: Call, id: string): Promise<ContainerServicePlacement> => {
    const response = await call(`/placements/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ContainerServicePlacement.parse(await response.json())
  }
  const patchPlacement = async (id: string, values: unknown): Promise<ContainerServicePlacement> => {
    const response = await olivia(`/placements/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ContainerServicePlacement.parse(await response.json())
  }
  const placements = async (call: Call, query = "") => PlacementPage.parse(await (await call(`/placements${query}`)).json())

  describe("POST /containers", () => {
    test("mints the id, defaults the ownership to the company, and carries no status and no location", async () => {
      const created = await container("BIN-3410", { barcode: "5701234567890", notes: "Left of the gate" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.ownership, "company", "a container the company bought is the common case")
      assert.deepEqual([created.rfid, created.serialNumber], [null, null])
      assert.deepEqual(Object.keys(created).filter((key) => key === "status" || key === "location"), [], "where it is, is the placement valid that day")
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("holds the container type to this company, naming the field", async () => {
      const foreign = await refused(await olivia("/containers", { method: "POST", body: body("BIN-3411", { containerTypeId: theirBin.id }) }), 400)
      assert.deepEqual(foreign.errors, [{ path: "containerTypeId", message: "Not a container type of this company" }])
      const unminted = await refused(await olivia("/containers", { method: "POST", body: body("BIN-3412", { containerTypeId: testId() }) }), 400)
      assert.deepEqual(unminted.errors, [{ path: "containerTypeId", message: "Not a container type of this company" }])
    })

    test("refuses a project the caller does not work in, and a member the server owns", async () => {
      const foreign = await refused(await olivia("/containers", { method: "POST", body: body("BIN-3413", { projectId: b.projects.copenhagen.id }) }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(await olivia("/containers", { method: "POST", body: body("BIN-3414", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a label the company already uses, in this project or any other", async () => {
      await container("BIN-3415")
      const problem = await refused(await olivia("/containers", { method: "POST", body: body("BIN-3415") }), 409)
      assert.equal(problem.detail, "This company already has a container labelled BIN-3415")
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      await refused(await olivia("/containers", { method: "POST", body: body("BIN-3415", { projectId: a.projects.harbor.id }) }), 409)
      assert.equal(
        (await create(other, "/containers", { projectId: b.projects.copenhagen.id, label: "BIN-3415", containerTypeId: theirBin.id }, Container)).label,
        "BIN-3415",
        "a label is read off a bin inside one company, so another company's is free",
      )
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/containers", { method: "POST", body: body("BIN-3416") }), 403)
      assert.match(problem.detail ?? "", /create on resources\.containers/)
    })
  })

  describe("GET /containers", () => {
    test("answers the company's containers in id order and holds nothing of another company's", async () => {
      const mine = await container("BIN-3420")
      const ids = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirContainer.id))
    })

    test("filters by project and by container type", async () => {
      const wheelie = await create(olivia, "/container-types", { name: "660 L wheelie", volumeLitres: 660 }, ContainerType)
      const harbor = await container("BIN-3421", { projectId: a.projects.harbor.id, containerTypeId: wheelie.id })

      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)

      const byType = await page(olivia, `?limit=200&containerTypeId=${wheelie.id}`)
      assert.deepEqual(byType.items.map((row) => row.id), [harbor.id])
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await container("BIN-3422")
      const elsewhere = await container("BIN-3423", { projectId: a.projects.harbor.id })
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      const { items, nextCursor } = await page(lars, "?limit=200")
      assert.deepEqual(items, [])
      assert.equal(nextCursor, null)

      const problem = await refused(await viewer(`/containers?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without resources.containers view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/containers"), 403)).detail ?? "", /view on resources\.containers/)
      assert.equal((await app.request("/containers")).status, 401)
    })
  })

  describe("GET and PATCH /containers/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      await refused(await olivia(`/containers/${theirContainer.id}`), 404)
      assert.equal((await one(other, theirContainer.id)).label, "BIN-THEIRS", "still there for its own company")
      const elsewhere = await container("BIN-3430", { projectId: a.projects.harbor.id })
      await refused(await viewer(`/containers/${elsewhere.id}`), 404)
      await refused(await olivia(`/containers/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/containers/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })

    test("changes what the body names, refuses a rename onto a label the company uses, and holds the type to this company", async () => {
      const created = await container("BIN-3431")
      const changed = await patch(olivia, created.id, { ownership: "customer", rfid: "E2801160" })
      assert.equal(changed.ownership, "customer")
      assert.equal(changed.label, "BIN-3431", "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      await container("BIN-3432")
      const taken = await refused(await olivia(`/containers/${created.id}`, { method: "PATCH", body: { label: "BIN-3432" } }), 409)
      assert.equal(taken.detail, "This company already has a container labelled BIN-3432")
      const foreign = await refused(await olivia(`/containers/${created.id}`, { method: "PATCH", body: { containerTypeId: theirBin.id } }), 400)
      assert.deepEqual(foreign.errors, [{ path: "containerTypeId", message: "Not a container type of this company" }])
      assert.equal((await one(olivia, created.id)).label, "BIN-3431")
    })

    test("refuses an empty patch, another company's container, and a role that may view but not edit", async () => {
      const created = await container("BIN-3433")
      assert.deepEqual(
        (await refused(await olivia(`/containers/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      await refused(await olivia(`/containers/${theirContainer.id}`, { method: "PATCH", body: { ownership: "customer" } }), 404)
      assert.match((await refused(await lars(`/containers/${created.id}`, { method: "PATCH", body: { ownership: "customer" } }), 403)).detail ?? "", /edit on resources\.containers/)
    })
  })

  describe("POST /containers/:id/placements", () => {
    test("puts the container into service, taking the project from it, and answers the cadence in force", async () => {
      const into = await container("BIN-3440")
      const placed = await place(into, { validTo: APRIL })
      assert.equal(Id.parse(placed.id), placed.id)
      assert.equal(placed.containerId, into.id)
      assert.equal(placed.projectId, into.projectId, "the project is the container's; a body cannot name a second one")
      assert.equal(placed.serviceFrequencyId, null, "no override was asked for")
      assert.equal(placed.effectiveServiceFrequencyId, weekly.id, "so the product's cadence is the one in force")
      assert.deepEqual([placed.validFrom, placed.validTo], [JANUARY, APRIL])
      assert.deepEqual(await onePlacement(olivia, placed.id), placed, "the create answers what the next read says")

      const overridden = await place(into, { validFrom: APRIL, serviceFrequencyId: fortnightly.id })
      assert.equal(overridden.serviceFrequencyId, fortnightly.id)
      assert.equal(overridden.effectiveServiceFrequencyId, fortnightly.id, "the placement's cadence beats the product's")
    })

    test("answers 404 for a container outside the caller's projects", async () => {
      const elsewhere = await container("BIN-3441", { projectId: a.projects.harbor.id })
      const problem = await refused(
        await viewer(`/containers/${elsewhere.id}/placements`, { method: "POST", body: { subscriptionId: harborSubscription.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        404,
      )
      assert.match(problem.detail ?? "", /container/i)
      await refused(
        await olivia(`/containers/${theirContainer.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        404,
      )
    })

    test("holds the subscription to the container's project and the fraction and the cadence to their own scope", async () => {
      const into = await container("BIN-3442")
      const foreignSubscription = await refused(
        await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: harborSubscription.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        400,
      )
      assert.deepEqual(foreignSubscription.errors, [{ path: "subscriptionId", message: "Not a subscription of this container's project" }])

      const theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
      const fraction = await refused(
        await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: theirFraction.id, validFrom: JANUARY } }),
        400,
      )
      assert.deepEqual(fraction.errors, [{ path: "wasteFractionId", message: "Not a waste fraction of this company" }])

      const cadence = await refused(
        await olivia(`/containers/${into.id}/placements`, {
          method: "POST",
          body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, serviceFrequencyId: harborWeekly.id, validFrom: JANUARY },
        }),
        400,
      )
      assert.deepEqual(cadence.errors, [{ path: "serviceFrequencyId", message: "Not a service frequency of this project" }])
    })

    test("refuses a period outside the subscription's, naming the bound", async () => {
      const bounded = await subscribeTo(
        await agreement("AGR-3443", a.projects.copenhagen.id, (await create(olivia, "/customers", { kind: "organisation", name: "Bounded Housing" }, Customer)).id),
        (await product(a.projects.copenhagen.id, "Bounded collection", weekly.id)).id,
        (await property(a.projects.copenhagen.id, "Bounded 1", "Bounded 1, 2100 København Ø")).id,
      )
      assert.equal((await endSubscription(bounded, OCTOBER)).validTo, OCTOBER)
      const into = await container("BIN-3443")

      const open = await refused(
        await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: bounded.id, wasteFractionId: residual.id, validFrom: APRIL } }),
        400,
      )
      assert.deepEqual(open.errors, [{ path: "validTo", message: "Outside the subscription's period" }])
      const late = await refused(
        await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: bounded.id, wasteFractionId: residual.id, validFrom: APRIL, validTo: NEXT_YEAR } }),
        400,
      )
      assert.deepEqual(late.errors, [{ path: "validTo", message: "Outside the subscription's period" }])

      const inside = await place(into, { subscriptionId: bounded.id, validFrom: APRIL, validTo: OCTOBER })
      assert.deepEqual([inside.validFrom, inside.validTo], [APRIL, OCTOBER], "the subscription's own period is inside itself")
    })

    test("refuses a second placement of the container over part of the period, and takes one back to back", async () => {
      const into = await container("BIN-3444")
      await place(into, { validFrom: JANUARY, validTo: APRIL })
      const next = await place(into, { validFrom: APRIL, validTo: JULY })
      assert.equal(next.validFrom, APRIL, "the day one placement ends is the day the next may begin")

      const problem = await refused(
        await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: FEBRUARY } }),
        409,
      )
      assert.equal(problem.detail, "Container BIN-3444 is already placed over part of that period; end that placement first")
      assert.doesNotMatch(problem.detail ?? "", /no_overlap/)
    })

    test("refuses a role that may view but not create", async () => {
      const into = await container("BIN-3445")
      const problem = await refused(
        await lars(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        403,
      )
      assert.match(problem.detail ?? "", /create on resources\.containers/)
    })
  })

  describe("GET /placements", () => {
    test("filters by container, by subscription and by the day, and answers none between two placements", async () => {
      const into = await container("BIN-3450")
      const first = await place(into, { validFrom: JANUARY, validTo: APRIL })
      const second = await place(into, { validFrom: JULY })

      const all = await placements(olivia, `?limit=200&containerId=${into.id}`)
      assert.deepEqual(all.items.map((row) => row.id).sort(), [first.id, second.id].sort())
      assert.deepEqual(all.items.map((row) => row.id), [...all.items.map((row) => row.id)].sort(), "ascending by id")

      assert.deepEqual((await placements(olivia, `?containerId=${into.id}&validOn=${FEBRUARY}`)).items.map((row) => row.id), [first.id])
      assert.deepEqual((await placements(olivia, `?containerId=${into.id}&validOn=${OCTOBER}`)).items.map((row) => row.id), [second.id])
      assert.deepEqual((await placements(olivia, `?containerId=${into.id}&validOn=${APRIL}`)).items, [], "the day one ended and before the next began")

      const bySubscription = (await placements(olivia, `?limit=200&subscriptionId=${subscribed.id}`)).items
      assert.ok(bySubscription.some((row) => row.id === first.id))
      for (const row of bySubscription) assert.equal(row.subscriptionId, subscribed.id)
      for (const row of bySubscription) {
        assert.equal(row.effectiveServiceFrequencyId, row.serviceFrequencyId ?? weekly.id, "a page item carries the cadence in force too")
      }
    })

    test("answers the containers standing at a place on a day, through the subscription, and asks for the day", async () => {
      const into = await container("BIN-3451")
      const placed = await place(into, { validFrom: JANUARY })

      const atTheProperty = (await placements(olivia, `?limit=200&propertyId=${parkvej.id}&validOn=${FEBRUARY}`)).items
      assert.ok(atTheProperty.some((row) => row.id === placed.id))
      assert.deepEqual((await placements(olivia, `?limit=200&propertyId=${havnegade.id}&validOn=${FEBRUARY}`)).items, [])
      assert.deepEqual((await placements(olivia, `?limit=200&sharedCollectionPointId=${testId()}&validOn=${FEBRUARY}`)).items, [])

      const dayless = await refused(await olivia(`/placements?propertyId=${parkvej.id}`), 400)
      assert.deepEqual(dayless.errors?.map((error) => error.path), ["validOn"])
      assert.match(dayless.errors?.[0].message ?? "", /what stands at a place is what stands there on a day/)
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await place(await container("BIN-3452"), { validFrom: OCTOBER })
      const harborContainer = await container("BIN-3453", { projectId: a.projects.harbor.id })
      const elsewhere = await create(
        olivia,
        `/containers/${harborContainer.id}/placements`,
        { subscriptionId: harborSubscription.id, wasteFractionId: residual.id, validFrom: JANUARY },
        ContainerServicePlacement,
      )
      const seen = (await placements(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      const byProject = (await placements(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)).items
      assert.ok(byProject.some((row) => row.id === elsewhere.id))
      for (const row of byProject) assert.equal(row.projectId, a.projects.harbor.id)
      const refusedProject = await refused(await viewer(`/placements?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(refusedProject.errors, [{ path: "projectId", message: "Not a project this account works in" }])

      assert.deepEqual((await placements(lars, "?limit=200")).items, [])
      assert.match((await refused(await ungranted("/placements"), 403)).detail ?? "", /view on resources\.containers/)
      assert.equal((await app.request("/placements")).status, 401)
    })
  })

  describe("GET and PATCH /placements/:id", () => {
    test("reads the cadence in force off the product, and follows it when the product's changes", async () => {
      const placed = await place(await container("BIN-3460"), { subscriptionId: inherited.id, validFrom: JANUARY })
      assert.equal(placed.effectiveServiceFrequencyId, weekly.id)

      const changed = await olivia(`/products/${inheritedProduct.id}`, { method: "PATCH", body: { serviceFrequencyId: fortnightly.id } })
      assert.equal(changed.status, 200, JSON.stringify(await changed.clone().json()))
      const read = await onePlacement(olivia, placed.id)
      assert.equal(read.serviceFrequencyId, null, "nothing was written on the placement")
      assert.equal(read.effectiveServiceFrequencyId, fortnightly.id, "the cadence is inherited by query, never copied")

      const overridden = await patchPlacement(placed.id, { serviceFrequencyId: weekly.id })
      assert.equal(overridden.effectiveServiceFrequencyId, weekly.id)
      const cleared = await patchPlacement(placed.id, { serviceFrequencyId: null })
      assert.equal(cleared.effectiveServiceFrequencyId, fortnightly.id, "a null override is the product's cadence again")
    })

    test("answers 404 for another company's placement and for an id nobody minted", async () => {
      const theirs = await theirPlacement()
      await refused(await olivia(`/placements/${theirs.id}`), 404)
      await refused(await olivia(`/placements/${testId()}`), 404)
      assert.equal((await onePlacement(other, theirs.id)).containerId, theirContainer.id)
      assert.deepEqual((await refused(await olivia("/placements/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })

    test("ends a placement, corrects the fraction, and refuses an end outside the subscription's period", async () => {
      const bounded = await subscribeTo(
        await agreement("AGR-3462", a.projects.copenhagen.id, (await create(olivia, "/customers", { kind: "organisation", name: "Ending Housing" }, Customer)).id),
        (await product(a.projects.copenhagen.id, "Ending collection", weekly.id)).id,
        (await property(a.projects.copenhagen.id, "Ending 1", "Ending 1, 2100 København Ø")).id,
      )
      assert.equal((await endSubscription(bounded, OCTOBER)).validTo, OCTOBER)
      const placed = await place(await container("BIN-3462"), { subscriptionId: bounded.id, validFrom: APRIL, validTo: JULY })

      const glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
      const ended = await patchPlacement(placed.id, { validTo: OCTOBER, wasteFractionId: glass.id })
      assert.deepEqual([ended.validTo, ended.wasteFractionId], [OCTOBER, glass.id])
      assert.ok(ended.updatedAt > placed.updatedAt)

      const beyond = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { validTo: NEXT_YEAR } }), 400)
      assert.deepEqual(beyond.errors, [{ path: "validTo", message: "Outside the subscription's period" }])
      const open = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { validTo: null } }), 400)
      assert.deepEqual(open.errors, [{ path: "validTo", message: "Outside the subscription's period" }])
      const backwards = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { validTo: JANUARY } }), 400)
      assert.deepEqual(backwards.errors?.map((error) => error.path), ["validTo"])
      assert.equal((await onePlacement(olivia, placed.id)).validTo, OCTOBER)
    })

    test("refuses an end that would run the placement into the next one", async () => {
      const into = await container("BIN-3463")
      const first = await place(into, { validFrom: JANUARY, validTo: APRIL })
      await place(into, { validFrom: JULY, validTo: OCTOBER })
      const problem = await refused(await olivia(`/placements/${first.id}`, { method: "PATCH", body: { validTo: OCTOBER } }), 409)
      assert.equal(problem.detail, "Container BIN-3463 is already placed over part of that period; end that placement first")
      assert.equal((await onePlacement(olivia, first.id)).validTo, APRIL)
      assert.equal((await patchPlacement(first.id, { validTo: JULY })).validTo, JULY, "up to the day the next begins is fine")
    })

    test("refuses an empty patch, a fraction of another company, and a role that may view but not edit", async () => {
      const placed = await place(await container("BIN-3464"), { validFrom: NEXT_YEAR })
      assert.deepEqual(
        (await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      const theirFraction = await create(other, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
      const fraction = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { wasteFractionId: theirFraction.id } }), 400)
      assert.deepEqual(fraction.errors, [{ path: "wasteFractionId", message: "Not a waste fraction of this company" }])
      assert.match((await refused(await lars(`/placements/${placed.id}`, { method: "PATCH", body: { wasteFractionId: residual.id } }), 403)).detail ?? "", /edit on resources\.containers/)
    })
  })

  /** The other company's placement, made the way it makes everything else: through its own routes. */
  const theirPlacement = async (): Promise<ContainerServicePlacement> => {
    const customer = await create(other, "/customers", { kind: "organisation", name: "Their Housing" }, Customer)
    const held = await create(
      other,
      "/agreements",
      {
        projectId: b.projects.copenhagen.id,
        number: "THEIRS-2",
        customerId: customer.id,
        payerCustomerId: customer.id,
        billingCadence: "monthly",
        currency: "DKK",
        validFrom: JANUARY,
      },
      Agreement,
    )
    const theirProperty = await create(
      other,
      "/properties",
      { projectId: b.projects.copenhagen.id, name: "Their Parkvej", address: "Parkvej 1", kind: "residential" },
      Property,
    )
    const theirProduct = await create(
      other,
      "/products",
      { projectId: b.projects.copenhagen.id, name: "Residual collection", kind: "container-collection", unit: "pickup" },
      Product,
    )
    const theirSubscription = await create(
      other,
      `/agreements/${held.id}/subscriptions`,
      { productId: theirProduct.id, propertyId: theirProperty.id, validFrom: JANUARY },
      Subscription,
    )
    const theirFraction = await create(other, "/waste-fractions", { key: "paper", name: "Paper" }, WasteFraction)
    return await create(
      other,
      `/containers/${theirContainer.id}/placements`,
      { subscriptionId: theirSubscription.id, wasteFractionId: theirFraction.id, validFrom: JANUARY },
      ContainerServicePlacement,
    )
  }
})

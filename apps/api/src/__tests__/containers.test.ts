import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product, ServiceFrequency, WasteFraction } from "@waste/contracts/catalogue"
import { Container, ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property, SharedCollectionPoint } from "@waste/contracts/customers"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { StockMovement } from "@waste/contracts/stock"
import { createDb, type Database } from "@waste/db/client"
import { stockMovement } from "@waste/db/schema/stock"
import { withCompany } from "@waste/db/tenant"

import { createApp } from "../app"
import { END_BY_COMMAND } from "../routes/containers"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { pointBody, setStatus } from "./registry"
import { stocked as stockedIn, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ledger rows this suite writes, which `wms_api` may not delete (#101 §6.24). */
const owner = ownerUnderTest()
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

describe("the container and placement endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  /** Every placement here is of a container received through the ledger, so the owner sweeps the whole suite's rows (#101 §6.24). */
  let ownerPool: Database
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
  /** A warehouse of Copenhagen Central and one of Harbor Commercial: where a container is received before it can be issued (Issue #101). */
  let west: string
  let havnen: string
  /** The other company's. */
  let theirBin: ContainerType
  let theirContainer: Container

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
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

    west = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-WEST")
    havnen = await warehouseIn(pool, a.companyId, a.projects.harbor.id, "WH-HAVNEN")

    theirBin = await create(other, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    theirContainer = await create(
      other,
      "/containers",
      { projectId: b.projects.copenhagen.id, label: "BIN-THEIRS", containerTypeId: theirBin.id },
      Container,
    )
    await appended(other, `/containers/${theirContainer.id}/receive`, { warehouseId: await warehouseIn(pool, b.companyId, b.projects.copenhagen.id, "WH-THEIRS") }, StockMovement)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  /** A ledger command's 201: the movement parsed and no Location to follow, since a movement has no address of its own (app.test.ts). */
  const appended = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
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
  /** A point in the status a test names, since a subscription needs one that is open or restricted (Issue #79). */
  const point = (projectId: string, name: string, status: string) =>
    create(olivia, "/shared-collection-points", pointBody(projectId, name, status), SharedCollectionPoint)
  /** An active product: a draft one cannot be subscribed to (Issue #79). */
  const product = (projectId: string, name: string, serviceFrequencyId: string) =>
    create(olivia, "/products", { projectId, name, kind: "container-collection", unit: "pickup", serviceFrequencyId, status: "active" }, Product)
  const agreement = (number: string, projectId: string, customerId: string) =>
    create(
      olivia,
      "/agreements",
      { projectId, number, customerId, payerCustomerId: customerId, billingCadence: "monthly", currency: "DKK", validFrom: JANUARY },
      Agreement,
    )
  const subscribeTo = (held: Agreement, productId: string, propertyId: string) =>
    create(olivia, `/agreements/${held.id}/subscriptions`, { productId, propertyId, validFrom: JANUARY }, Subscription)
  /** The same, delivered at a point: the other kind of place. */
  const subscribeAtPoint = (held: Agreement, productId: string, sharedCollectionPointId: string) =>
    create(olivia, `/agreements/${held.id}/subscriptions`, { productId, sharedCollectionPointId, validFrom: JANUARY }, Subscription)
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

  /** Puts a container into service under a subscription; the fraction is residual unless a test says otherwise. The container has to be in stock: `stocked` makes one. */
  const place = (into: Container, values: Record<string, unknown> = {}) =>
    create(
      olivia,
      `/containers/${into.id}/placements`,
      { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY, ...values },
      ContainerServicePlacement,
    )
  /** A container received into a warehouse through the ledger's own command (Issue #101): the state the issue command wants (stock-fixtures.ts). */
  const stocked = (label: string, values: Record<string, unknown> = {}, warehouseId = west): Promise<Container> =>
    stockedIn(olivia, body(label, values), warehouseId)
  /** Takes the container out of service on `validTo`, back into the west warehouse: how a placement ends since the ledger. */
  const returned = (into: Container, validTo: string) => appended(olivia, `/containers/${into.id}/return`, { warehouseId: west, validTo }, StockMovement)
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

  /** A receipt of the container into the warehouse, appended directly as `wms_api` (which may insert into the ledger and never delete), so the projection is proved over rows the commands did not shape; the commands themselves are lifecycle.test.ts's. */
  const receivedInto = async (into: Container, warehouseId: string, occurredAt: string): Promise<string> => {
    const id = testId()
    await withCompany(pool.db, a.companyId, async (tx) => {
      await tx.insert(stockMovement).values({
        id,
        companyId: a.companyId,
        projectId: into.projectId,
        containerId: into.id,
        kind: "receipt",
        fromKind: "supplier",
        toKind: "warehouse",
        toWarehouseId: warehouseId,
        occurredAt: new Date(occurredAt),
        recordedBy: a.users.olivia.id,
      })
    })
    return id
  }

  describe("POST /containers", () => {
    test("mints the id, defaults the ownership to the company, and carries no status and no location of its own", async () => {
      const created = await container("BIN-3410", { barcode: "5701234567890", notes: "Left of the gate" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.ownership, "company", "a container the company bought is the common case")
      assert.deepEqual([created.rfid, created.serialNumber], [null, null])
      assert.deepEqual(Object.keys(created).filter((key) => key === "status" || key === "location"), [], "where it is, is the placement valid that day")
      assert.equal(created.assetState, null, "no movement yet is no state")
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

  describe("assetState, the ledger's reading (Issue #101)", () => {
    test("is null for a container with no movement, and where the latest movement left it once one is recorded, on the read, the list and the patch alike", async () => {
      const created = await container("BIN-3490")
      assert.equal(created.assetState, null)
      const west = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-3490")
      const received = await receivedInto(created, west, "2026-09-01T08:00:00Z")
      const state = { status: "in-warehouse", warehouseId: west, placementId: null, since: "2026-09-01T08:00:00.000Z", movementId: received }
      assert.deepEqual((await one(olivia, created.id)).assetState, state)
      assert.deepEqual((await patch(olivia, created.id, { notes: "Received" })).assetState, state, "a write answers what the next read says")
      const listed = (await page(olivia, `?projectId=${a.projects.copenhagen.id}`)).items.find((item) => item.id === created.id)
      assert.deepEqual(listed?.assetState, state)
      // A later movement is the reading; the earlier one is history.
      const east = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-3491")
      const moved = await receivedInto(created, east, "2026-09-02T08:00:00Z")
      assert.deepEqual((await one(olivia, created.id)).assetState, { ...state, warehouseId: east, since: "2026-09-02T08:00:00.000Z", movementId: moved })
    })

    test("the list asks by the reading: assetStatus selects the state, warehouseId the containers standing in that warehouse", async () => {
      const west = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-3492")
      const stocked = await container("BIN-3492")
      const unrecorded = await container("BIN-3493")
      await receivedInto(stocked, west, "2026-09-01T09:00:00Z")
      const standing = await page(olivia, `?warehouseId=${west}`)
      assert.deepEqual(standing.items.map((item) => item.id), [stocked.id], "what stands in the warehouse, and nothing else")
      const inStock = await page(olivia, "?assetStatus=in-warehouse")
      assert.ok(inStock.items.some((item) => item.id === stocked.id))
      assert.ok(inStock.items.every((item) => item.assetState?.status === "in-warehouse"), "every item is in the state asked for")
      assert.equal(inStock.items.some((item) => item.id === unrecorded.id), false, "the unrecorded have no state to match")
      assert.equal((await page(olivia, "?assetStatus=retired")).items.some((item) => item.id === stocked.id), false)
      assert.equal((await page(olivia, `?assetStatus=in-service&warehouseId=${west}`)).items.length, 0, "the two filters compose")
    })

    test("holds warehouseId to the projects the caller works in, naming the filter", async () => {
      const havnen = await warehouseIn(pool, a.companyId, a.projects.harbor.id, "WH-3494")
      const outside = await refused(await viewer(`/containers?warehouseId=${havnen}`), 400)
      assert.deepEqual(outside.errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }], "Vera works in Copenhagen Central only")
      assert.deepEqual((await page(olivia, `?warehouseId=${havnen}`)).items, [], "Olivia works in every project and finds nothing standing there")
      const elsewhere = await refused(await olivia(`/containers?projectId=${a.projects.copenhagen.id}&warehouseId=${havnen}`), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }], "the project named bounds the warehouse")
      const nobody = await refused(await olivia(`/containers?warehouseId=${testId()}`), 400)
      assert.deepEqual(nobody.errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }])
      assert.deepEqual((await refused(await olivia("/containers?assetStatus=in-transit"), 400)).errors?.map((error) => error.path), ["assetStatus"], "a state outside the vocabulary")
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
      const into = await stocked("BIN-3440")
      const placed = await place(into)
      assert.equal(Id.parse(placed.id), placed.id)
      assert.equal(placed.containerId, into.id)
      assert.equal(placed.projectId, into.projectId, "the project is the container's; a body cannot name a second one")
      assert.equal(placed.serviceFrequencyId, null, "no override was asked for")
      assert.equal(placed.effectiveServiceFrequencyId, weekly.id, "so the product's cadence is the one in force")
      assert.deepEqual([placed.validFrom, placed.validTo], [JANUARY, null], "open: the end is the ledger's to set")
      assert.deepEqual(await onePlacement(olivia, placed.id), placed, "the create answers what the next read says")
      assert.equal((await one(olivia, into.id)).assetState?.placementId, placed.id, "the issue movement names the placement it opened")

      await returned(into, APRIL)
      const overridden = await place(into, { validFrom: APRIL, serviceFrequencyId: fortnightly.id })
      assert.equal(overridden.serviceFrequencyId, fortnightly.id)
      assert.equal(overridden.effectiveServiceFrequencyId, fortnightly.id, "the placement's cadence beats the product's")
    })

    test("is the issue command: a container with no stock record is refused, and the body's instant and paper go on the movement, not the placement", async () => {
      const unrecorded = await container("BIN-3446")
      const problem = await refused(
        await olivia(`/containers/${unrecorded.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        409,
      )
      assert.equal(problem.detail, "Container BIN-3446 has no stock record; receive it first")
      assert.deepEqual((await placements(olivia, `?containerId=${unrecorded.id}`)).items, [])

      const into = await stocked("BIN-3447")
      const placed = await place(into, { occurredAt: "2026-01-02T08:00:00Z", reference: "DN-3447" })
      assert.deepEqual(Object.keys(placed).filter((key) => key === "occurredAt" || key === "reference"), [], "neither is a column of the placement")
      const state = (await one(olivia, into.id)).assetState
      assert.deepEqual([state?.status, state?.warehouseId, state?.placementId, state?.since], ["in-service", null, placed.id, "2026-01-02T08:00:00.000Z"], "the issue movement is the reading")
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

    test("starts inside the subscription's period, naming validFrom, carries no end, and is held to that before the container's state is read", async () => {
      const bounded = await subscribeTo(
        await agreement("AGR-3443", a.projects.copenhagen.id, (await create(olivia, "/customers", { kind: "organisation", name: "Bounded Housing" }, Customer)).id),
        (await product(a.projects.copenhagen.id, "Bounded collection", weekly.id)).id,
        (await property(a.projects.copenhagen.id, "Bounded 1", "Bounded 1, 2100 København Ø")).id,
      )
      assert.equal((await endSubscription(bounded, OCTOBER)).validTo, OCTOBER)
      const into = await stocked("BIN-3443")
      const issue = (values: Record<string, unknown>) =>
        olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: bounded.id, wasteFractionId: residual.id, ...values } })

      const early = await refused(await issue({ validFrom: "2025-06-01" }), 400)
      assert.deepEqual(early.errors, [{ path: "validFrom", message: "Outside the subscription's period" }])
      const onTheEnd = await refused(await issue({ validFrom: OCTOBER }), 400)
      assert.deepEqual(onTheEnd.errors, [{ path: "validFrom", message: "Outside the subscription's period" }], "validTo is the first day out of force")
      const withAnEnd = await refused(await issue({ validFrom: APRIL, validTo: JULY }), 400)
      assert.ok(withAnEnd.errors?.some((error) => /validTo/.test(error.message)), `${JSON.stringify(withAnEnd.errors)}: a placement ends through the container's return or decommission`)

      // The start is held before the ledger is consulted: an unrecorded
      // container is refused for its start, not for its state.
      const unrecorded = await container("BIN-3448")
      const first = await refused(
        await olivia(`/containers/${unrecorded.id}/placements`, { method: "POST", body: { subscriptionId: bounded.id, wasteFractionId: residual.id, validFrom: NEXT_YEAR } }),
        400,
      )
      assert.deepEqual(first.errors, [{ path: "validFrom", message: "Outside the subscription's period" }], "a 400 whatever the state")

      const inside = await place(into, { subscriptionId: bounded.id, validFrom: APRIL })
      assert.deepEqual([inside.validFrom, inside.validTo], [APRIL, null], "open under a bounded subscription: the return's validTo is what is held inside it")
      const beyond = await refused(await olivia(`/containers/${into.id}/return`, { method: "POST", body: { warehouseId: west, validTo: NEXT_YEAR } }), 400)
      assert.deepEqual(beyond.errors, [{ path: "validTo", message: "Outside the subscription's period" }])
      assert.equal((await returned(into, OCTOBER)).placementId, inside.id, "and the subscription's own end is inside itself")
    })

    test("refuses a second placement of the container over part of the period, and takes one back to back", async () => {
      const into = await stocked("BIN-3444")
      await place(into, { validFrom: JANUARY })
      await returned(into, APRIL)
      const next = await place(into, { validFrom: APRIL })
      assert.equal(next.validFrom, APRIL, "the day one placement ends is the day the next may begin")
      await returned(into, JULY)

      // Back in stock, so the state lets the issue through and the exclusion
      // constraint is what refuses the period over the two it left.
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

    test("refuses a new placement at a property that has gone inactive, and lets the placement already there be ended", async () => {
      const held = await agreement("AGR-3446", a.projects.copenhagen.id, (await create(olivia, "/customers", { kind: "organisation", name: "Leaving Housing" }, Customer)).id)
      const demolished = await property(a.projects.copenhagen.id, "Demolished 1", "Demolished 1, 2100 København Ø")
      const served = await subscribeTo(held, (await product(a.projects.copenhagen.id, "Demolished collection", weekly.id)).id, demolished.id)
      // Stocked first, since a container is issued out of a warehouse (Issue #101), and labelled apart from the ledger tests' bins.
      const into = await stocked("BIN-3470")
      const standing = await place(into, { subscriptionId: served.id })
      await setStatus(olivia, `/properties/${demolished.id}`, "inactive")

      const later = await stocked("BIN-3471")
      const problem = await refused(
        await olivia(`/containers/${later.id}/placements`, { method: "POST", body: { subscriptionId: served.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        409,
      )
      assert.equal(problem.detail, "The subscription's property is inactive; a placement needs an active property")
      // Ended through the container's return, the ledger's door out of service (Issue #101): the status never reaches back to it.
      assert.equal((await returned(into, APRIL)).placementId, standing.id, "the placement already there is ended by its period, through the return")
      assert.equal((await onePlacement(olivia, standing.id)).validTo, APRIL)

      const wrong = await refused(
        await olivia(`/containers/${later.id}/placements`, { method: "POST", body: { subscriptionId: served.id, wasteFractionId: testId(), validFrom: JANUARY } }),
        400,
      )
      assert.deepEqual(wrong.errors, [{ path: "wasteFractionId", message: "Not a waste fraction of this company" }], "a body that is wrong is told so before a place that does not serve: 400 before any 409")
    })

    test("refuses a new placement at a point that has closed or been drafted again, and lets the placement already there be ended", async () => {
      const held = await agreement("AGR-3448", a.projects.copenhagen.id, (await create(olivia, "/customers", { kind: "organisation", name: "Bank Housing" }, Customer)).id)
      const bank = await point(a.projects.copenhagen.id, "Closing bank", "open")
      const served = await subscribeAtPoint(held, (await product(a.projects.copenhagen.id, "Bank collection", weekly.id)).id, bank.id)
      const into = await stocked("BIN-3472")
      const standing = await place(into, { subscriptionId: served.id })
      await setStatus(olivia, `/shared-collection-points/${bank.id}`, "closed")

      const later = await stocked("BIN-3473")
      const closed = await refused(
        await olivia(`/containers/${later.id}/placements`, { method: "POST", body: { subscriptionId: served.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        409,
      )
      assert.equal(closed.detail, "The subscription's shared collection point is closed; a placement needs an open or restricted point")
      // Ended through the container's return, the ledger's door out of service (Issue #101): the status never reaches back to it.
      assert.equal((await returned(into, APRIL)).placementId, standing.id, "the placement already there is ended by its period, through the return")
      assert.equal((await onePlacement(olivia, standing.id)).validTo, APRIL)

      await setStatus(olivia, `/shared-collection-points/${bank.id}`, "draft")
      const drafted = await refused(
        await olivia(`/containers/${later.id}/placements`, { method: "POST", body: { subscriptionId: served.id, wasteFractionId: residual.id, validFrom: JANUARY } }),
        409,
      )
      assert.equal(drafted.detail, "The subscription's shared collection point is draft; a placement needs an open or restricted point", "a place a subscription may not be made at is a place a container may not be placed at: one definition of served")
      assert.equal((await patchPlacement(standing.id, { validTo: JULY })).validTo, JULY, "and the end of the placement already there is still corrected freely")

      await setStatus(olivia, `/shared-collection-points/${bank.id}`, "restricted")
      const again = await place(later, { subscriptionId: served.id, validFrom: JULY })
      assert.equal(again.subscriptionId, served.id, "a point that takes waste from its members again takes containers again")
    })
  })

  describe("GET /placements", () => {
    test("filters by container, by subscription and by the day, and answers none between two placements", async () => {
      const into = await stocked("BIN-3450")
      const first = await place(into, { validFrom: JANUARY })
      await returned(into, APRIL)
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
      const into = await stocked("BIN-3451")
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
      const here = await place(await stocked("BIN-3452"), { validFrom: OCTOBER })
      const harborContainer = await stocked("BIN-3453", { projectId: a.projects.harbor.id }, havnen)
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
      const placed = await place(await stocked("BIN-3460"), { subscriptionId: inherited.id, validFrom: JANUARY })
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

    test("corrects the end of an ended placement and the fraction, and refuses an end outside the subscription's period", async () => {
      const bounded = await subscribeTo(
        await agreement("AGR-3462", a.projects.copenhagen.id, (await create(olivia, "/customers", { kind: "organisation", name: "Ending Housing" }, Customer)).id),
        (await product(a.projects.copenhagen.id, "Ending collection", weekly.id)).id,
        (await property(a.projects.copenhagen.id, "Ending 1", "Ending 1, 2100 København Ø")).id,
      )
      assert.equal((await endSubscription(bounded, OCTOBER)).validTo, OCTOBER)
      const into = await stocked("BIN-3462")
      const placed = await place(into, { subscriptionId: bounded.id, validFrom: APRIL })
      await returned(into, JULY)

      const glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
      const ended = await patchPlacement(placed.id, { validTo: OCTOBER, wasteFractionId: glass.id })
      assert.deepEqual([ended.validTo, ended.wasteFractionId], [OCTOBER, glass.id])
      assert.ok(ended.updatedAt > placed.updatedAt)

      const beyond = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { validTo: NEXT_YEAR } }), 400)
      assert.deepEqual(beyond.errors, [{ path: "validTo", message: "Outside the subscription's period" }])
      const backwards = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { validTo: JANUARY } }), 400)
      assert.deepEqual(backwards.errors?.map((error) => error.path), ["validTo"])
      assert.equal((await onePlacement(olivia, placed.id)).validTo, OCTOBER)
    })

    test("neither ends an open placement nor reopens an ended one: the ledger's commands do that (Issue #101)", async () => {
      const into = await stocked("BIN-3465")
      const placed = await place(into)
      const closing = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { validTo: JULY } }), 409)
      assert.equal(closing.detail, END_BY_COMMAND)
      assert.equal((await onePlacement(olivia, placed.id)).validTo, null, "still open")
      assert.equal((await patchPlacement(placed.id, { serviceFrequencyId: fortnightly.id })).serviceFrequencyId, fortnightly.id, "the rest of the patch is untouched by the rule")

      await returned(into, JULY)
      const reopening = await refused(await olivia(`/placements/${placed.id}`, { method: "PATCH", body: { validTo: null } }), 400)
      assert.deepEqual(reopening.errors?.map((error) => error.path), ["validTo"], "a null would take the end off, which the ledger's word forbids: the contracts refuse the member before the route sees it")
      assert.equal((await onePlacement(olivia, placed.id)).validTo, JULY, "still ended on the day the container left")
      assert.equal((await patchPlacement(placed.id, { validTo: OCTOBER })).validTo, OCTOBER, "a day it already left on may be corrected")
      assert.equal((await one(olivia, into.id)).assetState?.status, "in-warehouse", "the ledger is untouched by the patch")
    })

    test("refuses an end that would run the placement into the next one", async () => {
      const into = await stocked("BIN-3463")
      const first = await place(into, { validFrom: JANUARY })
      await returned(into, APRIL)
      await place(into, { validFrom: JULY })
      const problem = await refused(await olivia(`/placements/${first.id}`, { method: "PATCH", body: { validTo: OCTOBER } }), 409)
      assert.equal(problem.detail, "Container BIN-3463 is already placed over part of that period; end that placement first")
      assert.equal((await onePlacement(olivia, first.id)).validTo, APRIL)
      assert.equal((await patchPlacement(first.id, { validTo: JULY })).validTo, JULY, "up to the day the next begins is fine")
    })

    test("refuses an empty patch, a fraction of another company, and a role that may view but not edit", async () => {
      const placed = await place(await stocked("BIN-3464"), { validFrom: NEXT_YEAR })
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
      { projectId: b.projects.copenhagen.id, name: "Residual collection", kind: "container-collection", unit: "pickup", status: "active" },
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

import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product, ServiceFrequency, WasteFraction } from "@waste/contracts/catalogue"
import { Container, ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property } from "@waste/contracts/customers"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { StockMovement } from "@waste/contracts/stock"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import { createDb, type Database } from "@waste/db/client"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { stockMovement } from "@waste/db/schema/stock"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import {
  ALREADY_THERE,
  GIVE_VALID_TO,
  NOT_A_MOVEMENT_OF_THIS_CONTAINER,
  OUTSIDE_SUBSCRIPTION,
  placementAlreadyEnded,
  RECORDED_AFTER_IT_HAPPENED,
  VALID_TO_SAYS_NOTHING,
} from "../routes/lifecycle"
import { OCCURRED_AT_SKEW_MS } from "../routes/shared"
import { takesNoStock } from "../routes/statuses"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { stocked as stockedIn, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ledger rows this suite writes, which `wms_api` may not delete (#101 §6.24). */
const owner = ownerUnderTest()
const MovementPage = Page(StockMovement)
const ContainerPage = Page(Container)
const PlacementPage = Page(ContainerServicePlacement)

const MODULE = "resources.containers"
const INVENTORY = "resources.inventory"

/** The days the periods of this file are cut from. */
const JANUARY = "2026-01-01"
const FEBRUARY = "2026-02-01"
const APRIL = "2026-04-01"
const JULY = "2026-07-01"
const OCTOBER = "2026-10-01"
const NEXT_YEAR = "2027-01-01"
/** An instant no request's clock has reached. */
const FUTURE = "2100-01-01T00:00:00Z"
/** The clock the skew tests pin the request to. */
const PINNED = Date.parse("2026-09-25T12:00:00Z")

/** The SQLSTATE of a refused statement, through Drizzle's wrapper or straight from postgres.js. */
const sqlstate = (error: unknown): string | undefined => {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null)?.code
    if (typeof code === "string") return code
  }
  return undefined
}

describe("the container lifecycle commands and the ledger's reads", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit on containers and view on the inventory, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted view on both: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** Two warehouses of Copenhagen Central and one of Harbor Commercial, by id; their names are `Warehouse <code>`. */
  let west: string
  let east: string
  let havnen: string
  let bin: ContainerType
  let residual: WasteFraction
  /** What is subscribed to in Copenhagen Central, open-ended. */
  let subscribed: Subscription
  /** A subscription that ends in October, so a placement of it has a bound to fall outside of. */
  let bounded: Subscription
  /** The other company's, in its own warehouse. */
  let theirContainer: Container

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: MODULE, actions: ["view", "create", "edit"] },
      { moduleKey: INVENTORY, actions: ["view"] },
    ])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [
      { moduleKey: MODULE, actions: ["view"] },
      { moduleKey: INVENTORY, actions: ["view"] },
    ])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    west = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-WEST")
    east = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-EAST")
    havnen = await warehouseIn(pool, a.companyId, a.projects.harbor.id, "WH-HAVNEN")

    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    const weekly = await create(olivia, "/service-frequencies", { projectId: a.projects.copenhagen.id, name: "Weekly", collectionsPerWeek: 1 }, ServiceFrequency)
    const customer = await create(olivia, "/customers", { kind: "organisation", name: "Acme Housing" }, Customer)
    const collection = await create(
      olivia,
      "/products",
      // Active, since a subscription needs an active product (routes/statuses.ts, Issue #79).
      { projectId: a.projects.copenhagen.id, name: "Residual collection", kind: "container-collection", unit: "pickup", serviceFrequencyId: weekly.id, status: "active" },
      Product,
    )
    const property = async (name: string) => create(olivia, "/properties", { projectId: a.projects.copenhagen.id, name, address: `${name}, 2100 København Ø`, kind: "residential" }, Property)
    const agreement = async (number: string) =>
      create(
        olivia,
        "/agreements",
        { projectId: a.projects.copenhagen.id, number, customerId: customer.id, payerCustomerId: customer.id, billingCadence: "monthly", currency: "DKK", validFrom: JANUARY },
        Agreement,
      )
    subscribed = await create(
      olivia,
      `/agreements/${(await agreement("AGR-5001")).id}/subscriptions`,
      { productId: collection.id, propertyId: (await property("Parkvej 18")).id, validFrom: JANUARY },
      Subscription,
    )
    bounded = await create(
      olivia,
      `/agreements/${(await agreement("AGR-5002")).id}/subscriptions`,
      { productId: collection.id, propertyId: (await property("Strandvej 7")).id, validFrom: JANUARY, validTo: OCTOBER },
      Subscription,
    )

    const theirBin = await create(other, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    theirContainer = await create(other, "/containers", { projectId: b.projects.copenhagen.id, label: "BIN-THEIRS", containerTypeId: theirBin.id }, Container)
    await create(other, `/containers/${theirContainer.id}/receive`, { warehouseId: await warehouseIn(pool, b.companyId, b.projects.copenhagen.id, "WH-THEIRS") }, StockMovement)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
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

  /** A container of this test's own, in Copenhagen Central unless it says otherwise. */
  const container = (label: string, values: Record<string, unknown> = {}) =>
    create(olivia, "/containers", { projectId: a.projects.copenhagen.id, label, containerTypeId: bin.id, ...values }, Container)

  /** The commands, each answering the movement it appended. */
  const command = (into: Container, verb: string, body: Record<string, unknown>, call: Call = olivia) =>
    create(call, `/containers/${into.id}/${verb}`, body, StockMovement)
  const receive = (into: Container, warehouseId: string, body: Record<string, unknown> = {}) => command(into, "receive", { warehouseId, ...body })
  const transfer = (into: Container, warehouseId: string, body: Record<string, unknown> = {}) => command(into, "transfer", { warehouseId, ...body })
  const giveBack = (into: Container, warehouseId: string, validTo: string, body: Record<string, unknown> = {}) =>
    command(into, "return", { warehouseId, validTo, ...body })
  const decommission = (into: Container, body: Record<string, unknown> = {}) => command(into, "decommission", { reason: "Crushed", ...body })
  const adjust = (into: Container, body: Record<string, unknown>) => command(into, "adjust", { reason: "The ledger was wrong", ...body })
  /** A container received into the west warehouse: the state most commands start from (stock-fixtures.ts). */
  const stocked = (label: string, values: Record<string, unknown> = {}, warehouseId = west): Promise<Container> =>
    stockedIn(olivia, { projectId: a.projects.copenhagen.id, label, containerTypeId: bin.id, ...values }, warehouseId)
  /** Issues the container into service under the open-ended subscription, from January unless said otherwise. */
  const place = (into: Container, values: Record<string, unknown> = {}) =>
    create(olivia, `/containers/${into.id}/placements`, { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY, ...values }, ContainerServicePlacement)
  /** A command refused: the status and the problem. */
  const refusedCommand = async (into: Container, verb: string, body: Record<string, unknown>, status: number, call: Call = olivia) =>
    refused(await call(`/containers/${into.id}/${verb}`, { method: "POST", body }), status)

  const one = async (id: string): Promise<Container> => {
    const response = await olivia(`/containers/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Container.parse(await response.json())
  }
  const onePlacement = async (id: string): Promise<ContainerServicePlacement> => {
    const response = await olivia(`/placements/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ContainerServicePlacement.parse(await response.json())
  }
  const movements = async (into: Container, call: Call = olivia, query = "?limit=200") => {
    const response = await call(`/containers/${into.id}/movements${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return MovementPage.parse(await response.json())
  }
  const ledger = async (query: string, call: Call = olivia) => {
    const response = await call(`/stock-movements${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return MovementPage.parse(await response.json())
  }
  const containers = async (query: string) => ContainerPage.parse(await (await olivia(`/containers${query}`)).json())
  const placements = async (query: string) => PlacementPage.parse(await (await olivia(`/placements${query}`)).json())

  /** The state the wire spells for a movement that just left the container somewhere. */
  const stateAfter = (movement: StockMovement, status: string) => ({
    status,
    warehouseId: movement.toWarehouseId,
    placementId: movement.placementId,
    since: movement.occurredAt,
    movementId: movement.id,
  })

  describe("POST /containers/:id/receive", () => {
    test("appends the first movement from a supplier, minted and stamped, and the reading follows it", async () => {
      const into = await container("BIN-5010")
      const before = Date.now()
      const received = await receive(into, west, { reference: "DN-2048" })
      assert.equal(Id.parse(received.id), received.id, "a version 7 id the server minted")
      assert.equal(received.projectId, into.projectId)
      assert.equal(received.containerId, into.id)
      assert.deepEqual(
        [received.kind, received.fromKind, received.fromWarehouseId, received.toKind, received.toWarehouseId, received.placementId],
        ["receipt", "supplier", null, "warehouse", west, null],
      )
      assert.equal(received.recordedBy, a.users.olivia.id, "on whose word")
      assert.deepEqual([received.reference, received.reason, received.correctsMovementId], ["DN-2048", null, null])
      assert.ok(Math.abs(Date.parse(received.occurredAt) - before) < 60_000, "absent, occurredAt is the request's clock")
      assert.ok(Date.parse(received.recordedAt) >= before - 60_000, "recordedAt is the database's")
      assert.deepEqual((await one(into.id)).assetState, stateAfter(received, "in-warehouse"))
      assert.deepEqual((await movements(into)).items, [received], "the ledger is the one row")

      const dated = await receive(await container("BIN-5011"), east, { occurredAt: "2026-09-01T06:30:00+02:00" })
      assert.equal(dated.occurredAt, "2026-09-01T04:30:00.000Z", "when it happened, on the caller's word, as an instant")
    })

    test("refuses a container that already has a record, naming its state", async () => {
      const stockedBin = await stocked("BIN-5012")
      const inStock = await refusedCommand(stockedBin, "receive", { warehouseId: east }, 409)
      assert.equal(inStock.detail, "Container BIN-5012 is already in stock (Warehouse WH-WEST)")
      await transfer(stockedBin, east, { toKind: "maintenance" })
      const inMaintenance = await refusedCommand(stockedBin, "receive", { warehouseId: east }, 409)
      assert.equal(inMaintenance.detail, "Container BIN-5012 is already in stock (Warehouse WH-EAST)", "maintenance is a place in stock, at a warehouse")

      const placed = await stocked("BIN-5013")
      await place(placed)
      assert.equal((await refusedCommand(placed, "receive", { warehouseId: west }, 409)).detail, "Container BIN-5013 is in service; return it first")

      const scrapped = await stocked("BIN-5014")
      await decommission(scrapped)
      assert.equal(
        (await refusedCommand(scrapped, "receive", { warehouseId: west }, 409)).detail,
        "Container BIN-5014 is retired; a scrapped container does not come back — register a new one",
      )
      assert.equal((await movements(scrapped)).items.length, 2, "no refusal wrote a row")
    })

    test("holds the warehouse to the container's project, dates nothing after the request, and answers 404 and 403 like every command", async () => {
      const into = await container("BIN-5015")
      const elsewhere = await refusedCommand(into, "receive", { warehouseId: havnen }, 400)
      assert.deepEqual(elsewhere.errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }])
      const nobody = await refusedCommand(into, "receive", { warehouseId: testId() }, 400)
      assert.deepEqual(nobody.errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }])
      const late = await refusedCommand(into, "receive", { warehouseId: west, occurredAt: FUTURE }, 400)
      assert.deepEqual(late.errors, [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }])
      const owned = await refusedCommand(into, "receive", { warehouseId: west, fromKind: "supplier" }, 400)
      assert.ok(owned.errors?.some((error) => /fromKind/.test(error.message)), JSON.stringify(owned.errors))
      assert.deepEqual((await movements(into)).items, [], "nothing refused was written")
      assert.equal((await one(into.id)).assetState, null)

      await refusedCommand(theirContainer, "receive", { warehouseId: west }, 404)
      const harbor = await container("BIN-5016", { projectId: a.projects.harbor.id })
      await refusedCommand(harbor, "receive", { warehouseId: havnen }, 404, viewer)
      assert.match((await refusedCommand(into, "receive", { warehouseId: west }, 403, lars)).detail ?? "", /create on resources\.containers/)
      assert.equal((await app.request(`/containers/${into.id}/receive`, { method: "POST" })).status, 401)
      assert.deepEqual((await refused(await olivia("/containers/not-a-uuid/receive", { method: "POST", body: { warehouseId: west } }), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("POST /containers/:id/placements, the issue command", () => {
    test("refuses a container with no record, in service elsewhere or retired, and issues one in stock or in maintenance", async () => {
      const unrecorded = await container("BIN-5020")
      const noRecord = await refused(await olivia(`/containers/${unrecorded.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY } }), 409)
      assert.equal(noRecord.detail, "Container BIN-5020 has no stock record; receive it first")
      assert.deepEqual((await placements(`?containerId=${unrecorded.id}`)).items, [], "no placement was written behind the refusal")

      const into = await stocked("BIN-5021")
      const placed = await place(into, { occurredAt: "2026-01-05T07:00:00Z", reference: "TICKET-77" })
      assert.deepEqual([placed.containerId, placed.validFrom, placed.validTo], [into.id, JANUARY, null])
      const [receipt, issue] = (await movements(into)).items
      assert.equal(receipt.kind, "receipt")
      assert.deepEqual(
        [issue.kind, issue.fromKind, issue.fromWarehouseId, issue.toKind, issue.toWarehouseId, issue.placementId, issue.occurredAt, issue.reference],
        ["issue", "warehouse", west, "service", null, placed.id, "2026-01-05T07:00:00.000Z", "TICKET-77"],
        "from the warehouse it stood in, into the placement just written; the body's instant and paper are the movement's",
      )
      assert.deepEqual((await one(into.id)).assetState, stateAfter(issue, "in-service"))

      const again = await refused(await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: NEXT_YEAR } }), 409)
      assert.equal(again.detail, "Container BIN-5021 is in service at another placement; return it first", "the state sentence, one door before the exclusion constraint")

      const scrapped = await stocked("BIN-5022")
      await decommission(scrapped)
      const retired = await refused(await olivia(`/containers/${scrapped.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY } }), 409)
      assert.equal(retired.detail, "Container BIN-5022 is retired")

      const repaired = await stocked("BIN-5023")
      await transfer(repaired, west, { toKind: "maintenance" })
      const fromTheWorkshop = await place(repaired)
      const issued = (await movements(repaired)).items.at(-1)
      assert.deepEqual([issued?.fromKind, issued?.fromWarehouseId, issued?.placementId], ["maintenance", west, fromTheWorkshop.id], "out of maintenance straight into service")
    })

    test("writes the placement and the movement in one transaction, or neither", async () => {
      const into = await stocked("BIN-5024")
      // The clock is held before the Registry half runs (round A), so no
      // placement is written for the refusal to roll back; the reading is
      // untouched either way.
      const late = await refused(
        await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY, occurredAt: FUTURE } }),
        400,
      )
      assert.deepEqual(late.errors, [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }])
      assert.deepEqual((await placements(`?containerId=${into.id}`)).items, [], "no placement")
      assert.deepEqual((await movements(into)).items.map((movement) => movement.kind), ["receipt"], "no movement")
      assert.equal((await one(into.id)).assetState?.status, "in-warehouse", "still where it was")

      // The other way round: a body that names nothing real is refused before
      // the ledger is consulted, so it too leaves nothing.
      const cadence = await refused(
        await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: subscribed.id, wasteFractionId: residual.id, serviceFrequencyId: testId(), validFrom: JANUARY } }),
        400,
      )
      assert.deepEqual(cadence.errors, [{ path: "serviceFrequencyId", message: "Not a service frequency of this project" }])
      assert.deepEqual((await movements(into)).items.map((movement) => movement.kind), ["receipt"])
    })

    test("serialises two issues on the container's lock — one 201, one 409 — and the exclusion constraint still answers behind the state", async () => {
      const into = await stocked("BIN-5025")
      const body = { subscriptionId: subscribed.id, wasteFractionId: residual.id, validFrom: JANUARY }
      const [first, second] = await Promise.all([
        olivia(`/containers/${into.id}/placements`, { method: "POST", body }),
        olivia(`/containers/${into.id}/placements`, { method: "POST", body }),
      ])
      const statuses = [first.status, second.status].sort()
      assert.deepEqual(statuses, [201, 409], `${await first.clone().text()} / ${await second.clone().text()}`)
      const lost = first.status === 409 ? first : second
      assert.equal((await readProblem(lost)).detail, "Container BIN-5025 is in service at another placement; return it first", "the second read the first's service under the lock")
      assert.deepEqual((await movements(into)).items.map((movement) => movement.kind), ["receipt", "issue"], "one issue, not two")
      assert.equal((await placements(`?containerId=${into.id}`)).items.length, 1)

      // Back in stock, a period over the placement it left is the
      // constraint's own refusal, in the Registry's sentence.
      await giveBack(into, west, APRIL)
      const overlapping = await refused(await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { ...body, validFrom: FEBRUARY } }), 409)
      assert.equal(overlapping.detail, "Container BIN-5025 is already placed over part of that period; end that placement first")
      assert.doesNotMatch(overlapping.detail ?? "", /no_overlap/)
      assert.deepEqual((await movements(into)).items.map((movement) => movement.kind), ["receipt", "issue", "return"], "the refused issue appended nothing")
      const next = await place(into, { validFrom: APRIL })
      assert.equal(next.validFrom, APRIL, "the day one placement ends is the day the next may begin")
    })
  })

  describe("POST /containers/:id/return", () => {
    test("ends the placement on validTo and appends the return into stock or into maintenance", async () => {
      const into = await stocked("BIN-5030")
      const placed = await place(into)
      const returned = await giveBack(into, east, APRIL, { reason: "Tenant moved out", reference: "TICKET-12" })
      assert.deepEqual(
        [returned.kind, returned.fromKind, returned.fromWarehouseId, returned.toKind, returned.toWarehouseId, returned.placementId, returned.reason, returned.reference],
        ["return", "service", null, "warehouse", east, placed.id, "Tenant moved out", "TICKET-12"],
      )
      const ended = await onePlacement(placed.id)
      assert.equal(ended.validTo, APRIL, "the placement ends on the day the body said")
      assert.ok(ended.updatedAt > placed.updatedAt)
      assert.deepEqual((await one(into.id)).assetState, stateAfter(returned, "in-warehouse"))

      const again = await place(into, { validFrom: APRIL })
      const toTheWorkshop = await giveBack(into, east, JULY, { toKind: "maintenance" })
      assert.deepEqual([toTheWorkshop.toKind, toTheWorkshop.toWarehouseId, toTheWorkshop.placementId], ["maintenance", east, again.id])
      assert.equal((await one(into.id)).assetState?.status, "in-maintenance")
      assert.equal((await onePlacement(again.id)).validTo, JULY)
    })

    test("refuses a container that is not in service, whatever else it is", async () => {
      const unrecorded = await container("BIN-5031")
      assert.equal((await refusedCommand(unrecorded, "return", { warehouseId: west, validTo: APRIL }, 409)).detail, "Container BIN-5031 is not in service")
      const inStock = await stocked("BIN-5032")
      assert.equal((await refusedCommand(inStock, "return", { warehouseId: west, validTo: APRIL }, 409)).detail, "Container BIN-5032 is not in service")
      await decommission(inStock)
      assert.equal((await refusedCommand(inStock, "return", { warehouseId: west, validTo: APRIL }, 409)).detail, "Container BIN-5032 is not in service")
      assert.deepEqual((await movements(inStock)).items.map((movement) => movement.kind), ["receipt", "decommission"])
    })

    test("holds validTo to the placement's start and the subscription's period, and leaves the placement open when refused", async () => {
      const into = await stocked("BIN-5033")
      // Placed open under a subscription that ends in October: the return's
      // `validTo` is what is held inside it.
      const placed = await place(into, { subscriptionId: bounded.id, validFrom: APRIL })
      const beyond = await refusedCommand(into, "return", { warehouseId: west, validTo: NEXT_YEAR }, 400)
      assert.deepEqual(beyond.errors, [{ path: "validTo", message: OUTSIDE_SUBSCRIPTION }])
      const backwards = await refusedCommand(into, "return", { warehouseId: west, validTo: JANUARY }, 400)
      assert.deepEqual(backwards.errors, [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])
      const elsewhere = await refusedCommand(into, "return", { warehouseId: havnen, validTo: JULY }, 400)
      assert.deepEqual(elsewhere.errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }])
      // The clock is held before the Registry half runs, so the placement is
      // never touched: it stays open, the container still in service.
      const late = await refusedCommand(into, "return", { warehouseId: west, validTo: JULY, occurredAt: FUTURE }, 400)
      assert.deepEqual(late.errors, [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }])
      assert.equal((await onePlacement(placed.id)).validTo, null, "still open: the clock refused before the placement was touched")
      assert.equal((await one(into.id)).assetState?.status, "in-service", "still in service")
      assert.deepEqual((await movements(into)).items.map((movement) => movement.kind), ["receipt", "issue"])

      const returned = await giveBack(into, west, JULY)
      assert.equal((await onePlacement(placed.id)).validTo, JULY, "the placement ends the day the container came back")
      assert.equal(returned.placementId, placed.id)
    })
  })

  describe("POST /containers/:id/transfer", () => {
    test("moves a container between warehouses and into and out of maintenance, refusing the place it already stands in", async () => {
      const into = await stocked("BIN-5040")
      const moved = await transfer(into, east, { reference: "Van run 3" })
      assert.deepEqual([moved.kind, moved.fromKind, moved.fromWarehouseId, moved.toKind, moved.toWarehouseId], ["transfer", "warehouse", west, "warehouse", east])
      assert.deepEqual((await one(into.id)).assetState, stateAfter(moved, "in-warehouse"))

      const there = await refusedCommand(into, "transfer", { warehouseId: east }, 400)
      assert.deepEqual(there.errors, [{ path: "warehouseId", message: ALREADY_THERE }])

      const workshop = await transfer(into, east, { toKind: "maintenance", reason: "Lid broken" })
      assert.deepEqual([workshop.fromKind, workshop.fromWarehouseId, workshop.toKind, workshop.toWarehouseId], ["warehouse", east, "maintenance", east], "the same yard, another kind of place")
      assert.deepEqual((await one(into.id)).assetState, stateAfter(workshop, "in-maintenance"))
      assert.deepEqual((await refusedCommand(into, "transfer", { warehouseId: east, toKind: "maintenance" }, 400)).errors, [{ path: "warehouseId", message: ALREADY_THERE }])

      const back = await transfer(into, east)
      assert.deepEqual([back.fromKind, back.toKind], ["maintenance", "warehouse"])
      assert.equal((await movements(into)).items.length, 4)
    })

    test("refuses a container with no record, in service or retired", async () => {
      const unrecorded = await container("BIN-5041")
      assert.equal((await refusedCommand(unrecorded, "transfer", { warehouseId: east }, 409)).detail, "Container BIN-5041 has no stock record; receive it first")
      const placed = await stocked("BIN-5042")
      await place(placed)
      assert.equal((await refusedCommand(placed, "transfer", { warehouseId: east }, 409)).detail, "Container BIN-5042 is in service; return it first")
      const scrapped = await stocked("BIN-5043")
      await decommission(scrapped)
      assert.equal((await refusedCommand(scrapped, "transfer", { warehouseId: east }, 409)).detail, "Container BIN-5043 is retired")
    })
  })

  describe("POST /containers/:id/decommission", () => {
    test("scraps a container in stock, and once retired refuses every command but an adjustment", async () => {
      const into = await stocked("BIN-5050")
      const scrapped = await decommission(into, { reason: "Crushed by the lift", reference: "TICKET-40" })
      assert.deepEqual(
        [scrapped.kind, scrapped.fromKind, scrapped.fromWarehouseId, scrapped.toKind, scrapped.toWarehouseId, scrapped.placementId, scrapped.reason],
        ["decommission", "warehouse", west, "scrap", null, null, "Crushed by the lift"],
      )
      assert.deepEqual((await one(into.id)).assetState, stateAfter(scrapped, "retired"))
      assert.equal((await refusedCommand(into, "decommission", { reason: "Again" }, 409)).detail, "Container BIN-5050 is already retired")
      assert.equal((await refusedCommand(into, "transfer", { warehouseId: east }, 409)).detail, "Container BIN-5050 is retired")
      assert.deepEqual((await refusedCommand(into, "decommission", {}, 400)).errors?.map((error) => error.path), ["reason"], "a reason is the contracts' rule")

      const found = await adjust(into, { toKind: "warehouse", warehouseId: east, reason: "It was the bin next to it", correctsMovementId: scrapped.id })
      assert.deepEqual([found.kind, found.fromKind, found.toKind, found.toWarehouseId, found.correctsMovementId], ["adjustment", "scrap", "warehouse", east, scrapped.id], "the correction door leaves scrap")
      assert.equal((await one(into.id)).assetState?.status, "in-warehouse")
    })

    test("in service requires validTo and ends the placement with the movement; out of service refuses it", async () => {
      const unrecorded = await container("BIN-5051")
      assert.equal((await refusedCommand(unrecorded, "decommission", { reason: "x" }, 409)).detail, "Container BIN-5051 has no stock record; receive it first")
      const inStock = await stocked("BIN-5052")
      const saysNothing = await refusedCommand(inStock, "decommission", { reason: "x", validTo: APRIL }, 400)
      assert.deepEqual(saysNothing.errors, [{ path: "validTo", message: VALID_TO_SAYS_NOTHING }])

      const placed = await place(inStock)
      const withoutAnEnd = await refusedCommand(inStock, "decommission", { reason: "x" }, 400)
      assert.deepEqual(withoutAnEnd.errors, [{ path: "validTo", message: GIVE_VALID_TO }])
      assert.equal((await onePlacement(placed.id)).validTo, null, "still open")
      const beyond = await refusedCommand(inStock, "decommission", { reason: "x", validTo: JANUARY }, 400)
      assert.deepEqual(beyond.errors, [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])

      const scrapped = await decommission(inStock, { validTo: APRIL, reason: "Burnt out on site" })
      assert.deepEqual([scrapped.fromKind, scrapped.fromWarehouseId, scrapped.toKind, scrapped.placementId], ["service", null, "scrap", placed.id])
      assert.equal((await onePlacement(placed.id)).validTo, APRIL, "the placement ended with it")
      assert.deepEqual((await one(inStock.id)).assetState, stateAfter(scrapped, "retired"))
    })
  })

  describe("POST /containers/:id/adjust", () => {
    test("repairs an unrecorded container into stock, corrects one of its own movements, and never touches service", async () => {
      const skipped = await container("BIN-5060")
      const repaired = await adjust(skipped, { toKind: "warehouse", warehouseId: west, reason: "Imported without its receipt" })
      assert.deepEqual([repaired.kind, repaired.fromKind, repaired.fromWarehouseId, repaired.toKind, repaired.toWarehouseId, repaired.correctsMovementId], ["adjustment", "supplier", null, "warehouse", west, null])
      assert.deepEqual((await one(skipped.id)).assetState, stateAfter(repaired, "in-warehouse"))

      const shelved = await adjust(skipped, { toKind: "maintenance", warehouseId: east, reason: "Booked to the wrong yard", correctsMovementId: repaired.id })
      assert.deepEqual([shelved.fromKind, shelved.fromWarehouseId, shelved.toKind, shelved.toWarehouseId, shelved.correctsMovementId], ["warehouse", west, "maintenance", east, repaired.id])

      const otherBin = await stocked("BIN-5061")
      const theirs = (await movements(otherBin)).items[0]
      const notMine = await refusedCommand(skipped, "adjust", { toKind: "warehouse", warehouseId: west, reason: "x", correctsMovementId: theirs.id }, 400)
      assert.deepEqual(notMine.errors, [{ path: "correctsMovementId", message: NOT_A_MOVEMENT_OF_THIS_CONTAINER }])
      const unminted = await refusedCommand(skipped, "adjust", { toKind: "warehouse", warehouseId: west, reason: "x", correctsMovementId: testId() }, 400)
      assert.deepEqual(unminted.errors, [{ path: "correctsMovementId", message: NOT_A_MOVEMENT_OF_THIS_CONTAINER }])

      const written = await adjust(skipped, { toKind: "scrap", reason: "Never came back from the workshop" })
      assert.deepEqual([written.fromKind, written.toKind, written.toWarehouseId], ["maintenance", "scrap", null])
      assert.equal((await one(skipped.id)).assetState?.status, "retired")

      await place(otherBin)
      const inService = await refusedCommand(otherBin, "adjust", { toKind: "warehouse", warehouseId: west, reason: "x" }, 409)
      assert.equal(inService.detail, "Container BIN-5061 is in service; return or decommission it, an adjustment does not touch a placement")
      assert.deepEqual((await refusedCommand(otherBin, "adjust", { toKind: "service", reason: "x" }, 400)).errors?.map((error) => error.path), ["toKind"], "refused at the schema, before any route")
      assert.match((await refusedCommand(otherBin, "adjust", { toKind: "warehouse", warehouseId: west, reason: "x" }, 403, lars)).detail ?? "", /edit on resources\.containers/)
    })
  })

  describe("GET /containers/:id/movements and GET /stock-movements", () => {
    test("answers one container's ledger oldest first, paged, and 404 outside the caller's projects", async () => {
      const into = await stocked("BIN-5070")
      await transfer(into, east)
      await transfer(into, west)
      const all = await movements(into)
      assert.deepEqual(all.items.map((movement) => movement.kind), ["receipt", "transfer", "transfer"])
      const ids = all.items.map((movement) => movement.id)
      assert.deepEqual(ids, [...ids].sort(), "recording order is id order")
      assert.equal(all.nextCursor, null)
      assert.equal((await one(into.id)).assetState?.movementId, ids[2], "the last item is the reading")

      const first = await movements(into, olivia, "?limit=2")
      assert.deepEqual(first.items.map((movement) => movement.id), ids.slice(0, 2))
      assert.ok(first.nextCursor)
      const rest = await movements(into, olivia, `?limit=2&cursor=${first.nextCursor}`)
      assert.deepEqual(rest.items.map((movement) => movement.id), ids.slice(2))
      assert.equal(rest.nextCursor, null)

      await refused(await olivia(`/containers/${theirContainer.id}/movements`), 404)
      assert.equal((await movements(theirContainer, other)).items.length, 1, "still there for its own company")
      const harbor = await stocked("BIN-5071", { projectId: a.projects.harbor.id }, havnen)
      await refused(await viewer(`/containers/${harbor.id}/movements`), 404)
      await refused(await lars(`/containers/${into.id}/movements`), 404)
      assert.equal((await app.request(`/containers/${into.id}/movements`)).status, 401)
      assert.deepEqual((await refused(await olivia(`/containers/${into.id}/movements?cursor=nope`), 400)).errors?.map((error) => error.path), ["cursor"])
    })

    test("answers the ledger across containers with its filters, inside the caller's projects", async () => {
      const yard = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-5072")
      const first = await stocked("BIN-5072", {}, yard)
      const second = await stocked("BIN-5073", {}, yard)
      const moved = await transfer(second, west, { occurredAt: "2026-03-01T10:00:00Z" })
      const harbor = await stocked("BIN-5074", { projectId: a.projects.harbor.id }, havnen)

      const byContainer = await ledger(`?limit=200&containerId=${second.id}`)
      assert.deepEqual(byContainer.items.map((movement) => movement.kind), ["receipt", "transfer"])
      for (const movement of byContainer.items) assert.equal(movement.containerId, second.id)

      const throughTheYard = await ledger(`?limit=200&warehouseId=${yard}`)
      assert.deepEqual(
        throughTheYard.items.map((movement) => [movement.containerId, movement.kind]),
        [[first.id, "receipt"], [second.id, "receipt"], [second.id, "transfer"]],
        "what arrived at the yard and what left it, oldest first",
      )
      const receipts = await ledger(`?limit=200&warehouseId=${yard}&kind=receipt`)
      assert.deepEqual(receipts.items.map((movement) => movement.containerId), [first.id, second.id])

      const inMarch = await ledger(`?limit=200&containerId=${second.id}&from=2026-03-01T00:00:00Z&to=2026-03-01T10:00:00Z`)
      assert.deepEqual(inMarch.items.map((movement) => movement.id), [moved.id], "both ends inclusive")
      assert.deepEqual((await ledger(`?limit=200&containerId=${second.id}&to=2026-02-01T00:00:00Z`)).items, [], "the receipt happened today")
      assert.deepEqual((await refused(await olivia("/stock-movements?from=2026-03-02T00:00:00Z&to=2026-03-01T00:00:00Z"), 400)).errors?.map((error) => error.path), ["to"])

      const byProject = await ledger(`?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((movement) => movement.containerId === harbor.id))
      for (const movement of byProject.items) assert.equal(movement.projectId, a.projects.harbor.id)
      const seen = await ledger("?limit=200", viewer)
      assert.ok(seen.items.some((movement) => movement.containerId === second.id))
      assert.equal(seen.items.some((movement) => movement.containerId === harbor.id), false, "Vera works in Copenhagen Central only")
      assert.deepEqual((await refused(await viewer(`/stock-movements?projectId=${a.projects.harbor.id}`), 400)).errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.deepEqual((await refused(await viewer(`/stock-movements?warehouseId=${havnen}`), 400)).errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }])
      assert.deepEqual((await refused(await olivia(`/stock-movements?projectId=${a.projects.copenhagen.id}&warehouseId=${havnen}`), 400)).errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }], "the project named bounds the warehouse")
      assert.deepEqual((await ledger("?limit=200", lars)).items, [], "an account that works in no project reads an empty page")
      assert.match((await refused(await ungranted("/stock-movements"), 403)).detail ?? "", /view on resources\.inventory/)
      assert.equal((await app.request("/stock-movements")).status, 401)
    })
  })

  describe("the order inside move, and the clock's skew (review round A)", () => {
    test("holds the clock before the Registry half: a return dated in the future is refused at occurredAt whatever its validTo says, and the placement is untouched", async () => {
      const into = await stocked("BIN-5100")
      const placed = await place(into, { subscriptionId: bounded.id, validFrom: APRIL })
      const late = await refusedCommand(into, "return", { warehouseId: west, validTo: NEXT_YEAR, occurredAt: FUTURE }, 400)
      assert.deepEqual(late.errors, [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }], "the clock, not the bound the Registry half would have refused")
      assert.equal((await onePlacement(placed.id)).validTo, null, "still open")
      assert.equal((await one(into.id)).assetState?.status, "in-service")
      // The state gate still comes first: a container that is not in service is refused as such before the clock is read.
      const unrecorded = await container("BIN-5101")
      assert.equal((await refusedCommand(unrecorded, "return", { warehouseId: west, validTo: APRIL, occurredAt: FUTURE }, 409)).detail, "Container BIN-5101 is not in service")
    })

    test("lets occurredAt run ahead of the request's clock by the skew a device's clock accounts for, and no further", async () => {
      const pinned = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => new Date(PINNED) })
      const oliviaThen = callingAs(pinned, keys, a.users.olivia, a.companyId)
      const atTheEdge = new Date(PINNED + OCCURRED_AT_SKEW_MS).toISOString()
      const received = await command(await container("BIN-5102"), "receive", { warehouseId: west, occurredAt: atTheEdge }, oliviaThen)
      assert.equal(received.occurredAt, atTheEdge, "five minutes ahead is a device's clock")
      const beyond = new Date(PINNED + OCCURRED_AT_SKEW_MS + 1_000).toISOString()
      const late = await refusedCommand(await container("BIN-5103"), "receive", { warehouseId: west, occurredAt: beyond }, 400, oliviaThen)
      assert.deepEqual(late.errors, [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }], "a second past the skew is recorded before it happened")
      assert.equal(OCCURRED_AT_SKEW_MS, 5 * 60_000, "the one constant")
    })
  })

  describe("the warehouse a movement arrives at takes stock (#79: a status gates a new reference, never an existing one)", () => {
    test("refuses a receipt, a transfer, a return and an adjustment into a closed or draft warehouse, naming the status, and takes a restricted one", async () => {
      const closed = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-CLOSED", "closed")
      const draft = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-DRAFT", "draft")
      const restricted = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-RESTRICTED", "restricted")

      const into = await container("BIN-5110")
      assert.equal((await refusedCommand(into, "receive", { warehouseId: closed }, 409)).detail, takesNoStock("Warehouse WH-CLOSED", "closed"))
      assert.equal((await refusedCommand(into, "receive", { warehouseId: closed }, 409)).detail, "Warehouse WH-CLOSED is closed; a movement arrives only at an active or restricted warehouse")
      assert.equal((await refusedCommand(into, "receive", { warehouseId: draft }, 409)).detail, "Warehouse WH-DRAFT is draft; a movement arrives only at an active or restricted warehouse")
      assert.equal((await one(into.id)).assetState, null, "nothing was written")
      assert.equal((await receive(into, restricted)).toWarehouseId, restricted, "restricted takes stock")

      assert.equal((await refusedCommand(into, "transfer", { warehouseId: closed }, 409)).detail, takesNoStock("Warehouse WH-CLOSED", "closed"))
      assert.equal((await refusedCommand(into, "transfer", { warehouseId: draft, toKind: "maintenance" }, 409)).detail, takesNoStock("Warehouse WH-DRAFT", "draft"), "maintenance at a draft warehouse is still into it")
      assert.equal((await refusedCommand(into, "adjust", { toKind: "warehouse", warehouseId: closed, reason: "x" }, 409)).detail, takesNoStock("Warehouse WH-CLOSED", "closed"))
      const placed = await place(into)
      assert.equal((await refusedCommand(into, "return", { warehouseId: closed, validTo: APRIL }, 409)).detail, takesNoStock("Warehouse WH-CLOSED", "closed"))
      assert.equal((await onePlacement(placed.id)).validTo, null, "the placement was not ended behind the refusal")
      assert.deepEqual((await movements(into)).items.map((movement) => movement.kind), ["receipt", "issue"])

      // Existence before status: a closed warehouse of another project is not this project's warehouse at all.
      const theirClosed = await warehouseIn(pool, a.companyId, a.projects.harbor.id, "WH-HAVN-CLOSED", "closed")
      assert.deepEqual((await refusedCommand(into, "return", { warehouseId: theirClosed, validTo: APRIL }, 400)).errors, [{ path: "warehouseId", message: "Not a warehouse of this project" }])
    })

    test("leaves what stands in a warehouse standing when it closes: the projection reads it, a transfer out is the way to empty it, and only a new arrival is refused", async () => {
      const yard = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-5111")
      const standing = await stocked("BIN-5111", {}, yard)
      const closing = await olivia(`/warehouses/${yard}`, { method: "PATCH", body: { status: "closed" } })
      assert.equal(closing.status, 200, JSON.stringify(await closing.clone().json()))

      assert.equal((await one(standing.id)).assetState?.warehouseId, yard, "the reading still says it stands there")
      assert.deepEqual((await containers(`?warehouseId=${yard}`)).items.map((item) => item.id), [standing.id], "and the list still finds it")
      assert.equal((await refusedCommand(await container("BIN-5112"), "receive", { warehouseId: yard }, 409)).detail, takesNoStock("Warehouse WH-5111", "closed"))
      const out = await transfer(standing, west)
      assert.deepEqual([out.fromWarehouseId, out.toWarehouseId], [yard, west], "out of the closed warehouse is a movement into an open one")
      assert.deepEqual((await containers(`?warehouseId=${yard}`)).items, [], "emptied")
    })
  })

  describe("a placement that already ended under a container the ledger has in service (a row from before the ledger, or an import)", () => {
    test("is a 409 naming the day on a return and on a decommission, after the body's own 400s, and nothing is written", async () => {
      const into = await stocked("BIN-5120")
      const placementId = testId()
      // The Registry says the placement ended in April; the ledger's issue
      // row says the container is still in service at it. Both written
      // through `tx` as `wms_api`, the way an import would, since no command
      // produces the pair: a create carries no end and the patch sets none on
      // an open placement.
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.insert(containerServicePlacement).values({
          id: placementId,
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          containerId: into.id,
          subscriptionId: subscribed.id,
          wasteFractionId: residual.id,
          validFrom: JANUARY,
          validTo: APRIL,
        })
        await tx.insert(stockMovement).values({
          id: testId(),
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          containerId: into.id,
          kind: "issue",
          fromKind: "warehouse",
          fromWarehouseId: west,
          toKind: "service",
          placementId,
          occurredAt: new Date("2026-01-05T07:00:00Z"),
          recordedBy: a.users.olivia.id,
        })
      })
      assert.equal((await one(into.id)).assetState?.status, "in-service", "the ledger reads the import's issue")

      // The body's 400s come first, as on every route: an end on or before the start is refused at validTo before the ledger's disagreement is.
      const backwards = await refusedCommand(into, "return", { warehouseId: west, validTo: JANUARY }, 400)
      assert.deepEqual(backwards.errors, [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }], "the body's 400 before the state's 409")
      assert.deepEqual((await refusedCommand(into, "decommission", { reason: "Crushed", validTo: JANUARY }, 400)).errors, [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])

      const returned = await refusedCommand(into, "return", { warehouseId: west, validTo: JULY }, 409)
      assert.equal(returned.detail, placementAlreadyEnded("BIN-5120", APRIL))
      assert.equal(returned.detail, "Container BIN-5120's placement already ended on 2026-04-01; the ledger disagrees", "a 409 like every other state a command is refused by, not a 500")
      const scrapped = await refusedCommand(into, "decommission", { reason: "Crushed", validTo: JULY }, 409)
      assert.equal(scrapped.detail, placementAlreadyEnded("BIN-5120", APRIL))
      assert.equal((await onePlacement(placementId)).validTo, APRIL, "the Registry's end stands")
      assert.deepEqual((await movements(into)).items.map((movement) => movement.kind), ["receipt", "issue"], "nothing appended")
      assert.equal((await one(into.id)).assetState?.status, "in-service", "and the ledger's reading stands")
    })
  })

  describe("the reading after the commands", () => {
    test("GET /containers answers assetState, assetStatus and warehouseId from what the commands wrote", async () => {
      const yard = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-5080")
      const shed = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-5081")
      const into = await stocked("BIN-5080", {}, yard)
      assert.deepEqual((await containers(`?warehouseId=${yard}`)).items.map((item) => item.id), [into.id])
      await transfer(into, shed)
      assert.deepEqual((await containers(`?warehouseId=${yard}`)).items, [], "it left")
      assert.deepEqual((await containers(`?warehouseId=${shed}`)).items.map((item) => item.id), [into.id])
      await transfer(into, shed, { toKind: "maintenance" })
      assert.deepEqual((await containers(`?warehouseId=${shed}`)).items.map((item) => item.id), [into.id], "in maintenance is still standing in the warehouse")
      assert.deepEqual((await containers(`?warehouseId=${shed}&assetStatus=in-maintenance`)).items.map((item) => item.id), [into.id])
      assert.deepEqual((await containers(`?warehouseId=${shed}&assetStatus=in-warehouse`)).items, [])
      const scrapped = await decommission(into)
      assert.deepEqual((await containers(`?warehouseId=${shed}`)).items, [], "scrap stands nowhere")
      const retired = await containers("?limit=200&assetStatus=retired")
      assert.deepEqual(retired.items.find((item) => item.id === into.id)?.assetState, stateAfter(scrapped, "retired"))
    })
  })

  describe("the ledger is append-only", () => {
    test("wms_api can neither delete nor update a movement: 42501", async () => {
      const into = await stocked("BIN-5090")
      const [receipt] = (await movements(into)).items
      await assert.rejects(
        withCompany(pool.db, a.companyId, (tx) => tx.delete(stockMovement).where(eq(stockMovement.id, receipt.id))),
        (error: unknown) => sqlstate(error) === "42501",
      )
      await assert.rejects(
        withCompany(pool.db, a.companyId, (tx) => tx.update(stockMovement).set({ reason: "rewritten" }).where(eq(stockMovement.id, receipt.id))),
        (error: unknown) => sqlstate(error) === "42501",
      )
      assert.deepEqual((await movements(into)).items, [receipt], "the row stands as it was appended")
    })
  })
})

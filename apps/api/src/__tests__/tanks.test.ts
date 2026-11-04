// The tank register (M11 of #293): a Property's tanks, each the Container
// that stands for it in the plan, read with its last emptying — its
// container's latest completed stop and the litres recorded there — and the
// day the next falls due, its interval after the last one; and the office's
// inspections, a ledger under the tank.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product, WasteFraction } from "@waste/contracts/catalogue"
import { ContainerServicePlacement, type Container } from "@waste/contracts/containers"
import { Customer, Property } from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import { TankInspection, TankInstallation } from "@waste/contracts/tanks"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { INSPECTED_BY_TODAY, notPlacedAt, standsForAnotherTank } from "../routes/tanks"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { stocked, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the stock movements a stocked container writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** The request's clock: 20 November 2026, noon. */
const NOON = new Date("2026-11-20T12:00:00Z")

describe("the tank register (M11 of #293)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fleet: FleetFixtures
  let fx: ExecutionFixtures
  let olivia: Call
  /** `view` on the properties and nothing more: reads the register, writes nothing of it. */
  let viewer: Call
  let copenhagen: string
  let residual: WasteFraction
  let tankType: ContainerType
  let emptying: Product
  let warehouse: string
  let householder: Customer

  type Schema<T> = { parse: (value: unknown) => T }
  async function make<T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> {
    return created(call, path, await call(path, { method: "POST", body: values }), schema)
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    fx = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.properties", actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    residual = await make(olivia, "/waste-fractions", { key: "sludge-tanks", name: "Sludge (tanks)" }, WasteFraction)
    tankType = await make(olivia, "/container-types", { name: "Septic tank (tanks)", volumeLitres: 3000 }, ContainerType)
    emptying = await make(olivia, "/products", { projectId: copenhagen, name: "Tank emptying (tanks)", kind: "container-collection", unit: "pickup", status: "active" }, Product)
    warehouse = await warehouseIn(pool, a.companyId, copenhagen, "WH-TANK")
    householder = await make(olivia, "/customers", { kind: "person", name: "Karen Septic" }, Customer)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  /** A property, an agreement for it, and a container placed there from January: what a tank is registered on. */
  const placed = async (name: string): Promise<{ property: Property; container: Container }> => {
    const property = await make(olivia, "/properties", { projectId: copenhagen, name, address: `${name}, 4000 Roskilde`, kind: "residential" }, Property)
    const agreement = await make(olivia, "/agreements", { projectId: copenhagen, number: `T-${name}`, customerId: householder.id, payerCustomerId: householder.id, status: "active", billingCadence: "annual", currency: "DKK", validFrom: "2026-01-01" }, Agreement)
    const subscription = await make(olivia, `/agreements/${agreement.id}/subscriptions`, { productId: emptying.id, propertyId: property.id, validFrom: "2026-01-01" }, Subscription)
    const container = await stocked(olivia, { projectId: copenhagen, label: `TANK-${name.replace(/\W/g, "")}`, containerTypeId: tankType.id }, warehouse)
    await make(olivia, `/containers/${container.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: residual.id, validFrom: "2026-01-01" }, ContainerServicePlacement)
    return { property, container }
  }

  const tankBody = (property: Property, container: Container, values: Record<string, unknown> = {}) => ({
    propertyId: property.id,
    containerId: container.id,
    kind: "septic-tank",
    volumeLitres: 3000,
    outlet: "soakaway",
    emptyingIntervalMonths: 12,
    validFrom: "2026-01-01",
    ...values,
  })

  const tankAt = async (id: string): Promise<TankInstallation> => {
    const response = await olivia(`/tank-installations/${id}`)
    assert.equal(response.status, 200)
    return TankInstallation.parse(await response.json())
  }

  test("a tank is registered on its container at its Property, and reads its next emptying due its interval after the last one; one never emptied is due now", async () => {
    const { property, container } = await placed("Skovvej 3")
    const tank = await make(olivia, "/tank-installations", tankBody(property, container, { lastEmptiedOn: "2025-12-01", notes: "Lid behind the shed" }), TankInstallation)
    assert.equal(tank.projectId, copenhagen)
    assert.equal(tank.lastEmptying, null)
    assert.equal(tank.dueOn, "2026-12-01", "a year after the register's last emptying")
    assert.deepEqual(await tankAt(tank.id), tank)

    const never = await placed("Skovvej 5")
    const fresh = await make(olivia, "/tank-installations", tankBody(never.property, never.container, { kind: "holding-tank", outlet: "none" }), TankInstallation)
    assert.equal(fresh.dueOn, null, "never emptied: due now")

    const listed = Page(TankInstallation).parse(await (await olivia(`/tank-installations?propertyId=${property.id}&validOn=2026-06-01`)).json())
    assert.deepEqual(listed.items.map((item) => item.id), [tank.id])
    assert.deepEqual(Page(TankInstallation).parse(await (await olivia(`/tank-installations?propertyId=${property.id}&validOn=2025-06-01`)).json()).items, [], "not in force before its first day")
  })

  test("a completed stop at its container is its last emptying, with the litres the driver recorded, and moves the due date on from it", async () => {
    const { property, container } = await placed("Skovvej 7")
    const tank = await make(olivia, "/tank-installations", tankBody(property, container, { lastEmptiedOn: "2025-12-01", emptyingIntervalMonths: 24 }), TankInstallation)
    const route = await seedRoute(pool, a, fleet, fx, {
      status: "completed",
      operatingDate: "2026-10-05",
      pickups: [{ containerId: container.id, propertyId: property.id, status: "completed", arrivedAt: new Date("2026-10-05T06:40:00+02:00"), outcomeAt: new Date("2026-10-05T06:55:00+02:00") }],
      proofs: [{ kind: "volume", pickupIndex: 0, occurredAt: new Date("2026-10-05T06:50:00+02:00"), volumeLitres: 2_800 }],
    })
    const read = await tankAt(tank.id)
    assert.deepEqual(read.lastEmptying, { on: "2026-10-05", pickupId: route.pickupIds[0], volumeLitres: 2_800 })
    assert.equal(read.dueOn, "2028-10-05", "two years after the stop, read before the register's older day")

    const shorter = await olivia(`/tank-installations/${tank.id}`, { method: "PATCH", body: { emptyingIntervalMonths: 12 } })
    assert.equal(shorter.status, 200)
    assert.equal(TankInstallation.parse(await shorter.json()).dueOn, "2027-10-05", "a shorter interval brings it forward")
  })

  test("refuses a Property or a Container it cannot use, a container not placed at the Property on the tank's first day, and a second tank on a container over the same days", async () => {
    const { property, container } = await placed("Skovvej 9")
    const refused = async (body: unknown) => {
      const response = await olivia("/tank-installations", { method: "POST", body })
      return { status: response.status, problem: await readProblem(response) }
    }
    const nowhere = await refused(tankBody(property, container, { propertyId: fx.properties.harbor.id }))
    assert.equal(nowhere.status, 400)
    assert.deepEqual(nowhere.problem.errors?.map((error) => error.path), ["containerId"], "a container of Copenhagen, not of the harbour's project")

    const otherWarehouse = await warehouseIn(pool, a.companyId, a.projects.harbor.id, "WH-TANK-H")
    const harbourBin = await stocked(olivia, { projectId: a.projects.harbor.id, label: "TANK-HARBOUR", containerTypeId: tankType.id }, otherWarehouse)
    const elsewhere = await refused(tankBody(property, harbourBin))
    assert.equal(elsewhere.status, 400)
    assert.deepEqual(elsewhere.problem.errors?.map((error) => error.path), ["containerId"])

    const early = await refused(tankBody(property, container, { validFrom: "2025-06-01" }))
    assert.equal(early.status, 409)
    assert.equal(early.problem.detail, notPlacedAt(container.label, "Skovvej 9", "2025-06-01"))

    const elsewhereProperty = await placed("Skovvej 11")
    const wrongPlace = await refused(tankBody(property, elsewhereProperty.container))
    assert.equal(wrongPlace.status, 409, "its placement serves another Property")

    await make(olivia, "/tank-installations", tankBody(property, container, { validTo: "2026-07-01" }), TankInstallation)
    const twice = await refused(tankBody(property, container, { validFrom: "2026-06-01" }))
    assert.equal(twice.status, 409)
    assert.equal(twice.problem.detail, standsForAnotherTank(container.label))
    await make(olivia, "/tank-installations", tankBody(property, container, { validFrom: "2026-07-01", kind: "small-treatment-plant", outlet: "sand-filter" }), TankInstallation)
  })

  test("a patch changes the facts and the end, never the first day; an end on or before it is a 400 at validTo", async () => {
    const { property, container } = await placed("Skovvej 13")
    const tank = await make(olivia, "/tank-installations", tankBody(property, container), TankInstallation)
    const backwards = await olivia(`/tank-installations/${tank.id}`, { method: "PATCH", body: { validTo: "2026-01-01" } })
    assert.equal(backwards.status, 400)
    assert.deepEqual((await readProblem(backwards)).errors, [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])
    assert.equal((await olivia(`/tank-installations/${tank.id}`, { method: "PATCH", body: {} })).status, 400)
    assert.equal((await olivia(`/tank-installations/${tank.id}`, { method: "PATCH", body: { validFrom: "2026-02-01" } })).status, 400)
    const ended = await olivia(`/tank-installations/${tank.id}`, { method: "PATCH", body: { validTo: "2026-12-01", volumeLitres: 4000, notes: null } })
    assert.equal(ended.status, 200)
    const body = TankInstallation.parse(await ended.json())
    assert.equal(body.validTo, "2026-12-01")
    assert.equal(body.volumeLitres, 4000)
    assert.equal((await olivia(`/tank-installations/${property.id}`)).status, 404, "a property's id names no tank")
  })

  test("an inspection is appended under the tank by the caller, dated today or before, and listed oldest first", async () => {
    const { property, container } = await placed("Skovvej 15")
    const tank = await make(olivia, "/tank-installations", tankBody(property, container), TankInstallation)
    const recorded = await olivia(`/tank-installations/${tank.id}/inspections`, { method: "POST", body: { inspectedOn: "2026-11-20", outcome: "remarks", findings: "Baffle cracked", nextInspectionOn: "2027-11-20" } })
    assert.equal(recorded.status, 201)
    const inspection = TankInspection.parse(await recorded.json())
    assert.equal(inspection.recordedBy, a.users.olivia.id)
    assert.equal(inspection.tankInstallationId, tank.id)
    const tomorrow = await olivia(`/tank-installations/${tank.id}/inspections`, { method: "POST", body: { inspectedOn: "2026-11-21", outcome: "approved" } })
    assert.equal(tomorrow.status, 400)
    assert.deepEqual((await readProblem(tomorrow)).errors, [{ path: "inspectedOn", message: INSPECTED_BY_TODAY }])
    const listed = Page(TankInspection).parse(await (await olivia(`/tank-installations/${tank.id}/inspections`)).json())
    assert.deepEqual(listed.items, [inspection])
    assert.equal((await olivia(`/tank-installations/${property.id}/inspections`, { method: "POST", body: { inspectedOn: "2026-11-20", outcome: "approved" } })).status, 404)
  })

  test("view on the properties reads the register; every write wants edit", async () => {
    const { property, container } = await placed("Skovvej 17")
    const tank = await make(olivia, "/tank-installations", tankBody(property, container), TankInstallation)
    assert.equal((await viewer(`/tank-installations/${tank.id}`)).status, 200)
    assert.equal((await viewer(`/tank-installations/${tank.id}/inspections`)).status, 200)
    assert.equal((await viewer("/tank-installations", { method: "POST", body: tankBody(property, container, { validFrom: "2027-01-01" }) })).status, 403)
    assert.equal((await viewer(`/tank-installations/${tank.id}`, { method: "PATCH", body: { notes: "x" } })).status, 403)
    assert.equal((await viewer(`/tank-installations/${tank.id}/inspections`, { method: "POST", body: { inspectedOn: "2026-11-20", outcome: "approved" } })).status, 403)
  })
})

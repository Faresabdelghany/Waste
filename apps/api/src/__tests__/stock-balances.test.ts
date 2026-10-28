import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType } from "@waste/contracts/catalogue"
import { EACH_TYPE_ONCE, StockBalances, StockMinimums, StockMovement } from "@waste/contracts/stock"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { stocked, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the receipts this suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()

describe("a warehouse's stock balances and minimums (O30 of #290, row 9.8)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  /** The custom role, granted view on the inventory and the warehouses and nothing more, with Project Access to Copenhagen Central only. */
  let viewer: Call
  let other: Call

  let west: string
  let havnen: string
  let theirs: string
  let bin: ContainerType
  let bigBin: ContainerType
  let theirType: ContainerType

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const ok = async <T>(response: Response, schema: Schema<T>): Promise<T> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return readProblem(response)
  }
  const balances = async (call: Call, query: string) => (await ok(await call(`/stock-balances?${query}`), StockBalances)).items
  const putMinimums = (call: Call, warehouseId: string, minimums: unknown) => call(`/warehouses/${warehouseId}/stock-minimums`, { method: "PUT", body: { minimums } })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "resources.inventory", actions: ["view"] },
      { moduleKey: "resources.warehouses", actions: ["view"] },
    ])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)

    west = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-WEST")
    havnen = await warehouseIn(pool, a.companyId, a.projects.harbor.id, "WH-HAVNEN")
    theirs = await warehouseIn(pool, b.companyId, b.projects.copenhagen.id, "WH-THEIRS")
    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    bigBin = await create(olivia, "/container-types", { name: "660 L bin", volumeLitres: 660 }, ContainerType)
    theirType = await create(other, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)

    // West: three 240 L bins in stock, one of them then taken into maintenance there; Havnen: one 240 L bin.
    const copenhagen = (label: string) => ({ projectId: a.projects.copenhagen.id, label, containerTypeId: bin.id })
    await stocked(olivia, copenhagen("BIN-1"), west)
    await stocked(olivia, copenhagen("BIN-2"), west)
    const repaired = await stocked(olivia, copenhagen("BIN-3"), west)
    await create(olivia, `/containers/${repaired.id}/transfer`, { warehouseId: west, toKind: "maintenance" }, StockMovement)
    await stocked(olivia, { projectId: a.projects.harbor.id, label: "HBIN-1", containerTypeId: bin.id }, havnen)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  test("counts what stands in each warehouse by type, in stock and in maintenance, with no minimum until one is set", async () => {
    assert.deepEqual(await balances(olivia, `warehouseId=${west}`), [
      { projectId: a.projects.copenhagen.id, warehouseId: west, containerTypeId: bin.id, inWarehouse: 2, inMaintenance: 1, minimum: null, belowMinimum: false },
    ])
    const all = await balances(olivia, "")
    assert.deepEqual(all.map((row) => [row.warehouseId, row.inWarehouse]).sort(), [[havnen, 1], [west, 2]].sort())
    assert.deepEqual((await balances(olivia, `projectId=${a.projects.harbor.id}`)).map((row) => row.warehouseId), [havnen])
  })

  test("a minimum set reads against the stock: below it where fewer stand in stock, maintenance not counting; a type with none in stock reads zero", async () => {
    const set = await ok(await putMinimums(olivia, west, [{ containerTypeId: bin.id, minimum: 3 }, { containerTypeId: bigBin.id, minimum: 1 }]), StockMinimums)
    assert.deepEqual(set, { warehouseId: west, minimums: [{ containerTypeId: bin.id, minimum: 3 }, { containerTypeId: bigBin.id, minimum: 1 }] })
    assert.deepEqual(await ok(await olivia(`/warehouses/${west}/stock-minimums`), StockMinimums), set)
    const read = await balances(olivia, `warehouseId=${west}`)
    assert.deepEqual(
      read.map((row) => [row.containerTypeId, row.inWarehouse, row.minimum, row.belowMinimum]).sort(),
      [[bin.id, 2, 3, true], [bigBin.id, 0, 1, true]].sort(),
    )

    const met = await ok(await putMinimums(olivia, west, [{ containerTypeId: bin.id, minimum: 2 }]), StockMinimums)
    assert.deepEqual(met.minimums, [{ containerTypeId: bin.id, minimum: 2 }], "the set is replaced whole: the 660 L minimum is gone")
    assert.deepEqual((await balances(olivia, `warehouseId=${west}`)).map((row) => [row.containerTypeId, row.belowMinimum]), [[bin.id, false]], "at the minimum is not below it, and a type with neither stock nor a minimum is not listed")

    assert.deepEqual((await ok(await putMinimums(olivia, west, []), StockMinimums)).minimums, [], "an empty set clears them")
  })

  test("refuses a type twice, a type of another company at its entry, a zero, and a member the body does not carry", async () => {
    const twice = await refused(await putMinimums(olivia, west, [{ containerTypeId: bin.id, minimum: 1 }, { containerTypeId: bin.id, minimum: 2 }]), 400)
    assert.deepEqual(twice.errors, [{ path: "minimums", message: EACH_TYPE_ONCE }])
    const theirsType = await refused(await putMinimums(olivia, west, [{ containerTypeId: bin.id, minimum: 1 }, { containerTypeId: theirType.id, minimum: 1 }]), 400)
    assert.deepEqual(theirsType.errors, [{ path: "minimums.1.containerTypeId", message: "Not a container type of this company" }])
    await refused(await putMinimums(olivia, west, [{ containerTypeId: bin.id, minimum: 0 }]), 400)
    await refused(await olivia(`/warehouses/${west}/stock-minimums`, { method: "PUT", body: { minimums: [], warehouseId: west } }), 400)
    assert.deepEqual((await ok(await olivia(`/warehouses/${west}/stock-minimums`), StockMinimums)).minimums, [], "a refused body writes nothing")
  })

  test("answers 404 for another company's warehouse and for one outside the caller's projects, 400 for such a filter, and 403 without the grant", async () => {
    await refused(await putMinimums(olivia, theirs, []), 404)
    await refused(await olivia(`/warehouses/${testId()}/stock-minimums`), 404)
    await refused(await viewer(`/warehouses/${havnen}/stock-minimums`), 404)
    await refused(await viewer(`/stock-balances?warehouseId=${havnen}`), 400)
    assert.deepEqual((await balances(viewer, "")).map((row) => row.warehouseId), [west], "the viewer reads Copenhagen Central alone")
    assert.match((await refused(await putMinimums(viewer, west, []), 403)).detail ?? "", /edit on resources\.warehouses/)
    assert.deepEqual(await balances(other, ""), [], "the other company sees its own warehouse only, which holds nothing")
  })
})

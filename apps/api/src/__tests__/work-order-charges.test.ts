// A project's work order charges through the API (M14 of #293): read and
// replaced whole as the ticket charges are — a service once, each product the
// project's, sold by the job, offered when it is new or changed — and each
// row written audited as a set of its project. Skipped with the reason when
// `DATABASE_URL` or `DATABASE_ADMIN_URL` is unset, failed under
// `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { SERVICE_PRICED_ONCE, WorkOrderCharges } from "@waste/contracts/work-order-charges"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { withCompany } from "@waste/db/tenant"
import { and, eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { workOrdersChargedAt } from "../routes/products"
import { NOT_A_PRODUCT } from "../routes/references"
import { unofferedProduct } from "../routes/statuses"
import { A_JOB_IS_SOLD_BY_THE_JOB } from "../routes/work-order-charges"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

describe("a project's work order charges (M14 of #293)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fx: BillingFixtures
  let olivia: Call
  let copenhagen: string
  /** A wash sold by the job, beside the fixtures' bulky pickup. */
  const wash = testId()

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    const ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.insert(product).values({ id: wash, companyId: a.companyId, projectId: copenhagen, name: "Bin wash", kind: "additional-service", status: "active", unit: "job", vatPercent: 25 }))
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const read = async (): Promise<WorkOrderCharges> => {
    const response = await olivia(`/work-order-charges?projectId=${copenhagen}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return WorkOrderCharges.parse(await response.json())
  }
  const put = (charges: { service: string; productId: string }[], projectId = copenhagen) => olivia("/work-order-charges", { method: "PUT", body: { projectId, charges } })
  const replaced = async (charges: { service: string; productId: string }[]): Promise<WorkOrderCharges> => {
    const response = await put(charges)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return WorkOrderCharges.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const retire = (id: string, status: "active" | "inactive") => withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(product).set({ status }).where(and(eq(product.companyId, a.companyId), eq(product.id, id))))

  test("are read and replaced whole: a service once, each product the project's and sold by the job, offered when new or changed — an entry restated as it stands is no new reference", async () => {
    assert.deepEqual(await read(), { projectId: copenhagen, charges: [] })
    const set = await replaced([
      { service: "wash", productId: wash },
      { service: "deliver", productId: fx.products.bulky.id },
    ])
    assert.deepEqual(set.charges, [{ service: "deliver", productId: fx.products.bulky.id }, { service: "wash", productId: wash }], "in the services' order")
    assert.deepEqual(await read(), set)

    assert.deepEqual((await refused(await put([{ service: "repair", productId: fx.products.residual.id }]), 400)).errors, [{ path: "charges.0.productId", message: A_JOB_IS_SOLD_BY_THE_JOB }], "a product sold by the pickup")
    assert.deepEqual((await refused(await put([{ service: "repair", productId: wash }, { service: "swap", productId: fx.products.harborBulky.id }]), 400)).errors, [{ path: "charges.1.productId", message: NOT_A_PRODUCT }], "Harbor's product")
    assert.deepEqual((await refused(await put([{ service: "wash", productId: wash }, { service: "wash", productId: fx.products.bulky.id }]), 400)).errors, [{ path: "charges", message: SERVICE_PRICED_ONCE }])
    assert.equal((await refused(await put([{ service: "empty", productId: wash }]), 400)).errors?.[0]?.path, "charges.0.service", "an emptying is no work order")
    assert.deepEqual((await refused(await put([], b.projects.copenhagen.id), 400)).errors, [{ path: "projectId", message: "Not a project this account works in" }])
    assert.deepEqual(await read(), set, "every refusal wrote nothing")

    // The wash retired since: restated as it stands it is no new reference, and a move onto it would be.
    await retire(wash, "inactive")
    try {
      const restated = await replaced([
        { service: "wash", productId: wash },
        { service: "remove", productId: fx.products.bulky.id },
      ])
      assert.deepEqual(restated.charges, [{ service: "remove", productId: fx.products.bulky.id }, { service: "wash", productId: wash }], "deliver left out, remove added")
      assert.equal((await refused(await put([{ service: "remove", productId: wash }]), 409)).detail, unofferedProduct("inactive"), "moved onto the retired product")
    } finally {
      await retire(wash, "active")
    }
    assert.deepEqual((await replaced([])).charges, [], "an empty set charges no work order")
  })

  test("a product a work order is charged at stays sold by the job: a patch moving it off the job is refused, and taken once no work order names it", async () => {
    await replaced([{ service: "wash", productId: wash }])
    const moved = await olivia(`/products/${wash}`, { method: "PATCH", body: { unit: "pickup" } })
    assert.equal((await refused(moved, 409)).detail, workOrdersChargedAt(1))
    await replaced([])
    const taken = await olivia(`/products/${wash}`, { method: "PATCH", body: { unit: "pickup" } })
    assert.equal(taken.status, 200, JSON.stringify(await taken.clone().json()))
    assert.equal((await olivia(`/products/${wash}`, { method: "PATCH", body: { unit: "job" } })).status, 200)
  })

  test("each row written is audited under the products' module, a set of its project", async () => {
    await replaced([{ service: "repair", productId: wash }])
    const [row] = await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx.execute<{ table_name: string; parent_table: string | null; parent_id: string | null; action: string }>(
        sql`select table_name, parent_table, parent_id, action from wms.audit_event where company_id = ${a.companyId} and table_name = 'work_order_product' order by recorded_at desc limit 1`,
      ),
    )
    assert.deepEqual(row, { table_name: "work_order_product", parent_table: "project", parent_id: copenhagen, action: "insert" })
  })
})

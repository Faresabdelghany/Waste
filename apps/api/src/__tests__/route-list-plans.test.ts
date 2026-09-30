// `GET /routes` carries each route's active Plan beside it (#173, on #132
// §5's rule that every per-route reading comes off `activePlan` alone): the
// planning map drawn over the list reads Not measured, Measuring…,
// Waiting…, the totals, failed or Stale for each route of the page without
// a second request or a join to the quota — the reading the route's own
// detail and the live list carry. The reorder writes the manual Plan here,
// so the measurement queue is made the way plans.test.ts makes it, and
// nobody works it.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { RouteDetail, RouteListItem } from "@waste/contracts/routes"
import { createDb, type Database } from "@waste/db/client"
import { ROUTING_MEASURE_QUEUE } from "@waste/db/commands/plans"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { FakeProvider } from "@waste/routing/fake"
import { sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const RoutePage = Page(RouteListItem)

describe("GET /routes: each route with its active Plan's reading (#173)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let boss: PgBoss
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 2 })
    boss = new PgBoss({ connectionString: owner.url, schema: PGBOSS_SCHEMA, migrate: false, supervise: false, schedule: false })
    await boss.start()
    await boss.createQueue(ROUTING_MEASURE_QUEUE, { policy: "exclusive" })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    olivia = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, routing: new FakeProvider() }), keys, a.users.olivia, a.companyId)
  })
  after(async () => {
    if (ownerPool && a) await ownerPool.db.execute(sql`delete from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${ROUTING_MEASURE_QUEUE} and data ->> 'companyId' = ${a.companyId}`)
    await boss?.stop({ graceful: false, close: true })
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await ownerPool?.close()
    await pool?.close()
  })

  test("a route without a Plan lists null; a reordered one lists its manual Plan, calculating, exactly as its own read carries it", async () => {
    const unmeasured = await seedRoute(pool, a, fleet, ex, {})
    const reordered = await seedRoute(pool, a, fleet, ex, {})
    const reorder = await olivia(`/routes/${reordered.id}/pickup-order`, { method: "PUT", body: { pickupIds: [...reordered.pickupIds].reverse() } })
    assert.equal(reorder.status, 200, JSON.stringify(await reorder.clone().json()))
    const detail = RouteDetail.parse(await (await olivia(`/routes/${reordered.id}`)).json())
    assert.equal(detail.activePlan?.status, "calculating")

    const response = await olivia(`/routes?routeSchemeId=${reordered.routeSchemeId}&limit=200`)
    assert.equal(response.status, 200)
    const listed = new Map(RoutePage.parse(await response.json()).items.map((item) => [item.id, item]))
    assert.equal(listed.get(unmeasured.id)?.activePlan, null)
    assert.deepEqual(listed.get(reordered.id)?.activePlan, detail.activePlan)
  })
})

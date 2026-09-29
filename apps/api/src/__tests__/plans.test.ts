// The Plan endpoints and the reorder that becomes one (#170, decided on #124
// and #132): the dispatcher's order written as a `manual` Plan — active from
// creation, `calculating`, its measurement queued under the fingerprint
// singleton, `pickup.position` never rewritten — and the route's read
// ordering by `sequence`, the active Plan's word; `POST /routes/:id/optimise`
// queuing an `optimiser` Plan that activates only on `ready` (#124 §2), two
// identical requests one Plan and one job, a `ready` match re-activated
// without a call; `GET /routes/:id/plans` the history and `GET /plans/:id`
// the legs. The queues are the worker's to create when it starts; here, as in
// generation.test.ts, a pg-boss instance on the owner's connection creates
// them and reads what the API sent, and nobody works them, so what was sent
// stays sent.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { Plan, PlanDetail } from "@waste/contracts/plans"
import { RouteDetail } from "@waste/contracts/routes"
import { createDb, type Database } from "@waste/db/client"
import { ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { FakeProvider } from "@waste/routing/fake"
import { eq, sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const MODULE = "route-studio.routes"
const PlanPage = Page(Plan)

describe("the Plan endpoints and the manual reorder", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let boss: PgBoss
  const bossErrors: unknown[] = []
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let other: Call
  /** Company b's custom role, granted nothing on this module: the 403s. */
  let ungranted: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 2 })
    boss = new PgBoss({ connectionString: owner.url, schema: PGBOSS_SCHEMA, migrate: false, supervise: false, schedule: false })
    boss.on("error", (error) => void bossErrors.push(error))
    await boss.start()
    await boss.createQueue(ROUTING_MEASURE_QUEUE, { policy: "exclusive" })
    await boss.createQueue(ROUTING_OPTIMISE_QUEUE, { policy: "exclusive" })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    // The fixtures put every property at the town hall; the fingerprint keys coordinates, so the three stops get places of their own here.
    await ownerPool.db.execute(sql`update wms.property set location = extensions.st_geomfromgeojson('{"type":"Point","coordinates":[12.575,55.68]}') where id = ${ex.properties.havnegade.id}`)
    await ownerPool.db.execute(sql`update wms.property set location = extensions.st_geomfromgeojson('{"type":"Point","coordinates":[12.61,55.71]}') where id = ${ex.properties.norrebrogade.id}`)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "edit"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, routing: new FakeProvider() })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  })
  after(async () => {
    // Jobs first: nobody works these queues here, and a job names its company only in its data.
    if (ownerPool) {
      for (const companyId of [a?.companyId, b?.companyId]) {
        if (companyId === undefined) continue
        await ownerPool.db.execute(
          sql`delete from ${sql.raw(PGBOSS_SCHEMA)}.job where name in (${ROUTING_MEASURE_QUEUE}, ${ROUTING_OPTIMISE_QUEUE}) and data ->> 'companyId' = ${companyId}`,
        )
      }
    }
    await boss?.stop({ graceful: false, close: true })
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await ownerPool?.close()
    await pool?.close()
    assert.deepEqual(bossErrors, [])
  })

  const detailOf = async (routeId: string): Promise<RouteDetail> => {
    const response = await olivia(`/routes/${routeId}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }
  const plansOf = async (routeId: string) => {
    const response = await olivia(`/routes/${routeId}/plans`)
    assert.equal(response.status, 200)
    return PlanPage.parse(await response.json())
  }
  const jobsFor = async (queue: string, planId: string) => {
    const rows = await ownerPool.db.execute<{ data: RoutingJobData; singleton_key: string | null }>(
      sql`select data, singleton_key from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${queue} and data ->> 'planId' = ${planId}`,
    )
    return rows
  }

  test("the reorder becomes a manual Plan: active and calculating, the sequence the body's, the baseline positions untouched, one measurement queued under the fingerprint", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const before = await detailOf(seeded.id)
    assert.equal(before.activePlan, null)
    assert.deepEqual(before.pickups.map((stop) => stop.sequence), [1, 2, 3], "the baseline order stands unmeasured")
    const reversed = [...seeded.pickupIds].reverse()
    const response = await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: reversed } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const detail = RouteDetail.parse(await response.json())
    assert.deepEqual(detail.pickups.map((stop) => stop.id), reversed, "the read orders by the Plan's sequence")
    assert.deepEqual(detail.pickups.map((stop) => stop.sequence), [1, 2, 3])
    assert.deepEqual(
      [...detail.pickups].sort((x, y) => x.position - y.position).map((stop) => stop.id),
      seeded.pickupIds,
      "pickup.position stays the generated baseline (#124: the clobber is retired)",
    )
    assert.ok(detail.activePlan, "a manual Plan is active from creation")
    assert.equal(detail.activePlan?.solver, "manual")
    assert.equal(detail.activePlan?.status, "calculating")
    assert.equal(detail.activePlan?.stale, false)
    const plans = await plansOf(seeded.id)
    assert.equal(plans.items.length, 1)
    const jobs = await jobsFor(ROUTING_MEASURE_QUEUE, plans.items[0].id)
    assert.equal(jobs.length, 1, "one measurement waits on the queue")
    assert.equal(jobs[0].data.companyId, a.companyId)
    assert.ok(jobs[0].singleton_key, "keyed by the Plan's id")
  })

  test("the same order twice is one Plan and one job; a second, different order is a second Plan, and the first stays as history", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const reversed = [...seeded.pickupIds].reverse()
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: reversed } })).status, 200)
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: reversed } })).status, 200)
    assert.equal((await plansOf(seeded.id)).items.length, 1, "an identical order still measuring is answered, not duplicated")
    const swapped = [seeded.pickupIds[1], seeded.pickupIds[0], seeded.pickupIds[2]]
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: swapped } })).status, 200)
    const plans = await plansOf(seeded.id)
    assert.equal(plans.items.length, 2, "a re-order is a new Plan; the previous row stays")
    const detail = await detailOf(seeded.id)
    assert.deepEqual(detail.pickups.map((stop) => stop.id), swapped)
  })

  test("optimise queues an optimiser Plan that is not yet active, 202; a second click answers the same Plan, 200, and one job waits", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const first = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()))
    const created = Plan.parse(await first.json())
    assert.equal(created.solver, "optimiser")
    assert.equal(created.status, "calculating")
    const detail = await detailOf(seeded.id)
    assert.equal(detail.activePlan, null, "an optimiser Plan activates atomically on ready (#124 §2), not before")
    const second = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(second.status, 200)
    assert.equal(Plan.parse(await second.json()).id, created.id)
    assert.equal((await jobsFor(ROUTING_OPTIMISE_QUEUE, created.id)).length, 1, "two clicks are one job")
  })

  test("a ready Plan of the same fingerprint is re-activated without a job, and the read follows its stops", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const first = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(first.status, 202)
    const created = Plan.parse(await first.json())
    // The solver's part, by hand, the way S3's worker will write it: the stops in its order, the totals, ready.
    const solved = [seeded.pickupIds[2], seeded.pickupIds[0], seeded.pickupIds[1]]
    await ownerPool.db.insert(planStop).values(
      solved.map((pickupId, index) => ({ companyId: a.companyId, projectId: created.projectId, routeId: seeded.id, planId: created.id, pickupId, position: index + 1 })),
    )
    await ownerPool.db.update(plan).set({ status: "ready", distanceMetres: 12_400, durationSeconds: 3_600 }).where(eq(plan.id, created.id))
    const again = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(again.status, 200, "the cache answers; no provider call, no new Plan")
    assert.equal(Plan.parse(await again.json()).id, created.id)
    const detail = await detailOf(seeded.id)
    assert.equal(detail.activePlan?.id, created.id, "re-activated")
    assert.equal(detail.activePlan?.status, "ready")
    assert.equal(detail.activePlan?.stale, false)
    assert.deepEqual(detail.pickups.map((stop) => stop.id), solved, "the read orders by the solved sequence")
    assert.equal((await plansOf(seeded.id)).items.length, 1)
  })

  test("GET /plans/:id answers the legs in driving order; another company reads a 404 and an ungranted role a 403", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: [...seeded.pickupIds].reverse() } })).status, 200)
    const [made] = (await plansOf(seeded.id)).items
    await ownerPool.db.insert(planLeg).values([
      { companyId: a.companyId, projectId: made.projectId, routeId: seeded.id, planId: made.id, position: 2, path: { type: "LineString", coordinates: [[12.58, 55.69], [12.6, 55.71]] }, metres: 1_800, seconds: 180 },
      { companyId: a.companyId, projectId: made.projectId, routeId: seeded.id, planId: made.id, position: 1, path: { type: "LineString", coordinates: [[12.55, 55.67], [12.58, 55.69]] }, metres: 2_600, seconds: 260 },
    ])
    const response = await olivia(`/plans/${made.id}`)
    assert.equal(response.status, 200)
    const detail = PlanDetail.parse(await response.json())
    assert.deepEqual(detail.legs.map((leg) => leg.position), [1, 2], "driving order, whatever order they were written in")
    assert.deepEqual(detail.legs[0].path.coordinates[0], [12.55, 55.67])
    assert.equal((await other(`/plans/${made.id}`)).status, 404)
    assert.equal((await ungranted(`/plans/${made.id}`)).status, 403)
    assert.equal((await other(`/routes/${seeded.id}/plans`)).status, 404)
    assert.equal((await other(`/routes/${seeded.id}/optimise`, { method: "POST" })).status, 404)
  })

  test("a started route refuses both doors, and a route with nothing open has nothing to order", async () => {
    const active = await seedRoute(pool, a, fleet, ex, { status: "active" })
    const frozen = await olivia(`/routes/${active.id}/optimise`, { method: "POST" })
    assert.equal(frozen.status, 409)
    assert.match((await readProblem(frozen)).detail ?? "", /its order is frozen/)
    const empty = await seedRoute(pool, a, fleet, ex, { pickups: [] })
    const nothing = await olivia(`/routes/${empty.id}/optimise`, { method: "POST" })
    assert.equal(nothing.status, 409)
    assert.match((await readProblem(nothing)).detail ?? "", /no open pickups to order/)
  })

  test("two routes over the same stops each keep their own job: a shared fingerprint never swallows the second send", async () => {
    const one = await seedRoute(pool, a, fleet, ex, {})
    const two = await seedRoute(pool, a, fleet, ex, {})
    assert.equal((await olivia(`/routes/${one.id}/pickup-order`, { method: "PUT", body: { pickupIds: [...one.pickupIds].reverse() } })).status, 200)
    assert.equal((await olivia(`/routes/${two.id}/pickup-order`, { method: "PUT", body: { pickupIds: [...two.pickupIds].reverse() } })).status, 200)
    const [planOne] = (await plansOf(one.id)).items
    const [planTwo] = (await plansOf(two.id)).items
    assert.equal((await jobsFor(ROUTING_MEASURE_QUEUE, planOne.id)).length, 1, "the first route's measurement waits")
    assert.equal((await jobsFor(ROUTING_MEASURE_QUEUE, planTwo.id)).length, 1, "and the second route's too: same coordinates, two Plans, two jobs")
  })

  test("re-submitting an earlier order while it still measures re-activates its Plan, and re-sends its job if pg-boss no longer holds one", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const orderA = [...seeded.pickupIds].reverse()
    const orderB = [seeded.pickupIds[1], seeded.pickupIds[0], seeded.pickupIds[2]]
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: orderA } })).status, 200)
    const [planA] = (await plansOf(seeded.id)).items
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: orderB } })).status, 200)
    // pg-boss loses A's job (retries exhausted and archived, say): the re-submit below must notice and re-send.
    await ownerPool.db.execute(sql`delete from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${ROUTING_MEASURE_QUEUE} and data ->> 'planId' = ${planA.id}`)
    const again = await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: orderA } })
    assert.equal(again.status, 200)
    const detail = RouteDetail.parse(await again.json())
    assert.equal(detail.activePlan?.id, planA.id, "the dispatcher's order is applied, not merely accepted")
    assert.deepEqual(detail.pickups.map((stop) => stop.id), orderA)
    assert.equal((await plansOf(seeded.id)).items.length, 2, "no third Plan: the calculating match is reused")
    assert.equal((await jobsFor(ROUTING_MEASURE_QUEUE, planA.id)).length, 1, "its lost job is sent again")
  })

  test("a ready Plan whose stops regeneration replaced is not replayed: same coordinates, new pickup ids, a new Plan", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const reversed = [...seeded.pickupIds].reverse()
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: reversed } })).status, 200)
    const [made] = (await plansOf(seeded.id)).items
    await ownerPool.db.insert(planStop).values(reversed.map((pickupId, index) => ({ companyId: a.companyId, projectId: made.projectId, routeId: seeded.id, planId: made.id, pickupId, position: index + 1 }))).onConflictDoNothing()
    await ownerPool.db.update(plan).set({ status: "ready", distanceMetres: 9_000, durationSeconds: 900 }).where(eq(plan.id, made.id))
    // Regeneration's shape, by hand: the old stops skipped with its reason, three new bins picked up at the same three properties.
    const replacements: string[] = []
    for (const [index, oldId] of seeded.pickupIds.entries()) {
      const binId = testId()
      const newId = testId()
      await ownerPool.db.execute(
        sql`insert into wms.container (id, company_id, project_id, label, container_type_id, ownership)
            select ${binId}, ${a.companyId}, p.project_id, ${`BIN-R${index}`}, c.container_type_id, 'company'
            from wms.pickup p join wms.container c on c.id = p.container_id where p.id = ${oldId}`,
      )
      await ownerPool.db.execute(
        sql`insert into wms.pickup (id, company_id, project_id, route_id, container_id, position, status, property_id, waste_fraction_id)
            select ${newId}, ${a.companyId}, p.project_id, ${seeded.id}, ${binId}, p.position + 3, 'planned', p.property_id, p.waste_fraction_id
            from wms.pickup p where p.id = ${oldId}`,
      )
      await ownerPool.db.execute(sql`update wms.pickup set status = 'skipped', reason = 'regeneration', outcome_at = now() where id = ${oldId}`)
      replacements.push(newId)
    }
    const order = [...replacements].reverse()
    const response = await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: order } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const detail = RouteDetail.parse(await response.json())
    assert.notEqual(detail.activePlan?.id, made.id, "the old Plan's stops are dead ids; replaying it would answer the baseline while claiming the order")
    assert.equal(detail.activePlan?.status, "calculating")
    assert.deepEqual(detail.pickups.slice(0, 3).map((stop) => stop.id), order, "the submitted order holds")
  })

  test("a stop the Plan does not name reads stale and appends in baseline order; the sequence never loses a stop", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const reversed = [...seeded.pickupIds].reverse()
    assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: reversed } })).status, 200)
    const [made] = (await plansOf(seeded.id)).items
    // A refresh inserts a stop under the active Plan (#124 §2): here, by hand, a fourth pickup at a fourth bin the Plan does not name.
    const insertedId = testId()
    const spareBinId = testId()
    const [templatePickup] = await ownerPool.db.execute<{ container_id: string; property_id: string | null; waste_fraction_id: string; project_id: string }>(
      sql`select container_id, property_id, waste_fraction_id, project_id from wms.pickup where id = ${seeded.pickupIds[0]}`,
    )
    await ownerPool.db.execute(
      sql`insert into wms.container (id, company_id, project_id, label, container_type_id, ownership)
          select ${spareBinId}, ${a.companyId}, ${templatePickup.project_id}, 'BIN-SPARE', c.container_type_id, 'company'
          from wms.container c where c.id = ${templatePickup.container_id}`,
    )
    await ownerPool.db.execute(
      sql`insert into wms.pickup (id, company_id, project_id, route_id, container_id, position, status, property_id, waste_fraction_id)
          values (${insertedId}, ${a.companyId}, ${templatePickup.project_id}, ${seeded.id}, ${spareBinId}, 4, 'planned', ${templatePickup.property_id}, ${templatePickup.waste_fraction_id})`,
    )
    const detail = await detailOf(seeded.id)
    assert.equal(detail.activePlan?.id, made.id, "the Plan stays active")
    assert.equal(detail.activePlan?.stale, true, "and reads stale")
    assert.deepEqual(detail.pickups.map((stop) => stop.id), [...reversed, insertedId], "the stops it does not name append in baseline order")
    assert.deepEqual(detail.pickups.map((stop) => stop.sequence), [1, 2, 3, 4])
  })
})

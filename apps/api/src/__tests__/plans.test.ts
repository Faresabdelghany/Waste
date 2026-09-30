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
import { OptimiseAnswer, Plan, PlanDetail } from "@waste/contracts/plans"
import { RoutingQuota } from "@waste/contracts/routing-quota"
import { RouteDetail } from "@waste/contracts/routes"
import { createDb, type Database } from "@waste/db/client"
import { activateSolved, ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { plan, planLeg, planStop, routingQuota } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
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
/** What an interactive routing job is sent at: ahead of every batch job (@waste/domain/routing/jobs). */
const INTERACTIVE_PRIORITY = 2_000_000

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
    const rows = await ownerPool.db.execute<{ data: RoutingJobData; singleton_key: string | null; priority: number }>(
      sql`select data, singleton_key, priority from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${queue} and data ->> 'planId' = ${planId}`,
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
    assert.equal(jobs[0].singleton_key, plans.items[0].id, "keyed by the Plan's id")
    assert.equal(jobs[0].data.class, "interactive", "a dispatcher waits on it (#132 §1)")
    assert.equal(jobs[0].priority, INTERACTIVE_PRIORITY, "ahead of every batch job")
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
    const seeded = await seedRoute(pool, a, fleet, ex, { depotId: fleet.depots.nordhavn.id })
    const first = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(first.status, 202, JSON.stringify(await first.clone().json()))
    const created = OptimiseAnswer.parse(await first.json())
    assert.equal(created.solver, "optimiser")
    assert.equal(created.status, "calculating")
    assert.equal(created.fallback, null, "the optimiser took it")
    const [job] = await jobsFor(ROUTING_OPTIMISE_QUEUE, created.id)
    assert.deepEqual([job.data.class, job.priority], ["interactive", INTERACTIVE_PRIORITY])
    const detail = await detailOf(seeded.id)
    assert.equal(detail.activePlan, null, "an optimiser Plan activates atomically on ready (#124 §2), not before")
    const second = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(second.status, 200)
    assert.equal(Plan.parse(await second.json()).id, created.id)
    assert.equal((await jobsFor(ROUTING_OPTIMISE_QUEUE, created.id)).length, 1, "two clicks are one job")
  })

  test("a ready Plan of the same fingerprint is re-activated without a job, and the read follows its stops", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, { depotId: fleet.depots.nordhavn.id })
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

  test("a route that names no depot is measured as a baseline instead, and the answer says why: no-depot", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, {})
    const response = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()))
    const answered = OptimiseAnswer.parse(await response.json())
    assert.deepEqual([answered.solver, answered.status, answered.fallback], ["baseline", "calculating", "no-depot"])
    assert.equal((await detailOf(seeded.id)).activePlan?.id, answered.id, "a baseline is active from creation (#124 §2)")
    assert.equal((await jobsFor(ROUTING_MEASURE_QUEUE, answered.id)).length, 1, "measured, on the measurement queue")
    const again = OptimiseAnswer.parse(await (await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })).json())
    assert.deepEqual([again.id, again.fallback], [answered.id, "no-depot"], "the same request answers the same Plan and the same reason")
  })

  test("the optimiser's fingerprint keys the route's depot, which orders its stops: another depot is another Plan", async () => {
    const seeded = await seedRoute(pool, a, fleet, ex, { depotId: fleet.depots.nordhavn.id })
    const first = OptimiseAnswer.parse(await (await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })).json())
    // A second depot of the route's own project, elsewhere in the city: the route moves to it.
    const elsewhere = testId()
    await ownerPool.db.execute(
      sql`insert into wms.depot (id, company_id, project_id, code, name, address, location, ownership, status)
          select ${elsewhere}, company_id, project_id, 'DEP-SYD', 'Sydhavn depot', 'Sydhavnsgade 1', extensions.st_geomfromgeojson('{"type":"Point","coordinates":[12.5467,55.6508]}'), ownership, status
          from wms.depot where id = ${fleet.depots.nordhavn.id}`,
    )
    await ownerPool.db.execute(sql`update wms.route set depot_id = ${elsewhere} where id = ${seeded.id}`)
    const moved = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
    assert.equal(moved.status, 202, "a new request, not the first answered again")
    assert.notEqual(OptimiseAnswer.parse(await moved.json()).id, first.id)
  })

  describe("a later order wins over a waiting optimisation (#171, amending #124 §2)", () => {
    const planRow = async (id: string) => (await ownerPool.db.select().from(plan).where(eq(plan.id, id)))[0]
    /** A Plan's result written by hand, the worker's part: the stops in its order, the totals, ready. */
    const solve = async (made: { id: string; projectId: string; routeId: string }, order: readonly string[]) => {
      await ownerPool.db
        .insert(planStop)
        .values(order.map((pickupId, index) => ({ companyId: a.companyId, projectId: made.projectId, routeId: made.routeId, planId: made.id, pickupId, position: index + 1 })))
        .onConflictDoNothing()
      await ownerPool.db.update(plan).set({ status: "ready", distanceMetres: 9_000, durationSeconds: 900, deferredUntil: null }).where(eq(plan.id, made.id))
    }

    test("an earlier order re-activated from the cache supersedes the optimisation still waiting on the route, at once", async () => {
      const seeded = await seedRoute(pool, a, fleet, ex, { depotId: fleet.depots.nordhavn.id })
      const reversed = [...seeded.pickupIds].reverse()
      assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: reversed } })).status, 200)
      const [manual] = (await plansOf(seeded.id)).items
      await solve(manual, reversed)
      const waiting = OptimiseAnswer.parse(await (await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })).json())
      assert.equal(waiting.solver, "optimiser")
      // The dispatcher goes back to the order they had: the cache re-activates it without a new Plan, and without a newer id.
      assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: reversed } })).status, 200)
      assert.equal((await detailOf(seeded.id)).activePlan?.id, manual.id)
      const superseded = await planRow(waiting.id)
      assert.deepEqual([superseded.status, superseded.failureReason, superseded.deferredUntil], ["failed", "superseded", null], "its answer would override the later order; it never will")
    })

    test("a fresh Optimise after the route moved on is a new request, not the superseded one answered again", async () => {
      const seeded = await seedRoute(pool, a, fleet, ex, { depotId: fleet.depots.nordhavn.id })
      const first = OptimiseAnswer.parse(await (await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })).json())
      assert.equal((await olivia(`/routes/${seeded.id}/pickup-order`, { method: "PUT", body: { pickupIds: [...seeded.pickupIds].reverse() } })).status, 200)
      assert.equal((await planRow(first.id)).failureReason, "superseded")
      const again = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
      assert.equal(again.status, 202, "a failed match is retried with a new Plan")
      const fresh = OptimiseAnswer.parse(await again.json())
      assert.notEqual(fresh.id, first.id)
      assert.equal((await jobsFor(ROUTING_OPTIMISE_QUEUE, fresh.id)).length, 1)
    })

    test("a waiting optimisation the optimiser's own newer answer has passed is failed by it, so the same request again is a new Plan", async () => {
      const seeded = await seedRoute(pool, a, fleet, ex, { depotId: fleet.depots.nordhavn.id })
      const older = OptimiseAnswer.parse(await (await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })).json())
      // The stops move, a second request answers and becomes active as the worker would make it, and the stops move back.
      const [moved] = await ownerPool.db.execute<{ location: string }>(sql`select extensions.st_asgeojson(location) as location from wms.property where id = ${ex.properties.havnegade.id}`)
      await ownerPool.db.execute(sql`update wms.property set location = extensions.st_geomfromgeojson('{"type":"Point","coordinates":[12.59,55.69]}') where id = ${ex.properties.havnegade.id}`)
      try {
        const newer = OptimiseAnswer.parse(await (await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })).json())
        assert.notEqual(newer.id, older.id, "another request, another fingerprint")
        await solve(newer, seeded.pickupIds)
        // Made active as the worker makes an answer active.
        await withCompany(pool.db, a.companyId, (tx) => activateSolved(tx, { companyId: a.companyId, routeId: seeded.id, planId: newer.id }))
      } finally {
        await ownerPool.db.execute(sql`update wms.property set location = extensions.st_geomfromgeojson(${moved.location}) where id = ${ex.properties.havnegade.id}`)
      }
      assert.equal((await planRow(older.id)).failureReason, "superseded")
      const again = await olivia(`/routes/${seeded.id}/optimise`, { method: "POST" })
      assert.equal(again.status, 202, "a failed match is retried with a new Plan")
      assert.notEqual(OptimiseAnswer.parse(await again.json()).id, older.id)
    })
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

  describe("GET /routing/quota (#132 §5)", () => {
    test("answers the provider and the caller's company's rows in the vocabulary's order; another company reads its own, and none before its first call", async () => {
      await withCompany(pool.db, a.companyId, (tx) =>
        tx.insert(routingQuota).values([
          { companyId: a.companyId, provider: "fake", family: "optimisation", remaining: 0, limit: 500, resetAt: new Date("2026-10-01T03:00:00.000Z"), exhaustedAt: new Date("2026-10-01T01:12:00.000Z") },
          { companyId: a.companyId, provider: "fake", family: "directions", remaining: 1_480, limit: 2_000, resetAt: new Date("2026-10-01T03:00:00.000Z") },
          { companyId: a.companyId, provider: "openrouteservice", family: "directions", remaining: 12, limit: 2_000 },
        ]),
      )
      const response = await olivia("/routing/quota")
      assert.equal(response.status, 200)
      const quota = RoutingQuota.parse(await response.json())
      assert.equal(quota.provider, "fake", "the provider this deployment routes with; another provider's rows are not its readings")
      assert.deepEqual(
        quota.families.map((family) => [family.family, family.remaining, family.limit, family.exhaustedAt, family.keyRefusedAt]),
        [
          ["directions", 1_480, 2_000, null, null],
          ["optimisation", 0, 500, "2026-10-01T01:12:00.000Z", null],
        ],
      )
      assert.deepEqual(RoutingQuota.parse(await (await other("/routing/quota")).json()), { provider: "fake", families: [] })
    })

    test("is route-studio.routes view: a role without it reads a 403", async () => {
      assert.equal((await ungranted("/routing/quota")).status, 403)
    })
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

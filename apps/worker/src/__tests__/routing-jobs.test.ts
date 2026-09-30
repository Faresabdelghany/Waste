// Routing's two jobs under the quota engine (#171, over #132 §4 and §7): the
// measurement and the optimiser, each against the fake's scripted states on
// a database of this file's own — real pg-boss queues made with the jobs'
// options, a job sent the way a sender sends it and fetched the way the
// worker's poll takes it, then handed to the handler — so a deferral's
// hand-over, a key refusal's disposition and the company's quota row are
// read back from the tables themselves. The engine runs on a pinned clock
// with half a minute of jitter; no test dials a provider. The last block
// runs the worker's own loop, for what only pg-boss's settlement shows.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE, routingSendOptions, type RoutingJobData } from "@waste/db/commands/plans"
import { migrateDatabase } from "@waste/db/migrate"
import { property } from "@waste/db/schema/customers"
import { route } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop, routingQuota } from "@waste/db/schema/routing"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { withCompany } from "@waste/db/tenant"
import { planFingerprint } from "@waste/domain/routing/fingerprint"
import { SUPERSEDED } from "@waste/domain/routing/vocabulary"
import { FakeProvider, type FakeScript } from "@waste/routing/fake"
import type { OptimiseRequest, RoutingProvider } from "@waste/routing/provider"
import { KEY_REFUSED, QuotaEngine, RoutingRetryable, STANDARD_PLAN } from "@waste/routing/quota"
import { asc, eq } from "drizzle-orm"
import type { Job, PgBoss } from "pg-boss"

import { createBoss } from "../boss"
import type { JobContext } from "../jobs/definition"
import { routingMeasure } from "../jobs/routing-measure"
import { routingOptimise } from "../jobs/routing-optimise"
import { FIXTURE_DAY, seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { rolesUnderTest, withDatabaseName } from "./database"
import { until } from "./until"

const roles = rolesUnderTest()

const DEPOT: Position2D = [12.5683, 55.6761]
const PARKVEJ: Position2D = [12.575, 55.68]
const HAVNEGADE: Position2D = [12.61, 55.71]
const STATION: Position2D = [12.55, 55.72]

/** The engine's clock: the night before the fixtures' Monday, two hours before the provider's reset. */
const NOW = new Date("2026-10-01T01:00:00.000Z")
const RESET = "2026-10-01T03:00:00.000Z"
const NEXT_RESET = "2026-10-02T03:00:00.000Z"
/** The reset plus the half-minute of jitter the engine is pinned to. */
const DEFERRED = new Date("2026-10-01T03:00:30.000Z")
/** A batch job's priority for the fixtures' Monday, day 20 731 of the Unix epoch, and an interactive job's, above every batch job. */
const BATCH_PRIORITY = 979_269
const INTERACTIVE_PRIORITY = 2_000_000

type JobRow = { id: string; state: string; data: RoutingJobData; priority: number; retry_count: number; start_epoch: number }

describe("routing's jobs under the quota engine", { skip: roles.skip }, () => {
  const name = `waste_worker_routing_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let owner: Database
  let api: Database
  let worker: Database
  let boss: PgBoss
  let tenant: ConsumerTenant
  let depotId: string
  let stationId: string
  const lines: string[] = []

  /** The engine's clock, which a test moves past a reset. */
  const clock = { now: NOW }
  /** An engine over a scripted fake on the pinned clock: the jitter half a minute, the 429's wait instant. */
  const engineOf = (script: FakeScript = {}, provider?: RoutingProvider) => {
    const fake = new FakeProvider(script)
    const engine = new QuotaEngine(provider ?? fake, {
      ...STANDARD_PLAN,
      now: () => clock.now,
      sleep: async () => {},
      random: () => 0.5,
      warn: (line) => void lines.push(line),
      error: (line) => void lines.push(line),
    })
    return { fake, engine }
  }
  const contextOf = (engine: QuotaEngine, overrides: Partial<JobContext> = {}): JobContext => ({
    api,
    worker: new Proxy({} as Database, {
      get() {
        throw new Error("a routing job never reads across tenants")
      },
    }),
    now: () => clock.now,
    log: (message) => void lines.push(message),
    send: (queue, data, options) => boss.send(queue, data, options ?? {}),
    complete: (queue, id, options) => boss.complete(queue, id, undefined, options),
    routing: engine,
    ...overrides,
  })

  before(async () => {
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    owner = createDb(withDatabaseName(roles.adminUrl, name), { max: 2 })
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 3 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 1 })
    boss = createBoss({ url: withDatabaseName(roles.adminUrl, name), log: (line) => void lines.push(line) })
    await boss.start()
    await boss.createQueue(ROUTING_MEASURE_QUEUE, routingMeasure.queueOptions)
    await boss.createQueue(ROUTING_OPTIMISE_QUEUE, routingOptimise.queueOptions)
    tenant = await seedConsumerTenant(api)
    depotId = testId()
    stationId = testId()
    await withCompany(api.db, tenant.companyId, async (tx: Tx) => {
      await tx.update(property).set({ location: { type: "Point", coordinates: PARKVEJ } }).where(eq(property.id, tenant.properties.parkvej.id))
      await tx.update(property).set({ location: { type: "Point", coordinates: HAVNEGADE } }).where(eq(property.id, tenant.properties.havnegade.id))
      await tx.insert(depot).values({ id: depotId, companyId: tenant.companyId, projectId: tenant.projectId, code: "DEP-NORD", name: "Nordhavn", address: "Sundkrogsgade 21", location: { type: "Point", coordinates: DEPOT }, ownership: "company", status: "active" })
      await tx.insert(unloadingStation).values({ id: stationId, companyId: tenant.companyId, code: "ARC-AMAGER", name: "Amager Bakke", address: "Vindmøllevej 6", location: { type: "Point", coordinates: STATION }, ownership: "company", status: "active" })
    })
  })

  after(async () => {
    await boss?.stop({ graceful: false, close: true, timeout: 2_000 })
    await Promise.allSettled([api?.close(), worker?.close(), owner?.close()])
    try {
      await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin?.close()
    }
  })

  /** A route of Mads's, its two stops in the order Havnegade then Parkvej, with the ends a test asks for. */
  async function routeWith(ends: "none" | "depot" | "full", status: "planned" | "active" = "planned"): Promise<SeededRoute> {
    const seeded = await seedRoute(api, tenant, {
      status,
      pickups: [
        { container: "bin2", status: "planned" },
        { container: "bin1", status: "planned" },
      ],
    })
    await withCompany(api.db, tenant.companyId, (tx: Tx) =>
      tx
        .update(route)
        .set({ depotId: ends === "none" ? null : depotId, unloadingStationId: ends === "full" ? stationId : null })
        .where(eq(route.id, seeded.id)),
    )
    return seeded
  }

  /** A calculating Plan as a sender writes it: a known sequence's stops with it, active from creation unless it is the optimiser's. */
  async function planOf(seeded: SeededRoute, solver: "manual" | "baseline" | "optimiser", trip: "full" | "stops-only"): Promise<string> {
    const planId = testId()
    await withCompany(api.db, tenant.companyId, async (tx: Tx) => {
      await tx.insert(plan).values({
        id: planId,
        companyId: tenant.companyId,
        projectId: tenant.projectId,
        routeId: seeded.id,
        solver,
        status: "calculating",
        trip,
        provider: "fake",
        fingerprint: planFingerprint({ provider: "fake", profile: "driving-hgv", solver, depot: trip === "full" ? DEPOT : null, station: trip === "full" ? STATION : null, stops: [HAVNEGADE, PARKVEJ] }),
      })
      if (solver === "optimiser") return
      await tx.insert(planStop).values(seeded.pickupIds.map((pickupId, index) => ({ companyId: tenant.companyId, projectId: tenant.projectId, routeId: seeded.id, planId, pickupId, position: index + 1 })))
      await tx.update(route).set({ activePlanId: planId }).where(eq(route.id, seeded.id))
    })
    return planId
  }

  /** The Plan's job, sent as its sender sends it and fetched as the worker's poll takes it: active, in hand. */
  async function inHand(queue: string, planId: string, jobClass: "interactive" | "batch" = "interactive"): Promise<Job<RoutingJobData>> {
    const data: RoutingJobData = { planId, companyId: tenant.companyId, class: jobClass }
    const sent = await boss.send(queue, data, routingSendOptions({ data, operatingDate: FIXTURE_DAY }))
    const [job] = await boss.fetch<RoutingJobData>(queue)
    assert.equal(job?.id, sent, "the job fetched is the one just sent")
    return job
  }

  const planRow = async (planId: string) => (await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select().from(plan).where(eq(plan.id, planId))))[0]
  const legsOf = (planId: string) => withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select().from(planLeg).where(eq(planLeg.planId, planId)).orderBy(asc(planLeg.position)))
  const stopsOf = async (planId: string) => (await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select({ pickupId: planStop.pickupId }).from(planStop).where(eq(planStop.planId, planId)).orderBy(asc(planStop.position)))).map((row) => row.pickupId)
  const activeOf = async (routeId: string) => (await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select({ activePlanId: route.activePlanId }).from(route).where(eq(route.id, routeId))))[0].activePlanId
  const quotaRow = async (family: "directions" | "optimisation") =>
    (await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select().from(routingQuota).where(eq(routingQuota.family, family))))[0]
  const clearQuota = () => withCompany(api.db, tenant.companyId, (tx: Tx) => tx.delete(routingQuota).where(eq(routingQuota.companyId, tenant.companyId)))
  const jobsOf = (planId: string) =>
    owner.sql.unsafe<JobRow[]>(`select id, state, data, priority, retry_count, extract(epoch from start_after)::float8 as start_epoch from ${PGBOSS_SCHEMA}.job where singleton_key = $1 order by created_on, id`, [planId])

  describe("routing.measure", () => {
    test("an answered measurement writes the legs and totals, and moves the company's quota row to the provider's reading", async () => {
      await clearQuota()
      const { engine } = engineOf({ quota: { directions: { remaining: 900, limit: 2000, resetAt: RESET } } })
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId)
      assert.deepEqual(await routingMeasure.handler([job], contextOf(engine)), [{ id: job.id, status: "completed" }])
      const measured = await planRow(planId)
      assert.equal(measured.status, "ready")
      const legs = await legsOf(planId)
      assert.deepEqual(
        legs.map((leg) => leg.path.coordinates),
        [[HAVNEGADE, PARKVEJ]],
      )
      assert.equal(measured.distanceMetres, legs[0].metres)
      const row = await quotaRow("directions")
      assert.deepEqual([row.provider, row.remaining, row.limit, row.resetAt?.toISOString(), row.exhaustedAt, row.keyRefusedAt], ["fake", 899, 2000, RESET, null, null])
    })

    test("a batch measurement at the reserve, read off the company's row by a fresh process, defers without a call: the job completed and re-sent under the Plan's key for the reset, the Plan still calculating", async () => {
      await clearQuota()
      await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.insert(routingQuota).values({ companyId: tenant.companyId, provider: "fake", family: "directions", remaining: 500, limit: 2000, resetAt: new Date(RESET) }))
      const { engine, fake } = engineOf()
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "baseline", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId, "batch")
      assert.deepEqual(await routingMeasure.handler([job], contextOf(engine)), [{ id: job.id, status: "completed" }])
      assert.equal(fake.calls.directions, 0, "no call below the reserve")
      const deferred = await planRow(planId)
      assert.deepEqual([deferred.status, deferred.deferredUntil?.toISOString()], ["calculating", DEFERRED.toISOString()])
      const [original, successor] = await jobsOf(planId)
      assert.deepEqual([original.id, original.state], [job.id, "completed"])
      assert.deepEqual([successor.state, successor.data, successor.priority, successor.start_epoch], ["created", job.data, BATCH_PRIORITY, DEFERRED.getTime() / 1000])
      assert.equal((await quotaRow("directions")).remaining, 500, "nothing new was learned, so the row stands")
    })

    test("a quota 403 defers the job to the reset and marks the family exhausted; once due, the re-sent job is the probe that measures and re-opens it", async () => {
      await clearQuota()
      const { engine, fake } = engineOf({
        quota: { directions: { remaining: 3, limit: 2000, resetAt: RESET } },
        responses: { directions: [{ status: 403, quota: true }, { status: 200, quota: { remaining: 2000, limit: 2000, resetAt: NEXT_RESET } }] },
      })
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId)
      await routingMeasure.handler([job], contextOf(engine))
      assert.equal((await planRow(planId)).deferredUntil?.toISOString(), DEFERRED.toISOString())
      const exhausted = await quotaRow("directions")
      assert.deepEqual([exhausted.remaining, exhausted.exhaustedAt?.toISOString()], [0, NOW.toISOString()])
      const [, successor] = await jobsOf(planId)
      assert.equal(successor.priority, INTERACTIVE_PRIORITY, "deferred, it keeps its priority")

      // The reset passes; the re-sent job comes due (its start moved to now, pg-boss's clock being the real one).
      clock.now = new Date("2026-10-01T03:01:00.000Z")
      await owner.sql.unsafe(`update ${PGBOSS_SCHEMA}.job set start_after = now() where id = $1`, [successor.id])
      const [probe] = await boss.fetch<RoutingJobData>(ROUTING_MEASURE_QUEUE)
      assert.equal(probe.id, successor.id)
      await routingMeasure.handler([probe], contextOf(engine))
      const measured = await planRow(planId)
      assert.deepEqual([measured.status, measured.deferredUntil], ["ready", null])
      const reopened = await quotaRow("directions")
      assert.deepEqual([reopened.remaining, reopened.exhaustedAt, reopened.resetAt?.toISOString()], [1999, null, NEXT_RESET])
      assert.equal(fake.calls.directions, 2)
      clock.now = NOW
    })

    test("a measurement whose Plan is no longer the route's active one is failed as superseded and makes no call", async () => {
      const { engine, fake } = engineOf()
      const seeded = await routeWith("none")
      const first = await planOf(seeded, "manual", "stops-only")
      const second = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, first)
      assert.deepEqual(await routingMeasure.handler([job], contextOf(engine)), [{ id: job.id, status: "completed" }])
      const superseded = await planRow(first)
      assert.deepEqual([superseded.status, superseded.failureReason], ["failed", SUPERSEDED])
      assert.equal(fake.calls.directions, 0)
      assert.equal(await activeOf(seeded.id), second)
    })

    test("the key refused fails the Plan with the sentence the office reads, marks the row, and answers the job dead-lettered: failed without a retry; the next job of the family is refused without a call", async () => {
      await clearQuota()
      const { engine, fake } = engineOf({ responses: { directions: [{ status: 401 }] } })
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId)
      assert.deepEqual(await routingMeasure.handler([job], contextOf(engine)), [{ id: job.id, status: "deadletter" }])
      const refused = await planRow(planId)
      assert.deepEqual([refused.status, refused.failureReason], ["failed", KEY_REFUSED])
      assert.equal((await quotaRow("directions")).keyRefusedAt?.toISOString(), NOW.toISOString())
      assert.equal(await activeOf(seeded.id), planId, "a manual Plan stays active, unmeasured and dashed (#124 §2)")
      await boss.complete(ROUTING_MEASURE_QUEUE, job.id)

      const again = await routeWith("none")
      const next = await planOf(again, "manual", "stops-only")
      const nextJob = await inHand(ROUTING_MEASURE_QUEUE, next)
      assert.deepEqual(await routingMeasure.handler([nextJob], contextOf(engine)), [{ id: nextJob.id, status: "deadletter" }])
      assert.equal(fake.calls.directions, 1)
      await boss.complete(ROUTING_MEASURE_QUEUE, nextJob.id)
    })

    test("a semantic refusal fails the Plan in the provider's own words, and the job completes", async () => {
      const sentence = "Could not find routable point within a radius of 350.0 meters of specified coordinate 2"
      const { engine } = engineOf({ responses: { directions: [{ status: 404, sentence }] } })
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId)
      assert.deepEqual(await routingMeasure.handler([job], contextOf(engine)), [{ id: job.id, status: "completed" }])
      assert.deepEqual([(await planRow(planId)).status, (await planRow(planId)).failureReason], ["failed", sentence])
    })

    test("a second 429 fails the job to pg-boss's retries: thrown, the Plan still calculating and not deferred", async () => {
      const { engine } = engineOf({ responses: { directions: [{ status: 429 }, { status: 429 }] } })
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId)
      await assert.rejects(routingMeasure.handler([job], contextOf(engine)), RoutingRetryable)
      const standing = await planRow(planId)
      assert.deepEqual([standing.status, standing.deferredUntil], ["calculating", null])
      await boss.complete(ROUTING_MEASURE_QUEUE, job.id)
    })

    test("a job failed to pg-boss's retries still stores what its calls taught: the reading a 429 carried is on the company's row", async () => {
      await clearQuota()
      const { engine } = engineOf({ quota: { directions: { remaining: 700, limit: 2000, resetAt: RESET } }, responses: { directions: [{ status: 429 }, { status: 429 }] } })
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId)
      await assert.rejects(routingMeasure.handler([job], contextOf(engine)), RoutingRetryable)
      assert.equal((await quotaRow("directions"))?.remaining, 700)
      await boss.complete(ROUTING_MEASURE_QUEUE, job.id)
    })

    test("a deferral whose successor cannot be sent rolls back whole: the Plan not deferred, the job still active for pg-boss to retry, no successor", async () => {
      const { engine } = engineOf({ quota: { directions: { remaining: 3, limit: 2000, resetAt: RESET } }, responses: { directions: [{ status: 403, quota: true }] } })
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_MEASURE_QUEUE, planId)
      const refusing = contextOf(engine, {
        send: async () => {
          throw new Error("the queue refused the successor")
        },
      })
      await assert.rejects(routingMeasure.handler([job], refusing), /refused the successor/)
      assert.equal((await planRow(planId)).deferredUntil, null)
      assert.deepEqual(
        (await jobsOf(planId)).map((row) => [row.id, row.state]),
        [[job.id, "active"]],
      )
      await boss.complete(ROUTING_MEASURE_QUEUE, job.id)
    })
  })

  describe("routing.optimise", () => {
    test("orders a stops-only route's stops from its depot, writes the solver's stops and the stop-to-stop legs, and activates the Plan on ready", async () => {
      await clearQuota()
      const { engine } = engineOf({ quota: { optimisation: { remaining: 480, limit: 500, resetAt: RESET } } })
      const seeded = await routeWith("depot")
      const planId = await planOf(seeded, "optimiser", "stops-only")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, planId)
      assert.deepEqual(await routingOptimise.handler([job], contextOf(engine)), [{ id: job.id, status: "completed" }])
      const solved = await planRow(planId)
      assert.equal(solved.status, "ready")
      // Nearest-neighbour from the depot takes Parkvej before Havnegade, the generated order reversed.
      assert.deepEqual(await stopsOf(planId), [seeded.pickupIds[1], seeded.pickupIds[0]])
      const legs = await legsOf(planId)
      assert.deepEqual(
        legs.map((leg) => leg.path.coordinates),
        [[PARKVEJ, HAVNEGADE]],
        "stops-only: no leg to or from the depot",
      )
      assert.equal(solved.distanceMetres, legs[0].metres)
      assert.equal(await activeOf(seeded.id), planId)
      assert.equal((await quotaRow("optimisation")).remaining, 479)
    })

    test("an answer made active fails the older optimisations still waiting on the route at once, and leaves a later request waiting", async () => {
      const { engine } = engineOf()
      const seeded = await routeWith("depot")
      const older = await planOf(seeded, "optimiser", "stops-only")
      const answering = await planOf(seeded, "optimiser", "stops-only")
      const later = await planOf(seeded, "optimiser", "stops-only")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, answering)
      await routingOptimise.handler([job], contextOf(engine))
      assert.equal(await activeOf(seeded.id), answering)
      assert.deepEqual([(await planRow(older)).status, (await planRow(older)).failureReason, (await planRow(older)).deferredUntil], ["failed", SUPERSEDED, null], "overtaken: it will never be read")
      assert.equal((await planRow(later)).status, "calculating", "an answer supersedes no request made after it")
    })

    test("a full trip holds the station last: depot, the stops, the station, home", async () => {
      const { engine } = engineOf()
      const seeded = await routeWith("full")
      const planId = await planOf(seeded, "optimiser", "full")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, planId)
      await routingOptimise.handler([job], contextOf(engine))
      assert.deepEqual(
        (await legsOf(planId)).map((leg) => leg.path.coordinates),
        [
          [DEPOT, PARKVEJ],
          [PARKVEJ, HAVNEGADE],
          [HAVNEGADE, STATION],
          [STATION, DEPOT],
        ],
      )
    })

    test("an optimiser Plan the route has moved past — a newer active Plan — is superseded without a call, and the newer order stands", async () => {
      const { engine, fake } = engineOf()
      const seeded = await routeWith("depot")
      const optimiser = await planOf(seeded, "optimiser", "stops-only")
      const manual = await planOf(seeded, "manual", "stops-only")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, optimiser)
      await routingOptimise.handler([job], contextOf(engine))
      assert.deepEqual([(await planRow(optimiser)).status, (await planRow(optimiser)).failureReason], ["failed", SUPERSEDED])
      assert.equal(fake.calls.optimisation, 0)
      assert.equal(await activeOf(seeded.id), manual)
    })

    test("an answer that lands after a newer Plan became active is kept ready and never activated: the later order wins", async () => {
      const seeded = await routeWith("depot")
      const optimiser = await planOf(seeded, "optimiser", "stops-only")
      let manual = ""
      const fake = new FakeProvider()
      // While the provider works, a dispatcher reorders by hand.
      const racing: RoutingProvider = {
        name: fake.name,
        maxWaypoints: fake.maxWaypoints,
        measure: (request) => fake.measure(request),
        optimise: async (request: OptimiseRequest) => {
          manual = await planOf(seeded, "manual", "stops-only")
          return fake.optimise(request)
        },
      }
      const { engine } = engineOf({}, racing)
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, optimiser)
      await routingOptimise.handler([job], contextOf(engine))
      assert.equal((await planRow(optimiser)).status, "ready", "the call was spent; its answer is kept as history")
      assert.equal(await activeOf(seeded.id), manual)
    })

    test("a route that has started is refused before a call: its order is frozen", async () => {
      const { engine, fake } = engineOf()
      const seeded = await routeWith("depot", "active")
      const planId = await planOf(seeded, "optimiser", "stops-only")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, planId)
      await routingOptimise.handler([job], contextOf(engine))
      const refused = await planRow(planId)
      assert.equal(refused.status, "failed")
      assert.match(refused.failureReason ?? "", /frozen/)
      assert.equal(fake.calls.optimisation, 0)
    })

    test("a route that names no depot is refused before a call: the optimiser orders from the depot", async () => {
      const { engine, fake } = engineOf()
      const seeded = await routeWith("none")
      const planId = await planOf(seeded, "optimiser", "stops-only")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, planId)
      await routingOptimise.handler([job], contextOf(engine))
      const refused = await planRow(planId)
      assert.equal(refused.status, "failed")
      assert.match(refused.failureReason ?? "", /depot/)
      assert.equal(fake.calls.optimisation, 0)
    })

    test("an answer that does not fit the trip fails the Plan in so many words, final: no retry spends another call", async () => {
      const fake = new FakeProvider()
      // An answer one leg short of the closed trip it was asked for.
      const short: RoutingProvider = {
        name: fake.name,
        maxWaypoints: fake.maxWaypoints,
        measure: (request) => fake.measure(request),
        optimise: async (request: OptimiseRequest) => {
          const answer = await fake.optimise(request)
          return answer.kind === "answered" ? { ...answer, result: { ...answer.result, legs: answer.result.legs.slice(1) } } : answer
        },
      }
      const { engine } = engineOf({}, short)
      const seeded = await routeWith("depot")
      const planId = await planOf(seeded, "optimiser", "stops-only")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, planId)
      assert.deepEqual(await routingOptimise.handler([job], contextOf(engine)), [{ id: job.id, status: "completed" }])
      const refused = await planRow(planId)
      assert.equal(refused.status, "failed")
      assert.match(refused.failureReason ?? "", /did not fit the trip/)
    })

    test("optimisation exhausted defers the optimiser Plan to the reset, and the Plan standing stays active: no downgrade to baseline", async () => {
      const { engine } = engineOf({ quota: { optimisation: { remaining: 4, limit: 500, resetAt: RESET } }, responses: { optimisation: [{ status: 403, quota: true }] } })
      const seeded = await routeWith("depot")
      const standing = await planOf(seeded, "manual", "stops-only")
      const optimiser = await planOf(seeded, "optimiser", "stops-only")
      const job = await inHand(ROUTING_OPTIMISE_QUEUE, optimiser)
      await routingOptimise.handler([job], contextOf(engine))
      const waiting = await planRow(optimiser)
      assert.deepEqual([waiting.status, waiting.deferredUntil?.toISOString()], ["calculating", DEFERRED.toISOString()])
      assert.equal(await activeOf(seeded.id), standing)
      const [, successor] = await jobsOf(optimiser)
      assert.deepEqual([successor.state, successor.data.planId], ["created", optimiser])
    })
  })

  describe("under the worker's own loop", () => {
    test("a key refusal is settled failed with no retry spent, and a deferral's hand-over survives pg-boss's own completion", async () => {
      const refusedKey = engineOf({ responses: { directions: [{ status: 401 }] } })
      const keyWorker = await boss.work<RoutingJobData>(ROUTING_MEASURE_QUEUE, { ...routingMeasure.workOptions, pollingIntervalSeconds: 0.5 }, (batch) => routingMeasure.handler(batch, contextOf(refusedKey.engine)))
      const refused = await planOf(await routeWith("none"), "manual", "stops-only")
      await boss.send(ROUTING_MEASURE_QUEUE, { planId: refused, companyId: tenant.companyId, class: "interactive" } satisfies RoutingJobData, { singletonKey: refused })
      await until(async () => (await jobsOf(refused))[0]?.state === "failed", 15_000, "the refused job settling failed")
      assert.deepEqual(
        (await jobsOf(refused)).map((row) => [row.state, row.retry_count]),
        [["failed", 0]],
      )
      await boss.offWork(ROUTING_MEASURE_QUEUE, { id: keyWorker })

      const exhausted = engineOf({ quota: { directions: { remaining: 3, limit: 2000, resetAt: RESET } }, responses: { directions: [{ status: 403, quota: true }] } })
      const deferWorker = await boss.work<RoutingJobData>(ROUTING_MEASURE_QUEUE, { ...routingMeasure.workOptions, pollingIntervalSeconds: 0.5 }, (batch) => routingMeasure.handler(batch, contextOf(exhausted.engine)))
      const deferred = await planOf(await routeWith("none"), "manual", "stops-only")
      await boss.send(ROUTING_MEASURE_QUEUE, { planId: deferred, companyId: tenant.companyId, class: "interactive" } satisfies RoutingJobData, { singletonKey: deferred })
      await until(async () => (await jobsOf(deferred)).length === 2, 15_000, "the deferred job handing over to its successor")
      assert.deepEqual(
        (await jobsOf(deferred)).map((row) => row.state),
        ["completed", "created"],
      )
      await boss.offWork(ROUTING_MEASURE_QUEUE, { id: deferWorker })
      assert.ok(!lines.some((line) => /no longer claimed|rolled back/.test(line)), "pg-boss's own completion found the job already settled and said nothing of it")
    })
  })
})

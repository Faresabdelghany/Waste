// The measurement job (#169, decided on #124/#132): a `baseline` or `manual`
// Plan whose stops were written at creation gets its legs and totals through
// the provider and flips `calculating → ready`; the stops are never
// rewritten (#124 §1: the sequence is written exactly once, on creation for a
// known sequence). Runs on the shared local database the way the consumer
// suites do: every write as `wms_api` under `withCompany`, a tenant of its
// own, swept after. The provider is the deterministic fake, injected through
// the context the way main.ts injects the process's own.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { pickup, route } from "@waste/db/schema/execution"
import { property } from "@waste/db/schema/customers"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { planFingerprint } from "@waste/domain/routing/fingerprint"
import { asc, eq } from "drizzle-orm"

import type { JobContext } from "../jobs/definition"
import { routingMeasure, ROUTING_MEASURE_QUEUE, type RoutingMeasureData } from "../jobs/routing-measure"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { dropConsumerTenant, seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { fakeRouting, settlesNothing } from "./routing-context"

const database = databaseUnderTest()
const owner = ownerUnderTest()

const DEPOT: Position2D = [12.5683, 55.6761]
const PARKVEJ: Position2D = [12.575, 55.68]
const HAVNEGADE: Position2D = [12.61, 55.71]
const STATION: Position2D = [12.55, 55.72]

describe("routing.measure through the fake provider", { skip: database.skip || owner.skip }, () => {
  let api: Database
  let admin: Database
  let tenant: ConsumerTenant
  let depotId: string
  let stationId: string
  const lines: string[] = []

  const context = (): JobContext => ({
    api,
    worker: new Proxy({} as Database, {
      get() {
        throw new Error("routing.measure never reads across tenants")
      },
    }),
    now: () => new Date("2026-10-05T04:00:00Z"),
    log: (message) => void lines.push(message),
    send: async () => null,
    complete: settlesNothing,
    routing: fakeRouting(),
  })

  before(async () => {
    api = createDb(database.url)
    admin = createDb(owner.url)
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
    if (tenant) await dropConsumerTenant(api, admin, tenant.companyId)
    await admin?.close()
    await api?.close()
  })

  /** A calculating Plan with its stops written at creation, the way #124 §1 has it, over the seeded route's pickups in position order — and, being a known sequence, the route's active Plan from creation (#124 §2), as a sender makes it. */
  async function seedPlan(seeded: SeededRoute, trip: "full" | "stops-only", solver: "baseline" | "optimiser" = "baseline"): Promise<string> {
    const planId = testId()
    const stops = seeded.pickupIds
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
        fingerprint: planFingerprint({ provider: "fake", profile: "driving-hgv", solver, depot: trip === "full" ? DEPOT : null, station: trip === "full" ? STATION : null, stops: [PARKVEJ, HAVNEGADE] }),
      })
      await tx.insert(planStop).values(stops.map((pickupId, index) => ({ id: testId(), companyId: tenant.companyId, projectId: tenant.projectId, routeId: seeded.id, planId, pickupId, position: index + 1 })))
      if (solver !== "optimiser") await tx.update(route).set({ activePlanId: planId }).where(eq(route.id, seeded.id))
    })
    return planId
  }

  const run = (planId: string) => routingMeasure.handler([{ id: testId(), name: ROUTING_MEASURE_QUEUE, data: { planId, companyId: tenant.companyId } } as never], context())

  const planRow = async (planId: string) => {
    const rows = await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select().from(plan).where(eq(plan.id, planId)))
    return rows[0]
  }
  const legsOf = (planId: string) =>
    withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select().from(planLeg).where(eq(planLeg.planId, planId)).orderBy(asc(planLeg.position)))

  test("measures the full trip — depot, the stops in plan order, the station, home — one leg per pair, the totals the sum, the Plan ready", async () => {
    const seeded = await seedRoute(api, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.update(route).set({ depotId, unloadingStationId: stationId }).where(eq(route.id, seeded.id)))
    const planId = await seedPlan(seeded, "full")
    await run(planId)
    const measured = await planRow(planId)
    assert.equal(measured.status, "ready")
    const legs = await legsOf(planId)
    assert.equal(legs.length, 4, "depot → Parkvej → Havnegade → station → depot")
    assert.deepEqual(legs[0].path.coordinates, [DEPOT, PARKVEJ])
    assert.deepEqual(legs[1].path.coordinates, [PARKVEJ, HAVNEGADE])
    assert.deepEqual(legs[2].path.coordinates, [HAVNEGADE, STATION])
    assert.deepEqual(legs[3].path.coordinates, [STATION, DEPOT])
    assert.equal(measured.distanceMetres, legs.reduce((sum, leg) => sum + leg.metres, 0))
    assert.equal(measured.durationSeconds, legs.reduce((sum, leg) => sum + leg.seconds, 0))
    const stops = await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.select().from(planStop).where(eq(planStop.planId, planId)))
    assert.equal(stops.length, 2, "the stops stand as creation wrote them")
  })

  test("a second run writes nothing: not a leg, not an updated_at", async () => {
    const seeded = await seedRoute(api, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.update(route).set({ depotId, unloadingStationId: stationId }).where(eq(route.id, seeded.id)))
    const planId = await seedPlan(seeded, "full")
    await run(planId)
    const first = await planRow(planId)
    const firstLegs = await legsOf(planId)
    await run(planId)
    assert.deepEqual(await planRow(planId), first)
    assert.deepEqual(await legsOf(planId), firstLegs)
  })

  test("a stops-only Plan measures the stops alone: one leg between the two, nothing to or from a depot", async () => {
    const seeded = await seedRoute(api, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    const planId = await seedPlan(seeded, "stops-only")
    await run(planId)
    const measured = await planRow(planId)
    assert.equal(measured.status, "ready")
    const legs = await legsOf(planId)
    assert.equal(legs.length, 1)
    assert.deepEqual(legs[0].path.coordinates, [PARKVEJ, HAVNEGADE])
    assert.equal(measured.distanceMetres, legs[0].metres)
  })

  test("a stop whose place has no location fails the Plan with the sentence and completes, the way a semantic refusal is final (#132 §4)", async () => {
    const bareId = testId()
    await withCompany(api.db, tenant.companyId, async (tx: Tx) => {
      await tx.insert(property).values({ id: bareId, companyId: tenant.companyId, projectId: tenant.projectId, name: "Ny Adresse 1", address: "Ny Adresse 1", kind: "residential", status: "active" })
    })
    const seeded = await seedRoute(api, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }] })
    await withCompany(api.db, tenant.companyId, (tx: Tx) => tx.update(pickup).set({ propertyId: bareId }).where(eq(pickup.id, seeded.pickupIds[0])))
    const planId = await seedPlan(seeded, "stops-only")
    await run(planId)
    const measured = await planRow(planId)
    assert.equal(measured.status, "failed")
    assert.match(measured.failureReason ?? "", /stop 1 .*no location/)
    assert.deepEqual(await legsOf(planId), [])
  })

  test("two consecutive stops at one address measure as one point: no zero-length leg, the Plan ready (two bins at one property is routine)", async () => {
    const seeded = await seedRoute(api, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    await withCompany(api.db, tenant.companyId, async (tx: Tx) => {
      await tx.update(route).set({ depotId, unloadingStationId: stationId }).where(eq(route.id, seeded.id))
      // Both bins at Parkvej: consecutive identical coordinates, which PostGIS would refuse as a LINESTRING(P, P).
      await tx.update(pickup).set({ propertyId: tenant.properties.parkvej.id }).where(eq(pickup.id, seeded.pickupIds[1]))
    })
    const planId = await seedPlan(seeded, "full")
    await run(planId)
    const measured = await planRow(planId)
    assert.equal(measured.status, "ready")
    const legs = await legsOf(planId)
    assert.equal(legs.length, 3, "depot → Parkvej → station → depot; the duplicate point spans no leg")
    assert.deepEqual(legs[1].path.coordinates, [PARKVEJ, STATION])
  })

  test("an optimiser Plan is refused, not measured: its sequence is the solver's to write (#124 §2)", async () => {
    const seeded = await seedRoute(api, tenant, { status: "active", pickups: [{ container: "bin1", status: "planned" }] })
    const planId = await seedPlan(seeded, "stops-only", "optimiser")
    await run(planId)
    const measured = await planRow(planId)
    assert.equal(measured.status, "failed")
    assert.match(measured.failureReason ?? "", /optimiser/)
    assert.deepEqual(await legsOf(planId), [])
  })

  test("a Plan that is not there completes as a no-op: a sweep between send and work retries nothing", async () => {
    await run(testId())
    assert.ok(lines.some((line) => /is not there|writes nothing|no such plan/i.test(line)))
  })

  test("the queue is #132's: exclusive under the Plan-id singleton, ten minutes to run, done jobs kept a week, a queued one a fortnight, settled per job", () => {
    assert.equal(routingMeasure.queue, "routing.measure")
    assert.deepEqual(routingMeasure.workOptions, { perJobResults: true })
    assert.deepEqual(routingMeasure.queueOptions, {
      policy: "exclusive",
      expireInSeconds: 600,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      retentionSeconds: 14 * 24 * 60 * 60,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 300,
    })
    const data: RoutingMeasureData = { planId: "x", companyId: "y" }
    assert.ok(data)
  })
})

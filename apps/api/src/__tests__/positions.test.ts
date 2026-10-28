// A route's track and estimates (O8 of #290): `GET /routes/:id/positions`,
// one session's positions in order — the open session's by default, another
// of the route's own on asking, a long track thinned with its last point kept
// — and `GET /routes/:id/eta`, the active Plan's stops with when the vehicle
// is expected there, read from the route's start, the Plan's legs, each
// stop's kerb time, its window and the progress so far; and the Live board's
// row carrying the newest position and the next stop's estimate. Both reads
// are the Live board's grant and the routes' reach.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { RouteEta, RouteTrack, TRACK_POINTS_MAX } from "@waste/contracts/positions"
import { LiveRoute } from "@waste/contracts/routes"
import { createDb, type Database } from "@waste/db/client"
import { property } from "@waste/db/schema/customers"
import { pickup, route, sessionPosition } from "@waste/db/schema/execution"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { NOT_A_SESSION_OF_THE_ROUTE } from "../routes/positions"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, FIXTURE_DAY, seedExecution, seedRoute, TOWN_HALL, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const LivePage = Page(LiveRoute)
const MODULE = "route-studio.live"

/** The request's clock: half past six on the fixtures' Monday, Copenhagen's summer time. */
const NOW = at(FIXTURE_DAY, "06:30")
const MINUTE = 60
const iso = (time: string) => at(FIXTURE_DAY, time).toISOString()

describe("a route's track and estimates", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  /** The custom role, granted view on the Live board, with Project Access to Copenhagen Central only. */
  let viewer: Call
  let ungranted: Call
  let theirs: Call
  let running: SeededRoute
  let other: SeededRoute
  let harbor: SeededRoute

  /** A fix of a session, written as the driver door writes it. */
  const fix = (seeded: SeededRoute, fixedAt: Date, coordinates: [number, number] = [12.5683, 55.6761]) =>
    withCompany(pool.db, a.companyId, (tx) =>
      tx.insert(sessionPosition).values({ companyId: a.companyId, projectId: seeded.projectId, routeId: seeded.id, sessionId: seeded.sessionId!, driverId: fleet.drivers.mads.id, fixedAt, location: { type: "Point", coordinates }, accuracyM: 9, speedKmh: 30, headingDeg: 90 }),
    )

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    theirs = callingAs(app, keys, b.users.olivia, b.companyId)

    const mads = { plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id, plannedStartTime: "06:00" }
    // Started at 06:00; the first stop completed at 06:20, the other two still to come.
    running = await seedRoute(pool, a, fleet, ex, {
      status: "active",
      ...mads,
      pickups: [
        { containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, status: "completed", outcomeAt: at(FIXTURE_DAY, "06:20") },
        { containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id },
        { containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id },
      ],
    })
    other = await seedRoute(pool, a, fleet, ex, { status: "active", operatingDate: "2026-10-04", plannedDriverId: fleet.drivers.jonas.id, plannedVehicleId: fleet.vehicles.wh25.id, deviceId: "device-jonas-1" })
    harbor = await seedRoute(pool, a, fleet, ex, { project: "harbor", status: "active", plannedDriverId: fleet.drivers.henrik.id, plannedVehicleId: fleet.vehicles.harborTruck.id, deviceId: "device-henrik-1" })

    // The third stop's property takes collections from 07:00: the vehicle arriving before waits.
    await withCompany(pool.db, a.companyId, (tx) => tx.update(property).set({ serviceWindowStart: "07:00", serviceWindowEnd: "09:00" }).where(and(eq(property.companyId, a.companyId), eq(property.id, ex.properties.norrebrogade.id))))

    // The active Plan: a full trip of the three stops, ten minutes between each, twenty to the station and fifteen home.
    const planId = testId()
    await withCompany(pool.db, a.companyId, async (tx) => {
      await tx.insert(plan).values({ id: planId, companyId: a.companyId, projectId: running.projectId, routeId: running.id, solver: "manual", status: "ready", fingerprint: `test:${planId}`, trip: "full", distanceMetres: 12_000, durationSeconds: 65 * MINUTE, provider: "fake" })
      await tx.insert(planStop).values(running.pickupIds.map((pickupId, index) => ({ companyId: a.companyId, projectId: running.projectId, routeId: running.id, planId, kind: "pickup", pickupId, position: index + 1 })))
      const line = { type: "LineString" as const, coordinates: [[12.55, 55.67], [12.58, 55.69]] as [number, number][] }
      await tx.insert(planLeg).values([10, 10, 10, 20, 15].map((minutes, index) => ({ companyId: a.companyId, projectId: running.projectId, routeId: running.id, planId, position: index + 1, path: line, metres: 2_000, seconds: minutes * MINUTE })))
      await tx.update(route).set({ activePlanId: planId }).where(and(eq(route.companyId, a.companyId), eq(route.id, running.id)))
    })
  })
  let app: ReturnType<typeof createApp>
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const track = async (call: Call, id: string, query = "") => {
    const response = await call(`/routes/${id}/positions${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteTrack.parse(await response.json())
  }
  const eta = async (call: Call, id: string) => {
    const response = await call(`/routes/${id}/eta`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteEta.parse(await response.json())
  }

  describe("GET /routes/:id/eta", () => {
    test("each stop of the active Plan: a stop decided is passed, the next goes from its outcome, and a stop whose window has not opened waits for it before the trip goes home", async () => {
      const read = await eta(olivia, running.id)
      assert.equal(read.computedAt, NOW.toISOString())
      assert.deepEqual(
        read.stops.map((stop) => [stop.kind, stop.pickupId, stop.position, stop.eta]),
        [
          ["pickup", running.pickupIds[0], 1, null],
          // 06:20 + ten minutes; a minute at the kerb (the bin's type says none); ten more.
          ["pickup", running.pickupIds[1], 2, iso("06:30")],
          ["pickup", running.pickupIds[2], 3, iso("06:41")],
        ],
      )
      // Served from 07:00 for a minute, twenty minutes to the station and fifteen home.
      assert.equal(read.finishAt, iso("07:36"))
    })

    test("a route without an active Plan has no stops to estimate, and an ended route none to tell", async () => {
      assert.deepEqual(await eta(olivia, other.id), { routeId: other.id, planId: null, computedAt: NOW.toISOString(), stops: [], finishAt: null })
      await withCompany(pool.db, a.companyId, (tx) => tx.update(pickup).set({ status: "completed", outcomeAt: at(FIXTURE_DAY, "06:25") }).where(and(eq(pickup.companyId, a.companyId), eq(pickup.id, running.pickupIds[1]))))
      try {
        const progressed = await eta(olivia, running.id)
        assert.deepEqual(
          progressed.stops.map((stop) => stop.eta),
          [null, null, iso("06:35")],
          "the second stop decided at 06:25: the third ten minutes on",
        )
      } finally {
        await withCompany(pool.db, a.companyId, (tx) => tx.update(pickup).set({ status: "planned", outcomeAt: null }).where(and(eq(pickup.companyId, a.companyId), eq(pickup.id, running.pickupIds[1]))))
      }
    })

    test("is the Live board's grant and the routes' reach: another project's route, another company's or none is the 404, and a role without the grant is refused", async () => {
      assert.equal((await readProblem(await viewer(`/routes/${harbor.id}/eta`))).status, 404, "a project the viewer does not work in")
      assert.equal((await theirs(`/routes/${running.id}/eta`)).status, 404)
      assert.equal((await olivia(`/routes/${testId()}/eta`)).status, 404)
      assert.equal((await ungranted(`/routes/${running.id}/eta`)).status, 403)
    })
  })

  describe("GET /routes/:id/positions", () => {
    test("the open session's positions in the order they were taken, and another of the route's sessions only by its own id", async () => {
      assert.deepEqual(await track(olivia, running.id), { routeId: running.id, sessionId: running.sessionId, points: [], thinned: false })
      await fix(running, at(FIXTURE_DAY, "06:10"), [12.57, 55.68])
      await fix(running, at(FIXTURE_DAY, "06:05"))
      await fix(running, at(FIXTURE_DAY, "06:15"), [12.58, 55.69])
      const read = await track(olivia, running.id)
      assert.deepEqual(
        read.points.map((point) => [point.at, point.location.coordinates]),
        [
          [iso("06:05"), TOWN_HALL.coordinates],
          [iso("06:10"), [12.57, 55.68]],
          [iso("06:15"), [12.58, 55.69]],
        ],
      )
      assert.deepEqual([read.points[0].accuracyM, read.points[0].speedKmh, read.points[0].headingDeg], [9, 30, 90])
      assert.deepEqual((await track(olivia, running.id, `?sessionId=${running.sessionId}`)).points.length, 3)
      const problem = await readProblem(await olivia(`/routes/${running.id}/positions?sessionId=${other.sessionId}`))
      assert.equal(problem.status, 400)
      assert.deepEqual(problem.errors, [{ path: "sessionId", message: NOT_A_SESSION_OF_THE_ROUTE }])
      assert.deepEqual(await track(olivia, ex.routes.ready.id), { routeId: ex.routes.ready.id, sessionId: null, points: [], thinned: false }, "a route never started")
    })

    test("a track longer than the bound is thinned evenly, its last point kept, and says so", async () => {
      await ownerPool.sql`
        insert into wms.session_position (company_id, project_id, route_id, session_id, driver_id, fixed_at, location, accuracy_m)
        select ${a.companyId}, ${other.projectId}, ${other.id}, ${other.sessionId}, ${fleet.drivers.jonas.id}, ${at("2026-10-04", "06:00").toISOString()}::timestamptz + make_interval(secs => n * 10), extensions.st_setsrid(extensions.st_makepoint(12.5683, 55.6761), 4326), 10
          from generate_series(1, ${TRACK_POINTS_MAX * 2 + 5}) as n`
      const read = await track(olivia, other.id)
      assert.equal(read.thinned, true)
      assert.ok(read.points.length <= TRACK_POINTS_MAX && read.points.length > TRACK_POINTS_MAX * 0.6, String(read.points.length))
      assert.equal(read.points.at(-1)?.at, new Date(at("2026-10-04", "06:00").getTime() + (TRACK_POINTS_MAX * 2 + 5) * 10_000).toISOString(), "the last point kept")
      assert.deepEqual(
        read.points.map((point) => point.at),
        [...read.points.map((point) => point.at)].sort(),
        "in order",
      )
    })

    test("is the Live board's grant and the routes' reach, like the estimates", async () => {
      assert.equal((await viewer(`/routes/${harbor.id}/positions`)).status, 404)
      assert.equal((await theirs(`/routes/${running.id}/positions`)).status, 404)
      assert.equal((await ungranted(`/routes/${running.id}/positions`)).status, 403)
      assert.equal((await viewer(`/routes/${running.id}/positions`)).status, 200, "a route of a project the viewer works in")
    })
  })

  describe("the Live board's row", () => {
    test("carries the open session's newest position and the next stop's estimate with the trip's end; a route without either carries null", async () => {
      const response = await olivia("/routes/live?limit=200")
      assert.equal(response.status, 200)
      const rows = LivePage.parse(await response.json()).items
      const row = rows.find((candidate) => candidate.id === running.id)
      assert.ok(row)
      assert.equal(row.lastPosition?.at, iso("06:15"))
      assert.deepEqual(row.eta, { nextPickupId: running.pickupIds[1], nextAt: iso("06:30"), finishAt: iso("07:36") })
      const unplanned = rows.find((candidate) => candidate.id === harbor.id)
      assert.deepEqual([unplanned?.lastPosition, unplanned?.eta], [null, null])
    })
  })
})

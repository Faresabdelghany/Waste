import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { LiveRoute } from "@waste/contracts/routes"
import { Session } from "@waste/contracts/sessions"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, TOWN_HALL, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const LivePage = Page(LiveRoute)
const SessionPage = Page(Session)

const MODULE = "route-studio.live"

/**
 * The request's clock, pinned to 22:30Z on the first of December: still the
 * 1st in Copenhagen (CET, +01:00, 23:30) and already the 2nd in Cairo (EET,
 * +02:00, 00:30), so "today" differs between the two projects of one company.
 */
const LATE = new Date("2026-12-01T22:30:00Z")

describe("the live endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let theirs: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager: route-studio view, no project. */
  let lars: Call
  let ungranted: Call

  /** The routes the live read is proved on: which are due today on their project's clock, which run, which are neither. */
  let copenhagenToday: SeededRoute
  let copenhagenTomorrow: SeededRoute
  let cairoToday: SeededRoute
  let cairoYesterday: SeededRoute
  let notDispatched: SeededRoute
  let running: SeededRoute
  let paused: SeededRoute
  let harborRunning: SeededRoute

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    theirs = await seedExecution(pool, b, await seedFleet(pool, b, await seedPlanning(pool, b)))
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => LATE })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    const mads = { plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id }
    const fresh = (seed: Parameters<typeof seedRoute>[4]) => seedRoute(pool, a, fleet, ex, seed)
    copenhagenToday = await fresh({ status: "ready", operatingDate: "2026-12-01", ...mads })
    copenhagenTomorrow = await fresh({ status: "ready", operatingDate: "2026-12-02", ...mads })
    cairoToday = await fresh({ project: "cairo", status: "ready", operatingDate: "2026-12-02" })
    cairoYesterday = await fresh({ project: "cairo", status: "ready", operatingDate: "2026-12-01" })
    notDispatched = await fresh({ operatingDate: "2026-12-01", ...mads })
    // A running route whose device recorded two located proofs, the later one at the town hall; and a paused one with a device that never sent a point.
    running = await fresh({
      status: "active",
      operatingDate: "2026-12-01",
      ...mads,
      proofs: [
        { kind: "arrival", pickupIndex: 0, occurredAt: at("2026-12-01", "06:40"), location: { type: "Point", coordinates: [12.5, 55.7] } },
        { kind: "completion", pickupIndex: 0, occurredAt: at("2026-12-01", "06:45"), location: TOWN_HALL },
        { kind: "note", pickupIndex: null, occurredAt: at("2026-12-01", "06:50"), note: "Road works on Parkvej" },
      ],
    })
    paused = await fresh({ status: "active", operatingDate: "2026-11-30", plannedDriverId: fleet.drivers.jonas.id, plannedVehicleId: fleet.vehicles.wh25.id, paused: true, deviceId: "device-jonas-1" })
    harborRunning = await fresh({ project: "harbor", status: "active", operatingDate: "2026-12-01", plannedDriverId: fleet.drivers.henrik.id, plannedVehicleId: fleet.vehicles.harborTruck.id, deviceId: "device-henrik-1" })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const live = async (call: Call, query = "?limit=200") => {
    const response = await call(`/routes/live${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return LivePage.parse(await response.json())
  }
  const sessions = async (call: Call, query = "?limit=200") => {
    const response = await call(`/sessions${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return SessionPage.parse(await response.json())
  }

  describe("GET /routes/live", () => {
    test("answers every active route and every ready one due today on its project's clock, and nothing else", async () => {
      const { items, nextCursor } = await live(olivia)
      assert.equal(nextCursor, null)
      const ids = items.map((row) => row.id)
      assert.deepEqual(
        ids,
        [...ids].sort((x, y) => x.localeCompare(y)),
        "in id order",
      )
      assert.deepEqual(new Set(ids), new Set([copenhagenToday.id, cairoToday.id, running.id, paused.id, harborRunning.id]))
      assert.ok(!ids.includes(copenhagenTomorrow.id), "22:30Z is 23:30 in Copenhagen: tomorrow is not today there")
      assert.ok(!ids.includes(cairoYesterday.id), "and 00:30 in Cairo: the 1st is over there")
      assert.ok(!ids.includes(notDispatched.id), "a planned route reaches no device and is not live")
      assert.ok(!ids.includes(ex.routes.completed.id))
      assert.ok(!ids.includes(ex.routes.ready.id), "ready on 2026-10-05, not today")
    })

    test("carries the open session, whether it is paused, when the device was last seen, the latest point a proof carried, and the progress", async () => {
      const { items } = await live(olivia)
      const byId = new Map(items.map((row) => [row.id, row] as const))
      const due = byId.get(copenhagenToday.id)
      assert.deepEqual([due?.session, due?.paused, due?.lastSeenAt, due?.lastLocation, due?.status], [null, false, null, null, "ready"], "due today, not started")
      const going = byId.get(running.id)
      assert.deepEqual([going?.session?.id, going?.paused, going?.lastSeenAt, going?.lastLocation], [running.sessionId, false, at("2026-12-01", "09:30").toISOString(), TOWN_HALL], "the later located proof wins; the note without a point does not")
      assert.deepEqual(going?.progress, { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 })
      const resting = byId.get(paused.id)
      assert.deepEqual([resting?.session?.id, resting?.paused, resting?.lastLocation, resting?.session?.driverId, resting?.session?.deviceId], [paused.sessionId, true, null, fleet.drivers.jonas.id, "device-jonas-1"], "yesterday's route still runs and reads as paused")
      assert.equal(resting?.session?.pausedAt, at("2026-11-30", "09:00").toISOString())
    })

    test("is bounded by the caller's projects and pages by id; a foreman sees nothing", async () => {
      const copenhagenOnly = (await live(viewer)).items.map((row) => row.id)
      assert.ok(copenhagenOnly.includes(running.id))
      assert.ok(!copenhagenOnly.includes(harborRunning.id), "the viewer works in Copenhagen only")
      assert.ok(!copenhagenOnly.includes(cairoToday.id))
      assert.deepEqual((await live(olivia, `?projectId=${a.projects.cairo.id}`)).items.map((row) => row.id), [cairoToday.id])
      const first = await live(olivia, "?limit=2")
      assert.equal(first.items.length, 2)
      assert.ok(first.nextCursor !== null)
      const rest = await live(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.equal(first.items.length + rest.items.length, 5)
      assert.deepEqual(await live(lars), { items: [], nextCursor: null })
      assert.deepEqual((await refused(await viewer(`/routes/live?projectId=${a.projects.harbor.id}`), 400)).errors?.map((error) => error.path), ["projectId"])
      assert.match((await refused(await ungranted("/routes/live"), 403)).detail ?? "", /view on route-studio\.live/)
      assert.equal((await app.request("/routes/live")).status, 401)
    })
  })

  describe("GET /sessions", () => {
    test("lists the caller's projects' sessions in id order and filters them by route, driver and whether they are open", async () => {
      const everything = await sessions(olivia)
      const ids = everything.items.map((row) => row.id)
      assert.deepEqual(new Set(ids), new Set([ex.routes.completed.sessionId, running.sessionId, paused.sessionId, harborRunning.sessionId]))
      assert.deepEqual(
        ids,
        [...ids].sort((x, y) => x.localeCompare(y)),
      )
      const filtered = async (query: string, call = olivia) => (await sessions(call, `?limit=200${query}`)).items.map((row) => row.id)
      assert.deepEqual(await filtered(`&routeId=${running.id}`), [running.sessionId])
      assert.deepEqual(await filtered(`&driverId=${fleet.drivers.jonas.id}`), [paused.sessionId])
      assert.deepEqual(new Set(await filtered("&open=true")), new Set([running.sessionId, paused.sessionId, harborRunning.sessionId]))
      assert.deepEqual(await filtered("&open=false"), [ex.routes.completed.sessionId])
      assert.deepEqual(await filtered(`&projectId=${a.projects.harbor.id}`), [harborRunning.sessionId])
      assert.ok(!(await filtered("", viewer)).some((id) => id === harborRunning.sessionId), "the viewer works in Copenhagen only")
      assert.deepEqual(await sessions(lars), { items: [], nextCursor: null })
      const one = everything.items.find((row) => row.id === ex.routes.completed.sessionId)
      assert.deepEqual([one?.routeId, one?.driverId, one?.vehicleId, one?.trailerId, one?.deviceId, one?.appVersion, one?.startedAt, one?.endedAt, one?.pausedAt], [ex.routes.completed.id, fleet.drivers.mads.id, fleet.vehicles.wh24.id, null, "device-mads-1", "1.0.0", at(ex.day, "06:00").toISOString(), at(ex.day, "13:00").toISOString(), null])
    })

    test("refuses a route out of reach, a malformed open, a project out of reach and a role without view", async () => {
      assert.deepEqual((await refused(await olivia(`/sessions?routeId=${theirs.routes.completed.id}`), 400)).errors, [{ path: "routeId", message: "Not a route of this project" }])
      assert.deepEqual((await refused(await viewer(`/sessions?routeId=${harborRunning.id}`), 400)).errors, [{ path: "routeId", message: "Not a route of this project" }])
      assert.deepEqual((await refused(await olivia("/sessions?open=maybe"), 400)).errors?.map((error) => error.path), ["open"])
      assert.deepEqual((await refused(await viewer(`/sessions?projectId=${a.projects.harbor.id}`), 400)).errors?.map((error) => error.path), ["projectId"])
      assert.match((await refused(await ungranted("/sessions"), 403)).detail ?? "", /view on route-studio\.live/)
    })
  })

  describe("GET /sessions/:id", () => {
    test("answers one session, and 404 outside the caller's scope", async () => {
      const sessionId = running.sessionId
      assert.ok(sessionId !== null, "an active route went out on a session")
      const response = await olivia(`/sessions/${sessionId}`)
      assert.equal(response.status, 200)
      const one = Session.parse(await response.json())
      assert.deepEqual([one.id, one.routeId, one.endedAt], [sessionId, running.id, null])
      await refused(await olivia(`/sessions/${theirs.routes.completed.sessionId}`), 404)
      await refused(await viewer(`/sessions/${harborRunning.sessionId}`), 404)
      await refused(await lars(`/sessions/${sessionId}`), 404)
      await refused(await olivia(`/sessions/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/sessions/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.match((await refused(await ungranted(`/sessions/${sessionId}`), 403)).detail ?? "", /view on route-studio\.live/)
    })
  })
})

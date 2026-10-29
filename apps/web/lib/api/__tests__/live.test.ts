// The Live board on the adapter (#179, slice 6 of #81): the routes running
// or due today as the API reads them live — each with its open session and
// three readings of it, the latest point a proof carried, when the device
// was last seen, whether it is paused — as the records of
// `route-studio.live`, read-only; and a route's sessions, read from
// `/sessions`. Nothing is written here: the driver's device moves a live
// route, and the office's commands are the route's own (routes.test.ts).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Driver, Vehicle } from "@waste/contracts/fleet"
import type { Project } from "@waste/contracts/organisation"
import { LiveRoute, type Route } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { driverAdapter, vehicleAdapter } from "../records/fleet"
import { LIVE_BOARD_REFRESH_MS, LIVE_MODULE, liveModule, liveRouteAdapter, routeEtas, routeSessions, routeTrack, trackPath, whileWatched } from "../records/live"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-01T07:20:00Z")
const STAMPS = { createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-10-01T07:04:00.000Z" }

const fixturesOf = (workspaceId: "configure" | "fleet" | "route-studio", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const fixtures = fixturesOf("route-studio", "live")

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const wh24: Vehicle = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, registration: "CN 42 018", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: "01a0d2a4-a280-7008-8000-000000000001", ownership: "company", serviceProviderId: null, status: "active", capacityKg: 18_000, requiredLicenceClass: "c", homeDepotId: null, fuel: "hvo", telematicsDeviceId: null, notes: null, compartments: [] }
const wh31: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000002", registration: "CN 42 031", callsign: "WH-31" }
const tr12: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000003", registration: "TR 12 001", callsign: "TR-12", kind: "trailer", compartments: [] }
const mads: Driver = { id: "01a0d2a4-a280-7014-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Mads Jensen", workforceReference: null, employment: "employee", serviceProviderId: null, homeDepotId: null, licenceClass: "ce", licenceNumber: null, licenceExpiry: "2028-12-31", userAccountId: null, status: "active", notes: null, shift: null }

const route: Route = {
  id: "01a0d2a4-a280-7030-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  routeSchemeId: "01a0d2a4-a280-7016-8000-000000000001",
  collectionGroupId: "01a0d2a4-a280-7017-8000-000000000001",
  serviceDate: "2026-10-01",
  operatingDate: "2026-10-01",
  number: 1042,
  label: "RC-1042",
  status: "active",
  note: null,
  cancelReasonCode: null,
  cancelledByGeneration: false,
  generationRunId: null,
  plannedStartTime: "06:30",
  planned: { vehicleId: wh24.id, driverId: mads.id, trailerId: null, serviceProviderId: null, depotId: null, unloadingStationId: null },
  heldAt: null,
  actual: { vehicleId: wh31.id, driverId: mads.id, trailerId: null },
  dispatchedAt: "2026-10-01T04:10:00.000Z",
  startedAt: "2026-10-01T04:31:00.000Z",
  completedAt: null,
  cancelledAt: null,
  progress: { planned: 2, completed: 1, skipped: 0, failed: 0, total: 3, fraction: 1 / 3 },
}
const session: Session = { id: "01a0d2a4-a280-7035-8000-000000000001", ...STAMPS, projectId: copenhagen.id, routeId: route.id, driverId: mads.id, vehicleId: wh31.id, trailerId: null, deviceId: "phone-mads", appVersion: "a1b2c3", startedAt: "2026-10-01T04:31:00.000Z", endedAt: null, pausedAt: null, lastSeenAt: "2026-10-01T07:16:00.000Z" }
const live: LiveRoute = { ...route, activePlan: null, session, lastLocation: { type: "Point", coordinates: [12.568337, 55.676098] }, lastPosition: null, eta: null, lastSeenAt: session.lastSeenAt, paused: false }
const dueToday: LiveRoute = { ...route, id: "01a0d2a4-a280-7030-8000-000000000002", number: 1043, label: "RC-1043", status: "ready", startedAt: null, actual: { vehicleId: null, driverId: null, trailerId: null }, progress: { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 }, activePlan: null, session: null, lastLocation: null, lastPosition: null, eta: null, lastSeenAt: null, paused: false }

const noResolve = (moduleFixtures: readonly BusinessRecord[], resolver: Resolver = NOTHING_RESOLVED): MappingContext => ({ fixtures: moduleFixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const serverIdsOf = (records: readonly BusinessRecord[], ids: readonly string[]) => new Map(records.map((record, index) => [record.id, ids[index]]))
const projectRecord = projectAdapter.toRecord(copenhagen, noResolve(fixturesOf("configure", "organization")))
const vehicleRecords = [wh24, wh31, tr12].map((vehicle) => vehicleAdapter.toRecord(vehicle, noResolve(fixturesOf("fleet", "vehicles"))))
const driverRecord = driverAdapter.toRecord(mads, noResolve(fixturesOf("fleet", "drivers")))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: serverIdsOf([projectRecord], [copenhagen.id]) }, 1)],
  ["fleet.vehicles", loaded({ records: vehicleRecords, serverIds: serverIdsOf(vehicleRecords, [wh24.id, wh31.id, tr12.id]) }, 1)],
  ["fleet.drivers", loaded({ records: [driverRecord], serverIds: serverIdsOf([driverRecord], [mads.id]) }, 1)],
])
const context = (resolver: Resolver = resolverOver(state)): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

describe("the live module", () => {
  test("is switched, after the fleet and the schemes its rows name, and ahead of the routes and the stops, the long windowed reads", () => {
    assert.ok(isServerBacked(LIVE_MODULE.workspaceId, LIVE_MODULE.moduleId))
    const at = SERVER_MODULE_KEYS.indexOf("route-studio.live")
    for (const named of ["configure.organization", "fleet.vehicles", "fleet.drivers", "route-studio.schemes"]) {
      assert.ok(at > SERVER_MODULE_KEYS.indexOf(named), `after ${named}`)
    }
    for (const later of ["route-studio.routes", "route-studio.pickups"]) assert.ok(at < SERVER_MODULE_KEYS.indexOf(later), `before ${later}`)
  })

  test("while the board is watched it is read again every 30 s, on one interval, and no more once it is left", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    let reads = 0
    const stop = whileWatched(() => {
      reads += 1
    })
    t.mock.timers.tick(LIVE_BOARD_REFRESH_MS - 1)
    assert.equal(reads, 0, "the load that mounted the board is its first read")
    t.mock.timers.tick(1)
    assert.equal(reads, 1)
    t.mock.timers.tick(LIVE_BOARD_REFRESH_MS * 2)
    assert.equal(reads, 3)
    stop()
    t.mock.timers.tick(LIVE_BOARD_REFRESH_MS * 2)
    assert.equal(reads, 3, "cleared on unmount")
    assert.equal(LIVE_BOARD_REFRESH_MS, 30_000)
  })

  test("reads the routes running or due today from /routes/live", async () => {
    const { fetch, calls } = scripted([() => json({ items: [live, dueToday], nextCursor: null })])
    const result = await loadModule(clientOver(fetch), liveModule, { fixtures, state, now: NOW })
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://api.test/routes/live?limit=200"],
    )
    assert.deepEqual(
      result.records.map((record) => record.id),
      [`route-${live.id}`, `route-${dueToday.id}`],
      "a live row is its route, under the route's own web id",
    )
  })
})

describe("a live route", () => {
  test("the wire fixtures are the contracts' shapes", () => {
    assert.ok(LiveRoute.safeParse(live).success)
    assert.ok(LiveRoute.safeParse(dueToday).success)
  })

  test("an assignment names the trailer after the vehicle, the planned and the actual alike", () => {
    const hauling: LiveRoute = { ...live, planned: { ...live.planned, trailerId: tr12.id }, actual: { ...live.actual, trailerId: tr12.id }, session: { ...session, trailerId: tr12.id } }
    const record = liveRouteAdapter.toRecord(hauling, context())
    assert.equal(record.facts["Planned assignment"], "Mads Jensen · WH-24 · TR-12")
    assert.equal(record.facts["Actual assignment"], "Mads Jensen · WH-31 · TR-12")
    assert.equal(record.context, "Mads Jensen · WH-31 · TR-12")
  })

  test("reads its progress, its actual assignment and where its device last was", () => {
    const record = liveRouteAdapter.toRecord(live, context())
    assert.equal(record.name, "RC-1042")
    assert.equal(record.status, "Active")
    assert.equal(record.value, "33% · 1/3 stops", "the table's progress circle reads the percentage")
    assert.equal(record.context, "Mads Jensen · WH-31")
    assert.equal(record.recordKind, "Active route")
    assert.equal(record.facts["Planned assignment"], "Mads Jensen · WH-24")
    assert.equal(record.facts["Actual assignment"], "Mads Jensen · WH-31")
    assert.equal(record.facts["Last position"], "55.67610, 12.56834")
    assert.equal(record.facts["Last seen"], "2026-10-01 09:16", "on the project's clock")
    assert.equal(record.facts["Position freshness"], "4 minutes ago")
    assert.equal(record.facts["Session started"], "2026-10-01 06:31")
    assert.equal(record.facts.Device, "phone-mads")
    assert.equal(record.submittedValues?.latitude, "55.676098")
    assert.equal(record.submittedValues?.longitude, "12.568337")
    assert.equal(record.submittedValues?.sessionId, session.id)
  })

  test("a paused session reads Paused; a route due today that has not started has no session and no position yet", () => {
    assert.equal(liveRouteAdapter.toRecord({ ...live, paused: true, session: { ...session, pausedAt: "2026-10-01T07:00:00.000Z" } }, context()).status, "Paused")
    const ready = liveRouteAdapter.toRecord(dueToday, context())
    assert.equal(ready.status, "Ready")
    assert.equal(ready.value, "0% · 0/3 stops")
    assert.equal(ready.context, "Mads Jensen · WH-24", "before a session, the Planned Assignment is what will run it")
    assert.equal(ready.facts["Actual assignment"], "Not started")
    assert.equal(ready.facts["Last position"], "No position yet")
    assert.equal(ready.facts["Position freshness"], "No session")
  })

  test("is read-only: nothing is created, edited or commanded here", async () => {
    assert.equal(liveRouteAdapter.toCreateBody, undefined)
    assert.equal(liveRouteAdapter.commands, undefined)
    const record = liveRouteAdapter.toRecord(live, context())
    const { fetch, calls } = scripted([])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, live.id]]) }, 1)
    assert.equal((await writeRecord(clientOver(fetch), liveModule, current, { ...record, status: "Completed" }, { fixtures, state, now: NOW })).kind, "refused")
    assert.equal((await writeRecord(clientOver(fetch), liveModule, current, { ...record, name: "RC-9" }, { fixtures, state, now: NOW })).kind, "refused")
    assert.equal(calls.length, 0)
  })

  test("with a recorded position (O8 of #290), reads where the session's vehicle last was and how fresh that is, and the next stop's estimate and the trip's end on the project's clock", () => {
    const tracked: LiveRoute = {
      ...live,
      lastPosition: { at: "2026-10-01T07:18:00.000Z", location: { type: "Point", coordinates: [12.6, 55.7] }, accuracyM: 8, speedKmh: 30, headingDeg: 90 },
      eta: { nextPickupId: "01a0d2a4-a280-7031-8000-000000000002", nextAt: "2026-10-01T07:31:00.000Z", finishAt: "2026-10-01T09:05:00.000Z" },
    }
    assert.ok(LiveRoute.safeParse(tracked).success)
    const record = liveRouteAdapter.toRecord(tracked, context())
    assert.equal(record.facts["Last position"], "55.70000, 12.60000", "the recorded position, not the proof's point")
    assert.equal(record.facts["Position freshness"], "2 minutes ago", "the position's age, not the device's")
    assert.equal(record.facts["Position recorded"], "2026-10-01 09:18")
    assert.equal(record.facts["Next stop expected"], "09:31")
    assert.equal(record.facts["Expected finish"], "11:05")
    assert.equal(record.submittedValues?.latitude, "55.7")
    const done = liveRouteAdapter.toRecord({ ...tracked, eta: { nextPickupId: null, nextAt: null, finishAt: null } }, context())
    assert.equal(done.facts["Next stop expected"], "No stop to come")
    assert.equal(done.facts["Expected finish"], undefined)
    assert.equal(liveRouteAdapter.toRecord(live, context()).facts["Next stop expected"], undefined, "a route without an active Plan says nothing of it")
  })

  test("a route's track and its estimates are read from the route, one row each", async () => {
    const track = { routeId: live.id, sessionId: session.id, points: [], thinned: false }
    const eta = { routeId: live.id, planId: null, computedAt: NOW.toISOString(), stops: [], finishAt: null }
    const { fetch, calls } = scripted([() => json(track), () => json(eta)])
    assert.deepEqual(await routeTrack(clientOver(fetch), live.id), [track])
    assert.deepEqual(await routeEtas(clientOver(fetch), live.id), [eta])
    assert.deepEqual(
      calls.map((call) => call.url),
      [`http://api.test/routes/${live.id}/positions`, `http://api.test/routes/${live.id}/eta`],
    )
  })

  test("a track is drawn north up in its box, scaled to its extent, and needs two points", () => {
    const point = (lon: number, lat: number) => ({ location: { coordinates: [lon, lat] as [number, number] } })
    assert.equal(trackPath([], 100, 100), null)
    assert.equal(trackPath([point(12.5, 55.7)], 100, 100), null)
    // A due-north line: centred across, top to bottom.
    assert.equal(trackPath([point(12.5, 55.7), point(12.5, 55.71)], 100, 100), "M50.0 100.0 L50.0 0.0")
    const path = trackPath([point(12.5, 55.7), point(12.52, 55.7), point(12.52, 55.71)], 200, 100) ?? ""
    assert.match(path, /^M\S+ \S+ L\S+ \S+ L\S+ \S+$/)
  })

  test("a route's sessions are read from /sessions, by route", async () => {
    const { fetch, calls } = scripted([() => json({ items: [session], nextCursor: null })])
    assert.deepEqual(await routeSessions(clientOver(fetch), live.id), [session])
    assert.equal(calls[0].url, `http://api.test/sessions?limit=200&routeId=${live.id}`)
  })
})

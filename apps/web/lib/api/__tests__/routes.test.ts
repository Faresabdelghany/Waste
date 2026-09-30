// Routes on the adapter (#179, slice 6 of #81): the dated Route generation
// wrote as the records of `route-studio.routes`, the table, the map and the
// route's details read; the dispatcher's five commands — assign, dispatch,
// reschedule, cancel and the stop order — whose bodies are held here
// against the contracts' own zod schemas, sent through the store's seam over
// a scripted `fetch`, the API's refusals coming back as its sentences. A
// route is never created or edited here: generation writes it, and its
// status moves by command alone.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { WasteFraction } from "@waste/contracts/catalogue"
import type { Driver, Vehicle } from "@waste/contracts/fleet"
import type { Project } from "@waste/contracts/organisation"
import type { Depot, UnloadingStation } from "@waste/contracts/places"
import { PickupOrderSet, Route, RouteAssign, RouteCancel, RouteDetail, RouteReschedule } from "@waste/contracts/routes"
import type { ActivePlan } from "@waste/contracts/plans"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { ROUTE_ACTIVE_PLAN_KEY } from "../../data/routes"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { driverAdapter, vehicleAdapter } from "../records/fleet"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { depotAdapter, unloadingStationAdapter } from "../records/places"
import {
  ASSIGN_ROUTE,
  CANCEL_ROUTE,
  DISPATCH_ROUTE,
  REORDER_ROUTE,
  RESCHEDULE_ROUTE,
  ROUTES_MODULE,
  routeAdapter,
  routeCommandLog,
  routeDetail,
  routesModule,
} from "../records/routes"
import { commandRecord, loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T02:00:00.000Z" }
const at = (lng: number, lat: number) => ({ type: "Point" as const, coordinates: [lng, lat] as [number, number] })

const fixturesOf = (workspaceId: "configure" | "fleet" | "resources" | "route-studio", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const fixtures = fixturesOf("route-studio", "routes")

// The seeded rows the store has loaded before the routes, as the API answers them.
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const nordhavn: Depot = { id: "01a0d2a4-a280-7010-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "DEPOT-NORDHAVN", name: "Nordhavn Depot", address: "Kaj 14, Nordhavn", location: at(12.5958, 55.7091), ownership: "company", serviceProviderId: null, opensAt: "05:00", closesAt: "22:00", vehicleCapacity: null, status: "active", notes: null }
const arc: UnloadingStation = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, code: "STATION-ARC", name: "ARC Amager", address: "Kraftværksvej 31", location: at(12.6186, 55.6903), ownership: "external", serviceProviderId: null, opensAt: null, closesAt: null, weighbridge: true, status: "active", notes: null, wasteFractionIds: [residual.id] }
const compartment = { position: 1, name: null, capacityKg: null, volumeLitres: null, wasteFractionIds: [residual.id] }
const wh24: Vehicle = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, registration: "CN 42 018", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: "01a0d2a4-a280-7008-8000-000000000001", ownership: "company", serviceProviderId: null, status: "active", capacityKg: 18_000, requiredLicenceClass: "c", homeDepotId: nordhavn.id, fuel: "hvo", telematicsDeviceId: null, notes: null, compartments: [compartment] }
const wh31: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000002", registration: "CN 42 031", callsign: "WH-31" }
const trailer: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000005", registration: "TR 12 012", callsign: "WH-T12", kind: "trailer", requiredLicenceClass: "ce", fuel: null, compartments: [] }
const mads: Driver = { id: "01a0d2a4-a280-7014-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Mads Jensen", workforceReference: null, employment: "employee", serviceProviderId: null, homeDepotId: null, licenceClass: "ce", licenceNumber: null, licenceExpiry: "2028-12-31", userAccountId: null, status: "active", notes: null }
const freja: Driver = { ...mads, id: "01a0d2a4-a280-7014-8000-000000000002", name: "Freja Nielsen" }

const schemeId = "01a0d2a4-a280-7016-8000-000000000001"
const groupId = "01a0d2a4-a280-7017-8000-000000000001"

const planned: Route = {
  id: "01a0d2a4-a280-7030-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  routeSchemeId: schemeId,
  collectionGroupId: groupId,
  serviceDate: "2026-10-01",
  operatingDate: "2026-10-01",
  number: 1042,
  label: "RC-1042",
  status: "planned",
  note: null,
  cancelledByGeneration: false,
  generationRunId: "01a0d2a4-a280-7031-8000-000000000001",
  plannedStartTime: "06:30",
  planned: { vehicleId: wh24.id, driverId: mads.id, trailerId: null, serviceProviderId: null, depotId: nordhavn.id, unloadingStationId: arc.id },
  actual: { vehicleId: null, driverId: null, trailerId: null },
  dispatchedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  progress: { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 },
}
const plan: ActivePlan = { id: "01a0d2a4-a280-7032-8000-000000000001", solver: "manual", status: "ready", trip: "full", distanceMetres: 18_400, durationSeconds: 2_700, stale: false, deferredUntil: null }
const detailOf = (route: Route, over: Partial<RouteDetail> = {}): RouteDetail => ({ ...route, pickups: [], activePlan: null, session: null, sessions: [], unloads: [], ...over })

// What the store has loaded when the routes load: the organisation, the places, the fleet.
const noResolve = (moduleFixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures: moduleFixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const projectRecord = projectAdapter.toRecord(copenhagen, noResolve(fixturesOf("configure", "organization")))
const depotRecord = depotAdapter.toRecord(nordhavn, noResolve(fixturesOf("resources", "depots")))
const stationRecord = unloadingStationAdapter.toRecord(arc, noResolve(fixturesOf("resources", "depots")))
const organisationState = (): ServerRecordsState => new Map([["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)]])
const vehicleRecords = [wh24, wh31, trailer].map((vehicle) => vehicleAdapter.toRecord(vehicle, { ...noResolve(fixturesOf("fleet", "vehicles")), resolve: resolverOver(organisationState()) }))
const driverRecords = [mads, freja].map((driver) => driverAdapter.toRecord(driver, { ...noResolve(fixturesOf("fleet", "drivers")), resolve: resolverOver(organisationState()) }))
const serverIdsOf = (records: readonly BusinessRecord[], ids: readonly string[]) => new Map(records.map((record, index) => [record.id, ids[index]]))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: serverIdsOf([projectRecord], [copenhagen.id]) }, 1)],
  ["resources.depots", loaded({ records: [depotRecord, stationRecord], serverIds: serverIdsOf([depotRecord, stationRecord], [nordhavn.id, arc.id]) }, 1)],
  ["fleet.vehicles", loaded({ records: vehicleRecords, serverIds: serverIdsOf(vehicleRecords, [wh24.id, wh31.id, trailer.id]) }, 1)],
  ["fleet.drivers", loaded({ records: driverRecords, serverIds: serverIdsOf(driverRecords, [mads.id, freja.id]) }, 1)],
])
const resolve = resolverOver(state)
const context = (resolver: Resolver = resolve): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const options = { fixtures, state, now: NOW }
const pageOf = (items: unknown[], nextCursor: string | null = null) => json({ items, nextCursor })

const [wh24Record, wh31Record, trailerRecord] = vehicleRecords
const [madsRecord, frejaRecord] = driverRecords

describe("the routes module", () => {
  test("is switched, after every module a route names a row of", () => {
    assert.ok(isServerBacked(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId))
    const at = SERVER_MODULE_KEYS.indexOf("route-studio.routes")
    for (const named of ["configure.organization", "service-providers.service-providers", "resources.depots", "fleet.vehicles", "fleet.drivers"]) {
      assert.ok(at > SERVER_MODULE_KEYS.indexOf(named), `after ${named}`)
    }
  })

  test("reads every route, page after page, and no fixture lends its id", async () => {
    const second: Route = { ...planned, id: "01a0d2a4-a280-7030-8000-000000000002", number: 1043, label: "RC-1043" }
    const { fetch, calls } = scripted([() => pageOf([planned], "next-page"), () => pageOf([second])])
    const result = await loadModule(clientOver(fetch), routesModule, options)
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://api.test/routes?limit=200", "http://api.test/routes?limit=200&cursor=next-page"],
    )
    assert.deepEqual(
      result.records.map((record) => record.id),
      [`route-${planned.id}`, `route-${second.id}`],
      "RC-1042 is a fixture's name too: a server route is route-<uuid> from the start",
    )
    assert.equal(result.serverIds.get(`route-${planned.id}`), planned.id)
  })
})

describe("a route", () => {
  test("the wire fixtures are the contracts' shapes", () => {
    assert.ok(Route.safeParse(planned).success)
    assert.ok(RouteDetail.safeParse(detailOf(planned, { activePlan: plan })).success)
  })

  test("is the record the Routes table, the map and the route's details read", () => {
    const record = routeAdapter.toRecord(planned, context())
    assert.equal(record.id, `route-${planned.id}`)
    assert.equal(record.name, "RC-1042")
    assert.equal(record.status, "Planned")
    assert.equal(record.owner, "Mads Jensen")
    assert.equal(record.value, "3 stops", "the map counts a route's stops off its value")
    assert.equal(record.context, "Copenhagen Central")
    assert.equal(record.recordKind, "Route")
    assert.equal(record.source, "Waste API")
    assert.deepEqual(record.projectIds, [projectRecord.id])
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.deepEqual(record.facts, {
      Project: "Copenhagen Central",
      "Route scheme": `scheme-${schemeId}`,
      "Service date": "2026-10-01",
      "Operating date": "2026-10-01",
      "Planned start": "06:30",
      Vehicle: "WH-24",
      Driver: "Mads Jensen",
      Depot: "Nordhavn Depot",
      Unloading: "ARC Amager",
      Deviation: "None",
    })
    assert.deepEqual(record.submittedValues, {
      projectId: projectRecord.id,
      schemeId: `scheme-${schemeId}`,
      collectionGroupId: `group-${groupId}`,
      serviceDate: "2026-10-01",
      operatingDate: "2026-10-01",
      actualDate: "2026-10-01",
      plannedStartTime: "06:30",
      vehicleId: wh24Record.id,
      driverId: madsRecord.id,
      trailerId: "",
      depotId: depotRecord.id,
      unloadingStationId: stationRecord.id,
      status: "planned",
    })
  })

  test("names its references by id chip until their modules load, and its scheme by the scheme's web id", () => {
    const record = routeAdapter.toRecord(planned, context(NOTHING_RESOLVED))
    assert.equal(record.facts.Vehicle, `vehicle-${wh24.id}`)
    assert.equal(record.facts.Driver, `driver-${mads.id}`)
    assert.equal(record.submittedValues?.vehicleId, `vehicle-${wh24.id}`)
    assert.equal(record.submittedValues?.driverId, `driver-${mads.id}`)
    assert.equal(record.submittedValues?.depotId, `depot-${nordhavn.id}`)
    assert.equal(record.submittedValues?.unloadingStationId, `station-${arc.id}`)
    assert.equal(record.submittedValues?.schemeId, `scheme-${schemeId}`, "the web id #177's adapter gives the scheme, so a link lands once the schemes load")
    assert.deepEqual(record.projectIds, [`project-${copenhagen.id}`])
  })

  test("reads each status as the table, the map and the lifecycle spell it", () => {
    const words = { planned: "Planned", ready: "Ready", active: "Active", completed: "Completed", cancelled: "Cancelled" } as const
    for (const [token, word] of Object.entries(words)) {
      assert.equal(routeAdapter.toRecord({ ...planned, status: token as Route["status"] }, context()).status, word)
    }
  })

  test("its value counts the stops, and the ones decided once any are", () => {
    const valueOf = (progress: Route["progress"]) => routeAdapter.toRecord({ ...planned, progress }, context()).value
    assert.equal(valueOf({ planned: 1, completed: 0, skipped: 0, failed: 0, total: 1, fraction: 0 }), "1 stop")
    assert.equal(valueOf({ planned: 1, completed: 1, skipped: 1, failed: 0, total: 3, fraction: 2 / 3 }), "2/3 stops")
    assert.equal(valueOf({ planned: 0, completed: 3, skipped: 0, failed: 0, total: 3, fraction: 1 }), "3/3 stops")
    assert.equal(valueOf({ planned: 0, completed: 0, skipped: 0, failed: 0, total: 0, fraction: 0 }), "0 stops")
  })

  test("says what moved it: the dispatch, the start, the actual assignment, a cancellation's reason", () => {
    const cancelled: Route = {
      ...planned,
      status: "cancelled",
      note: "Road closed on Nørrebrogade",
      dispatchedAt: "2026-10-01T04:10:00.000Z",
      startedAt: "2026-10-01T04:31:00.000Z",
      cancelledAt: "2026-10-01T06:02:00.000Z",
      actual: { vehicleId: wh31.id, driverId: freja.id, trailerId: trailer.id },
      planned: { ...planned.planned, trailerId: trailer.id },
    }
    const record = routeAdapter.toRecord(cancelled, context())
    assert.equal(record.facts.Deviation, "Road closed on Nørrebrogade")
    assert.equal(record.facts["Dispatched at"], "2026-10-01 06:10", "on the project's clock: Copenhagen is two hours ahead in summer time")
    assert.equal(record.facts["Started at"], "2026-10-01 06:31")
    assert.equal(record.facts["Cancelled at"], "2026-10-01 08:02")
    assert.equal(record.facts.Trailer, "WH-T12")
    assert.equal(record.facts["Actual assignment"], "Freja Nielsen · WH-31 · WH-T12")
    assert.equal(record.submittedValues?.trailerId, trailerRecord.id)
  })

  test("carries the active Plan the read gives it, as JSON under the key the map reads, and nothing when the read says nothing", () => {
    assert.equal(routeAdapter.toRecord(planned, context()).submittedValues?.[ROUTE_ACTIVE_PLAN_KEY], undefined, "GET /routes carries no activePlan yet (#173 adds it)")
    assert.equal(routeAdapter.toRecord(detailOf(planned), context()).submittedValues?.[ROUTE_ACTIVE_PLAN_KEY], "null")
    assert.deepEqual(JSON.parse(String(routeAdapter.toRecord(detailOf(planned, { activePlan: plan }), context()).submittedValues?.[ROUTE_ACTIVE_PLAN_KEY])), plan)
  })

  test("is never created or edited here: generation writes it and its commands move it", async () => {
    assert.equal(routeAdapter.toCreateBody, undefined)
    assert.equal(routeAdapter.create, undefined)
    assert.equal(routeAdapter.statuses, undefined, "a route's status moves by command alone")
    const record = routeAdapter.toRecord(planned, context())
    const edited: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, plannedStartTime: "07:00" } }
    assert.deepEqual(routeAdapter.toPatchBody(record, edited, context()), { path: "", message: "A route is changed by its commands: assign, dispatch, reschedule, cancel or reorder its stops" })
    const { fetch, calls } = scripted([])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)
    const moved = await writeRecord(clientOver(fetch), routesModule, current, { ...record, status: "Ready" }, options)
    assert.equal(moved.kind, "refused")
    const edit = await writeRecord(clientOver(fetch), routesModule, current, edited, options)
    assert.equal(edit.kind, "refused")
    assert.equal(calls.length, 0)
  })
})

describe("the route's commands", () => {
  const record = routeAdapter.toRecord(planned, context())
  const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)
  const assign = routeAdapter.commands?.[ASSIGN_ROUTE]
  const reschedule = routeAdapter.commands?.[RESCHEDULE_ROUTE]
  const cancel = routeAdapter.commands?.[CANCEL_ROUTE]
  const reorder = routeAdapter.commands?.[REORDER_ROUTE]

  test("assign sends only what moved, by server id, a cleared field as null", () => {
    const body = assign?.toBody?.({ vehicleId: wh31Record.id, driverId: frejaRecord.id, trailerId: "", depotId: depotRecord.id, unloadingStationId: "" }, record, context())
    assert.deepEqual(body, { vehicleId: wh31.id, driverId: freja.id, unloadingStationId: null })
    assert.ok(RouteAssign.safeParse(body).success)
    const trailerOnly = assign?.toBody?.({ ...record.submittedValues, trailerId: trailerRecord.id }, record, context())
    assert.deepEqual(trailerOnly, { trailerId: trailer.id })
    assert.ok(RouteAssign.safeParse(trailerOnly).success)
  })

  test("assign is refused here when nothing moved, or a field names no row of its kind the API holds", () => {
    assert.deepEqual(assign?.toBody?.({ ...record.submittedValues }, record, context()), { path: "vehicleId", message: "Nothing to assign: pick another vehicle, driver, trailer, depot or unloading station" })
    assert.deepEqual(assign?.toBody?.({ ...record.submittedValues, vehicleId: "vehicle-wh-24" }, record, context()), { path: "vehicleId", message: "Pick a vehicle the API holds" })
    assert.deepEqual(assign?.toBody?.({ ...record.submittedValues, driverId: wh31Record.id }, record, context()), { path: "driverId", message: "Pick a driver the API holds" })
    assert.deepEqual(assign?.toBody?.({ ...record.submittedValues, depotId: stationRecord.id }, record, context()), { path: "depotId", message: "Pick a depot the API holds" })
    assert.deepEqual(assign?.toBody?.({ ...record.submittedValues, unloadingStationId: depotRecord.id }, record, context()), { path: "unloadingStationId", message: "Pick an unloading station the API holds" })
    // An id chip the record shows before the fleet loads still travels as its id.
    assert.deepEqual(assign?.toBody?.({ ...record.submittedValues, vehicleId: `vehicle-${wh31.id}` }, record, context(NOTHING_RESOLVED)), { vehicleId: wh31.id })
  })

  test("assign posts its body and the route the API answers replaces the row", async () => {
    const { fetch, calls } = scripted([() => json(detailOf({ ...planned, planned: { ...planned.planned, driverId: freja.id } }))])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, ASSIGN_ROUTE, { ...record.submittedValues, driverId: frejaRecord.id }, options)
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}/assign`)
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(bodyOf(calls[0]), { driverId: freja.id })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.id, record.id)
    assert.equal(outcome.record.facts.Driver, "Freja Nielsen")
  })

  test("dispatch posts no body, and the route is Ready", async () => {
    const { fetch, calls } = scripted([() => json(detailOf({ ...planned, status: "ready", dispatchedAt: "2026-10-01T04:10:00.000Z" }))])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, DISPATCH_ROUTE, undefined, options)
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}/dispatch`)
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.body, undefined)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Ready")
  })

  test("the API's 409 on a dispatch without a planned driver comes back as its sentence, under the route's name", async () => {
    const detail = "Route RC-1042 has no planned driver; assign one first"
    const { fetch } = scripted([() => problem(409, detail)])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, DISPATCH_ROUTE, undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.what, "RC-1042 was not dispatched")
    assert.equal(problemSentence(outcome.problem), detail)
  })

  test("reschedule moves the day it runs or its planned start, never the service date; a cleared start is null", () => {
    const moved = reschedule?.toBody?.({ operatingDate: "2026-10-02", plannedStartTime: "07:15" }, record, context())
    assert.deepEqual(moved, { operatingDate: "2026-10-02", plannedStartTime: "07:15" })
    assert.ok(RouteReschedule.safeParse(moved).success)
    const cleared = reschedule?.toBody?.({ operatingDate: "2026-10-01", plannedStartTime: "" }, record, context())
    assert.deepEqual(cleared, { plannedStartTime: null })
    assert.ok(RouteReschedule.safeParse(cleared).success)
    assert.deepEqual(reschedule?.toBody?.({ operatingDate: "2026-10-01", plannedStartTime: "06:30" }, record, context()), { path: "operatingDate", message: "Nothing to reschedule: move the day it runs or its planned start" })
    assert.deepEqual(reschedule?.toBody?.({ operatingDate: "1 October", plannedStartTime: "06:30" }, record, context()), { path: "operatingDate", message: "Give the day it runs as a date" })
    assert.deepEqual(reschedule?.toBody?.({ operatingDate: "2026-10-01", plannedStartTime: "6.30" }, record, context()), { path: "plannedStartTime", message: "Give the planned start as HH:MM" })
    assert.deepEqual(reschedule?.toBody?.({ operatingDate: "", plannedStartTime: "06:30" }, record, context()), { path: "operatingDate", message: "A route runs on a day: give its operating date" })
  })

  test("reschedule posts to its path", async () => {
    const { fetch, calls } = scripted([() => json(detailOf({ ...planned, operatingDate: "2026-10-02" }))])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, RESCHEDULE_ROUTE, { operatingDate: "2026-10-02", plannedStartTime: "06:30" }, options)
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}/reschedule`)
    assert.deepEqual(bodyOf(calls[0]), { operatingDate: "2026-10-02" })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.facts["Operating date"], "2026-10-02")
    assert.equal(outcome.record.facts["Service date"], "2026-10-01")
  })

  test("cancel carries its reason, which becomes the route's deviation; without one it is refused here", async () => {
    const body = cancel?.toBody?.({ reason: "Road closed on Nørrebrogade" }, record, context())
    assert.deepEqual(body, { reason: "Road closed on Nørrebrogade" })
    assert.ok(RouteCancel.safeParse(body).success)
    assert.deepEqual(cancel?.toBody?.({ reason: "  " }, record, context()), { path: "reason", message: "Say why the route is cancelled" })
    const { fetch, calls } = scripted([() => json(detailOf({ ...planned, status: "cancelled", note: "Road closed on Nørrebrogade", cancelledAt: "2026-10-01T06:02:00.000Z" }))])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, CANCEL_ROUTE, { reason: "Road closed on Nørrebrogade" }, options)
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}/cancel`)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Cancelled")
    assert.equal(outcome.record.facts.Deviation, "Road closed on Nørrebrogade")
  })

  test("the stop order is PUT whole, every open pickup once by server id, and the answer carries the new Plan", async () => {
    const first = "01a0d2a4-a280-7033-8000-000000000001"
    const second = "01a0d2a4-a280-7033-8000-000000000002"
    const pickupRecords = [first, second].map((id) => ({ ...record, id: `pickup-${id}`, recordKind: "Pickup" }))
    const withPickups: ServerRecordsState = new Map([...state, ["route-studio.pickups", loaded({ records: pickupRecords, serverIds: serverIdsOf(pickupRecords, [first, second]) }, 1)]])
    const body = reorder?.toBody?.({ pickupIds: [`pickup-${second}`, `pickup-${first}`] }, record, context(resolverOver(withPickups)))
    assert.deepEqual(body, { pickupIds: [second, first] })
    assert.ok(PickupOrderSet.safeParse(body).success)
    assert.deepEqual(reorder?.toBody?.({ pickupIds: [] }, record, context()), { path: "pickupIds", message: "Order the route's open stops" })
    assert.deepEqual(reorder?.toBody?.({ pickupIds: ["pickup-1042-01"] }, record, context()), { path: "pickupIds", message: "Order the stops the API holds for this route" })

    const { fetch, calls } = scripted([() => json(detailOf(planned, { activePlan: { ...plan, status: "calculating", distanceMetres: null, durationSeconds: null } }))])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, REORDER_ROUTE, { pickupIds: [`pickup-${second}`, `pickup-${first}`] }, { ...options, state: withPickups })
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}/pickup-order`)
    assert.equal(calls[0].init.method, "PUT")
    assert.deepEqual(bodyOf(calls[0]), { pickupIds: [second, first] })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(JSON.parse(String(outcome.record.submittedValues?.[ROUTE_ACTIVE_PLAN_KEY])).solver, "manual")
  })

  test("the route's own read gives its stops in sequence, its sessions and its unloads; its command log is the device's", async () => {
    const detail = detailOf({ ...planned, status: "ready" })
    const receipts = { items: [], nextCursor: null }
    const { fetch, calls } = scripted([() => json(detail), () => json(receipts)])
    assert.deepEqual(await routeDetail(clientOver(fetch), planned.id), detail)
    assert.deepEqual(await routeCommandLog(clientOver(fetch), planned.id), [])
    assert.deepEqual(
      calls.map((call) => call.url),
      [`http://api.test/routes/${planned.id}`, `http://api.test/routes/${planned.id}/commands?limit=200`],
    )
  })
})

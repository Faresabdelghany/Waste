// Routes on the adapter (#179, slice 6 of #81): the dated Route generation
// wrote as the records of `route-studio.routes`, the table, the map and the
// route's details read; the dispatcher's five commands — assign, dispatch,
// reschedule, cancel and the stop order — whose bodies are held here
// against the contracts' own zod schemas, sent through the store's seam over
// a scripted `fetch`, the API's refusals coming back as its sentences. Since
// #111 the office makes an ad-hoc route here (New route) and adds a stop to
// a route (Add stop); a route is never edited, and its status moves by
// command alone.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { WasteFraction } from "@waste/contracts/catalogue"
import type { Driver, Vehicle } from "@waste/contracts/fleet"
import type { Project } from "@waste/contracts/organisation"
import type { Depot, UnloadingStation } from "@waste/contracts/places"
import { PickupAdd } from "@waste/contracts/pickups"
import { DISPATCH_MANY_MAX, PickupOrderSet, Route, RouteAssign, RouteBalanceApply, RouteBalanceDay, RouteBalancePreview, RouteMerge, RouteMoveStops, RouteSplit, RouteCancel, RouteCreate, RouteDetail, RouteDispatchMany, RouteReleaseHold, RouteReschedule, type RouteShift, type RouteWorkload } from "@waste/contracts/routes"
import type { ActivePlan, Plan } from "@waste/contracts/plans"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { createRouteRecord, ROUTE_ACTIVE_PLAN_KEY } from "../../data/routes"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { driverAdapter, vehicleAdapter } from "../records/fleet"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { depotAdapter, unloadingStationAdapter } from "../records/places"
import {
  ADD_STOP,
  addedStopBody,
  ASSIGN_ROUTE,
  CANCEL_ROUTE,
  applyBalance,
  balanceMoveLine,
  dayLoadLine,
  DISPATCH_BATCH,
  DISPATCH_ROUTE,
  dispatchRoutes,
  previewBalance,
  isHeldRoute,
  MADE_BY_THE_OFFICE,
  OPTIMISE_ROUTE,
  planLine,
  RELEASE_HOLD,
  REORDER_ROUTE,
  MOVE_STOPS,
  SPLIT_ROUTE,
  MERGE_ROUTE,
  RESCHEDULE_ROUTE,
  ROUTES_MODULE,
  ROUTES_WINDOW_DAYS,
  routeAdapter,
  routeCommandLog,
  routeDetail,
  routePlans,
  routesModule,
  routesWindowFrom,
} from "../records/routes"
import { commandRecord, loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T02:00:00.000Z" }
const at = (lng: number, lat: number) => ({ type: "Point" as const, coordinates: [lng, lat] as [number, number] })

const fixturesOf = (workspaceId: "configure" | "fleet" | "resources" | "route-studio", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const fixtures = fixturesOf("route-studio", "routes")

// The seeded rows the store has loaded before the routes, as the API answers them.
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual", wasteCode: null, treatment: null, densityKgPerCubicMetre: null, hazardous: false }
const nordhavn: Depot = { id: "01a0d2a4-a280-7010-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "DEPOT-NORDHAVN", name: "Nordhavn Depot", address: "Kaj 14, Nordhavn", location: at(12.5958, 55.7091), ownership: "company", serviceProviderId: null, opensAt: "05:00", closesAt: "22:00", vehicleCapacity: null, status: "active", notes: null }
const arc: UnloadingStation = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, code: "STATION-ARC", name: "ARC Amager", address: "Kraftværksvej 31", location: at(12.6186, 55.6903), ownership: "external", serviceProviderId: null, opensAt: null, closesAt: null, weighbridge: true, status: "active", notes: null, wasteFractionIds: [residual.id] }
const compartment = { position: 1, name: null, capacityKg: null, volumeLitres: null, wasteFractionIds: [residual.id] }
const wh24: Vehicle = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, registration: "CN 42 018", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: "01a0d2a4-a280-7008-8000-000000000001", ownership: "company", serviceProviderId: null, status: "active", capacityKg: 18_000, requiredLicenceClass: "c", homeDepotId: nordhavn.id, fuel: "hvo", telematicsDeviceId: null, notes: null, compartments: [compartment] }
const wh31: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000002", registration: "CN 42 031", callsign: "WH-31" }
const trailer: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000005", registration: "TR 12 012", callsign: "WH-T12", kind: "trailer", requiredLicenceClass: "ce", fuel: null, compartments: [] }
const mads: Driver = { id: "01a0d2a4-a280-7014-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Mads Jensen", workforceReference: null, employment: "employee", serviceProviderId: null, homeDepotId: null, licenceClass: "ce", licenceNumber: null, licenceExpiry: "2028-12-31", userAccountId: null, status: "active", notes: null, shift: null }
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
  cancelReasonCode: null,
  cancelledByGeneration: false,
  generationRunId: "01a0d2a4-a280-7031-8000-000000000001",
  plannedStartTime: "06:30",
  planned: { vehicleId: wh24.id, driverId: mads.id, trailerId: null, serviceProviderId: null, depotId: nordhavn.id, unloadingStationId: arc.id },
  heldAt: null,
  actual: { vehicleId: null, driverId: null, trailerId: null },
  dispatchedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  progress: { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 },
}
const plan: ActivePlan = { id: "01a0d2a4-a280-7032-8000-000000000001", solver: "manual", status: "ready", trip: "full", distanceMetres: 18_400, durationSeconds: 2_700, stale: false, deferredUntil: null, stopWarnings: [], unloads: [] }
/** A route whose stops take and weigh nothing known (O10 of #290). */
const NO_WORKLOAD: RouteWorkload = { stopSeconds: 0, expectedKg: null, unexpectedStops: 0, capacityKg: null, overCapacityKg: null }
/** A route whose driver has no shift on record (O14 of #290). */
const NO_SHIFT: RouteShift = { shift: null, startsAt: null, workSeconds: null, overShiftSeconds: null }
const detailOf = (route: Route, over: Partial<RouteDetail> = {}): RouteDetail => ({ ...route, pickups: [], activePlan: null, workload: NO_WORKLOAD, shift: NO_SHIFT, session: null, sessions: [], unloads: [], ...over })

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

  test("reads the routes over a window from 35 days back with no end — the recent and every future route — named once, for the stops to read by too", () => {
    assert.equal(ROUTES_WINDOW_DAYS, 35)
    assert.equal(routesWindowFrom(new Date("2026-10-01T12:00:00Z")), "2026-08-27")
    assert.equal(routesWindowFrom(new Date("2026-01-20T00:30:00Z")), "2025-12-16")
  })

  test("reads every route of the window, page after page, and no fixture lends its id", async () => {
    const second: Route = { ...planned, id: "01a0d2a4-a280-7030-8000-000000000002", number: 1043, label: "RC-1043" }
    const { fetch, calls } = scripted([() => pageOf([planned], "next-page"), () => pageOf([second])])
    const from = routesWindowFrom()
    const result = await loadModule(clientOver(fetch), routesModule, options)
    assert.deepEqual(
      calls.map((call) => call.url),
      [`http://api.test/routes?limit=200&from=${from}`, `http://api.test/routes?limit=200&from=${from}&cursor=next-page`],
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
      Stops: "3",
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
      serviceProviderId: "",
      depotId: depotRecord.id,
      unloadingStationId: stationRecord.id,
      status: "planned",
      cancelReasonCode: "",
      heldAt: "",
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

  test("once the schemes are loaded, names its scheme and files itself under the scheme's planning area", () => {
    const schemeRecord: BusinessRecord = { ...projectRecord, id: `scheme-${schemeId}`, name: "RS-Central · Week A", recordKind: "Route Scheme", facts: { "Planning area": "Indre By Operations" } }
    const withSchemes: ServerRecordsState = new Map([...state, ["route-studio.schemes", loaded({ records: [schemeRecord], serverIds: new Map([[schemeRecord.id, schemeId]]) }, 1)]])
    const record = routeAdapter.toRecord(planned, context(resolverOver(withSchemes)))
    assert.equal(record.facts["Route scheme"], "RS-Central · Week A")
    assert.equal(record.facts.Area, "Indre By Operations", "the Routes table's Area column")
    assert.equal(record.context, "Copenhagen Central · Indre By Operations")
    assert.equal(record.description, "Generated from RS-Central · Week A for 2026-10-01.")
    assert.equal(record.submittedValues?.schemeId, schemeRecord.id)
    const moved = routeAdapter.toRecord({ ...planned, operatingDate: "2026-10-02" }, context(resolverOver(withSchemes)))
    assert.equal(moved.description, "Generated from RS-Central · Week A for 2026-10-01, running 2026-10-02.")
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

  test("its Stops fact counts every stop it has, decided or not, as a generated route's does in fixture mode: the scheme's routes table reads it (#252)", () => {
    const stopsOf = (progress: Route["progress"]) => routeAdapter.toRecord({ ...planned, progress }, context()).facts.Stops
    assert.equal(stopsOf({ planned: 4, completed: 0, skipped: 0, failed: 0, total: 4, fraction: 0 }), "4")
    assert.equal(stopsOf({ planned: 0, completed: 2, skipped: 1, failed: 1, total: 4, fraction: 1 }), "4")
    assert.equal(stopsOf({ planned: 0, completed: 0, skipped: 0, failed: 0, total: 0, fraction: 0 }), "0")
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

  test("held by the office's move, says so on its row and in its details, and what ends the hold (#209)", () => {
    const held = routeAdapter.toRecord({ ...planned, heldAt: "2026-09-30T08:15:00.000Z" }, context())
    assert.equal(held.description, "Generated from its route scheme for 2026-10-01. Held by the office since 2026-09-30 10:15.", "the row's line, on the project's clock")
    assert.equal(held.facts.Hold, "Moved by the office 2026-09-30 10:15: generation runs keep its day, its start and its Planned Assignment, and still refresh its stops")
    assert.equal(held.facts["Hold released by"], "Release hold; an edit of its scheme's start, depot or unloading station, or of its group's vehicle, driver or provider; a day taken from its collection; a dispatch or a cancel")
    assert.ok(isHeldRoute(held))
    const free = routeAdapter.toRecord(planned, context())
    assert.deepEqual([free.facts.Hold, free.facts["Hold released by"]], [undefined, undefined])
    assert.ok(!isHeldRoute(free))
    assert.doesNotMatch(free.description, /Held/)
  })

  test("carries the active Plan the read gives it, as JSON under the key the map reads, and nothing when the read says nothing", () => {
    assert.equal(routeAdapter.toRecord(planned, context()).submittedValues?.[ROUTE_ACTIVE_PLAN_KEY], undefined, "GET /routes carries no activePlan yet (#173 adds it)")
    assert.equal(routeAdapter.toRecord(detailOf(planned), context()).submittedValues?.[ROUTE_ACTIVE_PLAN_KEY], "null")
    assert.deepEqual(JSON.parse(String(routeAdapter.toRecord(detailOf(planned, { activePlan: plan }), context()).submittedValues?.[ROUTE_ACTIVE_PLAN_KEY])), plan)
  })

  test("is never edited here: its commands move it", async () => {
    assert.equal(routeAdapter.statuses, undefined, "a route's status moves by command alone")
    const record = routeAdapter.toRecord(planned, context())
    const edited: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, plannedStartTime: "07:00" } }
    assert.deepEqual(routeAdapter.toPatchBody(record, edited, context()), { path: "", message: "A route is changed by its commands: assign, dispatch, reschedule, release its hold, cancel, add a stop, move its stops, split or merge it, optimise or reorder its stops" })
    const { fetch, calls } = scripted([])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)
    const moved = await writeRecord(clientOver(fetch), routesModule, current, { ...record, status: "Ready" }, options)
    assert.equal(moved.kind, "refused")
    const edit = await writeRecord(clientOver(fetch), routesModule, current, edited, options)
    assert.equal(edit.kind, "refused")
    assert.equal(calls.length, 0)
  })
})

describe("the office's ad-hoc route (#111)", () => {
  const adHoc: Route = { ...planned, id: "01a0d2a4-a280-7030-8000-000000000009", routeSchemeId: null, collectionGroupId: null, number: 1100, label: "RC-1100", generationRunId: null, plannedStartTime: null, note: "Re-collections", progress: { planned: 0, completed: 0, skipped: 0, failed: 0, total: 0, fraction: 0 } }

  test("says whose it is where a generated route names its scheme, and names no scheme and no group", () => {
    const record = routeAdapter.toRecord(adHoc, context())
    assert.equal(record.facts.Origin, MADE_BY_THE_OFFICE)
    assert.equal(record.facts["Route scheme"], undefined)
    // Its note is New route's, under its own name: no scheme to deviate from.
    assert.deepEqual([record.facts.Note, record.facts.Deviation], ["Re-collections", undefined])
    assert.equal(record.description, "The office's own route, with no scheme, for 2026-10-01.")
    assert.deepEqual([record.submittedValues?.schemeId, record.submittedValues?.collectionGroupId], ["", ""])
    assert.equal(record.value, "0 stops")
    assert.equal(routeAdapter.toRecord(planned, context()).facts.Origin, undefined, "a generated route says nothing of the kind")
  })

  test("New route's record is the create body the contract accepts: the project and the day, its ends and crew by server id, its note", () => {
    const values = { projectId: projectRecord.id, operatingDate: "2026-10-06", depotId: depotRecord.id, unloadingStationId: stationRecord.id, vehicleId: wh24Record.id, driverId: madsRecord.id, note: "Re-collections for Tuesday" }
    const body = routeAdapter.toCreateBody?.(createRouteRecord(values, { now: 1 }), context())
    assert.deepEqual(body, { projectId: copenhagen.id, operatingDate: "2026-10-06", depotId: nordhavn.id, unloadingStationId: arc.id, vehicleId: wh24.id, driverId: mads.id, note: "Re-collections for Tuesday" })
    assert.ok(RouteCreate.safeParse(body).success)
    // The bare minimum: a project and a day; a blank optional field is left out.
    const bare = routeAdapter.toCreateBody?.(createRouteRecord({ projectId: projectRecord.id, operatingDate: "2026-10-06", depotId: "", note: "" }, { now: 2 }), context())
    assert.deepEqual(bare, { projectId: copenhagen.id, operatingDate: "2026-10-06" })
    assert.ok(RouteCreate.safeParse(bare).success)
  })

  test("New route is refused here without a project or a day, or with a reference of the wrong kind", () => {
    const refusedFor = (values: Record<string, string>) => routeAdapter.toCreateBody?.(createRouteRecord({ projectId: projectRecord.id, operatingDate: "2026-10-06", ...values }, { now: 3 }), context())
    assert.equal((refusedFor({ operatingDate: "" }) as { path: string }).path, "operatingDate")
    assert.equal((refusedFor({ operatingDate: "Tuesday" }) as { path: string }).path, "operatingDate")
    assert.deepEqual(refusedFor({ driverId: wh31Record.id }), { path: "driverId", message: "Pick a driver the API holds" }, "a vehicle is no driver; a trailer named as the vehicle is the API's 400, as for assign")
    assert.deepEqual(refusedFor({ depotId: stationRecord.id }), { path: "depotId", message: "Pick a depot the API holds" })
    assert.equal((refusedFor({ projectId: "" }) as { path: string }).path, "projectId")
  })

  test("New route posts its body, and the route the API answers is the row, planned with no stops", async () => {
    const record = createRouteRecord({ projectId: projectRecord.id, operatingDate: "2026-10-06", driverId: madsRecord.id }, { now: 4 })
    const created = detailOf({ ...adHoc, operatingDate: "2026-10-06", serviceDate: "2026-10-06" })
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/routes/${adHoc.id}` })])
    const outcome = await writeRecord(clientOver(fetch), routesModule, loaded({ records: [], serverIds: new Map() }, 1), record, options)
    assert.equal(calls[0].url, "http://api.test/routes")
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(bodyOf(calls[0]), { projectId: copenhagen.id, operatingDate: "2026-10-06", driverId: mads.id })
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.serverId, adHoc.id)
    assert.deepEqual([outcome.record.name, outcome.record.status, outcome.record.facts.Origin, outcome.record.facts["Service date"]], ["RC-1100", "Planned", MADE_BY_THE_OFFICE, "2026-10-06"])
  })
})

describe("the route's commands", () => {
  const record = routeAdapter.toRecord(planned, context())
  const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)
  const assign = routeAdapter.commands?.[ASSIGN_ROUTE]
  const reschedule = routeAdapter.commands?.[RESCHEDULE_ROUTE]
  const cancel = routeAdapter.commands?.[CANCEL_ROUTE]
  const reorder = routeAdapter.commands?.[REORDER_ROUTE]

  test("each names the modules whose rows it changes too (`touches`): the Live board reads the routes' rows, a cancel closes the route's open stops, and a reorder moves each stop's sequence (#219)", () => {
    for (const name of [ASSIGN_ROUTE, DISPATCH_ROUTE, RESCHEDULE_ROUTE]) assert.deepEqual(routeAdapter.commands?.[name]?.touches, ["route-studio.live"], name)
    assert.deepEqual(cancel?.touches, ["route-studio.pickups", "route-studio.live", "operate.bulky-bookings"], "a cancel's skipped stops book their bulky bookings again")
    assert.deepEqual(routeAdapter.commands?.[REORDER_ROUTE]?.touches, ["route-studio.pickups", "route-studio.live"])
    assert.deepEqual(routeAdapter.commands?.[ADD_STOP]?.touches, ["route-studio.pickups", "route-studio.live", "operate.bulky-bookings"], "an added stop is a new row of the stops, moves the route's progress, and routes a bulky booking")
  })

  test("a move, a split and a merge send the stops and the other route by server id, and read the routes, the stops, the board and the bookings again (O23 of #290)", () => {
    const stop = "01a0d2a4-a280-7033-8000-000000000001"
    const other = "01a0d2a4-a280-7030-8000-000000000002"
    for (const name of [MOVE_STOPS, SPLIT_ROUTE, MERGE_ROUTE]) assert.deepEqual(routeAdapter.commands?.[name]?.touches, ["route-studio.routes", "route-studio.pickups", "route-studio.live", "operate.bulky-bookings"], name)
    const move = routeAdapter.commands?.[MOVE_STOPS]?.toBody?.({ pickupIds: [`pickup-${stop}`], toRouteId: `route-${other}` }, record, context())
    assert.deepEqual(move, { pickupIds: [stop], toRouteId: other })
    assert.ok(RouteMoveStops.safeParse(move).success)
    assert.deepEqual(routeAdapter.commands?.[MOVE_STOPS]?.toBody?.({ pickupIds: [], toRouteId: `route-${other}` }, record, context()), { path: "pickupIds", message: "Pick the stops to move" })
    assert.deepEqual(routeAdapter.commands?.[MOVE_STOPS]?.toBody?.({ pickupIds: [`pickup-${stop}`] }, record, context()), { path: "toRouteId", message: "Pick the other route" })
    const split = routeAdapter.commands?.[SPLIT_ROUTE]?.toBody?.({ pickupIds: [`pickup-${stop}`], note: "Second truck" }, record, context())
    assert.deepEqual(split, { pickupIds: [stop], note: "Second truck" })
    assert.ok(RouteSplit.safeParse(split).success)
    const merge = routeAdapter.commands?.[MERGE_ROUTE]?.toBody?.({ routeId: `route-${other}` }, record, context())
    assert.deepEqual(merge, { routeId: other })
    assert.ok(RouteMerge.safeParse(merge).success)
  })

  test("add a stop sends a container alone, or one address with its fraction, by server id, and the note: the stop body the contract accepts (#111)", () => {
    const bin = "01a0d2a4-a280-7015-8000-000000000009"
    const parkvej = "01a0d2a4-a280-7011-8000-000000000001"
    const point = "01a0d2a4-a280-7019-8000-000000000001"
    const atAContainer = addedStopBody({ stopAt: "container", containerId: `asset-${bin}`, note: "Extra emptying" }, context())
    assert.deepEqual(atAContainer, { containerId: bin, note: "Extra emptying" })
    assert.ok(PickupAdd.safeParse(atAContainer).success)
    const atAProperty = addedStopBody({ stopAt: "property", propertyId: `property-${parkvej}`, wasteFractionId: `fraction-${residual.id}`, containerId: `asset-${bin}` }, context())
    assert.deepEqual(atAProperty, { propertyId: parkvej, wasteFractionId: residual.id }, "a container the form now hides is not read")
    assert.ok(PickupAdd.safeParse(atAProperty).success)
    const atAPoint = addedStopBody({ stopAt: "shared-point", sharedCollectionPointId: `shared-point-${point}`, wasteFractionId: `fraction-${residual.id}` }, context())
    assert.deepEqual(atAPoint, { sharedCollectionPointId: point, wasteFractionId: residual.id })
    assert.ok(PickupAdd.safeParse(atAPoint).success)
    assert.deepEqual(routeAdapter.commands?.[ADD_STOP]?.toBody?.({ containerId: `asset-${bin}` }, record, context()), { containerId: bin }, "a container unless the form says otherwise")
  })

  test("add a stop collects a bulky booking by its server id alone, the note where the form gives one (O11 of #290)", () => {
    const booking = "01a0d2a4-a280-7050-8000-000000000001"
    const bulky = addedStopBody({ stopAt: "bulky-booking", bulkyBookingId: `bulky-booking-${booking}`, service: "wash", note: "Gate code 4711" }, context())
    assert.deepEqual(bulky, { service: "bulky", bulkyBookingId: booking, note: "Gate code 4711" }, "the booking says the place and the fraction; the service the form hides is not read")
    assert.ok(PickupAdd.safeParse(bulky).success)
    assert.deepEqual(addedStopBody({ stopAt: "bulky-booking" }, context()), { path: "bulkyBookingId", message: "Pick a bulky booking of the route's day" })
  })

  test("add a stop names the ticket it is booked to answer by server id, where the form carries one (O3c of #290)", () => {
    const bin = "01a0d2a4-a280-7015-8000-000000000009"
    const ticketId = "01a0d2a4-a280-7040-8000-000000000001"
    const answering = addedStopBody({ stopAt: "container", containerId: `asset-${bin}`, ticketId: `ticket-${ticketId}` }, context())
    assert.deepEqual(answering, { containerId: bin, ticketId })
    assert.ok(PickupAdd.safeParse(answering).success)
    assert.deepEqual(addedStopBody({ stopAt: "container", containerId: `asset-${bin}`, ticketId: "ticket-T-1" }, context()), { path: "ticketId", message: "Pick a ticket the API holds" })
  })

  test("add a stop is refused here without what it collects, or with a row the API does not hold", () => {
    assert.deepEqual(addedStopBody({ stopAt: "container" }, context()), { path: "containerId", message: "Pick the container to collect" })
    assert.deepEqual(addedStopBody({ stopAt: "container", containerId: "asset-bin-1" }, context()), { path: "containerId", message: "Pick a container the API holds" })
    assert.deepEqual(addedStopBody({ stopAt: "property", wasteFractionId: `fraction-${residual.id}` }, context()), { path: "propertyId", message: "Pick a property the API holds" })
    assert.deepEqual(addedStopBody({ stopAt: "property", propertyId: "property-01a0d2a4-a280-7011-8000-000000000001" }, context()), { path: "wasteFractionId", message: "Name the waste fraction collected there" })
    assert.deepEqual(addedStopBody({ stopAt: "somewhere" }, context()).path, "stopAt")
  })

  test("add a stop posts the stop to the route, then reads the route back: its row, its stops and its progress (#111)", async () => {
    const bin = "01a0d2a4-a280-7015-8000-000000000009"
    const grown = detailOf({ ...planned, progress: { ...planned.progress, planned: 4, total: 4 } })
    const { fetch, calls } = scripted([() => json({ id: "01a0d2a4-a280-7033-8000-000000000009" }, 201, { location: "/pickups/01a0d2a4-a280-7033-8000-000000000009" }), () => json(grown)])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, ADD_STOP, { stopAt: "container", containerId: `asset-${bin}` }, options)
    assert.deepEqual(
      calls.map((call) => [call.init.method, call.url]),
      [
        ["POST", `http://api.test/routes/${planned.id}/pickups`],
        ["GET", `http://api.test/routes/${planned.id}`],
      ],
    )
    assert.deepEqual(bodyOf(calls[0]), { containerId: bin })
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.value, "4 stops")
  })

  test("assign sends only what moved, by server id, a cleared field as null", () => {
    const body = assign?.toBody?.({ vehicleId: wh31Record.id, driverId: frejaRecord.id, trailerId: "", depotId: depotRecord.id, unloadingStationId: "" }, record, context())
    assert.deepEqual(body, { vehicleId: wh31.id, driverId: freja.id, unloadingStationId: null })
    assert.ok(RouteAssign.safeParse(body).success)
    const trailerOnly = assign?.toBody?.({ ...record.submittedValues, trailerId: trailerRecord.id }, record, context())
    assert.deepEqual(trailerOnly, { trailerId: trailer.id })
    assert.ok(RouteAssign.safeParse(trailerOnly).success)
  })

  test("a field the input does not name is left as the route stands: a scheme's one-off names only what it moves (#209)", () => {
    assert.deepEqual(assign?.toBody?.({ driverId: frejaRecord.id }, record, context()), { driverId: freja.id })
    assert.deepEqual(assign?.toBody?.({ depotId: "" }, record, context()), { depotId: null }, "a field named empty is cleared, as the dialog clears it")
    assert.deepEqual(reschedule?.toBody?.({ plannedStartTime: "08:15" }, record, context()), { plannedStartTime: "08:15" })
    assert.deepEqual(reschedule?.toBody?.({ plannedStartTime: "06:30" }, record, context()), { path: "operatingDate", message: "Nothing to reschedule: move the day it runs or its planned start" })
  })

  test("assign is refused here when nothing moved, or a field names no row of its kind the API holds", () => {
    assert.deepEqual(assign?.toBody?.({ ...record.submittedValues }, record, context()), { path: "vehicleId", message: "Nothing to assign: pick another vehicle, driver, trailer, service provider, depot or unloading station" })
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

  test("release-hold posts its empty body and answers the route back on its scheme, its hold cleared (#226)", async () => {
    const { fetch, calls } = scripted([() => json(detailOf(planned))])
    const heldRecord = routeAdapter.toRecord({ ...planned, heldAt: "2026-09-30T08:15:00.000Z" }, context())
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, heldRecord, RELEASE_HOLD, undefined, options)
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}/release-hold`)
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(bodyOf(calls[0]), {})
    assert.ok(RouteReleaseHold.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.ok(!isHeldRoute(outcome.record))
    assert.deepEqual(routeAdapter.commands?.[RELEASE_HOLD]?.touches, ["route-studio.live"])
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

  test("cancel carries its reason code and its reason, which becomes the route's deviation; without either it is refused here (O5 of #290)", async () => {
    const body = cancel?.toBody?.({ reasonCode: "road-closure", reason: "Road closed on Nørrebrogade" }, record, context())
    assert.deepEqual(body, { reasonCode: "road-closure", reason: "Road closed on Nørrebrogade" })
    assert.ok(RouteCancel.safeParse(body).success)
    assert.deepEqual(cancel?.toBody?.({ reasonCode: "road-closure", reason: "  " }, record, context()), { path: "reason", message: "Say why the route is cancelled" })
    assert.deepEqual(cancel?.toBody?.({ reason: "Road closed" }, record, context()), { path: "reasonCode", message: "Pick why the route is cancelled" })
    assert.deepEqual(cancel?.toBody?.({ reasonCode: "regeneration", reason: "Road closed" }, record, context()), { path: "reasonCode", message: "Pick why the route is cancelled" }, "a run's code is not the office's")
    const { fetch, calls } = scripted([() => json(detailOf({ ...planned, status: "cancelled", note: "Road closed on Nørrebrogade", cancelReasonCode: "road-closure", cancelledAt: "2026-10-01T06:02:00.000Z" }))])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, CANCEL_ROUTE, { reasonCode: "road-closure", reason: "Road closed on Nørrebrogade" }, options)
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}/cancel`)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Cancelled")
    assert.equal(outcome.record.facts.Deviation, "Road closed on Nørrebrogade")
    assert.equal(outcome.record.facts["Cancel reason"], "Road closure")
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

  test("reschedule says a day the project rests on is meant only when the dialog does, and only on a move of the day (O5 of #290)", () => {
    const knowingly = reschedule?.toBody?.({ operatingDate: "2026-10-03", plannedStartTime: "06:30", acceptNonWorkingDay: true }, record, context())
    assert.deepEqual(knowingly, { operatingDate: "2026-10-03", acceptNonWorkingDay: true })
    assert.ok(RouteReschedule.safeParse(knowingly).success)
    assert.deepEqual(reschedule?.toBody?.({ operatingDate: "2026-10-03", plannedStartTime: "06:30", acceptNonWorkingDay: false }, record, context()), { operatingDate: "2026-10-03" }, "unticked, the flag is left out")
    assert.deepEqual(reschedule?.toBody?.({ operatingDate: "2026-10-01", plannedStartTime: "07:00", acceptNonWorkingDay: true }, record, context()), { plannedStartTime: "07:00" }, "a start moved on the same day asks no calendar")
  })

  test("assign, reschedule and New route say the crew's same day is meant only when the dialog does (O7 of #290)", () => {
    const assigned = assign?.toBody?.({ driverId: frejaRecord.id, acceptSameDay: true }, record, context())
    assert.deepEqual(assigned, { driverId: freja.id, acceptSameDay: true })
    assert.ok(RouteAssign.safeParse(assigned).success)
    assert.deepEqual(assign?.toBody?.({ driverId: frejaRecord.id, acceptSameDay: false }, record, context()), { driverId: freja.id }, "unticked, the flag is left out")
    assert.deepEqual(assign?.toBody?.({ depotId: "", acceptSameDay: true }, record, context()), { depotId: null }, "a move of no crew asks no other route")
    const moved = reschedule?.toBody?.({ operatingDate: "2026-10-01", plannedStartTime: "07:00", acceptSameDay: true }, record, context())
    assert.deepEqual(moved, { plannedStartTime: "07:00", acceptSameDay: true })
    assert.ok(RouteReschedule.safeParse(moved).success)
    const created = routeAdapter.toCreateBody?.(createRouteRecord({ projectId: projectRecord.id, operatingDate: "2026-10-06", driverId: madsRecord.id, acceptSameDay: true }, { now: 4 }), context())
    assert.deepEqual(created, { projectId: copenhagen.id, operatingDate: "2026-10-06", driverId: mads.id, acceptSameDay: true })
    assert.ok(RouteCreate.safeParse(created).success)
    assert.deepEqual(routeAdapter.toCreateBody?.(createRouteRecord({ projectId: projectRecord.id, operatingDate: "2026-10-06", acceptSameDay: true }, { now: 5 }), context()), { projectId: copenhagen.id, operatingDate: "2026-10-06" }, "a route of no crew says nothing of it")
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

describe("the dispatch day's tooling (O5 of #290)", () => {
  const record = routeAdapter.toRecord(planned, context())
  const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)
  const providerId = "01a0d2a4-a280-7003-8000-000000000009"
  const nordren: BusinessRecord = { ...projectRecord, id: `service-provider-${providerId}`, name: "NordRen ApS", recordKind: "Service provider company", facts: {}, submittedValues: {} }
  const withProvider: ServerRecordsState = new Map([...state, ["service-providers.service-providers", loaded({ records: [nordren], serverIds: serverIdsOf([nordren], [providerId]) }, 1)]])

  test("a route measured by its active Plan says its distance and duration; one unmeasured says neither", () => {
    const measured = routeAdapter.toRecord(detailOf(planned, { activePlan: plan }), context())
    assert.deepEqual([measured.facts.Distance, measured.facts.Duration], ["18.4 km", "45 min"])
    const calculating = routeAdapter.toRecord(detailOf(planned, { activePlan: { ...plan, status: "calculating", distanceMetres: null, durationSeconds: null } }), context())
    assert.deepEqual([calculating.facts.Distance, calculating.facts.Duration], [undefined, undefined])
    assert.deepEqual([record.facts.Distance, record.facts.Duration], [undefined, undefined], "a list row without a Plan reading says nothing")
  })

  test("a route's stops add their time at the kerb to the Plan's drive, and its expected load reads against the vehicle's payload (O10 of #290)", () => {
    const loads = { stopSeconds: 5_400, expectedKg: 8_200, unexpectedStops: 0, capacityKg: 12_000, overCapacityKg: 0 }
    const measured = routeAdapter.toRecord(detailOf(planned, { activePlan: plan, workload: loads }), context())
    assert.deepEqual([measured.facts.Duration, measured.facts["Stop time"], measured.facts["Expected load"]], ["2 h 15 min", "1 h 30 min", "8,200 kg of 12,000 kg"])
    const over = routeAdapter.toRecord(detailOf(planned, { activePlan: plan, workload: { ...loads, expectedKg: 14_200, overCapacityKg: 2_200 } }), context())
    assert.equal(over.facts["Expected load"], "14,200 kg of 12,000 kg: over by 2,200 kg, plan a tip")
    // Its Plan unloads on the way (O15 of #290): no tip left to plan, and how often the vehicle empties before its last stop.
    const unloads = [{ afterPickupId: "01a0d2a4-a280-7031-8000-000000000003", unloadingStationId: "01a0d2a4-a280-7031-8000-000000000009" }]
    const reloaded = routeAdapter.toRecord(detailOf(planned, { activePlan: { ...plan, unloads }, workload: { ...loads, expectedKg: 14_200, overCapacityKg: 2_200 } }), context())
    assert.deepEqual(
      [reloaded.facts["Expected load"], reloaded.facts["Unloads on the way"]],
      ["14,200 kg of 12,000 kg: over by 2,200 kg, so its Plan unloads on the way", "1 visit to the unloading station before the last stop, where the vehicle is full"],
    )
    assert.equal(over.facts["Unloads on the way"], undefined)
    const partly = routeAdapter.toRecord(detailOf(planned, { workload: { ...loads, capacityKg: null, overCapacityKg: null, unexpectedStops: 3 } }), context())
    assert.deepEqual([partly.facts.Duration, partly.facts["Stop time"], partly.facts["Expected load"]], [undefined, "1 h 30 min", "8,200 kg, 3 stops not counted"], "no Plan, no drive to add the stops to")
    const unknown = routeAdapter.toRecord(detailOf(planned, { workload: NO_WORKLOAD }), context())
    assert.deepEqual([unknown.facts["Stop time"], unknown.facts["Expected load"]], [undefined, undefined], "a route with no stops says neither")
  })

  test("a route reads its planned driver's shift and the server's over-shift verdict, and says nothing of a shift a driver lacks (O14 of #290)", () => {
    const shift = { from: "07:00", to: "15:00", breakMinutes: 30, breakWindow: { from: "11:00", to: "12:30" } }
    const over = routeAdapter.toRecord(detailOf(planned, { activePlan: plan, shift: { shift, startsAt: "07:30", workSeconds: 30_600, overShiftSeconds: 3_600 } }), context())
    assert.deepEqual([over.facts.Shift, over.facts["Shift check"]], ["07:00–15:00 · 30 min break 11:00–12:30", "Over shift by 1 h 00 min: 8 h 30 min of work from 07:30"])
    const within = routeAdapter.toRecord(detailOf(planned, { activePlan: plan, shift: { shift: { ...shift, breakMinutes: null, breakWindow: null }, startsAt: "07:00", workSeconds: 3_600, overShiftSeconds: 0 } }), context())
    assert.deepEqual([within.facts.Shift, within.facts["Shift check"]], ["07:00–15:00", "Within the shift: 1 h 00 min of work from 07:00"])
    const unmeasured = routeAdapter.toRecord(detailOf(planned, { shift: { shift, startsAt: "07:00", workSeconds: null, overShiftSeconds: null } }), context())
    assert.deepEqual([unmeasured.facts.Shift, unmeasured.facts["Shift check"]], ["07:00–15:00 · 30 min break 11:00–12:30", undefined], "no verdict before a Plan is measured")
    const none = routeAdapter.toRecord(detailOf(planned), context())
    assert.deepEqual([none.facts.Shift, none.facts["Shift check"]], [undefined, undefined])
  })

  test("a Plan that holds stops outside their service window names each by its place in the order and says why (O14 of #290)", () => {
    const warned = routeAdapter.toRecord(
      detailOf(planned, {
        activePlan: {
          ...plan,
          solver: "optimiser",
          stopWarnings: [
            { pickupId: "01a0d2a4-a280-7031-8000-000000000001", position: 2, warning: "windows-disjoint" },
            { pickupId: "01a0d2a4-a280-7031-8000-000000000002", position: 5, warning: "window-unreachable" },
          ],
        },
      }),
      context(),
    )
    assert.equal(
      warned.facts["Window warnings"],
      "Stop 2: its property's access hours and its agreement's service window never overlap, so it was planned without a window; Stop 5: no order reached it inside its service window, so it was planned outside it",
    )
    assert.equal(routeAdapter.toRecord(detailOf(planned, { activePlan: plan }), context()).facts["Window warnings"], undefined)
  })

  test("assign names the service provider by server id, a cleared one as null, and the route reads it back", () => {
    const assign = routeAdapter.commands?.[ASSIGN_ROUTE]
    const named = assign?.toBody?.({ serviceProviderId: nordren.id }, record, context(resolverOver(withProvider)))
    assert.deepEqual(named, { serviceProviderId: providerId })
    assert.ok(RouteAssign.safeParse(named).success)
    assert.deepEqual(assign?.toBody?.({ serviceProviderId: "NordRen" }, record, context(resolverOver(withProvider))), { path: "serviceProviderId", message: "Pick a service provider the API holds" })
    const provided = routeAdapter.toRecord({ ...planned, planned: { ...planned.planned, serviceProviderId: providerId } }, context(resolverOver(withProvider)))
    assert.deepEqual([provided.submittedValues?.serviceProviderId, provided.facts["Service provider"]], [nordren.id, "NordRen ApS"])
    assert.deepEqual(assign?.toBody?.({ serviceProviderId: "" }, provided, context(resolverOver(withProvider))), { serviceProviderId: null })
    assert.equal(record.submittedValues?.serviceProviderId, "", "none planned")
  })

  test("optimise posts no body, then reads the route back for its active Plan, and touches what a new order touches", async () => {
    const optimise = routeAdapter.commands?.[OPTIMISE_ROUTE]
    assert.equal(optimise?.toBody, undefined)
    assert.deepEqual(optimise?.touches, ["route-studio.pickups", "route-studio.live"])
    const answer: Plan & { fallback: null } = { id: "01a0d2a4-a280-7032-8000-000000000002", ...STAMPS, projectId: copenhagen.id, routeId: planned.id, solver: "optimiser", status: "calculating", trip: "full", distanceMetres: null, durationSeconds: null, deferredUntil: null, failureReason: null, provider: "fake", engineVersion: null, graphDate: null, fallback: null }
    const { fetch, calls } = scripted([() => json(answer, 202), () => json(detailOf(planned, { activePlan: plan }))])
    const outcome = await commandRecord(clientOver(fetch), routesModule, current, record, OPTIMISE_ROUTE, undefined, options)
    assert.deepEqual(
      calls.map((call) => [call.init.method, call.url]),
      [
        ["POST", `http://api.test/routes/${planned.id}/optimise`],
        ["GET", `http://api.test/routes/${planned.id}`],
      ],
    )
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.facts.Distance, "18.4 km")
  })

  test("a Plan's line in the route's history: when, who ordered it, where it stands, its measure, and whether it is the active one", () => {
    const base = { id: plan.id, createdAt: "2026-10-01T04:00:00.000Z", distanceMetres: 18_400, durationSeconds: 3_900, failureReason: null }
    assert.equal(planLine({ ...base, solver: "optimiser", status: "ready" }, { activePlanId: plan.id, timezone: "Europe/Copenhagen" }), "2026-10-01 06:00 · Optimised · Ready · 18.4 km · 1 h 05 min driving · Active")
    assert.equal(planLine({ ...base, solver: "manual", status: "calculating", distanceMetres: null, durationSeconds: null }, { activePlanId: null, timezone: "Europe/Copenhagen" }), "2026-10-01 06:00 · The dispatcher's order · Calculating")
    assert.equal(planLine({ ...base, solver: "baseline", status: "failed", failureReason: "superseded" }, { activePlanId: "another", timezone: "Europe/Copenhagen" }), "2026-10-01 06:00 · Generated order, not optimised · Failed · superseded")
  })

  test("the route's Plans are its history, read page after page; a day's routes go out in one bulk dispatch the contract accepts", async () => {
    const listed = { items: [], nextCursor: null }
    const results = { results: [{ routeId: planned.id, outcome: "refused", status: 409, detail: "Route RC-1042 has no planned driver; assign one first" }] }
    const { fetch, calls } = scripted([() => json(listed), () => json(results)])
    assert.deepEqual(await routePlans(clientOver(fetch), planned.id), [])
    assert.deepEqual(await dispatchRoutes(clientOver(fetch), [planned.id]), results)
    assert.deepEqual(
      calls.map((call) => [call.init.method ?? "GET", call.url]),
      [
        ["GET", `http://api.test/routes/${planned.id}/plans?limit=200`],
        ["POST", "http://api.test/routes/dispatch"],
      ],
    )
    assert.ok(RouteDispatchMany.safeParse(bodyOf(calls[1])).success)
  })

  test("a day of more routes than one request takes goes out in batches the contract accepts, the results in the order given; nothing to dispatch asks nothing", async () => {
    assert.equal(DISPATCH_BATCH, DISPATCH_MANY_MAX, "the web spells the contracts' bound again")
    const ids = Array.from({ length: DISPATCH_BATCH + 1 }, (_, index) => `01a0d2a4-a280-7030-8000-${String(index).padStart(12, "0")}`)
    const answer = (call: { url: string; init: RequestInit }) => json({ results: (bodyOf(call) as { routeIds: string[] }).routeIds.map((routeId) => ({ routeId, outcome: "refused", status: 404, detail: `No route ${routeId}` })) })
    const { fetch, calls } = scripted([answer, answer])
    const { results } = await dispatchRoutes(clientOver(fetch), ids)
    assert.deepEqual(
      calls.map((call) => (bodyOf(call) as { routeIds: string[] }).routeIds.length),
      [DISPATCH_BATCH, 1],
    )
    for (const call of calls) assert.ok(RouteDispatchMany.safeParse(bodyOf(call)).success)
    assert.deepEqual(
      results.map((result) => result.routeId),
      ids,
    )
    const none = scripted([])
    assert.deepEqual(await dispatchRoutes(clientOver(none.fetch), []), { results: [] })
    assert.equal(none.calls.length, 0)
  })

  test("Balance day (O15 of #290) previews a project's day and applies the moves the office kept, each body one the contract accepts", async () => {
    const projectId = "01a0d2a4-a280-7002-8000-000000000001"
    const day = { projectId, operatingDate: "2026-10-12" }
    const preview = {
      token: "a".repeat(64),
      moves: [{ pickupId: "01a0d2a4-a280-7031-8000-000000000001", fromRouteId: planned.id, toRouteId: "01a0d2a4-a280-7030-8000-000000000099" }],
      routes: [{ routeId: planned.id, before: { kg: 72, workSeconds: 3_600, overCapacityKg: 22, overShiftSeconds: null }, after: { kg: 48, workSeconds: 3_400, overCapacityKg: 0, overShiftSeconds: null } }],
    }
    const result = { moved: 1, routes: [{ routeId: planned.id, planId: "01a0d2a4-a280-7032-8000-000000000001" }] }
    const { fetch, calls } = scripted([() => json(preview), () => json(result)])
    assert.deepEqual(await previewBalance(clientOver(fetch), day), preview)
    const body = { ...day, token: preview.token, moves: [{ pickupId: preview.moves[0].pickupId, toRouteId: preview.moves[0].toRouteId }] }
    assert.deepEqual(await applyBalance(clientOver(fetch), body), result)
    assert.deepEqual(
      calls.map((call) => [call.init.method, call.url]),
      [
        ["POST", "http://api.test/routes/balance-preview"],
        ["POST", "http://api.test/routes/balance"],
      ],
    )
    assert.ok(RouteBalanceDay.safeParse(bodyOf(calls[0])).success)
    assert.ok(RouteBalanceApply.safeParse(bodyOf(calls[1])).success)
    assert.ok(RouteBalancePreview.safeParse(preview).success)
  })

  test("Balance day says each route's load and work, and how far over its payload or shift, and each move as the stop, where it leaves and where it joins", () => {
    assert.equal(dayLoadLine({ kg: 14_200, workSeconds: 30_600, overCapacityKg: 2_200, overShiftSeconds: 1_800 }), "14,200 kg, 2,200 kg over the payload · 8 h 30 min, 30 min over the shift")
    assert.equal(dayLoadLine({ kg: 8_200, workSeconds: 3_600, overCapacityKg: 0, overShiftSeconds: null }), "8,200 kg · 1 h 00 min")
    assert.equal(balanceMoveLine("Parkvej 18", "RC-1042", "RC-1043"), "Parkvej 18: RC-1042 → RC-1043")
  })

  test("a route is read back as its details read it, for the row's measure once a Plan is ready", async () => {
    const { fetch, calls } = scripted([() => json(detailOf(planned, { activePlan: plan }))])
    const read = await routeAdapter.read?.(clientOver(fetch), planned.id)
    assert.equal(calls[0].url, `http://api.test/routes/${planned.id}`)
    assert.equal(routeAdapter.toRecord(read as Route, context()).facts.Distance, "18.4 km")
  })
})

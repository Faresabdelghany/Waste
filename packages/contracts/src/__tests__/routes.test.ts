import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DAY_WINDOW_ORDERED, dayWindowOrdered } from "../queries"
import { EACH_PICKUP_ONCE, LABEL_IS_THE_NUMBER, labelMatches, LiveRoute, LiveRouteQuery, PICKUP_ORDER_MAX, PickupOrderSet, Route, RouteAssign, RouteCancel, RouteDetail, RouteListItem, RouteListQuery, RouteProgress, RouteReschedule } from "../routes"
import { refusal, refusesAnEmptyPatch } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-04T22:00:00.000Z", updatedAt: "2026-10-05T06:00:00.000Z" }

const progress = { planned: 28, completed: 10, skipped: 1, failed: 1, total: 40, fraction: 0.3 }

const route = {
  id: ID,
  projectId: OTHER,
  routeSchemeId: THIRD,
  collectionGroupId: ID,
  serviceDate: "2026-10-05",
  operatingDate: "2026-10-05",
  number: 1042,
  label: "RC-1042",
  status: "active",
  note: null,
  cancelledByGeneration: false,
  generationRunId: null,
  plannedStartTime: "06:30",
  planned: { vehicleId: OTHER, driverId: THIRD, trailerId: null, serviceProviderId: null, depotId: ID, unloadingStationId: OTHER },
  actual: { vehicleId: OTHER, driverId: THIRD, trailerId: null },
  dispatchedAt: "2026-10-04T22:00:00.000Z",
  startedAt: "2026-10-05T06:00:00.000Z",
  completedAt: null,
  cancelledAt: null,
  progress,
  ...STAMPS,
}

const session = {
  id: THIRD,
  projectId: OTHER,
  routeId: ID,
  driverId: THIRD,
  vehicleId: OTHER,
  trailerId: null,
  deviceId: "device-7",
  appVersion: null,
  startedAt: "2026-10-05T06:00:00.000Z",
  endedAt: null,
  pausedAt: null,
  lastSeenAt: "2026-10-05T06:05:00.000Z",
  ...STAMPS,
}

const pickup = {
  id: OTHER,
  projectId: OTHER,
  routeId: ID,
  containerId: THIRD,
  position: 1,
  status: "planned",
  reason: null,
  note: null,
  propertyId: ID,
  sharedCollectionPointId: null,
  wasteFractionId: THIRD,
  arrivedAt: null,
  outcomeAt: null,
  ...STAMPS,
}

describe("Route", () => {
  test("carries its identity, its day, its number under the label, the two assignments, the four stamps and its progress", () => {
    assert.deepEqual(Route.parse(route), route)
    const planned = { ...route, status: "planned", actual: { vehicleId: null, driverId: null, trailerId: null }, dispatchedAt: null, startedAt: null, progress: { ...progress, planned: 40, completed: 0, skipped: 0, failed: 0, fraction: 0 } }
    assert.deepEqual(Route.parse(planned), planned)
    assert.equal(Object.keys(RouteProgress.shape).length, 6)
    assert.equal(RouteProgress.safeParse({ ...progress, fraction: 1.2 }).success, false)
    assert.equal(RouteProgress.safeParse({ ...progress, planned: -1 }).success, false)
  })

  test("holds the label to the number: the prefix is presentation, and a label that says another number does not parse", () => {
    assert.equal(labelMatches({ number: 1042, label: "RC-1042" }), true)
    assert.equal(labelMatches({ number: 1042, label: "RC-1043" }), false)
    assert.deepEqual(refusal(Route.safeParse({ ...route, label: "RC-1043" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
    assert.deepEqual(refusal(RouteDetail.safeParse({ ...route, label: "1042", pickups: [], activePlan: null, session: null, sessions: [], unloads: [] })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
    assert.equal(Route.safeParse({ ...route, number: 0 }).success, false)
    assert.equal(Route.safeParse({ ...route, plannedStartTime: "06:30:00" }).success, false, "HH:MM, no seconds")
    assert.equal(Route.safeParse({ ...route, serviceDate: "2026-10-05T00:00:00Z" }).success, false, "a day, not an instant")
  })

  test("a detail carries the pickups by position, the open session, every session and the unloads; a live route its open session and three readings", () => {
    const detail = { ...route, pickups: [pickup], activePlan: null, session, sessions: [session], unloads: [] }
    assert.deepEqual(RouteDetail.parse(detail), detail)
    const live = { ...route, activePlan: null, session, lastLocation: { type: "Point", coordinates: [12.5951, 55.7089] }, lastSeenAt: "2026-10-05T06:05:00.000Z", paused: false }
    assert.deepEqual(LiveRoute.parse(live), live)
    const due = { ...live, status: "ready", session: null, lastLocation: null, lastSeenAt: null, startedAt: null, actual: { vehicleId: null, driverId: null, trailerId: null } }
    assert.deepEqual(LiveRoute.parse(due), due)
    assert.equal(LiveRoute.safeParse({ ...live, lastLocation: { type: "Point", coordinates: [12.5951, 55.7089, 10] } }).success, false, "a flat point")
    assert.deepEqual(LiveRouteQuery.parse({ projectId: OTHER }), { projectId: OTHER, limit: 50 })
  })

  test("a listed route carries its active Plan's reading, or null, and holds the label to the number like the rest (#173)", () => {
    const activePlan = { id: OTHER, solver: "manual", status: "calculating", trip: "full", distanceMetres: null, durationSeconds: null, stale: false, deferredUntil: "2026-10-05T09:00:30.000Z" }
    assert.deepEqual(RouteListItem.parse({ ...route, activePlan }), { ...route, activePlan })
    assert.deepEqual(RouteListItem.parse({ ...route, activePlan: null }), { ...route, activePlan: null })
    assert.equal(RouteListItem.safeParse(route).success, false, "the reading is there, null or not")
    assert.deepEqual(refusal(RouteListItem.safeParse({ ...route, label: "RC-1043", activePlan: null })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
  })
})

describe("the dispatcher's commands", () => {
  test("assign moves any field of the Planned Assignment, clears one with null, and changes something", () => {
    assert.deepEqual(RouteAssign.parse({ driverId: THIRD }), { driverId: THIRD })
    assert.deepEqual(RouteAssign.parse({ trailerId: null, unloadingStationId: OTHER, depotId: null }), { trailerId: null, unloadingStationId: OTHER, depotId: null })
    refusesAnEmptyPatch(RouteAssign)
    for (const key of ["serviceProviderId", "status", "operatingDate", "actualDriverId", "id"]) assert.match(refusal(RouteAssign.safeParse({ driverId: THIRD, [key]: THIRD }))[0].message, new RegExp(key), key)
  })

  test("reschedule moves the operating date or the planned start and never the service date, the identity", () => {
    assert.deepEqual(RouteReschedule.parse({ operatingDate: "2026-10-06" }), { operatingDate: "2026-10-06" })
    assert.deepEqual(RouteReschedule.parse({ plannedStartTime: null }), { plannedStartTime: null })
    refusesAnEmptyPatch(RouteReschedule)
    assert.match(refusal(RouteReschedule.safeParse({ serviceDate: "2026-10-06" }))[0].message, /serviceDate/)
    assert.equal(RouteReschedule.safeParse({ operatingDate: "2026-10-06T06:00:00Z" }).success, false)
  })

  test("cancel carries the reason and nothing else", () => {
    assert.deepEqual(RouteCancel.parse({ reason: "Snowed in" }), { reason: "Snowed in" })
    assert.deepEqual(refusal(RouteCancel.safeParse({})).map((issue) => issue.path), ["reason"])
    assert.match(refusal(RouteCancel.safeParse({ reason: "x", note: "y" }))[0].message, /note/)
  })

  test("a pickup order names each pickup once, one to five hundred of them", () => {
    assert.deepEqual(PickupOrderSet.parse({ pickupIds: [ID, OTHER] }), { pickupIds: [ID, OTHER] })
    assert.deepEqual(refusal(PickupOrderSet.safeParse({ pickupIds: [ID, OTHER, ID] })), [{ path: "pickupIds", message: EACH_PICKUP_ONCE }])
    assert.deepEqual(refusal(PickupOrderSet.safeParse({ pickupIds: [] })).map((issue) => issue.path), ["pickupIds"])
    const tooMany = Array.from({ length: PICKUP_ORDER_MAX + 1 }, (_unused, index) => `01a0d3a5-e5e0-7000-8000-${String(index).padStart(12, "0")}`)
    assert.deepEqual(refusal(PickupOrderSet.safeParse({ pickupIds: tooMany })).map((issue) => issue.path), ["pickupIds"])
    assert.equal(PickupOrderSet.safeParse({ pickupIds: tooMany.slice(1) }).success, true)
  })
})

describe("RouteListQuery", () => {
  test("pages by project, scheme, group, a window of operating days, service date, status, planned driver and vehicle, the window ordered", () => {
    assert.deepEqual(RouteListQuery.parse({}), { limit: 50 })
    const query = { projectId: OTHER, routeSchemeId: THIRD, collectionGroupId: ID, from: "2026-10-05", to: "2026-10-11", serviceDate: "2026-10-05", status: "ready", plannedDriverId: THIRD, plannedVehicleId: OTHER }
    assert.deepEqual(RouteListQuery.parse(query), { ...query, limit: 50 })
    assert.deepEqual(refusal(RouteListQuery.safeParse({ from: "2026-10-11", to: "2026-10-05" })), [{ path: "to", message: DAY_WINDOW_ORDERED }])
    assert.equal(RouteListQuery.safeParse({ from: "2026-10-05", to: "2026-10-05" }).success, true, "one day is a window")
    assert.equal(dayWindowOrdered({ from: "2026-10-05" }), true, "a half-given window is not judged")
    assert.equal(RouteListQuery.safeParse({ status: "draft" }).success, false)
  })
})

// What the Driver App's screens read off the door's last read and the queue
// (Issue #145): the stops in execution order, what the read model makes
// impossible (no Start on an active route, no outcome on a decided stop),
// a second tap held off while one waits, the end-route confirm's count, and
// the sentences the banner and the confirm say. No local `decide`: nothing
// here judges a licence, a vehicle or another route.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { QueueEntry } from "../command-queue"
import type { PilotCommand } from "../commands"
import { endRouteWarning, mapsHref, routeActions, routesInDayOrder, stopActions, stopsInOrder, unreachableBanner, waitingOn } from "../route-view"
import { pickup, pickupId, route, ROUTE_ID, routeDetail } from "./driver-fixtures"

const queued = (command: Pick<PilotCommand, "kind" | "body"> & { routeId?: string }): QueueEntry =>
  ({ owner: "mads", state: "ready", command: { id: `id-${Math.random()}`, routeId: ROUTE_ID, occurredAt: "2027-01-15T08:00:00.000Z", deviceId: "web-x", ...command } }) as QueueEntry

describe("the stops", () => {
  test("run in the Plan's sequence where the read carries one, else by position", () => {
    const pickups = [pickup(1, { sequence: 3 }), pickup(2, { sequence: 1 }), pickup(3, { sequence: 2 })]
    assert.deepEqual(stopsInOrder(pickups).map((stop) => stop.position), [2, 3, 1])
    const unsequenced = [pickup(2, { sequence: undefined }), pickup(1, { sequence: undefined })]
    assert.deepEqual(stopsInOrder(unsequenced).map((stop) => stop.position), [1, 2])
  })

  test("open in Maps over the pickup's own point, and not at all without one", () => {
    assert.equal(mapsHref({ type: "Point", coordinates: [12.5683, 55.6761] }), "https://www.google.com/maps/search/?api=1&query=55.6761%2C12.5683")
    assert.equal(mapsHref(null), null)
  })
})

describe("what a stop offers", () => {
  const active = routeDetail({ status: "active" })

  test("an outcome and a problem on a planned stop of an active route", () => {
    assert.deepEqual(stopActions(active, active.pickups[0], []), { sending: false, outcome: true, report: true })
  })

  test("no outcome on a decided stop, though a problem may still be reported", () => {
    assert.deepEqual(stopActions(active, pickup(1, { status: "completed" }), []), { sending: false, outcome: false, report: true })
  })

  test("nothing while one of its commands waits: it is sending", () => {
    const waiting = [queued({ kind: "complete-pickup", body: { pickupId: pickupId(1) } })]
    assert.deepEqual(stopActions(active, active.pickups[0], waiting), { sending: true, outcome: false, report: false })
    assert.deepEqual(stopActions(active, active.pickups[1], waiting), { sending: false, outcome: true, report: true }, "another stop is untouched")
  })

  test("nothing on a route not yet started, unless its start is waiting to be sent", () => {
    const ready = routeDetail({ status: "ready" })
    assert.deepEqual(stopActions(ready, ready.pickups[0], []), { sending: false, outcome: false, report: false })
    const starting = [queued({ kind: "start-route", body: { vehicleId: "v" } })]
    assert.deepEqual(stopActions(ready, ready.pickups[0], starting), { sending: false, outcome: true, report: true })
  })

  test("nothing once the route is completed, or its end is waiting", () => {
    const done = routeDetail({ status: "completed" })
    assert.deepEqual(stopActions(done, done.pickups[0], []), { sending: false, outcome: false, report: false })
    assert.deepEqual(stopActions(active, active.pickups[0], [queued({ kind: "end-route", body: {} })]), { sending: false, outcome: false, report: false })
  })
})

describe("what a route offers", () => {
  test("a ready route offers its start, and not while the start waits", () => {
    assert.equal(routeActions(route({ status: "ready" }), null, []).start, true)
    assert.equal(routeActions(route({ status: "ready" }), null, [queued({ kind: "start-route", body: { vehicleId: "v" } })]).start, false)
    assert.equal(routeActions(route({ status: "active" }), null, []).start, false, "no Start on an active route")
  })

  test("another route's open session is the server's to refuse: the start stays on offer", () => {
    assert.equal(routeActions(route({ status: "ready" }), null, [queued({ kind: "start-route", body: { vehicleId: "v" }, routeId: "another-route" })]).start, true)
  })

  test("an active route offers pause or resume by its session, a problem, an unload and its end", () => {
    const running = routeDetail({ status: "active", session: { ...sessionOf(), pausedAt: null } })
    assert.deepEqual(routeActions(running, running.session, []), { start: false, pause: true, resume: false, report: true, unload: true, end: true, sending: false })
    const paused = routeDetail({ status: "active", session: { ...sessionOf(), pausedAt: "2027-01-15T09:00:00.000Z" } })
    assert.deepEqual(routeActions(paused, paused.session, []), { start: false, pause: false, resume: true, report: true, unload: true, end: true, sending: false })
  })

  test("holds pause and resume while either waits, and everything once the end waits", () => {
    const running = routeDetail({ status: "active", session: sessionOf() })
    const pausing = routeActions(running, running.session, [queued({ kind: "pause", body: {} })])
    assert.equal(pausing.pause, false)
    assert.equal(pausing.resume, false)
    assert.equal(pausing.unload, true)
    assert.deepEqual(routeActions(running, running.session, [queued({ kind: "end-route", body: {} })]), { start: false, pause: false, resume: false, report: false, unload: false, end: false, sending: true })
  })
})

describe("the sentences", () => {
  test("the end-route confirm counts the planned stops no waiting outcome covers", () => {
    const detail = routeDetail({ status: "active", pickups: [pickup(1), pickup(2), pickup(3), pickup(4, { status: "completed" })] })
    assert.equal(endRouteWarning(detail, []), "3 stops not done will be marked skipped")
    assert.equal(endRouteWarning(detail, [queued({ kind: "complete-pickup", body: { pickupId: pickupId(1) } }), queued({ kind: "report-problem", body: { pickupId: pickupId(2), reason: "other", note: "x" } })]), "2 stops not done will be marked skipped")
    assert.equal(endRouteWarning(routeDetail({ status: "active", pickups: [pickup(1)] }), []), "1 stop not done will be marked skipped")
    assert.equal(endRouteWarning(routeDetail({ status: "active", pickups: [pickup(1, { status: "failed" })] }), []), "Every stop has an outcome.")
  })

  test("the banner says the server is out of reach and how much waits", () => {
    assert.equal(unreachableBanner(0), "Can't reach the server · 0 actions waiting")
    assert.equal(unreachableBanner(1), "Can't reach the server · 1 action waiting")
    assert.equal(unreachableBanner(3), "Can't reach the server · 3 actions waiting")
  })
})

describe("the start screen", () => {
  test("lists the routes by operating date, then planned start, then number", () => {
    const routes = [
      route({ id: "c", operatingDate: "2027-01-16", number: 1, label: "RC-1" }),
      route({ id: "b", operatingDate: "2027-01-15", plannedStartTime: "07:00", number: 3, label: "RC-3" }),
      route({ id: "a", operatingDate: "2027-01-15", plannedStartTime: "06:00", number: 9, label: "RC-9" }),
    ]
    assert.deepEqual(routesInDayOrder(routes).map((candidate) => candidate.id), ["a", "b", "c"])
  })

  test("reads a route's waiting commands apart from another's", () => {
    const mine = queued({ kind: "pause", body: {} })
    const other = queued({ kind: "pause", body: {}, routeId: "another-route" })
    assert.deepEqual(waitingOn([mine, other], ROUTE_ID), [mine])
  })
})

function sessionOf() {
  return {
    id: "01950000-0000-7000-8000-00000000a501",
    createdAt: "2027-01-15T06:00:00.000Z",
    updatedAt: "2027-01-15T06:00:00.000Z",
    projectId: route().projectId,
    routeId: ROUTE_ID,
    driverId: route().planned.driverId ?? "",
    vehicleId: route().planned.vehicleId ?? "",
    trailerId: null,
    deviceId: "web-x",
    appVersion: null,
    startedAt: "2027-01-15T06:00:00.000Z",
    endedAt: null,
    pausedAt: null,
    lastSeenAt: "2027-01-15T06:00:00.000Z",
  }
}

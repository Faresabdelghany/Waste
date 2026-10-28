// A route's track and estimates on the wire (O8 of #290): a position in the
// contracts' whole units, a track bounded by `TRACK_POINTS_MAX`, and the
// active Plan's stops with an instant or null each.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { LiveEta, Position, RouteEta, RouteTrack, RouteTrackQuery, TRACK_POINTS_MAX } from "../positions"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const position = { at: "2026-10-05T06:04:00.000Z", location: { type: "Point", coordinates: [12.5951, 55.7089] }, accuracyM: 9, speedKmh: 32, headingDeg: 270 }

describe("a track", () => {
  test("is positions in whole units, a session or none, and at most the bound", () => {
    assert.deepEqual(Position.parse(position), position)
    assert.equal(Position.safeParse({ ...position, accuracyM: 0 }).success, false)
    assert.equal(Position.safeParse({ ...position, location: { type: "Point", coordinates: [12.5, 55.7, 4] } }).success, false, "a flat point")
    assert.deepEqual(RouteTrack.parse({ routeId: ID, sessionId: null, points: [], thinned: false }), { routeId: ID, sessionId: null, points: [], thinned: false })
    assert.equal(TRACK_POINTS_MAX, 2000)
    assert.equal(RouteTrack.safeParse({ routeId: ID, sessionId: OTHER, points: Array.from({ length: TRACK_POINTS_MAX + 1 }, () => position), thinned: true }).success, false)
    assert.deepEqual(RouteTrackQuery.parse({ sessionId: OTHER }), { sessionId: OTHER })
    assert.match(String(RouteTrackQuery.safeParse({ sessionId: OTHER, driverId: ID }).error?.issues[0].message), /driverId/, "no read of a driver's positions")
  })
})

describe("the estimates", () => {
  test("are the Plan's stops, a pickup's or an unload visit's, each with an instant or null, and the trip's end", () => {
    const eta = { routeId: ID, planId: OTHER, computedAt: "2026-10-05T06:30:00.000Z", stops: [{ kind: "pickup", pickupId: ID, position: 1, eta: null }, { kind: "unload", pickupId: null, position: 2, eta: "2026-10-05T07:00:00.000Z" }], finishAt: null }
    assert.deepEqual(RouteEta.parse(eta), eta)
    assert.equal(RouteEta.safeParse({ ...eta, stops: [{ kind: "station", pickupId: null, position: 1, eta: null }] }).success, false)
    assert.deepEqual(LiveEta.parse({ nextPickupId: null, nextAt: null, finishAt: null }), { nextPickupId: null, nextAt: null, finishAt: null })
  })
})

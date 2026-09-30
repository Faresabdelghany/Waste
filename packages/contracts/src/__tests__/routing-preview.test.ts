import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ROUTING_PREVIEW_POINTS_MAX, RoutingPreview, RoutingPreviewRequest } from "../routing-preview"
import { PICKUP_ORDER_MAX } from "../routes"

const depot = [12.5683, 55.6761]
const bin = [12.575, 55.68]
const station = [12.61, 55.71]

const along = (count: number) => Array.from({ length: count }, (_, index) => [12.5 + index / 10_000, 55.7])

describe("RoutingPreviewRequest: the drafted route's points POST /routing/preview measures (#173)", () => {
  test("two points or more in driving order, a repeated one included, up to a route's most stops with its depot and station", () => {
    const body = { points: [depot, bin, bin, station] }
    assert.deepEqual(RoutingPreviewRequest.parse(body), body)
    assert.equal(ROUTING_PREVIEW_POINTS_MAX, PICKUP_ORDER_MAX + 2)
    assert.equal(RoutingPreviewRequest.safeParse({ points: along(ROUTING_PREVIEW_POINTS_MAX) }).success, true)
  })

  test("refuses one point, one too many, a third ordinate, a position off the globe and a member it does not know", () => {
    assert.equal(RoutingPreviewRequest.safeParse({ points: [depot] }).success, false)
    assert.equal(RoutingPreviewRequest.safeParse({ points: along(ROUTING_PREVIEW_POINTS_MAX + 1) }).success, false)
    assert.equal(RoutingPreviewRequest.safeParse({ points: [depot, [12.6, 55.7, 12]] }).success, false)
    assert.equal(RoutingPreviewRequest.safeParse({ points: [depot, [181, 55.7]] }).success, false)
    assert.equal(RoutingPreviewRequest.safeParse({ points: [depot, bin], profile: "driving-car" }).success, false)
  })
})

describe("RoutingPreview: the road, or the reason there is none (#173, #132 §5)", () => {
  test("the road: one leg per consecutive pair of the body's points, with its totals and whose geometry it is", () => {
    const road = {
      basis: "road",
      provider: "openrouteservice",
      legs: [
        { path: { type: "LineString", coordinates: [depot, [12.571, 55.678], bin] }, metres: 640, seconds: 71 },
        { path: { type: "LineString", coordinates: [bin, bin] }, metres: 0, seconds: 0 },
      ],
      distanceMetres: 640,
      durationSeconds: 71,
    }
    assert.deepEqual(RoutingPreview.parse(road), road)
  })

  test("no road: when the quota resumes, or null when waiting would not help, and the reason in one sentence", () => {
    const waiting = { basis: "estimate", provider: "openrouteservice", resumesAt: "2026-10-01T03:00:30.000Z", reason: "the routing provider's directions quota is spent" }
    assert.deepEqual(RoutingPreview.parse(waiting), waiting)
    const refused = { basis: "estimate", provider: "openrouteservice", resumesAt: null, reason: "the routing provider refused the key" }
    assert.deepEqual(RoutingPreview.parse(refused), refused)
  })

  test("refuses a road without its totals, an estimate without its reason and a basis it does not know", () => {
    assert.equal(RoutingPreview.safeParse({ basis: "road", provider: "fake", legs: [] }).success, false)
    assert.equal(RoutingPreview.safeParse({ basis: "estimate", provider: "fake", resumesAt: null }).success, false)
    assert.equal(RoutingPreview.safeParse({ basis: "straight", provider: "fake", resumesAt: null, reason: "x" }).success, false)
  })
})

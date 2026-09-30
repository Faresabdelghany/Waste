import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { LngLat } from "@waste/domain/map-planning/geo"
import {
  PLAYBACK_STOPS_PER_SECOND,
  advancePlayback,
  clockMinutes,
  formatDelay,
  playbackFrame,
  stopDelay,
} from "../playback"
import type { RoadGeometry } from "../road-geometry"

const stops: LngLat[] = [
  { lng: 12.5, lat: 55.6 },
  { lng: 12.52, lat: 55.6 },
  { lng: 12.52, lat: 55.62 },
]

// Two legs, each with a vertex halfway: east along the 55.6 parallel, then north.
const geometry: RoadGeometry = {
  legs: [
    [stops[0], { lng: 12.51, lat: 55.6 }, stops[1]],
    [stops[1], { lng: 12.52, lat: 55.61 }, stops[2]],
  ],
  snappedStops: stops,
  distanceMetres: 0,
  durationSeconds: 0,
  source: { provider: "fake", optimised: false },
}

const rounded = (point: LngLat) => ({ lng: Number(point.lng.toFixed(5)), lat: Number(point.lat.toFixed(5)) })

describe("playbackFrame", () => {
  test("at the start the vehicle stands on the first stop having travelled nothing", () => {
    assert.deepEqual(playbackFrame(stops, null, 0), { position: stops[0], travelled: [stops[0]] })
  })

  test("without a road the vehicle moves straight between stops", () => {
    const frame = playbackFrame(stops, null, 1.5)!
    assert.deepEqual(rounded(frame.position), { lng: 12.52, lat: 55.61 })
    assert.deepEqual(frame.travelled.map(rounded), [stops[0], stops[1], { lng: 12.52, lat: 55.61 }].map(rounded))
  })

  test("with a road the vehicle follows the leg by distance and the travelled path keeps every passed vertex", () => {
    const frame = playbackFrame(stops, geometry, 1.5)!
    assert.deepEqual(rounded(frame.position), { lng: 12.52, lat: 55.61 })
    assert.deepEqual(
      frame.travelled.map(rounded),
      [stops[0], { lng: 12.51, lat: 55.6 }, stops[1], { lng: 12.52, lat: 55.61 }].map(rounded),
    )
    const quarter = playbackFrame(stops, geometry, 0.25)!
    assert.deepEqual(rounded(quarter.position), { lng: 12.505, lat: 55.6 })
  })

  test("progress past the last stop clamps to it; a lone stop is the whole journey; no stops, no frame", () => {
    const end = playbackFrame(stops, geometry, 7)!
    assert.deepEqual(rounded(end.position), rounded(stops[2]))
    assert.equal(end.travelled.length, 5)
    assert.deepEqual(playbackFrame([stops[0]], null, 0.5), { position: stops[0], travelled: [stops[0]] })
    assert.equal(playbackFrame([], null, 0), null)
  })
})

describe("stop times", () => {
  test("clock strings become minutes since midnight, or null", () => {
    assert.equal(clockMinutes("06:32"), 392)
    assert.equal(clockMinutes("6:05"), 365)
    assert.equal(clockMinutes("later"), null)
    assert.equal(clockMinutes(null), null)
  })

  test("the delay is actual minus planned, in minutes, when both are known", () => {
    assert.equal(stopDelay("06:32", "06:41"), 9)
    assert.equal(stopDelay("06:32", "06:30"), -2)
    assert.equal(stopDelay("06:32", null), null)
    assert.equal(stopDelay(null, "06:41"), null)
  })

  test("delays read as +9 min, −2 min, or On time", () => {
    assert.equal(formatDelay(9), "+9 min")
    assert.equal(formatDelay(-2), "−2 min")
    assert.equal(formatDelay(0), "On time")
  })
})

describe("advancePlayback", () => {
  test("a second at 1× moves the vehicle the configured share of a stop; speed multiplies it", () => {
    assert.deepEqual(advancePlayback(0, 1000, 1, 3), { progress: PLAYBACK_STOPS_PER_SECOND, done: false })
    assert.deepEqual(advancePlayback(0, 500, 2, 3), { progress: PLAYBACK_STOPS_PER_SECOND, done: false })
  })

  test("the journey ends at the last stop", () => {
    assert.deepEqual(advancePlayback(1.9, 1000, 4, 3), { progress: 2, done: true })
    assert.deepEqual(advancePlayback(0, 1000, 1, 1), { progress: 0, done: true })
  })
})

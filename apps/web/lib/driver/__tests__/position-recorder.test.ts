// The position recorder (O8 of #290) over a fake watch and hand-moved timers:
// a phone's reading as a fix in whole units, the domain's rule for which fix
// is kept, the open batch the controller is told of on every kept fix, and
// its close — two minutes after its first fix, at sixty, when asked, or when
// the recording stops — while a disposed page closes nothing.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { POSITION_RULES } from "@waste/domain/execution/positions"

import { createPositionRecorder, fixOf, sessionRecords, type PositionBatch } from "../position-recorder"
import { fakeGeolocation, NOW, ROUTE_ID } from "./driver-fixtures"
import { manualTimers } from "./manual-timers"

const OTHER_ROUTE = "01950000-0000-7000-8000-000000000002"
/** A degree of latitude is 111 195 m on the mean radius: a point that many metres north of the first. */
const north = (metres: number) => 55.7 + metres / 111_195

function recording() {
  const position = fakeGeolocation()
  const timers = manualTimers()
  let now = NOW
  const open: Array<PositionBatch | null> = []
  const closed: PositionBatch[] = []
  const recorder = createPositionRecorder({ geolocation: position.geolocation, now: () => now, timers, changed: (batch) => open.push(batch), closed: (batch) => closed.push(batch) })
  /** The phone is heard of `seconds` after the start, `metres` north of where it began. */
  const at = (seconds: number, metres = 0, accuracy = 8) => {
    now = NOW + seconds * 1000
    timers.advance(0)
    position.move(now, north(metres), 12.58, accuracy)
  }
  const wait = (seconds: number) => {
    now += seconds * 1000
    timers.advance(seconds * 1000)
  }
  return { position, timers, recorder, open, closed, at, wait }
}

describe("fixOf", () => {
  test("is the reading in the contracts' whole units: the point, the accuracy rounded up, the speed in km/h and the heading in degrees where the phone gave them", () => {
    assert.deepEqual(fixOf({ coords: { latitude: 55.7, longitude: 12.58, accuracy: 7.2, speed: 10, heading: 359.6 } as GeolocationCoordinates, timestamp: NOW }), {
      at: new Date(NOW).toISOString(),
      location: { type: "Point", coordinates: [12.58, 55.7] },
      accuracyM: 8,
      speedKmh: 36,
      headingDeg: 0,
    })
    assert.deepEqual(fixOf({ coords: { latitude: 55.7, longitude: 12.58, accuracy: 0.4, speed: null, heading: Number.NaN } as GeolocationCoordinates, timestamp: NOW }), {
      at: new Date(NOW).toISOString(),
      location: { type: "Point", coordinates: [12.58, 55.7] },
      accuracyM: 1,
    })
    assert.equal(fixOf({ coords: { latitude: 55.7, longitude: 12.58, accuracy: 5, speed: 200, heading: null } as GeolocationCoordinates, timestamp: NOW }).speedKmh, 300, "held to what a road vehicle is said to go")
  })
})

describe("the recorder", () => {
  test("watches only the route it follows, and keeps the fixes the domain's rule keeps, telling the controller of the open batch each time", () => {
    const { position, recorder, open, at } = recording()
    assert.equal(position.watches.size, 0, "nothing is watched before a route is followed")
    recorder.follow(ROUTE_ID)
    assert.equal(position.watches.size, 1)
    at(0)
    at(10, 200, 8)
    at(40, 10)
    at(45, 200, 150)
    at(60, 60)
    assert.deepEqual(
      open.map((batch) => batch?.points.length),
      [1, 2],
      "the first; then 60 s on and 50 m away — not 10 s on, not 10 m away, not 150 m coarse",
    )
    assert.equal(open.at(-1)?.routeId, ROUTE_ID)
    recorder.follow(ROUTE_ID)
    assert.equal(position.watches.size, 1, "following the same route again changes nothing")
  })

  test("closes the batch two minutes after its first fix, even with no fix since, and on the first fix kept after them", () => {
    const { recorder, open, closed, at, wait } = recording()
    recorder.follow(ROUTE_ID)
    at(0)
    wait(POSITION_RULES.batchMs / 1000 - 1)
    assert.equal(closed.length, 0)
    wait(1)
    assert.equal(closed.length, 1)
    assert.equal(closed[0].points.length, 1)
    assert.equal(open.at(-1), null, "the open batch is gone")

    // A fix every thirty seconds, 30 m apart: the fifth is two minutes after the first and closes the batch with it.
    for (let index = 0; index < 5; index += 1) at(200 + index * 30, index * 30)
    assert.equal(closed.length, 2)
    assert.equal(closed[1].points.length, 5)
  })

  test("closes when asked and when the recording stops or moves to another route; an empty batch closes into nothing", () => {
    const { position, recorder, closed, at } = recording()
    recorder.follow(ROUTE_ID)
    recorder.close()
    assert.equal(closed.length, 0, "nothing kept, nothing queued")
    at(0)
    recorder.close()
    assert.deepEqual(
      closed.map((batch) => [batch.routeId, batch.points.length]),
      [[ROUTE_ID, 1]],
    )
    at(30, 30)
    recorder.follow(OTHER_ROUTE)
    assert.deepEqual(closed.at(-1)?.routeId, ROUTE_ID, "the batch of the route left")
    assert.equal(position.watches.size, 1, "one watch, the new route's")
    at(60, 60)
    recorder.follow(null)
    assert.deepEqual(closed.at(-1)?.routeId, OTHER_ROUTE)
    assert.equal(position.watches.size, 0)
  })

  test("drops a fix from before the session started — a cached reading the door would refuse — and one from ahead of the phone's clock", () => {
    const { position, recorder, open, at } = recording()
    recorder.follow(ROUTE_ID, new Date(NOW + 5_000).toISOString())
    at(0)
    assert.equal(open.length, 0)
    position.move(NOW + 60_000)
    assert.equal(open.length, 0, "ahead of the clock")
    at(5)
    assert.equal(open.length, 1)
  })

  test("disposed, it stops watching and closes nothing: the controller's row is the next page's", () => {
    const { position, recorder, closed, timers, at } = recording()
    recorder.follow(ROUTE_ID)
    at(0)
    recorder.dispose()
    assert.equal(position.watches.size, 0)
    assert.deepEqual(timers.pending(), [])
    assert.equal(closed.length, 0)
  })

  test("a phone with no watch records nothing and says nothing", () => {
    const closed: PositionBatch[] = []
    const recorder = createPositionRecorder({ geolocation: null, changed: () => {}, closed: (batch) => closed.push(batch) })
    recorder.follow(ROUTE_ID)
    recorder.close()
    assert.equal(closed.length, 0)
  })
})

describe("sessionRecords", () => {
  const session = { endedAt: null, pausedAt: null, driverId: "mads" } as NonNullable<Parameters<typeof sessionRecords>[0]["session"]>
  test("is this driver's open, unpaused session on an active route, and nothing else", () => {
    assert.equal(sessionRecords({ status: "active", session }, "mads"), true)
    assert.equal(sessionRecords({ status: "active", session }, "freja"), false, "another driver's")
    assert.equal(sessionRecords({ status: "active", session: { ...session, pausedAt: "2027-01-15T07:00:00.000Z" } }, "mads"), false, "paused")
    assert.equal(sessionRecords({ status: "active", session: null }, "mads"), false, "no session")
    assert.equal(sessionRecords({ status: "completed", session: { ...session, endedAt: "2027-01-15T12:00:00.000Z" } }, "mads"), false, "ended")
    assert.equal(sessionRecords({ status: "ready", session: null }, "mads"), false, "not started")
  })
})

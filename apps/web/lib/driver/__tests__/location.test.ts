// The Driver App's position (Issue #145): best-effort only. One
// `getCurrentPosition` per command, asked for a fix at most 60 s old within
// 3 s; a fix is attached when it is 100 m or better and that recent, and
// otherwise the command goes without one. The 3 s bound is the helper's own
// as well as the browser's, since a permission prompt still open does not
// count against `timeout`. Never `watchPosition`.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { lookupFix } from "../location"
import { manualTimers } from "./manual-timers"

const NOW = 1_800_000_000_000

type Asked = { success: PositionCallback; error?: PositionErrorCallback | null; options?: PositionOptions }

function fakeGeolocation() {
  const asked: Asked[] = []
  const geolocation = {
    getCurrentPosition: (success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions) => {
      asked.push({ success, error, options })
    },
    watchPosition: () => {
      throw new Error("the Driver App never watches the position")
    },
  }
  return { geolocation, asked }
}

const position = (accuracy: number, ageMs: number, latitude = 55.6761, longitude = 12.5683) =>
  ({ coords: { latitude, longitude, accuracy }, timestamp: NOW - ageMs }) as GeolocationPosition

describe("a command's position", () => {
  test("is asked once, for a fix at most 60 s old within 3 s", async () => {
    const { geolocation, asked } = fakeGeolocation()
    const fix = lookupFix(geolocation, { now: () => NOW, timers: manualTimers() })
    assert.equal(asked.length, 1)
    assert.equal(asked[0].options?.maximumAge, 60_000)
    assert.equal(asked[0].options?.timeout, 3_000)
    asked[0].success(position(12.4, 5_000))
    assert.deepEqual(await fix, { location: { type: "Point", coordinates: [12.5683, 55.6761] }, accuracyM: 13 })
  })

  test("is attached at exactly 100 m and never worse", async () => {
    for (const [accuracy, attached] of [
      [100, true],
      [100.5, false],
    ] as const) {
      const { geolocation, asked } = fakeGeolocation()
      const fix = lookupFix(geolocation, { now: () => NOW, timers: manualTimers() })
      asked[0].success(position(accuracy, 0))
      assert.equal((await fix) !== null, attached, `accuracy ${accuracy}`)
    }
  })

  test("is left off when the fix is older than a minute", async () => {
    const { geolocation, asked } = fakeGeolocation()
    const fix = lookupFix(geolocation, { now: () => NOW, timers: manualTimers() })
    asked[0].success(position(10, 60_001))
    assert.equal(await fix, null)
  })

  test("is left off when the browser refuses or cannot tell", async () => {
    const { geolocation, asked } = fakeGeolocation()
    const fix = lookupFix(geolocation, { now: () => NOW, timers: manualTimers() })
    asked[0].error?.({ code: 1, message: "User denied Geolocation" } as GeolocationPositionError)
    assert.equal(await fix, null)
  })

  test("is left off after 3 s without an answer, a permission prompt still open included, and a late fix changes nothing", async () => {
    const { geolocation, asked } = fakeGeolocation()
    const timers = manualTimers()
    const fix = lookupFix(geolocation, { now: () => NOW, timers })
    timers.advance(2_999)
    let answered = false
    void fix.then(() => {
      answered = true
    })
    await Promise.resolve()
    assert.equal(answered, false)
    timers.advance(1)
    assert.equal(await fix, null)
    asked[0].success(position(5, 0))
    assert.equal(await fix, null)
  })

  test("is left off without a geolocation at all", async () => {
    assert.equal(await lookupFix(undefined, { now: () => NOW, timers: manualTimers() }), null)
  })

  test("clears its own bound once the browser has answered", async () => {
    const { geolocation, asked } = fakeGeolocation()
    const timers = manualTimers()
    const fix = lookupFix(geolocation, { now: () => NOW, timers })
    asked[0].success(position(10, 0))
    await fix
    assert.deepEqual(timers.pending(), [])
  })
})

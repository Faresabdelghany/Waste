// The Driver App's recording rules (O8 of #290, decided on #344): which fix is
// kept, when a batch is closed, the distance between two fixes, and the days
// a purge keeps — over plain values and no clock of its own.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { batchDue, keepsFix, metresBetween, POSITION_RETENTION_CEILING_DAYS, POSITION_RULES, positionRetentionDays, type PositionFix } from "../positions"

const AT = Date.parse("2026-10-05T08:00:00.000Z")
const at = (seconds: number): string => new Date(AT + seconds * 1000).toISOString()
/** A point that many metres north of the origin: a degree of latitude is 111 195 m on the mean radius. */
const north = (metres: number) => ({ type: "Point" as const, coordinates: [12.5951, 55.7089 + metres / 111_195] as [number, number] })
const fix = (seconds: number, metres = 0, accuracyM = 10): PositionFix => ({ at: at(seconds), location: north(metres), accuracyM })

describe("metresBetween", () => {
  test("is the great-circle distance, to a metre at a street's scale, and nothing between a point and itself", () => {
    assert.equal(metresBetween(north(0), north(0)), 0)
    assert.ok(Math.abs(metresBetween(north(0), north(100)) - 100) < 1)
    // Copenhagen's town hall to Nordhavn, about 4.5 km.
    const hall = { type: "Point" as const, coordinates: [12.5683, 55.6761] as [number, number] }
    const harbour = { type: "Point" as const, coordinates: [12.5951, 55.7089] as [number, number] }
    assert.ok(Math.abs(metresBetween(hall, harbour) - 3_950) < 100, String(metresBetween(hall, harbour)))
  })
})

describe("keepsFix", () => {
  test("the first fix of a session is kept when it is good enough, and a coarse one never is", () => {
    assert.equal(keepsFix(null, fix(0)), true)
    assert.equal(keepsFix(null, fix(0, 0, POSITION_RULES.accuracyM)), true, "at the bound")
    assert.equal(keepsFix(null, fix(0, 0, POSITION_RULES.accuracyM + 1)), false)
    assert.equal(keepsFix(fix(0), fix(600, 500, 250)), false, "however long since and however far")
  })

  test("within thirty seconds of the last kept fix, nothing is kept, however far it moved", () => {
    assert.equal(keepsFix(fix(0), fix(29, 400)), false)
    assert.equal(keepsFix(fix(0), fix(30, 25)), true, "at the interval and the distance")
  })

  test("after the interval, a fix 25 m from the last is kept and a nearer one waits for the two-minute heartbeat", () => {
    assert.equal(keepsFix(fix(0), fix(45, 24)), false)
    assert.equal(keepsFix(fix(0), fix(45, 26)), true)
    assert.equal(keepsFix(fix(0), fix(119, 0)), false, "a vehicle standing still, just short of the heartbeat")
    assert.equal(keepsFix(fix(0), fix(120, 0)), true, "and at it")
  })
})

describe("batchDue", () => {
  test("an empty batch is never due; one is due two minutes after its first fix, or when it holds sixty", () => {
    assert.equal(batchDue([], AT + 10 * 60_000), false)
    assert.equal(batchDue([fix(0)], AT + POSITION_RULES.batchMs - 1), false)
    assert.equal(batchDue([fix(0)], AT + POSITION_RULES.batchMs), true)
    const full = Array.from({ length: POSITION_RULES.batchMax }, (_, index) => fix(index))
    assert.equal(batchDue(full, AT), true)
    assert.equal(batchDue(full.slice(1), AT + 60_000), false)
  })
})

describe("positionRetentionDays", () => {
  test("is the setting, never past the thirty-day ceiling, and the ceiling when unset", () => {
    assert.equal(POSITION_RETENTION_CEILING_DAYS, 30)
    assert.equal(positionRetentionDays(undefined), 30)
    assert.equal(positionRetentionDays(7), 7)
    assert.equal(positionRetentionDays(30), 30)
    assert.equal(positionRetentionDays(90), 30, "a longer setting is held to the ceiling")
  })
})
